import type { AnalyzerLeadVerifyOverrides } from "../phases/closeVerifyAnalyzerLeads.js";
import type { HeadEvidenceOverrides } from "../phases/closeVerifyHeadEvidence.js";

export interface OrchestratorOptions {
  root: string;
  artifactsDir: string;
  input?: string;
  /**
   * Test-only seams for the close-gate analyzer re-verify leg
   * (candidate set / spawn runner / session config). Production passes nothing.
   */
  analyzerLeadVerifyOverrides?: AnalyzerLeadVerifyOverrides;
  /**
   * Test-only seams for the close-gate read-at-HEAD evidence leg: the ref
   * source reader, and the audit-read commit `B` the two-read rule needs.
   * Production passes nothing — no audit artifact records `B`, so a real run
   * withholds every candidate rather than fabricating a verdict.
   */
  headEvidenceOverrides?: HeadEvidenceOverrides;
}
