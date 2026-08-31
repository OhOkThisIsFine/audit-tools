/**
 * `foldTransaction.ts`'s two copy-then-delete fallbacks must never report
 * success while leaving their source file behind for a later pass to
 * re-process (`docs/backlog/open-bugs.md`).
 *
 * Both fallbacks exist for a cross-device artifacts mount, where `rename`
 * cannot work: they copy the content to the destination, then `unlink` the
 * source. Both used to swallow that `unlink` with `.catch(() => {})`, so an
 * EBUSY/EPERM — an antivirus scan holding the file open on Windows, a
 * permission problem anywhere — left the source in place while the call
 * resolved normally.
 *
 * What that costs, per fallback:
 *  - `moveFile` through `stageLaneSubmission`: the bound file survives beside
 *    its staging copy. The commit then deletes the STAGING copy and records
 *    `accepted`, while the bound original is still there for the next fold to
 *    consume again — a duplicate consumption behind an `accepted` event.
 *  - `quarantineSubmissionFile`: the refused file survives at its source, so
 *    every later pass quarantines it again and appends another `rejected`
 *    event — an unbounded repeat.
 *
 * The sibling instance in `commitFold`'s applied branch was closed first
 * (`tests/audit/submission-staging.test.ts`); these are the same class.
 *
 * The fault is injected rather than provoked: `rename` fails to force the copy
 * fallback, and `unlink` fails to strand the source. Neither depends on a real
 * filesystem quirk, so this test behaves identically on every OS.
 */
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect, vi } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const errno = (code: string, message: string): NodeJS.ErrnoException => {
    const error = new Error(message) as NodeJS.ErrnoException;
    error.code = code;
    return error;
  };
  return {
    ...actual,
    // Not a "file missing" error, so both fallbacks take the copy path.
    rename: vi.fn(async (from: unknown) => {
      throw errno("EXDEV", `EXDEV: cross-device link not permitted, rename '${String(from)}'`);
    }),
    // The copy has already landed by the time this fires: the destination
    // holds the content and only the source deletion fails.
    unlink: vi.fn(async (path: unknown) => {
      throw errno("EBUSY", `EBUSY: resource busy or locked, unlink '${String(path)}'`);
    }),
  };
});

const {
  createFoldTransaction,
  stageLaneSubmission,
  quarantineSubmissionFile,
  quarantineSurvivalNote,
} = await import("../../src/audit/cli/foldTransaction.js");
const { GATE_LANES, laneSubmissionPath } = await import(
  "../../src/audit/cli/laneSubmissions.js"
);
const { submissionsDir } = await import("../../src/shared/io/auditToolsPaths.js");
const { mkdir } = await import("node:fs/promises");

const LANE = GATE_LANES.synthesis_narrative;

async function withArtifactsDir(
  fn: (artifactsDir: string) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "copy-fallback-"));
  try {
    const artifactsDir = join(dir, "audit");
    await mkdir(submissionsDir(artifactsDir), { recursive: true });
    await fn(artifactsDir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("stageLaneSubmission does not report a submission staged while the bound file survives", async () => {
  await withArtifactsDir(async (artifactsDir) => {
    const boundPath = laneSubmissionPath(artifactsDir, LANE);
    writeFileSync(boundPath, JSON.stringify({ lane: LANE }), "utf8");

    const tx = createFoldTransaction();
    // The copy reaches staging, then the source deletion fails. Reporting
    // "staged" here hands the fold a submission it will delete from staging
    // and record `accepted` for, while the bound original waits at its path
    // for the next fold to consume a second time.
    await expect(
      stageLaneSubmission(tx, artifactsDir, LANE),
    ).rejects.toMatchObject({ code: "EBUSY" });

    // The bound file is untouched, so nothing is lost — the fold simply
    // retries. What must not happen is a staged entry recorded over it.
    expect(existsSync(boundPath)).toBe(true);
    expect(tx.staged).toHaveLength(0);
  });
});

test("quarantineSubmissionFile reports that its source survived, rather than a bare path", async () => {
  await withArtifactsDir(async (artifactsDir) => {
    const sourcePath = join(submissionsDir(artifactsDir), "refused.json");
    writeFileSync(sourcePath, JSON.stringify({ lane: LANE }), "utf8");

    // This half takes the RECORD arm, not the throw: every caller awaits the
    // quarantine and THEN records the refusal, so a throw would suppress the
    // event explaining it and leave the file bound for the next fold to fail
    // on identically — a permanent wedge with nothing on the ledger.
    const outcome = await quarantineSubmissionFile(
      artifactsDir,
      sourcePath,
      LANE,
    );

    expect(outcome.sourceSurvived).toBe(true);
    // The source really is still there — the repeat this records is real.
    expect(existsSync(sourcePath)).toBe(true);
    // The wording has one home, and a surviving source is never silent.
    expect(quarantineSurvivalNote(outcome)).toMatch(/could NOT be deleted/);
  });
});

test("quarantineSurvivalNote says nothing when the source was deleted", async () => {
  // The note is additive: a clean quarantine reads exactly as it did before,
  // so this change cannot make every ordinary refusal noisier.
  expect(
    quarantineSurvivalNote({ quarantinePath: "q.json", sourceSurvived: false }),
  ).toBe("");
});
