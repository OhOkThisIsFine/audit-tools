export const FLOW_CONFIDENCE_LEVELS = ["high", "low"] as const;
export type FlowConfidenceLevel = (typeof FLOW_CONFIDENCE_LEVELS)[number];

/** A critical user or system flow that must be covered by the audit. */
export interface CriticalFlow {
  id: string;
  name: string;
  entrypoints: string[];
  paths: string[];
  concerns: string[];
  confidence?: FlowConfidenceLevel;
  notes?: string[];
}

/** The set of critical flows inferred from intake artifacts. */
export interface CriticalFlowManifest {
  flows: CriticalFlow[];
  fallback_required?: boolean;
}
