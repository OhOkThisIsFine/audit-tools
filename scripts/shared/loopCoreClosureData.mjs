// Modules reachable ONLY through loop-core that are deliberately NOT in
// `LOOP_CORE_PATTERNS`, each with a CHECKED claim and a reason.
//
// Two things are enforced here, and the second is what makes the first mean
// anything:
//
//  1. A module reachable only through loop-core must be classified — in the set,
//     or declared here. `evaluateClosure` reds the build on a missing row AND on
//     a row whose condition no longer holds.
//  2. Each row's `claim` is RE-DERIVED from the module's own source and its
//     in-src transitive import closure (`checkDeclaredClaims`). A claim the
//     source no longer supports is a red build.
//
// WHY (2) EXISTS. The 25 rows this list landed with (2026-08-30) recorded what
// the tree MEASURED that night — not a judgement that each module is correctly
// outside the set — and their `reason` strings were prose the gate could not
// read, so a row stayed green after the shape it described had changed
// underneath it. See `docs/backlog/open-bugs.md`: "a declared exclusion states
// why the module is not core, and that reason has been checked rather than
// inherited from the measurement that created the row."
//
// THE CLAIMS (see `loopCoreClosure.mjs` for the exact predicates):
//   'pure'        neither this module nor anything it reaches imports a node
//                 I/O builtin — it cannot touch the filesystem even indirectly.
//   'reads-only'  I/O is reachable, but this module's own source performs no
//                 mutating filesystem call. It can observe, never change.
//   'mutates'     this module's own source performs a mutating filesystem call,
//                 so the reason below must say what it writes and who owns that
//                 location. This is the only claim whose argument is prose, and
//                 it is prose on purpose: WHICH location a write targets is not
//                 mechanically decidable from source text, and a guess dressed
//                 as a check is worse than a stated half.
//
// Retire a row by moving its module into `LOOP_CORE_PATTERNS`, or by giving it a
// consumer outside loop-core. Either way the gate notices.

/**
 * @typedef {object} ClosureExclusion
 * @property {string} module repo-relative path under src/
 * @property {'pure'|'reads-only'|'mutates'} claim re-derived by checkDeclaredClaims
 * @property {string} reason why this module is NOT loop-core
 */

/** @type {ReadonlyArray<ClosureExclusion>} */
export const LOOP_CORE_CLOSURE_EXCLUSIONS = [
  // ── Audit: leaf executors and extractors an orchestrator step calls ────────
  // These are the CONTENT work an orchestrator step dispatches to. They compute
  // and return; they do not persist workflow state, own a write boundary, or
  // decide what happens next — which is what the loop-core set governs.
  { module: "src/audit/clarification/dials.ts", claim: "pure", reason: "clarification dial arithmetic; pure, no persisted state" },
  { module: "src/audit/clarification/partition.ts", claim: "pure", reason: "clarification partitioning; pure, no persisted state" },
  { module: "src/audit/clarification/riskGate.ts", claim: "pure", reason: "clarification risk thresholding; pure, no persisted state" },
  { module: "src/audit/contracts/findingContractPrompt.ts", claim: "reads-only", reason: "prompt text for the finding contract; the prompt builder reads templates and returns text — no state, no write boundary" },
  { module: "src/audit/coverage.ts", claim: "pure", reason: "coverage arithmetic over an already-loaded bundle" },
  { module: "src/audit/extractors/analyzers/registry.ts", claim: "reads-only", reason: "re-export of the shared analyzer candidate registry; the installed-binary probe reads the disk, and the registry itself persists nothing" },
  { module: "src/audit/extractors/bucketing.ts", claim: "pure", reason: "unit bucketing; content-derived, no persisted state" },
  { module: "src/audit/extractors/designAssessment.ts", claim: "pure", reason: "design-assessment extraction; the executor owns the write" },
  { module: "src/audit/extractors/docsDigest.ts", claim: "reads-only", reason: "docs digest extraction; it reads the docs tree and the executor owns the write" },
  { module: "src/audit/extractors/fsIntake.ts", claim: "reads-only", reason: "filesystem intake extraction; it reads the audited tree and the executor owns the write" },
  { module: "src/audit/extractors/ignore.ts", claim: "reads-only", reason: "ignore-rule parsing; it reads ignore files and returns rules" },
  { module: "src/audit/extractors/risk.ts", claim: "pure", reason: "risk-signal extraction over already-loaded inputs; the executor owns the write" },
  { module: "src/audit/systemic/systemicChallengeLoop.ts", claim: "pure", reason: "systemic-challenge round logic; the executor owns dispatch and persistence" },

  // ── Remediate: contract-pipeline stages and phase bodies ──────────────────
  // Same argument on the remediate draw: `steps/contractPipeline.ts` and
  // `steps/nextStep.ts` are the loop-core boundary, and these are the bodies
  // they call.
  { module: "src/remediate/contractPipeline/cyclicSeamResolution.ts", claim: "pure", reason: "seam-cycle resolution; pure over the pipeline's own input" },
  { module: "src/remediate/contractPipeline/phaseCutArtifact.ts", claim: "reads-only", reason: "phase-cut rendering; it reads pipeline envelopes and returns text — the pipeline owns the write" },
  { module: "src/remediate/contractPipeline/reviewSnapshot.ts", claim: "mutates", reason: "review-snapshot shaping; it WRITES review-snapshots/<name>.json and mkdirs the snapshots dir, but every location derives from an artifactsDir its CALLER supplies (reviewSnapshotDir(artifactsDir)) — it never chooses where, so it holds no write-boundary decision the boundary itself should own" },
  { module: "src/remediate/contractPipeline/testPlanCarry.ts", claim: "mutates", reason: "test-plan carry-forward; it WRITES test-plan-carry.json under the contract-pipeline dir, again derived entirely from a caller-supplied artifactsDir (testPlanCarryPath(artifactsDir)), and it carries state between pipeline stages rather than deciding what the pipeline does next" },
  { module: "src/remediate/findingFilter.ts", claim: "reads-only", reason: "finding filtering; it reads findings input and returns a filter result" },
  { module: "src/remediate/intent/intentOrdering.ts", claim: "pure", reason: "intent ordering; pure" },
  { module: "src/remediate/phases/close.ts", claim: "mutates", reason: "closing-action bodies; it WRITES closing artifacts and removes the artifacts dir on promotion, but the STEP MACHINE owns the transition and the directory — close.ts executes a close it was handed, it does not decide that the run is closing or where its artifacts live (options.artifactsDir is caller-supplied throughout)" },
  { module: "src/remediate/phases/triage.ts", claim: "mutates", reason: "triage decision bodies; it WRITES triage_batch.json / triage-outcome.json and renames quarantined files, all under a caller-supplied options.artifactsDir — the step machine owns the transition and the location" },
  { module: "src/remediate/review/autonomousGate.ts", claim: "pure", reason: "autonomous-review gating predicate; pure" },
  { module: "src/remediate/steps/contractPipelinePrompts.ts", claim: "reads-only", reason: "prompt text for the contract pipeline; the builder reads templates and returns text — no state" },
  { module: "src/remediate/steps/intakeResolver.ts", claim: "reads-only", reason: "intake resolution; it reads intake artifacts and returns the resolution — the step machine owns the transition" },
  { module: "src/remediate/steps/sessionConfigLoad.ts", claim: "pure", reason: "session-config shaping; pure over an already-loaded config — the step machine owns the read and the transition" },
];

/**
 * @returns {Map<string, string>} module -> claim
 */
export function declaredExclusions() {
  return new Map(LOOP_CORE_CLOSURE_EXCLUSIONS.map((e) => [e.module, e.claim]));
}

/**
 * @returns {Map<string, string>} module -> reason, for the gate's report
 */
export function declaredReasons() {
  return new Map(LOOP_CORE_CLOSURE_EXCLUSIONS.map((e) => [e.module, e.reason]));
}
