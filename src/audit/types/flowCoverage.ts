export const FLOW_COVERAGE_STATUSES = [
  "pending",
  "partial",
  "complete",
] as const;
export type FlowCoverageStatus = (typeof FLOW_COVERAGE_STATUSES)[number];

/** Coverage for one critical flow across the lenses the audit expects to see. */
export interface FlowCoverageRecord {
  flow_id: string;
  paths: string[];
  required_lenses: string[];
  completed_lenses: string[];
  status: FlowCoverageStatus;
  notes?: string[];
}

/** Aggregated flow coverage written beside the critical flow manifest. */
export interface FlowCoverageManifest {
  flows: FlowCoverageRecord[];
}
