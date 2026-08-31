// Modules reachable ONLY through loop-core that are deliberately NOT in
// `LOOP_CORE_PATTERNS`, each with the reason. Data, not prose: `evaluateClosure`
// reads this list, and `check:loop-core-closure` reds the build both on a module
// missing from it AND on an entry whose condition no longer holds — so the list
// cannot outlive the shape it describes.
//
// This is the state as MEASURED when the closure gate landed (2026-08-30), not a
// judgement that these 25 modules are correctly classified. The gate's purpose is
// forward: any NEW module reachable only through loop-core must be classified
// deliberately, by adding it to the loop-core set or by adding a row here. The
// existing 25 are grandfathered VISIBLY rather than silently — declaring them was
// the owner's choice over widening the set, which would have made every commit
// touching them demand a review attestation.
//
// Retire a row by moving its module into `LOOP_CORE_PATTERNS`, or by giving it a
// consumer outside loop-core. Either way the gate notices.

/** @type {ReadonlyArray<{module: string, reason: string}>} */
export const LOOP_CORE_CLOSURE_EXCLUSIONS = [
  // ── Audit: leaf executors and extractors an orchestrator step calls ────────
  // These are the CONTENT work an orchestrator step dispatches to. They compute
  // and return; they do not persist workflow state, own a write boundary, or
  // decide what happens next — which is what the loop-core set governs.
  { module: "src/audit/clarification/dials.ts", reason: "clarification dial arithmetic; pure, no persisted state" },
  { module: "src/audit/clarification/partition.ts", reason: "clarification partitioning; pure, no persisted state" },
  { module: "src/audit/clarification/riskGate.ts", reason: "clarification risk thresholding; pure, no persisted state" },
  { module: "src/audit/contracts/findingContractPrompt.ts", reason: "prompt text for the finding contract; no state, no write boundary" },
  { module: "src/audit/coverage.ts", reason: "coverage arithmetic over an already-loaded bundle" },
  { module: "src/audit/extractors/analyzers/registry.ts", reason: "re-export of the shared analyzer candidate registry" },
  { module: "src/audit/extractors/bucketing.ts", reason: "unit bucketing; content-derived, no persisted state" },
  { module: "src/audit/extractors/designAssessment.ts", reason: "design-assessment extraction; the executor owns the write" },
  { module: "src/audit/extractors/docsDigest.ts", reason: "docs digest extraction; the executor owns the write" },
  { module: "src/audit/extractors/fsIntake.ts", reason: "filesystem intake extraction; the executor owns the write" },
  { module: "src/audit/extractors/ignore.ts", reason: "ignore-rule parsing; pure" },
  { module: "src/audit/extractors/risk.ts", reason: "risk-signal extraction; the executor owns the write" },
  { module: "src/audit/systemic/systemicChallengeLoop.ts", reason: "systemic-challenge round logic; the executor owns dispatch and persistence" },

  // ── Remediate: contract-pipeline stages and phase bodies ──────────────────
  // Same argument on the remediate draw: `steps/contractPipeline.ts` and
  // `steps/nextStep.ts` are the loop-core boundary, and these are the bodies
  // they call.
  { module: "src/remediate/contractPipeline/cyclicSeamResolution.ts", reason: "seam-cycle resolution; pure over the pipeline's own input" },
  { module: "src/remediate/contractPipeline/phaseCutArtifact.ts", reason: "phase-cut rendering; the pipeline owns the write" },
  { module: "src/remediate/contractPipeline/reviewSnapshot.ts", reason: "review-snapshot shaping; the pipeline owns the write" },
  { module: "src/remediate/contractPipeline/testPlanCarry.ts", reason: "test-plan carry-forward; pure" },
  { module: "src/remediate/findingFilter.ts", reason: "finding filtering; pure" },
  { module: "src/remediate/intent/intentOrdering.ts", reason: "intent ordering; pure" },
  { module: "src/remediate/phases/close.ts", reason: "closing-action bodies; the step machine owns the transition" },
  { module: "src/remediate/phases/triage.ts", reason: "triage decision bodies; the step machine owns the transition" },
  { module: "src/remediate/review/autonomousGate.ts", reason: "autonomous-review gating predicate; pure" },
  { module: "src/remediate/steps/contractPipelinePrompts.ts", reason: "prompt text for the contract pipeline; no state" },
  { module: "src/remediate/steps/intakeResolver.ts", reason: "intake resolution; the step machine owns the transition" },
  { module: "src/remediate/steps/sessionConfigLoad.ts", reason: "session-config load; read-only" },
];

/** @returns {Map<string, string>} module -> reason */
export function declaredExclusions() {
  return new Map(LOOP_CORE_CLOSURE_EXCLUSIONS.map((e) => [e.module, e.reason]));
}
