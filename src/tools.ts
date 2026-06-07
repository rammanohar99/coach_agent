import { mkdir, writeFile } from "fs/promises";
import { join } from "path";

// ─── Data shape types ────────────────────────────────────────────────────────

interface Student {
  id: string;
  name: string;
  course: string;
  scores: Record<string, number>;
}

interface Topic {
  name: string;
  difficulty: number;
  prerequisites: string[];
}

interface Resource {
  type: "video" | "article" | "practice";
  title: string;
  url: string;
  duration_mins: number;
}

// ─── Tool implementations ────────────────────────────────────────────────────

export async function get_student_data(student_id: string, course: string) {
  const { students } = (await Bun.file("data/students.json").json()) as {
    students: Student[];
  };

  const student = students.find(
    (s: Student) => s.id.toLowerCase() === student_id.toLowerCase()
  );
  if (!student) throw new Error(`Student '${student_id}' not found`);

  if (student.course.toLowerCase() !== course.toLowerCase())
    throw new Error(
      `Student '${student_id}' is enrolled in '${student.course}', not '${course}'`
    );

  return { id: student.id, name: student.name, course: student.course, scores: student.scores };
}

export async function get_curriculum(course: string) {
  const data = (await Bun.file("data/curriculum.json").json()) as {
    course: string;
    topics: Topic[];
  };

  if (data.course.toLowerCase() !== course.toLowerCase())
    throw new Error(`Course '${course}' not found in curriculum`);

  return { course: data.course, topics: data.topics };
}

export async function get_resources(topic: string): Promise<Resource[]> {
  const { resources } = (await Bun.file("data/resources.json").json()) as {
    resources: Record<string, Resource[]>;
  };

  return resources[topic] ?? [];
}

// Hardcoded difficulty map — keeps calculate_time_budget a pure function
const TOPIC_DIFFICULTY: Record<string, number> = {
  Arrays: 1,
  LinkedList: 2,
  Trees: 3,
  Graphs: 4,
  DP: 5,
};
const WEAKNESS_MULTIPLIER = 2.0;

export function calculate_time_budget(
  exam_days: number,
  hours_per_day: number,
  weak_topics: string[]
) {
  const total_hours = exam_days * hours_per_day;
  const weak_set = new Set(weak_topics);
  const all_topics = Object.keys(TOPIC_DIFFICULTY);

  const weighted = all_topics.map((topic) => ({
    topic,
    difficulty: TOPIC_DIFFICULTY[topic],
    is_weak: weak_set.has(topic),
    weight: TOPIC_DIFFICULTY[topic] * (weak_set.has(topic) ? WEAKNESS_MULTIPLIER : 1),
  }));

  const total_weight = weighted.reduce((sum, t) => sum + t.weight, 0);

  const allocations = weighted
    .map(({ topic, difficulty, is_weak, weight }) => {
      const hours = parseFloat(((weight / total_weight) * total_hours).toFixed(2));
      const priority: "high" | "medium" | "low" =
        is_weak || difficulty >= 4 ? "high" : difficulty >= 3 ? "medium" : "low";
      return { topic, hours, minutes: Math.round(hours * 60), is_weak, priority };
    })
    .sort((a, b) => b.hours - a.hours);

  return { total_hours, exam_days, hours_per_day, allocations };
}

export async function save_plan(student_id: string, plan: object) {
  await mkdir("output", { recursive: true });
  const filepath = join("output", `${student_id}_plan.json`);
  await writeFile(filepath, JSON.stringify(plan, null, 2), "utf8");
  return { success: true, message: "Plan saved successfully", file_path: filepath };
}

