// Single source of truth for the "loop-core" path set — the persisted workflow,
// host-handoff, verification, and orchestrator-step substrate whose changes carry
// the highest blast radius. The surviving consumers are the two pre-build
// enforcement hooks:
//
//   • the pre-commit ADVERSARIAL GATE (`.claude/hooks/pre-commit-gate.mjs`)
//     blocks a hand-authored loop-core commit that lacks a fresh review
//     attestation, and
//   • the attestation WRITER (`.claude/hooks/attest-loop-core-review.mjs`)
//     scopes what it binds to the same set.
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
  "src/audit/cli/dispatch.ts",
  "src/audit/cli/dispatch/",
  "src/audit/cli/laneSubmissions.ts",
  "src/audit/cli/laneValidators.ts",
  "src/audit/cli/nextStepHelpers.ts",
  "src/audit/orchestrator/",
  "src/remediate/riskSignal.ts",
  "src/remediate/steps/contractPipeline.ts",
  "src/remediate/steps/dispatch/",
  "src/remediate/steps/nextStep.ts",
  "src/shared/engine/",
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
