import { z } from "zod";

export const StepStatusSchema = z.enum(["ready", "blocked", "complete"]);
export type StepStatus = z.infer<typeof StepStatusSchema>;

export const DispatchModelTierSchema = z.enum(["small", "standard", "deep"]);
export type DispatchModelTier = z.infer<typeof DispatchModelTierSchema>;

export interface DispatchModelHint {
  tier: DispatchModelTier;
  reasons: string[];
}
