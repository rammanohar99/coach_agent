import { runAgent } from "./agent";
import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ExpectedBehavior {
  weak_topics_covered: string[];
  strong_topics_excluded: string[];
  prereq_order: [string, string][];
  max_total_hours: number;
}

export interface TestCase {
  id: string;
  student_id: string;
  course: string;
  exam_days: number;
  hours_per_day: number;
  expected_behavior: ExpectedBehavior;
}

interface PlanResource {
  type: string;
  title: string;
  duration_mins?: number;
}

interface PlanDay {
  day: number;
  topics?: unknown[];          // flat: string[] or nested: {name?, resources?}[]
  topics_covered?: unknown[];  // variant: [{topic, resources}] or string[]
  sessions?: unknown[];        // variant: [{topic, resources}] (alongside string topics_covered)
  topic?: string;              // Priya variant: singular string
  resources?: PlanResource[];  // day-level resources (flat / singular-topic shapes)
}

export interface Plan {
  student_id?: string;
  weak_topics?: unknown[]; // may be string[] or [{topic, ...}] or [{name, ...}]
  day_plan?: PlanDay[];
}

export interface MetricResult {
  name: string;
  score: number;
  details: string;
}

interface CaseResult {
  id: string;
  student_id: string;
  course: string;
  exam_days: number;
  hours_per_day: number;
  metrics: MetricResult[];
  total_score: number;
  error?: string;
}

// ─── Shape-aware helpers ──────────────────────────────────────────────────────

// Extract a topic name from any entry shape the agent may produce:
//   string          → the string itself
//   { name }        → obj.name   (flat-object variant)
//   { topic }       → obj.topic  (topics_covered variant)
function getEntryName(entry: unknown): string | undefined {
  if (typeof entry === "string") return entry;
  if (typeof entry === "object" && entry !== null) {
    const o = entry as Record<string, unknown>;
    if (typeof o.name === "string") return o.name;
    if (typeof o.topic === "string") return o.topic;
  }
  return undefined;
}

// Extract resources embedded inside a topic entry object (nested shapes).
function getEntryResources(entry: unknown): PlanResource[] {
  if (typeof entry !== "object" || entry === null) return [];
  const o = entry as Record<string, unknown>;
  return Array.isArray(o.resources) ? (o.resources as PlanResource[]) : [];
}

// Return every topic entry in a day, checking all structural variants:
//   day.topics          – string[] or [{name, resources}]
//   day.topics_covered  – [{topic, resources}] or string[] summary list
//   day.sessions        – [{topic, resources}] used alongside string topics_covered
//   day.topic           – singular string (Priya variant)
function getDayEntries(day: PlanDay): unknown[] {
  const entries: unknown[] = [];
  if (Array.isArray(day.topics)) entries.push(...day.topics);
  if (Array.isArray(day.topics_covered)) entries.push(...day.topics_covered);
  if (Array.isArray(day.sessions)) entries.push(...day.sessions);
  if (typeof day.topic === "string") entries.push(day.topic);
  return entries;
}

// True when any entry in a day covers the target topic (substring match handles
// combined labels like "LinkedList (Review) + Trees" or "Graphs (continued) & DP Intro").
function entryMatchesTopic(entry: unknown, target: string): boolean {
  const name = getEntryName(entry);
  return name != null && (name === target || name.includes(target));
}

function dayCoversTopics(day: PlanDay, target: string): boolean {
  return getDayEntries(day).some((e) => entryMatchesTopic(e, target));
}

// Returns the first day number in which the target topic appears, or undefined.
function findFirstDay(plan: Plan, target: string): number | undefined {
  for (const day of plan.day_plan ?? []) {
    if (dayCoversTopics(day, target)) return day.day;
  }
  return undefined;
}

// True if the target topic appears anywhere in the plan.
// weak_topics may contain plain strings or topic objects like {topic: "Arrays", ...}.
function topicAppearsInPlan(plan: Plan, target: string): boolean {
  const inWeakTopics = (plan.weak_topics ?? []).some((t) => {
    const name = getEntryName(t);
    return name != null && (name === target || name.includes(target));
  });
  if (inWeakTopics) return true;
  return (plan.day_plan ?? []).some((day) => dayCoversTopics(day, target));
}

// Collect all resources associated with a target topic from one day.
//   string entry  → flat shape: resources live at day level
//   object entry  → nested shape: resources live inside the entry; fall back to day level if empty
function resourcesForTopicInDay(day: PlanDay, target: string): PlanResource[] {
  const result: PlanResource[] = [];
  let addedDayResources = false;

  for (const entry of getDayEntries(day)) {
    if (!entryMatchesTopic(entry, target)) continue;

    if (typeof entry === "string") {
      if (!addedDayResources) {
        result.push(...(day.resources ?? []));
        addedDayResources = true;
      }
    } else {
      const nested = getEntryResources(entry);
      if (nested.length > 0) {
        result.push(...nested);
      } else if (!addedDayResources) {
        result.push(...(day.resources ?? []));
        addedDayResources = true;
      }
    }
  }

  return result;
}

// Aggregate resources for a target topic across the entire plan.
function getResourcesForTopic(plan: Plan, target: string): PlanResource[] {
  return (plan.day_plan ?? []).flatMap((day) => resourcesForTopicInDay(day, target));
}

// Sum duration_mins from all resource locations across all structural shapes.
// day.resources handles flat/singular shapes; getEntryResources handles nested shapes.
// These are mutually exclusive in practice so there is no double-counting.
function sumAllResourceMins(plan: Plan): number {
  let total = 0;
  for (const day of plan.day_plan ?? []) {
    for (const r of day.resources ?? []) total += r.duration_mins ?? 0;
    for (const entry of getDayEntries(day)) {
      for (const r of getEntryResources(entry)) total += r.duration_mins ?? 0;
    }
  }
  return total;
}

// ─── Scoring functions ────────────────────────────────────────────────────────

function metric1_weakTopicsCovered(plan: Plan, expected: string[]): MetricResult {
  const missing = expected.filter((t) => !topicAppearsInPlan(plan, t));
  const passed = missing.length === 0;
  return {
    name: "weak_topics_covered",
    score: passed ? 1.0 : 0.0,
    details: passed
      ? `All ${expected.length} expected weak topics present`
      : `Missing: ${missing.join(", ")}`,
  };
}

function metric2_strongTopicsExcluded(plan: Plan, excluded: string[]): MetricResult {
  if (excluded.length === 0) {
    return { name: "strong_topics_excluded", score: 1.0, details: "No strong topics to check" };
  }
  const wronglyIn = excluded.filter((t) => topicAppearsInPlan(plan, t));
  const passed = wronglyIn.length === 0;
  return {
    name: "strong_topics_excluded",
    score: passed ? 1.0 : 0.0,
    details: passed ? "No strong topics in plan" : `Included: ${wronglyIn.join(", ")}`,
  };
}

function metric3_prereqOrder(plan: Plan, pairs: [string, string][]): MetricResult {
  if (pairs.length === 0) {
    return { name: "prereq_order", score: 1.0, details: "No prerequisite pairs to check" };
  }

  const violations: string[] = [];
  for (const [before, after] of pairs) {
    const bDay = findFirstDay(plan, before);
    const aDay = findFirstDay(plan, after);
    if (bDay == null || aDay == null) continue; // topic absent from plan — skip
    if (bDay > aDay) violations.push(`${before} (day ${bDay}) > ${after} (day ${aDay})`);
  }

  const passed = violations.length === 0;
  return {
    name: "prereq_order",
    score: passed ? 1.0 : 0.0,
    details: passed ? "All prerequisite orderings respected" : violations.join("; "),
  };
}

function metric4_hoursBudget(plan: Plan, maxHours: number): MetricResult {
  // Sum duration_mins from both flat (day.resources) and nested (topic.resources) shapes
  const totalMins = sumAllResourceMins(plan);
  const totalHours = totalMins / 60;
  const passed = totalHours <= maxHours;
  return {
    name: "hours_within_budget",
    score: passed ? 1.0 : 0.0,
    details: `Scheduled ${totalHours.toFixed(2)}h  (budget: ${maxHours}h)`,
  };
}

function metric5_theoryAndPractice(plan: Plan, weakTopics: string[]): MetricResult {
  if (weakTopics.length === 0) {
    return { name: "theory_and_practice", score: 1.0, details: "No weak topics to check" };
  }

  const failures: string[] = [];
  for (const topic of weakTopics) {
    const res = getResourcesForTopic(plan, topic);
    const hasTheory = res.some((r) => r.type === "video" || r.type === "article");
    const hasPractice = res.some((r) => r.type === "practice");
    if (!hasTheory || !hasPractice) {
      const missing: string[] = [];
      if (!hasTheory) missing.push("theory");
      if (!hasPractice) missing.push("practice");
      failures.push(`${topic}: no ${missing.join(" or ")}`);
    }
  }

  const passed = failures.length === 0;
  return {
    name: "theory_and_practice",
    score: passed ? 1.0 : 0.0,
    details: passed ? "Every weak topic has theory + practice" : failures.join("; "),
  };
}

export function scorePlan(plan: Plan, eb: ExpectedBehavior): MetricResult[] {
  return [
    metric1_weakTopicsCovered(plan, eb.weak_topics_covered),
    metric2_strongTopicsExcluded(plan, eb.strong_topics_excluded),
    metric3_prereqOrder(plan, eb.prereq_order),
    metric4_hoursBudget(plan, eb.max_total_hours),
    metric5_theoryAndPractice(plan, eb.weak_topics_covered),
  ];
}

// ─── Output helpers ───────────────────────────────────────────────────────────

const BAR = "═".repeat(62);
const DASH = "─".repeat(50);

function printCaseResult(tc: TestCase, result: CaseResult) {
  console.log(`\nTest Case ${tc.id}: ${tc.student_id} | ${tc.course} | ${tc.exam_days}d × ${tc.hours_per_day}h`);
  for (const m of result.metrics) {
    const mark = m.score === 1.0 ? "✓" : "✗";
    const namePad = m.name.padEnd(26);
    console.log(`  ${mark} ${namePad}  ${m.score.toFixed(1)} / 1.0   ${m.details}`);
  }
  console.log(`  ${DASH}`);
  console.log(`  Score: ${result.total_score.toFixed(1)} / 5.0\n`);
}

// ─── Main eval runner ─────────────────────────────────────────────────────────

async function runEval() {
  const { test_cases: testCases } = (await Bun.file("evals/test-cases.json").json()) as {
    test_cases: TestCase[];
  };

  const results: CaseResult[] = [];

  for (const tc of testCases) {
    console.log(`\n${BAR}`);
    console.log(` Running ${tc.id}: ${tc.student_id} | ${tc.course} | ${tc.exam_days}d × ${tc.hours_per_day}h`);
    console.log(BAR);

    let metrics: MetricResult[];
    let error: string | undefined;

    try {
      await runAgent(tc.student_id, tc.course, tc.exam_days, tc.hours_per_day);

      const planPath = join("output", `${tc.student_id}_plan.json`);
      const plan = JSON.parse(await readFile(planPath, "utf8")) as Plan;
      metrics = scorePlan(plan, tc.expected_behavior);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      console.error(`[EVAL ERROR] ${error}`);
      const fail = (name: string): MetricResult => ({
        name,
        score: 0.0,
        details: "Agent run failed",
      });
      metrics = [
        fail("weak_topics_covered"),
        fail("strong_topics_excluded"),
        fail("prereq_order"),
        fail("hours_within_budget"),
        fail("theory_and_practice"),
      ];
    }

    const total = metrics.reduce((s, m) => s + m.score, 0);
    results.push({
      id: tc.id,
      student_id: tc.student_id,
      course: tc.course,
      exam_days: tc.exam_days,
      hours_per_day: tc.hours_per_day,
      metrics,
      total_score: total,
      ...(error ? { error } : {}),
    });
  }

  // ─── Print summary ─────────────────────────────────────────────────────────

  console.log(`\n${BAR}`);
  console.log(" EVAL RESULTS");
  console.log(BAR);

  for (const result of results) {
    const tc = testCases.find((t) => t.id === result.id)!;
    printCaseResult(tc, result);
  }

  const aggregate = results.reduce((s, r) => s + r.total_score, 0) / results.length;

  console.log(BAR);
  console.log(` AGGREGATE SCORE: ${aggregate.toFixed(2)} / 5.00`);
  console.log(BAR + "\n");

  // ─── Save results ──────────────────────────────────────────────────────────

  await mkdir("output", { recursive: true });
  const outputPath = join("output", "eval_results.json");
  await writeFile(
    outputPath,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        aggregate_score: parseFloat(aggregate.toFixed(2)),
        max_score_per_case: 5.0,
        num_cases: results.length,
        cases: results,
      },
      null,
      2
    ),
    "utf8"
  );

  console.log(`Results saved to ${outputPath}`);
}

// ─── Entry point ──────────────────────────────────────────────────────────────

if (import.meta.main) {
  runEval().catch((err) => {
    console.error(`[FATAL] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
