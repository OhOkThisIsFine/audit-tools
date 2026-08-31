/**
 * `quarantineSubmissionFile` must never report a quarantine path over content
 * that never reached it (`docs/backlog/open-bugs.md`).
 *
 * The sibling entry closed the SURVIVING-SOURCE half
 * (`tests/audit/copy-fallback-delete-failure.test.ts`). This is the other half
 * of the same fallback, and it is strictly worse than a misleading record.
 *
 * The fallback runs when `rename` fails: it copies the content to the
 * quarantine path, then unlinks the source. The copy's `catch` was empty —
 * "nothing left to quarantine if even the read failed" — which is true only
 * when the READ failed. A `writeFile` failure (a full disk, or permissions on
 * the quarantine directory) leaves the source perfectly readable, and the
 * unlink below then DELETES it. So the submission is destroyed while the
 * returned `quarantinePath` names a file that was never written, and both the
 * operator's stderr line and the durable `rejected` ledger message point at it.
 *
 * The fault is injected rather than provoked — `rename` and `writeFile` fail,
 * `unlink` is the real one — so this depends on no filesystem quirk and
 * behaves identically on every OS.
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
    // Not a "file missing" error, so the fallback takes the copy path.
    rename: vi.fn(async (from: unknown) => {
      throw errno("EXDEV", `EXDEV: cross-device link not permitted, rename '${String(from)}'`);
    }),
    // The READ succeeds and the WRITE fails: the source is still intact and
    // readable, which is exactly the case the empty catch assumed away.
    writeFile: vi.fn(async (path: unknown) => {
      throw errno("EACCES", `EACCES: permission denied, open '${String(path)}'`);
    }),
    // `unlink` is deliberately REAL. The defect is that it runs at all.
  };
});

const { quarantineSubmissionFile, quarantineSurvivalNote } = await import(
  "../../src/audit/cli/foldTransaction.js"
);
const { GATE_LANES } = await import("../../src/audit/cli/laneSubmissions.js");
const { submissionsDir } = await import("../../src/shared/io/auditToolsPaths.js");
const { mkdir } = await import("node:fs/promises");

const LANE = GATE_LANES.synthesis_narrative;

test("a failed copy neither reports a quarantine path nor destroys the source", async () => {
  const dir = mkdtempSync(join(tmpdir(), "quarantine-copy-"));
  try {
    const artifactsDir = join(dir, "audit");
    await mkdir(submissionsDir(artifactsDir), { recursive: true });
    const sourcePath = join(submissionsDir(artifactsDir), "refused.json");
    writeFileSync(sourcePath, JSON.stringify({ lane: LANE }), "utf8");

    const outcome = await quarantineSubmissionFile(artifactsDir, sourcePath, LANE);

    // The content is the thing being protected. Deleting a submission that was
    // never copied anywhere is data loss, not a bookkeeping error.
    expect(existsSync(sourcePath)).toBe(true);
    // No path is reported, because no file was written to one. A caller cannot
    // put a path into the ledger that names nothing.
    expect(outcome.quarantinePath).toBeNull();
    // And the source therefore survives by construction, not by accident.
    expect(outcome.sourceSurvived).toBe(true);
    // The single home for the wording states the real outcome.
    expect(quarantineSurvivalNote(outcome)).toMatch(/could NOT be copied/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
