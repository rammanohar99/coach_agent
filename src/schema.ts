import { z } from "zod";

export const PlanSchema = z.object({
  student_id: z.string(),
  student_name: z.string(),
  course: z.string(),
  exam_days: z.number(),
  hours_per_day: z.number(),
  weak_topics: z.array(z.string()),
  day_plan: z.array(
    z.object({
      day: z.number(),
      topics: z.array(z.string()),
      total_hours: z.number().optional(),
      allocated_hours: z.number().optional(),
      resources: z.array(
        z.object({
          type: z.enum(["video", "article", "practice"]),
          title: z.string(),
          url: z.string(),
          duration_mins: z.number(),
        })
      ),
    })
  ),
});

export type ValidatedPlan = z.infer<typeof PlanSchema>;
