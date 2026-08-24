import type { AnalyzerLeadVerifyOverrides } from "../phases/closeVerifyAnalyzerLeads.js";

export interface OrchestratorOptions {
  root: string;
  artifactsDir: string;
  input?: string;
  /**
   * Test-only seams for the close-gate analyzer re-verify leg
   * (candidate set / spawn runner / session config). Production passes nothing.
   */
  analyzerLeadVerifyOverrides?: AnalyzerLeadVerifyOverrides;
}
