/**
 * The artifact-tree lock has ONE acquisition surface, and that surface carries
 * the widened waiter window.
 *
 * Owner decision (2026-08-29, from the CX-02 live measurement —
 * `docs/reviews/cx02-hold-time-measurement-2026-08-29.md`): frontier folds
 * legitimately hold this lock 22–58.5 s, so waiters get
 * `ARTIFACT_TREE_LOCK_TIMEOUT_MS` (≥ 120 s) instead of the 10 s `withFileLock`
 * default — WAITER-SIDE ONLY (the 30 s stale window and heartbeat are pinned
 * elsewhere and untouched). The window can only be guaranteed if every
 * acquisition goes through `withArtifactTreeHold`, so this test pins:
 *
 * 1. `artifactTreeLockPath` is REFERENCED only by its definition module, the
 *    shared re-export barrel, and `auditStep.ts` (the wrapper) — a new direct
 *    `withFileLock(artifactTreeLockPath(...))` call site anywhere else is red.
 * 2. `withArtifactTreeHold` passes `ARTIFACT_TREE_LOCK_TIMEOUT_MS` to
 *    `withFileLock`.
 * 3. The constant is at least 120_000 ms.
 */
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { test, expect } from "vitest";

import { ARTIFACT_TREE_LOCK_TIMEOUT_MS } from "../../src/audit/cli/auditStep.js";

const ROOT = process.cwd();

/** Files allowed to reference `artifactTreeLockPath` at all. */
const ALLOWED_REFERENCING_FILES = new Set([
  "src/shared/io/auditToolsPaths.ts", // the definition
  "src/shared/index.ts", // the re-export barrel
  "src/audit/cli/auditStep.ts", // the ONE acquisition surface
]);

function trackedSourceFilesReferencing(needle: string): string[] {
  const listing = execFileSync("git", ["grep", "-l", needle, "--", "src"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return listing
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => line.replaceAll("\\", "/"));
}

test("artifactTreeLockPath is referenced only by its definition, the barrel, and the one acquisition surface", () => {
  const referencing = trackedSourceFilesReferencing("artifactTreeLockPath");
  const offenders = referencing.filter(
    (file) => !ALLOWED_REFERENCING_FILES.has(file),
  );
  expect(offenders).toEqual([]);
});

test("withArtifactTreeHold passes the widened waiter window to withFileLock", async () => {
  const source = await readFile(
    join(ROOT, "src", "audit", "cli", "auditStep.ts"),
    "utf8",
  );
  const holdBody = source.slice(source.indexOf("export async function withArtifactTreeHold"));
  const call = holdBody.match(/withFileLock\(([\s\S]*?)\);/);
  expect(call).not.toBeNull();
  expect(call![1]).toContain("ARTIFACT_TREE_LOCK_TIMEOUT_MS");
});

test("the artifact-tree waiter window is at least 120s", () => {
  expect(ARTIFACT_TREE_LOCK_TIMEOUT_MS).toBeGreaterThanOrEqual(120_000);
});
