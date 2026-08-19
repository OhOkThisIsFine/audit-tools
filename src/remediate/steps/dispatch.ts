// ---------------------------------------------------------------------------
// dispatch.ts — thin barrel
//
// The implementation was split into cohesive sibling modules under
// `./dispatch/` (CP-NODE-7). This file re-exports the modules' public surface so
// consumers that import from `steps/dispatch.js` keep working unchanged. New
// code may import directly from the submodules; the barrel is the aggregate.
// ---------------------------------------------------------------------------

// --- planning-pipeline handoff reader ---
export { readExtractedPlanIfPresent } from "./dispatch/marshal.js";

// --- provider-neutral host workload / result-ingestion boundary ---
export type {
  CurrentRemediationHostState,
  PreparedRemediationHostHandoff,
  RemediationHostIngestSummary,
  RemediationHostWorkItem,
  RemediationHostWorkload,
  UnsupportedRetiredRemediationState,
} from "./dispatch/hostHandoff.js";
export {
  ingestRemediationHostResults,
  prepareRemediationHostHandoff,
  remediationHostResultFilePath,
} from "./dispatch/hostHandoff.js";
