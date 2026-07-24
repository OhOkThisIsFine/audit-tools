// Single source of truth for the "loop-core" path set — the dispatch / admission /
// quota / rolling-engine / orchestrator-step substrate whose changes carry the
// highest blast radius. Two independent tool-enforcement mechanisms consume it:
//
//   • the per-node merged-base GUARD (`acceptNode.ts`) runs the cross-cutting
//     invariant suite when a remediate node's edits touch loop-core paths, and
//   • the pre-commit ADVERSARIAL GATE (`.claude/hooks/pre-commit-gate.mjs`)
//     blocks a hand-authored loop-core commit that lacks a fresh review
//     attestation.
//
// The `.mjs` hook cannot import this TypeScript module (it runs under plain
// node, pre-build), so it re-declares the same pattern list; a parity test
// (`tests/shared/loop-core-paths.test.mjs`) pins the two lists byte-equal so they
// can never drift. Keep the array below the ONE canonical definition — edit here,
// and the parity test forces the hook to follow.
//
// A pattern ending in "/" matches any path under that directory prefix; any other
// pattern matches that exact repo-relative path. Paths are compared with forward
// slashes (win32 backslashes are normalized first), so the set is OS-agnostic.

/**
 * The canonical loop-core pattern list. Directory prefixes end in "/"; every
 * other entry is an exact repo-relative file path. Sorted by content (path-sort)
 * so the serialized order is stable and the parity comparison is order-free-safe.
 */
export const LOOP_CORE_PATTERNS: readonly string[] = [
  // Path-sorted (JS default string order) so the serialized order is stable and
  // the hook-parity comparison is deterministic. Groups, for the reader:
  //   • audit orchestrator step machine + its dispatch drivers
  //   • remediate step machine + its dispatch drivers + risk/pipeline core
  //   • shared dispatch / admission / rolling / quota / engine substrate
  "src/audit/cli/dispatch.ts",
  "src/audit/cli/dispatch/",
  "src/audit/cli/dispatchAttempted.ts",
  "src/audit/cli/mergeAndIngestCommand.ts",
  "src/audit/cli/ownerTokens.ts",
  "src/audit/cli/rollingAuditDispatch.ts",
  "src/audit/orchestrator/",
  "src/remediate/riskSignal.ts",
  "src/remediate/steps/contractPipeline.ts",
  "src/remediate/steps/dispatch/",
  "src/remediate/steps/nextStep.ts",
  "src/remediate/steps/rollingSession.ts",
  "src/shared/dispatch/",
  "src/shared/engine/",
  "src/shared/quota/",
  "src/shared/rolling/",
];

/** Normalize a repo-relative path to forward slashes, no leading "./". */
function normalizeRepoRelPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

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
