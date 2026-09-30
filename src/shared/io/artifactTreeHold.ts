// sites-pinned: tests/audit/artifact-tree-lock-single-surface.test.ts, tests/audit/artifact-tree-lock.test.ts
import { artifactTreeLockPath } from "./auditToolsPaths.js";
import { withFileLock } from "./fileLock.js";
import type { RunLogger } from "../observability/runLog.js";

// Measured frontier folds hold this lock for 22–58.5 seconds on a 1,051-file
// repository (docs/reviews/cx02-hold-time-measurement-2026-08-29.md). Widen only
// the waiter window; the stale-lock threshold and live-holder heartbeat remain
// owned by fileLock. Every artifact-tree acquisition uses this one surface.
export const ARTIFACT_TREE_LOCK_TIMEOUT_MS = 120_000;

/** Non-reentrant artifact-tree hold shared by folding, consent and publication. */
export async function withArtifactTreeHold<T>(
  artifactsDir: string,
  runLogger: RunLogger | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  return await withFileLock(
    artifactTreeLockPath(artifactsDir),
    fn,
    ARTIFACT_TREE_LOCK_TIMEOUT_MS,
    runLogger,
  );
}
