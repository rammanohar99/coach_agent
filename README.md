# lms-study-coach

An AI study coach that analyses a student's topic scores, builds a personalised day-by-day study plan, and automatically optimises its own system prompt against an eval harness.

---

## Tech stack

| Layer | Choice |
|---|---|
| Runtime | [Bun](https://bun.sh) |
| Language | TypeScript |
| AI SDK | `@anthropic-ai/claude-agent-sdk` (Claude Agent SDK) |
| Model | `claude-haiku-4-5` |

---

## Folder structure

```
lms-study-coach/
├── src/
│   ├── agent.ts        # Agentic loop — runs tools, saves plan
│   ├── eval.ts         # Eval harness — scores plans against 5 metrics
│   ├── optimizer.ts    # Prompt optimizer — iterates system prompt via eval feedback
│   └── tools.ts        # Tool implementations + Anthropic tool definitions
├── data/
│   ├── students.json   # Student topic scores
│   ├── curriculum.json # Topic difficulty levels and prerequisite chains
│   └── resources.json  # Learning resources per topic (video / article / practice)
├── evals/
│   └── test-cases.json # 3 eval test cases with expected behaviours
├── output/             # Generated plans and results (git-ignored except .gitkeep)
│   ├── {student}_plan.json
│   ├── eval_results.json
│   └── optimizer_results.json
└── package.json
```

---

## Setup

### 1. Install Bun

```bash
# macOS / Linux
curl -fsSL https://bun.sh/install | bash

# Windows (PowerShell)
powershell -c "irm bun.sh/install.ps1 | iex"
```

### 2. Install dependencies

```bash
bun install
```

### Prerequisites
- Claude Code CLI installed and authenticated:
```bash
npm install -g @anthropic-ai/claude-code
claude login
```

The Agent SDK uses Claude Code credentials automatically.
No `ANTHROPIC_API_KEY` required.

---

## Running the three commands

### Available scripts
| Script | Command | What it does |
|--------|---------|--------------|
| agent | `bun run agent -- --student <id> --course <name> --exam-days <n> --hours <n>` | Generate a plan for one student |
| eval | `bun run eval` | Run all 3 test cases and score them |
| eval (score only) | `bun run src/eval.ts --score-only` | Score existing plans without re-running agents |
| optimizer | `bun run optimizer` | Run the prompt optimization loop |

### Pillar 1 — Generate a study plan

Runs the agentic loop for one student and saves the plan to `output/{student}_plan.json`.

```bash
bun run src/agent.ts --student ram --course DSA --exam-days 5 --hours 2
```

**Arguments**

| Flag | Description |
|---|---|
| `--student` | Student ID (`ram`, `priya`, `alex`) |
| `--course` | Course name (`DSA`) |
| `--exam-days` | Days until the exam |
| `--hours` | Study hours available per day |

The agent calls tools in sequence — `get_student_data` → `get_curriculum` → `calculate_time_budget` → `get_resources` (per topic) → `save_plan` — then prints a human-readable summary.

---

### Pillar 2 — Run the eval harness

Runs all three test cases, scores each plan against five metrics, and saves results to `output/eval_results.json`.

```bash
bun run src/eval.ts
```

**Baseline result: 5.67 / 6.00 (5 deterministic + 1 LLM judge)** (aggregate across tc-01, tc-02, tc-03)

---

### Pillar 3 — Run the prompt optimizer

Runs up to 5 iterations of automated prompt improvement on a single test case. Each iteration finds the lowest-scoring metric, asks Claude Haiku for a one-sentence improvement, appends it to the system prompt, re-evals, and keeps the change only if the score increases. Results are saved to `output/optimizer_results.json`.

```bash
bun run src/optimizer.ts
```

---

## Eval metrics

Each test case is scored out of 5 (one point per metric):

| Metric | What is checked |
|---|---|
| `weak_topics_covered` | Every topic where the student scored below 60 appears in the plan |
| `strong_topics_excluded` | Topics where the student scored well are not included |
| `prereq_order` | Prerequisite topics are scheduled before the topics that depend on them |
| `hours_within_budget` | Total scheduled resource time does not exceed available study hours |
| `theory_and_practice` | Each weak topic has at least one theory resource (video or article) and one practice resource |
| `plan_quality` | LLM-as-judge scores whether the plan is pedagogically sound — realistic daily workload, correct learning progression, theory and practice balance |

---

## Optimizer results

Optimized against **all 3 test cases** (tc-01 Ram, tc-02 Priya, tc-03 Alex). The aggregate score is the mean of each case's 6-metric total, so the maximum is 6.00.

| | Score (avg across 3 cases) |
|---|---|
| Baseline | 5.67 / 6.00 |
| After optimization | see `output/optimizer_results.json` |

- Each iteration finds the lowest-scoring metric averaged across all cases, asks Claude Haiku for a one-sentence fix, appends it to the system prompt, re-evals, and keeps the change only if the aggregate improves
- Each accepted change was a single sentence targeting the lowest-scoring metric at that iteration

The final optimized prompt is saved in full inside `output/optimizer_results.json` alongside per-iteration scores and the suggestion applied at each step.

> The optimizer's suggestion loop also runs on the Claude Agent SDK —
> no raw API calls anywhere in the codebase.

---

## How the optimizer works

```
baseline prompt
      │
      ▼
  run eval  ──→  aggregate score + per-metric breakdown
      │
      ▼
find lowest metric
      │
      ▼
ask Haiku: "write one sentence to improve <metric>"
      │
      ▼
append sentence → re-run eval
      │
   improved?
   ├── yes → keep, continue
   └── no  → discard, continue
      │
      ▼
stop after 5 iterations or 2 consecutive non-improvements
```

## V2 improvements

Addressed after feedback:

- **tc-03 budget corrected** — max_total_hours fixed from 14.0 to 6.0 (2 days × 3 hours). tc-02 budget updated to 10.0 to account for DP as a third weak topic.
- **Optimizer averaging** — scores averaged across RUNS_PER_EVAL runs before accepting a prompt change. Prevents false improvements from LLM non-determinism (scores fluctuate ~0.33 per run).
- **Refiner LLM** — optimizer now passes current prompt + suggestion to a Haiku rewrite call that produces a single clean document. No more blindly appended sentences.
- **Parse error telemetry** — Zod validation failures and JSON parse errors surface in a separate parse_error field. Optimizer can distinguish structural failures from content quality failures.
- **calculate_time_budget wired in** — system prompt now explicitly instructs the agent to use the allocations array from calculate_time_budget when building the day plan.
- **Zod schema enforcement** — save_plan validates the plan against PlanSchema before writing to disk. Schema violations return a structured error to the model for self-correction.
- **package.json scripts fixed** — removed dangling src/index.ts reference.
- **LLM-as-judge metric** — added as metric 6. The break test revealed that 5/5 deterministic scores were masking pedagogically poor plans. The judge correctly identifies tc-03 as a hard constraint — 5 weak topics in 2 days cannot produce a sound plan regardless of prompt quality. The optimizer detects this ceiling and stops early.

## Known limitations

**Agent stop-on-error is advisory, not enforced**
The system prompt instructs the agent to stop immediately on any tool error. In practice the model sometimes calls one additional tool before stopping — for example calling `get_curriculum` after `get_student_data` fails for an invalid student ID. The correct fix is a code-level guard in `runAgent` that checks the last tool result before the next model call. This does not affect normal usage since all three test case students exist in the data.

**calculate_time_budget with empty weak_topics**
If called with `weak_topics=[]`, the function returns allocations for all 5 topics with `is_weak: false` rather than returning an empty array. The agent never hits this case in practice because it always identifies at least one weak topic from the test data. The behavior should either be corrected or documented in the function signature.
