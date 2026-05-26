export const RUNTIME_VALIDATION_KINDS = [
  "unit-risk-check",
  "critical-flow-check",
] as const;
export type RuntimeValidationKind =
  (typeof RUNTIME_VALIDATION_KINDS)[number];

export const RUNTIME_VALIDATION_PRIORITIES = [
  "high",
  "medium",
  "low",
] as const;
export type RuntimeValidationPriority =
  (typeof RUNTIME_VALIDATION_PRIORITIES)[number];

export const RUNTIME_VALIDATION_STATUSES = [
  "pending",
  "confirmed",
  "not_confirmed",
  "inconclusive",
  "not_required",
] as const;
export type RuntimeValidationStatus =
  (typeof RUNTIME_VALIDATION_STATUSES)[number];

/** A deterministic runtime check queued after static review highlights risk. */
export interface RuntimeValidationTask {
  id: string;
  kind: RuntimeValidationKind;
  target_paths: string[];
  reason: string;
  priority: RuntimeValidationPriority;
  command?: string[];
  suggested_checks?: string[];
  source_artifacts?: string[];
}

/** Planner output for the runtime validation stage. */
export interface RuntimeValidationTaskManifest {
  tasks: RuntimeValidationTask[];
}

/** Result recorded after a runtime validation task runs or is intentionally skipped. */
export interface RuntimeValidationResult {
  task_id: string;
  status: RuntimeValidationStatus;
  summary: string;
  evidence?: string[];
  notes?: string[];
}

/** Persisted runtime validation outcomes keyed by generated task id. */
export interface RuntimeValidationReport {
  results: RuntimeValidationResult[];
}
