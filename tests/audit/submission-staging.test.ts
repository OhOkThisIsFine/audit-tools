/**
 * CX-02 landing 3 — durable submission STAGING, the decided replacement for
 * unlink deferral (which was refuted: a deferred deletion creates a
 * re-consumption path, and a re-consumed systemic-challenge round reports a
 * quiet round and converges the adversary loop falsely and permanently).
 *
 * The mechanics under test:
 *  - consumption RENAMES the bound file into `submission-staging/` before
 *    anything parses or applies it;
 *  - an APPLIED staged file is deleted at the commit, WITH its deferred
 *    `accepted` ledger event;
 *  - an UN-applied staged file (the fold threw before the apply landed) is
 *    RESTORED to its bound path at the commit;
 *  - the fold-start recovery sweep restores a crashed fold's staged file, and
 *    quarantines it instead when the host has meanwhile resubmitted;
 *  - the duplicate window (death between core commit and staged cleanup) is
 *    closed by the iterative-fold register: a systemic-challenge submission
 *    whose content hash the register already folded is IGNORED — never
 *    counted as a quiet round.
 */
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { test, expect } from "vitest";

import {
  commitFold,
  createFoldTransaction,
  markSubmissionApplied,
  recoverStagedSubmissions,
  stageLaneSubmission,
  submissionStagingDir,
} from "../../src/audit/cli/foldTransaction.js";
import {
  GATE_LANES,
  laneSubmissionPath,
} from "../../src/audit/cli/laneSubmissions.js";
import { submissionsDir } from "../../src/shared/io/auditToolsPaths.js";
import { readSubmissionLedger } from "../../src/shared/submission/submissionLedger.js";
import { runSystemicChallengeExecutor } from "../../src/audit/orchestrator/systemicChallengeExecutor.js";
import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";

async function withArtifactsDir(
  fn: (artifactsDir: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "staging-test-"));
  try {
    const artifactsDir = join(dir, "audit");
    await mkdir(submissionsDir(artifactsDir), { recursive: true });
    await fn(artifactsDir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const LANE = GATE_LANES.synthesis_narrative;

test("staging moves the bound file before anything parses it, and hashes its content", async () => {
  await withArtifactsDir(async (artifactsDir) => {
    const bound = laneSubmissionPath(artifactsDir, LANE);
    await writeFile(bound, JSON.stringify({ themes: [] }), "utf8");

    const tx = createFoldTransaction();
    const staged = await stageLaneSubmission(tx, artifactsDir, LANE);
    expect(staged.status).toBe("staged");
    if (staged.status !== "staged") throw new Error("expected staged");

    await expect(readFile(bound, "utf8")).rejects.toThrow();
    expect(await readFile(staged.staged.stagingPath, "utf8")).toContain("themes");
    expect(staged.staged.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(staged.staged.applied).toBe(false);
  });
});

test("commit deletes an APPLIED staged submission and records its accepted event only then", async () => {
  await withArtifactsDir(async (artifactsDir) => {
    const bound = laneSubmissionPath(artifactsDir, LANE);
    await writeFile(bound, JSON.stringify({ themes: [] }), "utf8");

    const tx = createFoldTransaction();
    const staged = await stageLaneSubmission(tx, artifactsDir, LANE);
    if (staged.status !== "staged") throw new Error("expected staged");
    markSubmissionApplied(tx, staged.staged.stagingPath, "with a note");

    // Before the commit: no accepted event exists (a crash here replays with
    // the submission restored and the ledger silent — never a double record).
    const before = (await readSubmissionLedger(artifactsDir)).filter(
      (e) => e.kind === "accepted",
    );
    expect(before).toEqual([]);

    await commitFold(artifactsDir, {}, tx);

    await expect(readFile(staged.staged.stagingPath, "utf8")).rejects.toThrow();
    await expect(readFile(bound, "utf8")).rejects.toThrow();
    const accepted = (await readSubmissionLedger(artifactsDir)).filter(
      (e) => e.kind === "accepted",
    );
    expect(accepted).toHaveLength(1);
    expect(accepted[0]!.message).toBe("with a note");
  });
});

test("commit RESTORES an un-applied staged submission to its bound path (the throw-before-apply retry)", async () => {
  await withArtifactsDir(async (artifactsDir) => {
    const bound = laneSubmissionPath(artifactsDir, LANE);
    await writeFile(bound, JSON.stringify({ themes: ["kept"] }), "utf8");

    const tx = createFoldTransaction();
    const staged = await stageLaneSubmission(tx, artifactsDir, LANE);
    if (staged.status !== "staged") throw new Error("expected staged");
    // No markSubmissionApplied: the fold threw before the apply landed.

    await commitFold(artifactsDir, {}, tx);

    expect(JSON.parse(await readFile(bound, "utf8"))).toEqual({ themes: ["kept"] });
    const events = (await readSubmissionLedger(artifactsDir)).filter(
      (e) => e.kind !== "expected",
    );
    expect(events, "a restored submission leaves no outcome event").toEqual([]);
  });
});

test("the recovery sweep restores a crashed fold's staged file when the bound path is free", async () => {
  await withArtifactsDir(async (artifactsDir) => {
    const bound = laneSubmissionPath(artifactsDir, LANE);
    await writeFile(bound, JSON.stringify({ themes: ["crashed"] }), "utf8");
    const tx = createFoldTransaction();
    await stageLaneSubmission(tx, artifactsDir, LANE);
    // The process dies here: no commit ever runs; tx is lost.

    await recoverStagedSubmissions(artifactsDir);

    expect(JSON.parse(await readFile(bound, "utf8"))).toEqual({ themes: ["crashed"] });
    expect(
      await readdir(submissionStagingDir(artifactsDir)).catch(() => []),
    ).toEqual([]);
  });
});

test("the recovery sweep quarantines the staged copy when the host has resubmitted over the bound path", async () => {
  await withArtifactsDir(async (artifactsDir) => {
    const bound = laneSubmissionPath(artifactsDir, LANE);
    await writeFile(bound, JSON.stringify({ themes: ["old"] }), "utf8");
    const tx = createFoldTransaction();
    await stageLaneSubmission(tx, artifactsDir, LANE);
    // The host resubmits while the crashed fold's copy is still staged.
    await writeFile(bound, JSON.stringify({ themes: ["newer"] }), "utf8");

    await recoverStagedSubmissions(artifactsDir);

    // The newer submission wins the bound path; the staged copy is preserved
    // under quarantine (never silently discarded), with a rejected event.
    expect(JSON.parse(await readFile(bound, "utf8"))).toEqual({ themes: ["newer"] });
    const quarantined = await readdir(join(artifactsDir, "quarantine"));
    expect(quarantined.some((name) => name.startsWith(`${LANE}.`))).toBe(true);
    const rejected = (await readSubmissionLedger(artifactsDir)).filter(
      (e) => e.kind === "rejected",
    );
    expect(rejected).toHaveLength(1);
  });
});

test("a re-entered commit RESUMES: an entry the first attempt processed is never re-recorded", async () => {
  await withArtifactsDir(async (artifactsDir) => {
    const acceptedLane = GATE_LANES.synthesis_narrative;
    const restoredLane = GATE_LANES.charter_delta;
    await writeFile(
      laneSubmissionPath(artifactsDir, acceptedLane),
      JSON.stringify({ themes: [] }),
      "utf8",
    );
    const restoredBound = laneSubmissionPath(artifactsDir, restoredLane);
    await writeFile(restoredBound, JSON.stringify({ deltas: ["kept"] }), "utf8");

    const tx = createFoldTransaction();
    const first = await stageLaneSubmission(tx, artifactsDir, acceptedLane);
    if (first.status !== "staged") throw new Error("expected staged");
    markSubmissionApplied(tx, first.staged.stagingPath);
    const second = await stageLaneSubmission(tx, artifactsDir, restoredLane);
    if (second.status !== "staged") throw new Error("expected staged");

    // A directory squatting on the restore destination makes the staged loop
    // throw AFTER the accepted entry was processed — the mid-commit I/O error
    // the catch-path re-commit then runs into.
    await mkdir(restoredBound);
    await expect(commitFold(artifactsDir, {}, tx)).rejects.toThrow();

    await rm(restoredBound, { recursive: true, force: true });
    await commitFold(artifactsDir, {}, tx);

    // The re-entered commit resumed at the failed entry: exactly one accepted
    // event, and the un-applied submission restored for the retry.
    const accepted = (await readSubmissionLedger(artifactsDir)).filter(
      (e) => e.kind === "accepted",
    );
    expect(accepted).toHaveLength(1);
    expect(JSON.parse(await readFile(restoredBound, "utf8"))).toEqual({
      deltas: ["kept"],
    });
  });
});

test("a systemic-challenge round whose hash is already folded is IGNORED — never a quiet round", async () => {
  const bundle: ArtifactBundle = {
    intent_checkpoint: {
      confirmed_at: "now",
      audit_focus: "full",
      ceiling: { rung: "deepest" },
    } as never,
    systemic_challenge: {
      generated_at: "then",
      target: "systemic_challenge",
      ceiling: { rung: "deepest" } as never,
      rounds: [{ round: 1, new_finding_ids: ["SC-1"], dry: false }],
      folded_submission_hashes: ["a".repeat(64)],
      converged: false,
      findings: [],
      validation_issues: [],
    },
  };

  const result = runSystemicChallengeExecutor(
    bundle,
    { findings: [] },
    "a".repeat(64),
  );

  // Not folded: no new round, no dry counting, convergence untouched.
  expect(result.progress_summary).toContain("duplicate");
  expect(result.updated.systemic_challenge?.rounds).toHaveLength(1);
  expect(result.updated.systemic_challenge?.converged).toBe(false);
});
