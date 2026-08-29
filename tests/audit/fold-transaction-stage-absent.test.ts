/**
 * Regression guard for the CI-red EACCES bug (audit-cli-invariants.test.ts,
 * INV-audit-cli-08): `stageLaneSubmission` used to unconditionally `mkdir` the
 * `submission-staging/` directory BEFORE checking whether the lane's bound
 * path even holds a submission. Every omittable gate (`runOmittableGate`,
 * `handleGraphEnrichmentBranch`, ...) polls by trying to consume FIRST — the
 * ordinary, most-common outcome of that poll is "nothing is there" — so that
 * mkdir fires on essentially every `next-step` call whether or not a host
 * submission is waiting.
 *
 * On this dev box `mkdir` at an absent path harmlessly succeeds (or the
 * artifactsDir already exists), which is why the bug never showed up locally.
 * On Linux CI, a test exercising a synthetic non-existent artifactsDir
 * (`/nonexistent-dir-abc`) hit `EACCES: permission denied, mkdir
 * '/nonexistent-dir-abc'` because `mkdir(..., {recursive:true})` had to reach
 * up to the filesystem root to create it — a permission failure with nothing
 * OS-specific about the underlying defect: the mkdir simply had no work to do,
 * since there was never a bound submission to stage.
 *
 * This test reproduces the SAME shape of failure — a `mkdir` on the staging
 * directory failing when there is nothing bound to stage — independent of any
 * real filesystem permission quirk, so it fails identically on every OS. Run
 * against the pre-fix `stageLaneSubmission` (mkdir called unconditionally
 * before the bound-path check), it throws the mocked EACCES instead of
 * resolving `{status:"absent"}` — confirmed red before the fix landed.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect, vi } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    mkdir: vi.fn(async (path: unknown) => {
      const error = new Error(
        `EACCES: permission denied, mkdir '${String(path)}'`,
      ) as NodeJS.ErrnoException;
      error.code = "EACCES";
      throw error;
    }),
  };
});

const { createFoldTransaction, stageLaneSubmission } = await import(
  "../../src/audit/cli/foldTransaction.js"
);
const { GATE_LANES } = await import("../../src/audit/cli/laneSubmissions.js");
const { mkdir: mockedMkdir } = await import("node:fs/promises");

test("stageLaneSubmission reports absent — without ever calling mkdir — when nothing is bound to stage", async () => {
  const artifactsDir = mkdtempSync(join(tmpdir(), "stage-absent-"));
  try {
    const tx = createFoldTransaction();
    // No submission ever written at the bound path: the ordinary "poll found
    // nothing" outcome every omittable gate hits on most turns. Forcing every
    // `mkdir` to fail proves the poll never needs to create the staging
    // directory when there is nothing to move into it.
    const result = await stageLaneSubmission(
      tx,
      artifactsDir,
      GATE_LANES.synthesis_narrative,
    );
    expect(result.status).toBe("absent");
    expect(mockedMkdir).not.toHaveBeenCalled();
  } finally {
    rmSync(artifactsDir, { recursive: true, force: true });
  }
});
