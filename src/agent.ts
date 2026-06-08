import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  get_student_data,
  get_curriculum,
  get_resources,
  calculate_time_budget,
  save_plan,
} from "./tools";
import { PlanSchema } from "./schema";

const MODEL = "claude-haiku-4-5";

// ─── System prompt ────────────────────────────────────────────────────────────

export const SYSTEM_PROMPT = `
You are a personalized study coach for computer science students. Your goal is to analyze a student's knowledge gaps and produce a targeted, day-by-day study plan.

Complete ALL of the following steps in order using the available tools:

1. Call get_student_data to retrieve the student's current scores.
2. Identify ALL topics where the student's score is strictly less than 60 as weak topics. Do not skip any topic below 60 regardless of whether it has prerequisites or is considered foundational.
3. Call get_curriculum to understand topic difficulty levels and prerequisite chains.
4. Resolve prerequisite order for weak topics:
   - If a weak topic has a prerequisite that is also weak, the prerequisite must be studied first.
   - Build a correctly ordered list (most foundational first).
5. Call calculate_time_budget with the exam timeline and the ordered weak topic list.
   - Read the returned allocations array carefully — each entry has { topic, hours, minutes, priority }.
   - Record these allocations. You will use the hours values directly in step 7; do not invent your own hour values.
6. For each weak topic (in order), call get_resources to gather learning materials.
7. Assemble a day-by-day study plan. Each day must:
   - Assign hours to each topic STRICTLY using the hours values from the calculate_time_budget allocations — do not invent your own hour allocations.
   - Distribute topics across days so each day stays within the hours-per-day limit, drawing from the allocated hours.
   - List concrete resources (title, type, estimated duration) for that day.
   - When building the day plan, the sum of all resource duration_mins across ALL days converted to hours MUST NOT exceed exam_days × hours_per_day. If resources exceed the budget, select only the highest-priority resources (video first, then article, then practice) until the total fits within budget.
8. Call save_plan with the student_id and the complete plan object containing:
   - student info (id, name, course)
   - weak_topics list
   - time_budget allocations
   - day_plan array (one entry per day, each with topic, hours, and resources)
9. After saving, print a concise human-readable summary that includes:
   - Student name and weak topics found
   - Total available study hours
   - Day-by-day topic overview (e.g. "Day 1: LinkedList — 2.4h")
   - The file path where the plan was saved

Critical rules:
- Always respect prerequisite order. If Trees requires LinkedList and both are weak, LinkedList must come before Trees.
- For every weak topic, you MUST include at least one practice resource (type: practice) in the day plan, even if it means reducing the duration_mins of other resources to fit within the budget. Theory without practice is incomplete.
- Do not stop until all 9 steps are complete and the plan is saved.
- If any tool returns an error, immediately output a one-sentence explanation of what failed and stop — do not call any more tools, do not correct the input, do not retry with different arguments.

OUTPUT FORMAT RULE — MANDATORY:
Call save_plan with exactly this structure, no variations:
{
  student_id: string,
  student_name: string,
  course: string,
  exam_days: number,
  hours_per_day: number,
  weak_topics: string[],  // flat string array always
  day_plan: [{
    day: number,
    topics: string[],         // flat string array always
    total_hours: number,
    allocated_hours: number,  // sum of calculate_time_budget hours for the topics on this day
    resources: [{             // always at day level, never nested
      title: string,
      type: video|article|practice,
      duration_mins: number,
      url: string
    }]
  }]
}
Never use sessions, topics_covered, or nested topic objects.
`.trim();

// ─── Logging helpers ──────────────────────────────────────────────────────────

function logTool(name: string, input: unknown) {
  console.log(`[TOOL]   ${name} → ${JSON.stringify(input)}`);
}

function logResult(result: unknown) {
  const str = JSON.stringify(result);
  const preview = str.length > 400 ? str.slice(0, 400) + " …" : str;
  console.log(`[RESULT] ${preview}`);
}

function logError(message: string) {
  console.log(`[ERROR]  ${message}`);
}

// PlanSchema is imported from ./schema — see src/schema.ts for the definition.

// ─── In-process MCP server ────────────────────────────────────────────────────
//
// The Claude Agent SDK routes custom tools through MCP (Model Context Protocol).
// createSdkMcpServer() + tool() build an in-process server that the SDK
// connects to automatically — no external process required.
//
// Each tool wraps the corresponding implementation from tools.ts.
// [TOOL] / [RESULT] logs fire here, so progress is visible during the run.
//
// The SDK feeds each tool result back to the model automatically, so there is
// no manual dispatch loop — the for-await in runAgent() only needs to handle
// the text output.

const studyCoachServer = createSdkMcpServer({
  name: "study_coach",
  alwaysLoad: true,
  tools: [
    tool(
      "get_student_data",
      "Retrieve a student's current scores for every topic in a given course. Call this first to understand where the student currently stands before building a plan.",
      {
        student_id: z.string().describe("Unique student identifier (e.g. 'ram', 'priya', 'alex')."),
        course: z.string().describe("Course name to retrieve scores for (e.g. 'DSA')."),
      },
      async ({ student_id, course }) => {
        logTool("get_student_data", { student_id, course });
        try {
          const result = await get_student_data(student_id, course);
          logResult(result);
          return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logError(msg);
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: msg }) }], isError: true };
        }
      }
    ),

    tool(
      "get_curriculum",
      "Retrieve the full curriculum for a course — all topics with difficulty levels (1–5) and prerequisite chains. Use this to understand topic ordering and complexity.",
      {
        course: z.string().describe("Course name (e.g. 'DSA')."),
      },
      async ({ course }) => {
        logTool("get_curriculum", { course });
        try {
          const result = await get_curriculum(course);
          logResult(result);
          return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logError(msg);
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: msg }) }], isError: true };
        }
      }
    ),

    tool(
      "get_resources",
      "Get available learning resources (videos, articles, practice sets) for a specific topic. Returns an empty array if no resources exist for the topic.",
      {
        topic: z.string().describe("Topic name to fetch resources for (e.g. 'Arrays', 'DP', 'Trees')."),
      },
      async ({ topic }) => {
        logTool("get_resources", { topic });
        try {
          const result = await get_resources(topic);
          logResult(result);
          return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logError(msg);
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: msg }) }], isError: true };
        }
      }
    ),

    tool(
      "calculate_time_budget",
      "Calculate per-topic study hour allocations given exam timeline and the student's weak areas. Weak topics and higher-difficulty topics receive proportionally more time.",
      {
        exam_days: z.number().describe("Number of days remaining until the exam."),
        hours_per_day: z.number().describe("Hours the student can dedicate to studying each day."),
        weak_topics: z
          .array(z.string())
          .describe("Topic names where the student scored below threshold (e.g. ['LinkedList', 'Trees', 'DP'])."),
      },
      async ({ exam_days, hours_per_day, weak_topics }) => {
        logTool("calculate_time_budget", { exam_days, hours_per_day, weak_topics });
        try {
          const result = calculate_time_budget(exam_days, hours_per_day, weak_topics);
          logResult(result);
          return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logError(msg);
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: msg }) }], isError: true };
        }
      }
    ),

    tool(
      "save_plan",
      "Persist the completed study plan as a JSON file under output/{student_id}_plan.json. Call this once the full plan has been assembled.",
      {
        student_id: z.string().describe("Student identifier — used as the output filename prefix."),
        plan: z
          .record(z.string(), z.unknown())
          .describe("The complete study plan object to serialize and save."),
      },
      async ({ student_id, plan }) => {
        logTool("save_plan", { student_id, plan });
        const parsed = PlanSchema.safeParse(plan);
        if (!parsed.success) {
          const details = parsed.error.format();
          console.log(`[SCHEMA ERROR] ${JSON.stringify(details)}`);
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: "Plan schema validation failed", details }) }],
            isError: true,
          };
        }
        try {
          const result = await save_plan(student_id, parsed.data);
          logResult(result);
          return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logError(msg);
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: msg }) }], isError: true };
        }
      }
    ),
  ],
});

// Auto-allow all study-coach MCP tools so the SDK never pauses to prompt.
const ALLOWED_TOOLS = [
  "mcp__study_coach__get_student_data",
  "mcp__study_coach__get_curriculum",
  "mcp__study_coach__get_resources",
  "mcp__study_coach__calculate_time_budget",
  "mcp__study_coach__save_plan",
];

// ─── Agentic loop ─────────────────────────────────────────────────────────────

export async function runAgent(
  student: string,
  course: string,
  examDays: number,
  hoursPerDay: number,
  systemPrompt: string = SYSTEM_PROMPT
) {
  const prompt =
    `Create a personalized study plan for student "${student}" ` +
    `enrolled in the "${course}" course. ` +
    `They have ${examDays} day(s) until their exam and can study ${hoursPerDay} hour(s) per day.`;

  console.log(`\n${"─".repeat(62)}`);
  console.log(
    ` Study Coach  |  ${student}  |  ${course}  |  ${examDays}d × ${hoursPerDay}h`
  );
  console.log(`${"─".repeat(62)}\n`);

  // query() returns an AsyncGenerator<SDKMessage> — the SDK's built-in agentic
  // loop. It spawns a Claude Code subprocess, registers the in-process MCP
  // server, and handles the full tool-use cycle automatically. Each yielded
  // SDKMessage reflects the current state of the conversation.
  //
  // [TOOL] / [RESULT] logs appear during the tool handlers above. Here we only
  // need to surface the model's text output (intermediate reasoning + the
  // final study-plan summary).
  let printedText = false;

  for await (const message of query({
    prompt,
    options: {
      model: MODEL,
      systemPrompt,
      tools: [],                              // disable all built-in Claude Code tools
      allowedTools: ALLOWED_TOOLS,            // auto-approve MCP tool calls
      mcpServers: { study_coach: studyCoachServer },
    },
  })) {
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "text" && block.text) {
          if (!printedText) {
            console.log(`\n${"─".repeat(62)}`);
            printedText = true;
          }
          process.stdout.write(block.text);
        }
      }
    } else if (message.type === "result") {
      if (printedText) {
        console.log(`\n${"─".repeat(62)}\n`);
      }
      if (message.subtype !== "success") {
        console.log(`[WARN]   Run ended with status: ${message.subtype}`);
      }
    }
  }
}

// ─── CLI arg parsing ──────────────────────────────────────────────────────────

function parseArgs() {
  const argv = process.argv.slice(2);

  const get = (flag: string): string | undefined => {
    const idx = argv.indexOf(`--${flag}`);
    return idx !== -1 ? argv[idx + 1] : undefined;
  };

  const student = get("student");
  const course = get("course");
  const examDaysRaw = get("exam-days");
  const hoursRaw = get("hours");

  if (!student || !course || !examDaysRaw || !hoursRaw) {
    console.error("Usage:");
    console.error(
      "  bun run src/agent.ts --student <id> --course <name> --exam-days <n> --hours <n>"
    );
    console.error("\nExample:");
    console.error(
      "  bun run src/agent.ts --student ram --course DSA --exam-days 7 --hours 3"
    );
    process.exit(1);
  }

  const examDays = Number(examDaysRaw);
  const hoursPerDay = Number(hoursRaw);

  if (!Number.isFinite(examDays) || examDays < 1 || examDays > 365) {
    console.error("--exam-days must be a positive integer between 1 and 365");
    process.exit(1);
  }
  if (!Number.isFinite(hoursPerDay) || hoursPerDay <= 0 || hoursPerDay > 24) {
    console.error("--hours must be a positive number between 0 and 24");
    process.exit(1);
  }

  return { student, course, examDays, hoursPerDay };
}

// ─── Entry point ──────────────────────────────────────────────────────────────

if (import.meta.main) {
  const { student, course, examDays, hoursPerDay } = parseArgs();

  runAgent(student, course, examDays, hoursPerDay).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\n[FATAL]  ${message}`);
    process.exit(1);
  });
}
