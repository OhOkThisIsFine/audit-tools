export type StepStatus = "ready" | "blocked" | "complete";

export type DispatchModelTier = "small" | "standard" | "deep";

export interface DispatchModelHint {
  tier: DispatchModelTier;
  reasons: string[];
}
