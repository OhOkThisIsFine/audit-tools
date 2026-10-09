// sites-pinned: tests/shared/loop-core-gate-parity.test.ts, tests/shared/loop-core-closure.test.ts
// Single source of truth for the "loop-core" path set — the persisted workflow,
// host-handoff, verification, and orchestrator-step substrate whose changes carry
// the highest blast radius. The surviving consumers are pre-build enforcement
// scripts:
//
//   • the pre-commit ADVERSARIAL GATE (`.claude/hooks/commit-gate.mjs`)
//     blocks a hand-authored loop-core commit that lacks a fresh review
//     attestation,
//   • the attestation WRITER (`.claude/hooks/attest-loop-core-review.mjs`)
//     scopes what it binds to the same set, and
//   • the tracked attestation LEDGER check
//     (`scripts/check-loop-core-attestations.mjs`, in verify:checks, so CI and
//     the release gate run it) refuses a tree whose loop-core content the
//     ledger does not vouch for — the boundary a squash merge or a hook-less
//     cloud commit cannot skip.
//
// Both run under plain node BEFORE any build, so they cannot import this
// TypeScript module. They import a GENERATED sibling instead
// (`.claude/hooks/loop-core-patterns.mjs`, emitted by
// `scripts/shared/generate-loop-core-patterns.mjs`), which carries the pattern
// list AND the `isLoopCorePath` predicate — so neither the set nor the matching
// semantics has a second hand-maintained home. `npm run check:loop-core-patterns`
// (in verify:checks) fails on a stale generated file, and
// `tests/shared/loop-core-gate-parity.test.ts` pins byte-equality plus
// behavioral parity of the two predicates. Keep the array below the ONE
// canonical definition — edit here, then regenerate.
//
// A pattern ending in "/" matches any path under that directory prefix; any other
// pattern matches that exact repo-relative path. Paths are compared with forward
// slashes (win32 backslashes are normalized first), so the set is OS-agnostic.

import { normalizeRepoRelPath } from "./paths.js";

/**
 * The canonical loop-core pattern list. Directory prefixes end in "/"; every
 * other entry is an exact repo-relative file path. Sorted by content (path-sort)
 * so the serialized order is stable and the parity comparison is order-free-safe.
 */
export const LOOP_CORE_PATTERNS: readonly string[] = [
  // Path-sorted (JS default string order) so the serialized order is stable and
  // the hook-parity comparison is deterministic. Groups, for the reader:
  //   • audit orchestrator step machine + host-handoff boundary + gate ingest
  //     (the lane modules carry the bound-path rule and the lane validators —
  //     the audit draw of the submission core, not a helper beside it)
  //   • remediate step machine + host-handoff/landing + risk/pipeline core
  //   • shared obligation engine + submission core
  // Workload composition (backlog 2026-10-01): `nextStepCommand.ts` and
  // `semanticReviewStep.ts` COMPOSE the step a host is handed, and the prompt
  // and issue-code modules below are reachable only through them (the closure
  // rule claims them). A change to any of these alters what every audit host
  // does next — the same blast radius as the dispatch and orchestrator modules,
  // and the audit counterpart of `src/remediate/steps/prompts.ts`.
  //
  // The gate's own files (owner decision 2026-10-04): this list, its generated
  // twin, the ledger check and the ledger module decide WHAT is attested. An
  // edit that narrows the list or weakens the check would otherwise land with
  // no attestation — a change to what the gate attests is itself attested.
  ".claude/hooks/loop-core-patterns.mjs",
  "scripts/check-loop-core-attestations.mjs",
  "scripts/shared/loopCoreAttestationLedger.mjs",
  "src/audit/cli/charterClarificationPrompt.ts",
  "src/audit/cli/charterExtractionPrompt.ts",
  "src/audit/cli/charterFidelityPrompt.ts",
  "src/audit/cli/conceptualDispatch.ts",
  "src/audit/cli/confirmIntentStep.ts",
  "src/audit/cli/dispatch/",
  "src/audit/cli/fanoutLanes.ts",
  // The fold's staging and commit core. It is here because `quarantineSubmissionFile`
  // MOVED into it out of `nextStepHelpers.ts` (b4a3eb4a, CX-02) — a loop-core path then
  // and now — which took the fold's one core write boundary out of attestation coverage
  // silently. A symbol does not leave this set by being relocated.
  "src/audit/cli/foldTransaction.ts",
  "src/audit/cli/laneSubmissions.ts",
  "src/audit/cli/laneValidators.ts",
  "src/audit/cli/nextStepCommand.ts",
  "src/audit/cli/nextStepHelpers.ts",
  "src/audit/cli/prompts.ts",
  "src/audit/cli/semanticReviewStep.ts",
  "src/audit/io/runSnapshot.ts",
  "src/audit/orchestrator/",
  "src/audit/reporting/criticalFlowFallbackPrompt.ts",
  "src/audit/reporting/synthesisNarrativePrompt.ts",
  "src/audit/systemic/aggregateMetricsDigest.ts",
  "src/audit/systemic/reviewFileMap.ts",
  "src/audit/systemic/secondOrderAdversaryPrompt.ts",
  "src/audit/validation/ingestIssueCodes.ts",
  // Dispatch, result acceptance and closing share this reviewed-authority boundary.
  "src/remediate/contractPipeline/runtimePlanAuthority.ts",
  // Imported ONLY by nextStep.ts, so the closure rule claims it: a module every
  // one of whose importers is core is core. It renders the record of what the
  // intake filter removed, which is a statement about the loop's own decisions.
  "src/remediate/droppedFindingsRecord.ts",
  "src/remediate/intent/intentPersistence.ts",
  "src/remediate/review/filterDispositions.ts",
  "src/remediate/review/reviewGate.ts",
  "src/remediate/review/reviewNecessity.ts",
  "src/remediate/riskSignal.ts",
  "src/remediate/state/runIdentity.ts",
  "src/remediate/steps/contractPipeline.ts",
  "src/remediate/steps/contractPipelinePrompts.ts",
  "src/remediate/steps/dispatch/",
  "src/remediate/steps/frictionCloseout.ts",
  "src/remediate/steps/nextStep.ts",
  "src/remediate/steps/prompts.ts",
  "src/remediate/steps/recoverIngest.ts",
  "src/shared/engine/",
  "src/shared/loopCorePaths.ts",
  // Both host boundaries own this persisted, create-once observation history.
  // Keep its baseline and deduplication semantics under the same review gate.
  "src/shared/observability/rootLogObservations.ts",
  // The host-facing step-contract WRITE-AND-LOG site: `createStepEmissionScaffold`
  // owns the ONE call site that turns a plan into a written, logged step for BOTH
  // orchestrators. It is the boundary every host handoff is emitted through —
  // "written exactly once, logged exactly once" is a property of this module, not
  // of each adopter remembering to do both — so a change here can alter what any
  // host is handed, which is the blast radius this set exists to cover. It was
  // the last emission-path module outside the set.
  "src/shared/steps/",
  "src/shared/submission/",
];

/**
 * Whether a repo-relative path is in the loop-core set. A "/"-terminated pattern
 * matches the directory prefix; any other pattern matches the exact path.
 */
export function isLoopCorePath(path: string): boolean {
  const p = normalizeRepoRelPath(path);
  for (const pattern of LOOP_CORE_PATTERNS) {
    if (pattern.endsWith("/")) {
      if (p.startsWith(pattern)) return true;
    } else if (p === pattern) {
      return true;
    }
  }
  return false;
}
