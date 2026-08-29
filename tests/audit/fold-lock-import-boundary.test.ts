/**
 * CX-02 landing 1's import-boundary rule, stated as a fail-closed mechanism.
 *
 * The `next-step` fold holds the artifact-tree lock for its whole drain, and
 * `withFileLock` is non-reentrant — so ANY path from a fold `execute` back to
 * the lock is a deterministic `FileLockTimeoutError`. A static reachability
 * test over dynamic dispatch cannot prove absence (the engine calls
 * `def.execute`, gates call injected callbacks), so the record replaces it
 * with two fail-closed halves:
 *
 * 1. THIS test — `nextStepHelpers.ts` may not IMPORT the locking surface at
 *    all: `withFileLock`, `artifactTreeLockPath`, the locking `runAuditStep`,
 *    the locking `ensureSemanticReviewRun`, or `writeCoreArtifacts` (the
 *    fold's one core write lives in `commitFold`). Only the lock-free cores
 *    (`runAuditStepUnlocked`, `ensureSemanticReviewRunUnlocked`) and the
 *    sanctioned hold wrapper (`withArtifactTreeHold`) may appear.
 * 2. The DYNAMIC half — `one-lock-hold-per-next-step.test.ts` counts real
 *    acquisitions across a real fold and demands exactly one.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test, expect } from "vitest";

const HELPERS_PATH = join(
  process.cwd(),
  "src",
  "audit",
  "cli",
  "nextStepHelpers.ts",
);

/** Names that must never appear in an import clause of the fold module. */
const BANNED_IMPORTS = [
  "withFileLock",
  "artifactTreeLockPath",
  "runAuditStep",
  "ensureSemanticReviewRun",
  "writeCoreArtifacts",
] as const;

/** Extract every import clause (`import { ... } from "..."`) as one string. */
function importClauses(source: string): string {
  const clauses = source.match(/import[\s\S]*?from\s+"[^"]+";/g) ?? [];
  return clauses.join("\n");
}

test("nextStepHelpers.ts imports no locking surface (CX-02 import boundary)", async () => {
  const source = await readFile(HELPERS_PATH, "utf8");
  const clauses = importClauses(source);
  for (const banned of BANNED_IMPORTS) {
    // Word-boundary match that does not swallow the sanctioned Unlocked
    // variants: `runAuditStepUnlocked` must not satisfy a `runAuditStep` hit.
    const pattern = new RegExp(`\\b${banned}\\b(?!Unlocked)`, "g");
    const hits = clauses.match(pattern) ?? [];
    expect(
      hits,
      `nextStepHelpers.ts imports "${banned}" — the fold holds the one artifact-tree lock, so the locking surface is banned from this module (use the lock-free cores / withArtifactTreeHold / commitFold)`,
    ).toEqual([]);
  }
});

test("the sanctioned lock entry is present, so the boundary bans the surface, not the fold", async () => {
  const source = await readFile(HELPERS_PATH, "utf8");
  expect(importClauses(source)).toMatch(/\bwithArtifactTreeHold\b/);
});
