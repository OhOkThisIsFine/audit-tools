import { z } from "zod";

export const StepStatusSchema = z.enum(["ready", "blocked", "complete"]);
export type StepStatus = z.infer<typeof StepStatusSchema>;
