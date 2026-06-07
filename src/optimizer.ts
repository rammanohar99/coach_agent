import { query } from "@anthropic-ai/claude-agent-sdk";
import { runAgent, SYSTEM_PROMPT } from "./agent";
import { scorePlan } from "./eval";
import type { TestCase, MetricResult, Plan } from "./eval";
import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";

const MODEL = "claude-haiku-4-5";

// ─── Types ────────────────────────────────────────────────────────────────────

interface CaseScore {
  id: string;
  student_id: string;
  total: number;
  metrics: MetricResult[];
}

interface IterationRecord {
  iteration: number;
  prompt_length: number;
  aggregate: number;
  case_scores: CaseScore[];
  lowest_metric: string;
  suggestion?: string;
  kept: boolean;
}

// ─── Eval runner ──────────────────────────────────────────────────────────────

async function evalWithPrompt(
  testCases: TestCase[],
  systemPrompt: string
): Promise<{ aggregate: number; cases: CaseScore[] }> {
  const cases: CaseScore[] = [];

  for (const tc of testCases) {
    try {
      await runAgent(tc.student_id, tc.course, tc.exam_days, tc.hours_per_day, systemPrompt);
      const planPath = join("output", `${tc.student_id}_plan.json`);
      const plan = JSON.parse(await readFile(planPath, "utf8")) as Plan;
      const metrics = scorePlan(plan, tc.expected_behavior);
      const total = metrics.reduce((s, m) => s + m.score, 0);
      cases.push({ id: tc.id, student_id: tc.student_id, total, metrics });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  [EVAL ERROR] ${tc.id}: ${msg}`);
      const fail = (name: string): MetricResult => ({ name, score: 0, details: "Agent run failed" });
      cases.push({
        id: tc.id,
        student_id: tc.student_id,
        total: 0,
        metrics: [
          fail("weak_topics_covered"),
          fail("strong_topics_excluded"),
          fail("prereq_order"),
          fail("hours_within_budget"),
          fail("theory_and_practice"),
        ],
      });
    }
  }

  const aggregate = cases.reduce((s, c) => s + c.total, 0) / cases.length;
  return { aggregate, cases };
}

// ─── Metric analysis ──────────────────────────────────────────────────────────

function findLowestMetric(cases: CaseScore[]): string {
  const totals: Record<string, number> = {};
  const counts: Record<string, number> = {};

  for (const c of cases) {
    for (const m of c.metrics) {
      totals[m.name] = (totals[m.name] ?? 0) + m.score;
      counts[m.name] = (counts[m.name] ?? 0) + 1;
    }
  }

  let lowestName = "";
  let lowestAvg = Infinity;

  for (const [name, total] of Object.entries(totals)) {
    const avg = total / (counts[name] ?? 1);
    if (avg < lowestAvg) {
      lowestAvg = avg;
      lowestName = name;
    }
  }

  return lowestName;
}

// ─── Haiku suggestion ─────────────────────────────────────────────────────────

async function getSuggestion(metricName: string, currentPrompt: string): Promise<string> {
  const metricDescriptions: Record<string, string> = {
    weak_topics_covered: "all weak topics (below score 60) must appear in the study plan",
    strong_topics_excluded: "topics where the student already scores well must NOT appear in the plan",
    prereq_order: "prerequisite topics must be studied before the topics that depend on them",
    hours_within_budget: "total resource time must not exceed the available study hours",
    theory_and_practice: "each weak topic must have both a theory resource (video or article) and a practice resource",
  };

  const description = metricDescriptions[metricName] ?? metricName;
  const promptExcerpt = currentPrompt.slice(-600);

  const prompt =
    `You are improving a system prompt for a study coach AI agent. ` +
    `The lowest-scoring evaluation metric is "${metricName}": ${description}.\n\n` +
    `Current system prompt (last 600 chars):\n${promptExcerpt}\n\n` +
    `Write exactly ONE sentence to append to the system prompt that directly addresses the "${metricName}" metric. ` +
    `Output only the sentence, no preamble, no explanation.`;

  let text = "";
  for await (const message of query({
    prompt,
    options: { model: MODEL, tools: [] },
  })) {
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "text" && block.text) text += block.text;
      }
    }
  }

  const suggestion = text.trim();
  if (!suggestion) throw new Error("Empty response from model in getSuggestion");
  return suggestion;
}

// ─── Main optimizer loop ──────────────────────────────────────────────────────

async function main() {
  const { test_cases: allTestCases } = (await Bun.file("evals/test-cases.json").json()) as {
    test_cases: TestCase[];
  };
  const testCases = allTestCases;
  const iterations: IterationRecord[] = [];

  let currentPrompt = SYSTEM_PROMPT;
  let bestScore = -1;

  const BAR = "═".repeat(62);
  console.log(`\n${BAR}`);
  console.log(" OPTIMIZER — prompt improvement via eval feedback");
  console.log(BAR);

  // ── Iteration 0: baseline ──────────────────────────────────────────────────

  console.log("\n[Iteration 0] Running baseline eval...");
  const baseline = await evalWithPrompt(testCases, currentPrompt);
  bestScore = baseline.aggregate;

  const baselineLowest = findLowestMetric(baseline.cases);
  console.log(`  Aggregate: ${baseline.aggregate.toFixed(2)} / 5.00  (lowest metric: ${baselineLowest})`);

  iterations.push({
    iteration: 0,
    prompt_length: currentPrompt.length,
    aggregate: baseline.aggregate,
    case_scores: baseline.cases,
    lowest_metric: baselineLowest,
    kept: true,
  });

  // ── Optimization loop ──────────────────────────────────────────────────────

  const MAX_ITERATIONS = 5;
  let consecutiveNoImprovement = 0;

  for (let i = 1; i <= MAX_ITERATIONS; i++) {
    const lowestMetric = iterations[iterations.length - 1].lowest_metric;

    console.log(`\n[Iteration ${i}] Targeting metric: "${lowestMetric}"`);
    const suggestion = await getSuggestion(lowestMetric, currentPrompt);
    console.log(`  Suggestion: ${suggestion}`);

    const candidatePrompt = currentPrompt + "\n" + suggestion;

    console.log("  Running eval with candidate prompt...");
    const result = await evalWithPrompt(testCases, candidatePrompt);
    const resultLowest = findLowestMetric(result.cases);

    const improved = result.aggregate > bestScore;
    console.log(
      `  Score: ${result.aggregate.toFixed(2)} / 5.00  ` +
        `(was ${bestScore.toFixed(2)})  → ${improved ? "✓ kept" : "✗ discarded"}`
    );

    if (improved) {
      currentPrompt = candidatePrompt;
      bestScore = result.aggregate;
      consecutiveNoImprovement = 0;
    } else {
      consecutiveNoImprovement++;
    }

    iterations.push({
      iteration: i,
      prompt_length: candidatePrompt.length,
      aggregate: result.aggregate,
      case_scores: result.cases,
      lowest_metric: resultLowest,
      suggestion,
      kept: improved,
    });

    if (consecutiveNoImprovement >= 2) {
      console.log("\n  Score plateaued (2 consecutive non-improvements) — stopping early.");
      break;
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────────

  console.log(`\n${BAR}`);
  console.log(" OPTIMIZER RESULTS");
  console.log(BAR);
  console.log(`  Before : ${iterations[0].aggregate.toFixed(2)} / 5.00`);
  console.log(`  After  : ${bestScore.toFixed(2)} / 5.00`);
  console.log(`  Δ      : ${(bestScore - iterations[0].aggregate).toFixed(2)}`);
  console.log(`  Iterations run: ${iterations.length - 1}`);
  console.log(`\nFinal optimized prompt:\n${"─".repeat(62)}`);
  console.log(currentPrompt);
  console.log("─".repeat(62));

  // ── Save results ───────────────────────────────────────────────────────────

  await mkdir("output", { recursive: true });
  const outputPath = join("output", "optimizer_results.json");

  await writeFile(
    outputPath,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        baseline_score: iterations[0].aggregate,
        final_score: bestScore,
        improvement: parseFloat((bestScore - iterations[0].aggregate).toFixed(2)),
        final_prompt: currentPrompt,
        iterations,
      },
      null,
      2
    ),
    "utf8"
  );

  console.log(`\nResults saved to ${outputPath}`);
}

// ─── Entry point ──────────────────────────────────────────────────────────────

main().catch((err: unknown) => {
  console.error(`\n[FATAL]  ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
