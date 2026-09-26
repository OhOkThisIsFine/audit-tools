// sites-pinned: tests/remediate/landing-gates-close.test.ts
//   The added seam is test-only wiring for the landing-gate close leg; that
//   suite is what fails if the option stops reaching the leg.
import type { AnalyzerLeadVerifyOverrides } from "../phases/closeVerifyAnalyzerLeads.js";
import type { LandingGateVerifyOverrides } from "../phases/closeVerifyLandingGates.js";
import type { HeadEvidenceOverrides } from "../phases/closeVerifyHeadEvidence.js";
import type { ProjectTestAdmissionOutcome } from "audit-tools/shared";

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
   * Test-only seam for the close-gate landing-gate leg's spawn. Production
   * passes nothing, so every gate goes through the shared admission path.
   */
  landingGateVerifyOverrides?: LandingGateVerifyOverrides;
  /**
   * Test-only seams for the close-gate read-at-HEAD evidence leg: the ref
   * source reader, and the audit-read commit `B` the two-read rule needs.
   * Production passes nothing — no audit artifact records `B`, so a real run
   * withholds every candidate rather than fabricating a verdict.
   */
  headEvidenceOverrides?: HeadEvidenceOverrides;
  /**
   * Test-only seam for the close phase's e2e-leg spawn (see
   * `runE2eTests`). Production passes nothing, so a discovered e2e command goes
   * through the shared admission path (`runAdmittedProjectE2eCommand`) like a
   * discovered test or landing-gate command.
   */
  e2eVerifyOverrides?: {
    run?: (
      command: string[],
      root: string,
      options: { timeoutMs: number },
    ) => Promise<ProjectTestAdmissionOutcome>;
  };
}
