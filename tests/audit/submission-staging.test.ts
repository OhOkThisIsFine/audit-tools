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
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { test, expect, vi } from "vitest";

const splitMount = vi.hoisted(() => ({ stagingPath: undefined as string | undefined }));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, link: async (from: Parameters<typeof actual.link>[0], to: Parameters<typeof actual.link>[1]) => {
    if (from === splitMount.stagingPath) throw Object.assign(new Error("split mount"), { code: "EXDEV" });
    return actual.link(from, to);
  } };
});

import {
  commitFold,
  createFoldTransaction,
  markSubmissionApplied,
  recoverFoldReceipt,
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
import { loadArtifactBundle, type ArtifactBundle } from "../../src/audit/io/artifacts.js";
import { foldReceiptPath } from "../../src/audit/io/foldReceiptPath.js";
import { cleanupStaleArtifactsDir } from "../../src/audit/cli/cleanup.js";
import { markRunEnded, rollOverFinishedRun } from "../../src/audit/io/rollover.js";

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

test("a FAILED delete of an applied staged file fails the commit — it never records accepted over a surviving file", async () => {
  await withArtifactsDir(async (artifactsDir) => {
    const bound = laneSubmissionPath(artifactsDir, LANE);
    await writeFile(bound, JSON.stringify({ themes: [] }), "utf8");

    const tx = createFoldTransaction();
    const staged = await stageLaneSubmission(tx, artifactsDir, LANE);
    if (staged.status !== "staged") throw new Error("expected staged");
    markSubmissionApplied(tx, staged.staged.stagingPath);

    // A non-empty DIRECTORY at the staging path makes the delete fail with a
    // real, non-ENOENT error on every platform (EPERM/EISDIR) — the honest
    // stand-in for the EBUSY an AV scan produces on Windows. A runtime patch
    // of node:fs would not work: this tree imports fs through NAMED imports.
    await rm(staged.staged.stagingPath, { force: true });
    await mkdir(staged.staged.stagingPath, { recursive: true });
    await writeFile(join(staged.staged.stagingPath, "held"), "x", "utf8");

    // Reject unexpected staging state without acknowledging the submission.
    await expect(commitFold(artifactsDir, {}, tx)).rejects.toThrow();

    const accepted = (await readSubmissionLedger(artifactsDir)).filter(
      (e) => e.kind === "accepted",
    );
    expect(accepted).toEqual([]);
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

test("restoring an un-applied submission retains a different result already in the bound slot", async () => {
  await withArtifactsDir(async (artifactsDir) => {
    const bound = laneSubmissionPath(artifactsDir, LANE);
    const prior = JSON.stringify({ themes: ["first"] });
    const current = JSON.stringify({ themes: ["second"] });
    await writeFile(bound, prior);
    const tx = createFoldTransaction();
    await stageLaneSubmission(tx, artifactsDir, LANE);
    await writeFile(bound, current);

    await commitFold(artifactsDir, {}, tx);
    expect(await readFile(bound, "utf8")).toBe(current);
    expect(await readdir(submissionStagingDir(artifactsDir))).toEqual([]);
    const [saved] = await readdir(join(artifactsDir, "quarantine"));
    expect(await readFile(join(artifactsDir, "quarantine", saved!), "utf8")).toBe(prior);
    const outcomes = (await readSubmissionLedger(artifactsDir)).filter((e) => e.kind !== "expected");
    expect(outcomes.map((e) => e.kind)).toEqual(["rejected"]);
  });
});

test("restoring identical bytes is idempotent and leaves the bound result intact", async () => {
  await withArtifactsDir(async (artifactsDir) => {
    const bound = laneSubmissionPath(artifactsDir, LANE);
    const payload = JSON.stringify({ themes: ["same"] });
    await writeFile(bound, payload);
    const tx = createFoldTransaction();
    await stageLaneSubmission(tx, artifactsDir, LANE);
    await writeFile(bound, payload);

    await recoverStagedSubmissions(artifactsDir);
    await recoverStagedSubmissions(artifactsDir);
    expect(await readFile(bound, "utf8")).toBe(payload);
    expect(await readdir(submissionStagingDir(artifactsDir))).toEqual([]);
    expect((await readSubmissionLedger(artifactsDir)).filter((e) => e.kind !== "expected")).toEqual([]);
  });
});

test.each([false, true])("split mounts publish a complete copy without replacement (occupied: %s)", async (occupied) => {
  await withArtifactsDir(async (artifactsDir) => {
    const bound = laneSubmissionPath(artifactsDir, LANE);
    const stagedBytes = JSON.stringify({ themes: ["staged"] });
    const boundBytes = JSON.stringify({ themes: ["bound"] });
    await writeFile(bound, stagedBytes);
    const tx = createFoldTransaction();
    const staged = await stageLaneSubmission(tx, artifactsDir, LANE);
    if (staged.status !== "staged") throw new Error("expected staged");
    if (occupied) await writeFile(bound, boundBytes);

    splitMount.stagingPath = staged.staged.stagingPath;
    try {
      await commitFold(artifactsDir, {}, tx);
    } finally {
      splitMount.stagingPath = undefined;
    }
    expect(await readFile(bound, "utf8")).toBe(occupied ? boundBytes : stagedBytes);
    expect(await readdir(submissionStagingDir(artifactsDir))).toEqual([]);
    expect((await readdir(submissionsDir(artifactsDir))).filter((file) => file.endsWith(".restore"))).toEqual([]);
  });
});

test("a re-entered commit RESUMES: an entry the first attempt processed is never re-recorded", async () => {
  await withArtifactsDir(async (artifactsDir) => {
    const acceptedLane = GATE_LANES.synthesis_narrative;
    const restoredLane = GATE_LANES.charter_comparison;
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

/**
 * The re-entered-commit window. `commitFold`'s own header states the contract:
 * "the throw path re-runs commitFold on the SAME transaction: a re-entry after a
 * mid-loop I/O error must RESUME at the failed entry, never re-record an
 * `accepted` event the first attempt already appended."
 *
 * The staged entry leaves the register LAST in the applied branch, so the window
 * is real: `recordLaneOutcome` appends the event durably and THEN drops the
 * submission from the expected set, and that second half can throw. The entry is
 * still on `tx.staged`, the event is on the ledger, and the re-entry appends a
 * second identical row — one submission, two `accepted` events.
 *
 * The re-entry state is built EXPLICITLY rather than by injecting an OS fault.
 * What a mid-branch throw leaves behind is exactly: the ledger row present, the
 * staged entry still at the head of the register, the staging file already
 * deleted. That is the state constructed below, so the mechanism under test —
 * `recordLaneOutcome` asking the ledger what already landed — is exercised
 * without depending on a filesystem quirk that behaves differently per platform.
 */
test("a RE-ENTERED commit does not append a second accepted event for the same staged submission", async () => {
  await withArtifactsDir(async (artifactsDir) => {
    const bound = laneSubmissionPath(artifactsDir, LANE);
    await writeFile(bound, JSON.stringify({ themes: [] }), "utf8");

    const tx = createFoldTransaction();
    const staged = await stageLaneSubmission(tx, artifactsDir, LANE);
    if (staged.status !== "staged") throw new Error("expected staged");
    markSubmissionApplied(tx, staged.staged.stagingPath, "with a note");

    await commitFold(artifactsDir, {}, tx);
    const acceptedAfterFirst = (await readSubmissionLedger(artifactsDir)).filter(
      (e) => e.kind === "accepted",
    );
    expect(acceptedAfterFirst).toHaveLength(1);

    // The throw window: the event landed, the entry never left the register.
    tx.staged.push(staged.staged);
    await commitFold(artifactsDir, {}, tx);

    const accepted = (await readSubmissionLedger(artifactsDir)).filter(
      (e) => e.kind === "accepted",
    );
    expect(
      accepted,
      "one staged submission, one accepted event — a re-entry must not double-record it",
    ).toHaveLength(1);
    expect(accepted[0]!.message).toBe("with a note");
  });
});

/**
 * The dedupe question is about HISTORY, not about the last row. An accepted
 * submission can be followed by a rejection — the host resubmits at the bound
 * path after the acceptance was consumed, and the repair fails again — so a
 * recorder that asks only "is the TRAILING event an accepted?" reads the
 * rejection, concludes nothing landed, and appends a SECOND accepted for one
 * staged submission. The state built below is exactly that interleaving; the
 * re-entry is the same explicit construction the test above uses.
 */
test("an accepted already on the ledger suppresses a re-entry even when a REJECTION is the trailing event", async () => {
  await withArtifactsDir(async (artifactsDir) => {
    const { recordLaneOutcome } = await import(
      "../../src/audit/cli/laneSubmissions.js"
    );
    const bound = laneSubmissionPath(artifactsDir, LANE);
    await writeFile(bound, JSON.stringify({ themes: [] }), "utf8");

    const tx = createFoldTransaction();
    const staged = await stageLaneSubmission(tx, artifactsDir, LANE);
    if (staged.status !== "staged") throw new Error("expected staged");
    markSubmissionApplied(tx, staged.staged.stagingPath, "with a note");
    await commitFold(artifactsDir, {}, tx);

    // The interleaving: the host resubmitted at the bound path and the repair
    // was refused, so the TRAILING ingest event is now a rejection.
    await recordLaneOutcome(artifactsDir, LANE, {
      kind: "rejected",
      issueCode: "submission_contract_invalid",
      message: "repair failed again",
    });

    // The re-entry: the entry is still on the register, exactly as a mid-loop
    // throw after the durable append would leave it.
    tx.staged.push(staged.staged);
    await commitFold(artifactsDir, {}, tx);

    const accepted = (await readSubmissionLedger(artifactsDir)).filter(
      (e) => e.kind === "accepted",
    );
    expect(
      accepted,
      "one staged submission, one accepted event — a later rejection must not reopen the question",
    ).toHaveLength(1);
    expect(accepted[0]!.message).toBe("with a note");
  });
});

/**
 * The other half of the same rule, so the idempotence cannot be over-applied: a
 * REJECTION is deliberately re-recorded every time it is observed. A repeated
 * missing observation is not substantive history (see
 * `readTrailingSubmissionRefusals`), but a refusal a host has not repaired must
 * stay on the ledger as the reason it is being re-asked — collapsing it to one
 * row would erase that.
 */
test("a repeated rejection is still recorded — only the accepted arm is idempotent", async () => {
  await withArtifactsDir(async (artifactsDir) => {
    const { recordLaneOutcome } = await import(
      "../../src/audit/cli/laneSubmissions.js"
    );
    await recordLaneOutcome(artifactsDir, LANE, {
      kind: "rejected",
      issueCode: "submission_contract_invalid",
      message: "still the wrong shape",
    });
    await recordLaneOutcome(artifactsDir, LANE, {
      kind: "rejected",
      issueCode: "submission_contract_invalid",
      message: "still the wrong shape",
    });

    const rejected = (await readSubmissionLedger(artifactsDir)).filter(
      (e) => e.kind === "rejected",
    );
    expect(rejected).toHaveLength(2);
  });
});

test("a pending receipt blocks competing reads and cleanup and replays the exact fold", async () => {
  await withArtifactsDir(async (artifactsDir) => {
    const bound = laneSubmissionPath(artifactsDir, LANE);
    await writeFile(bound, JSON.stringify({ themes: [] }));
    const tx = createFoldTransaction();
    const staged = await stageLaneSubmission(tx, artifactsDir, LANE);
    if (staged.status !== "staged") throw new Error("expected staged");
    markSubmissionApplied(tx, staged.staged.stagingPath, "retained across restart");
    await markRunEnded(artifactsDir);

    const report = "complete payload to replay";
    const ordinaryStop = async () => {
      // Stop a synthetic commit between removal and acknowledgment.
      if (!(await stat(staged.staged.stagingPath).catch(() => undefined))) throw new Error("interrupted");
    };
    await expect(commitFold(artifactsDir, { audit_report: report }, tx, ordinaryStop)).rejects.toThrow("interrupted");
    const receipt = JSON.parse(await readFile(foldReceiptPath(artifactsDir), "utf8"));
    expect(receipt.applied[0]).toMatchObject({ lane: LANE, acceptedMessage: "retained across restart" });
    expect((await readSubmissionLedger(artifactsDir)).filter(event => event.kind === "accepted")).toEqual([]);
    await expect(loadArtifactBundle(artifactsDir)).rejects.toThrow("incomplete fold receipt");
    await expect(cleanupStaleArtifactsDir(artifactsDir, { force: true })).resolves.toMatchObject({ action: "skipped" });
    await expect(rollOverFinishedRun(artifactsDir)).resolves.toBe(false);
    expect(await readFile(foldReceiptPath(artifactsDir), "utf8")).toContain(report);

    const own = async () => undefined;
    await expect(recoverFoldReceipt(artifactsDir, own)).resolves.toBe(true);
    await expect(recoverFoldReceipt(artifactsDir, own)).resolves.toBe(false);
    expect((await loadArtifactBundle(artifactsDir)).audit_report).toBe(report);
    const accepted = (await readSubmissionLedger(artifactsDir)).filter(event => event.kind === "accepted");
    expect(accepted).toHaveLength(1);
    expect(accepted[0]!.message).toBe("retained across restart");
  });
});
