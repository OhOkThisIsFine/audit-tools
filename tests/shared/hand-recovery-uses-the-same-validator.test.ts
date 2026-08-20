import { describe, it, expect, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { recoverSubmission, type HandRecoveryRequest } from "../../src/shared/submission/handRecovery.js";
import {
  submissionPathFor,
  absoluteSubmissionPath,
} from "../../src/shared/submission/submissionIdentity.js";
import type { SubmissionIssue } from "../../src/shared/submission/submissionClassifier.js";
import {
  readSubmissionLedger,
  submissionLedgerPath,
} from "../../src/shared/submission/submissionLedger.js";
import {
  expectedSubmissionsPath,
  submissionsDir,
} from "../../src/shared/io/auditToolsPaths.js";
import { EXPECTED_SET_CONTRACT_VERSION } from "../../src/shared/submission/expectedSubmissions.js";
import { writeJsonFile } from "../../src/shared/io/json.js";

// P25-e / design record §5 #5.
//
// The hand-recovery verb (`recover-submission --submission-id <id> --from <path>`)
// exists so an operator can re-land a submission a host mangled. It must not be a
// second, weaker door into the tool: it runs the SAME validator the normal lane
// runs, writes to the SAME tool-computed path, and the fact that a human hand
// touched the run is recorded (`recovered_by_hand`) rather than erased.
//
// "Same validator" is enforced by construction — `recoverSubmission` takes the
// normal lane's validator as an argument — so this test asserts the two agree
// EXACTLY (same code, same message), and that a rejected payload leaves nothing
// behind at the tool-owned path.

const cleanups: string[] = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const dir = cleanups.pop()!;
    await rm(dir, { recursive: true, force: true });
  }
});

/** Stand-in for a gate schema: the normal lane's zod-before-apply check (D7). */
const GateSubmissionSchema = z
  .object({
    contract_version: z.literal("synthesis-narrative/v1alpha1"),
    executive_summary: z.string().min(1),
    themes: z.array(z.string()),
  })
  .strict();

/** The normal lane's validator. Handed to the recovery lane verbatim. */
function validateGateSubmission(value: unknown): SubmissionIssue | null {
  const parsed = GateSubmissionSchema.safeParse(value);
  if (parsed.success) {
    return null;
  }
  return {
    code: "submission_contract_invalid",
    message: `submission failed schema validation: ${parsed.error.issues[0]?.message ?? "invalid"}`,
  };
}

async function fixture(): Promise<{
  root: string;
  artifactsDir: string;
  request: (submissionId: string, fromPath: string) => HandRecoveryRequest;
}> {
  const root = await mkdtemp(join(tmpdir(), "p25-hand-recovery-"));
  cleanups.push(root);
  const artifactsDir = join(root, ".audit-tools", "audit");
  await mkdir(artifactsDir, { recursive: true });
  return {
    root,
    artifactsDir,
    request: (submissionId, fromPath) => ({
      root,
      artifactsDir,
      runId: "run-p25",
      submissionId,
      fromPath,
    }),
  };
}

describe("hand recovery — the recovery lane is the normal lane's validator, not a weaker one", () => {
  it("rejects a payload the normal lane rejects, with the identical issue", async () => {
    const { root, artifactsDir, request } = await fixture();
    const submissionId = "synthesis-narrative-lane";

    // A payload the gate schema refuses: `themes` is the wrong type.
    const bad = { contract_version: "synthesis-narrative/v1alpha1", executive_summary: "s", themes: "nope" };
    const operatorPath = join(root, "operator-fixed.json");
    await writeFile(operatorPath, JSON.stringify(bad), "utf8");

    const normalLaneIssue = validateGateSubmission(bad);
    expect(normalLaneIssue).not.toBeNull();

    const outcome = await recoverSubmission(request(submissionId, operatorPath), validateGateSubmission);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      throw new Error("expected the recovery lane to refuse a payload the normal lane refuses");
    }
    // Identical rejection — not merely "also rejected".
    expect(outcome.issue.code).toBe(normalLaneIssue!.code);
    expect(outcome.issue.message).toBe(normalLaneIssue!.message);

    // Nothing landed at the tool-owned path.
    const landed = absoluteSubmissionPath(
      { root, submissionDir: submissionsDir(artifactsDir) },
      submissionId,
    );
    await expect(readFile(landed, "utf8")).rejects.toThrow();

    // And the run is not falsely marked as hand-repaired. (A ledger that does not
    // exist yet reads as empty, never as a throw.)
    const events = await readSubmissionLedger(artifactsDir);
    expect(events.filter((e) => e.kind === "recovered_by_hand")).toHaveLength(0);
  });

  it("lands a valid payload at the tool-owned path and records recovered_by_hand", async () => {
    const { root, artifactsDir, request } = await fixture();
    const submissionId = "synthesis-narrative-lane";

    const good = {
      contract_version: "synthesis-narrative/v1alpha1",
      executive_summary: "the repo is fine",
      themes: ["coupling"],
    };
    const operatorPath = join(root, "operator-fixed.json");
    await writeFile(operatorPath, JSON.stringify(good), "utf8");

    expect(validateGateSubmission(good)).toBeNull();

    const outcome = await recoverSubmission(request(submissionId, operatorPath), validateGateSubmission);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      throw new Error(`expected recovery to succeed, got ${outcome.issue.code}: ${outcome.issue.message}`);
    }

    const paths = { root, submissionDir: submissionsDir(artifactsDir) };
    // The path is TOOL-owned — the operator's `--from` path has no say in it.
    expect(outcome.submission_path.replaceAll("\\", "/")).toBe(
      submissionPathFor(paths, submissionId).replaceAll("\\", "/"),
    );
    expect(outcome.submission_path.replaceAll("\\", "/")).toMatch(
      /\/submissions\/[0-9a-f]{64}\.json$/u,
    );

    const landed = absoluteSubmissionPath(paths, submissionId);
    expect(JSON.parse(await readFile(landed, "utf8")) as unknown).toEqual(good);

    // The hand repair is on the record.
    const events = await readSubmissionLedger(artifactsDir);
    const recovered = events.filter(
      (e) => e.kind === "recovered_by_hand" && e.submission_id === submissionId,
    );
    expect(recovered).toHaveLength(1);
  });

  // The lane name on the ledger is looked up from the recorded expectation. That
  // set is REGENERABLE bookkeeping, so one left by another release is treated as
  // absent — landing on this function's existing degrade path (record the raw
  // id) rather than labelling the repair with a lane read out of a foreign
  // contract. CONTROL first, so the empty-lane case below is the version check
  // firing and not a lookup that never worked.
  describe("the lane label is read from the expected set only at the current contract version", () => {
    const good = {
      contract_version: "synthesis-narrative/v1alpha1",
      executive_summary: "the repo is fine",
      themes: ["coupling"],
    };

    async function recoverWithPersistedSet(setContractVersion: string): Promise<string> {
      const { root, artifactsDir, request } = await fixture();
      const submissionId = "synthesis-narrative-lane";
      const operatorPath = join(root, "operator-fixed.json");
      await writeFile(operatorPath, JSON.stringify(good), "utf8");

      await writeJsonFile(expectedSubmissionsPath(artifactsDir), {
        contract_version: setContractVersion,
        run_id: "run-p25",
        entries: [
          {
            submission_id: submissionId,
            lane: "synthesis_narrative",
            prompt_sha256: "0".repeat(64),
            submission_path: submissionPathFor(
              { root, submissionDir: submissionsDir(artifactsDir) },
              submissionId,
            ),
          },
        ],
      });

      const outcome = await recoverSubmission(
        request(submissionId, operatorPath),
        validateGateSubmission,
      );
      expect(outcome.ok).toBe(true);

      const recovered = (await readSubmissionLedger(artifactsDir)).filter(
        (e) => e.kind === "recovered_by_hand" && e.submission_id === submissionId,
      );
      expect(recovered).toHaveLength(1);
      return recovered[0]!.lane;
    }

    it("CONTROL: a set at the CURRENT version supplies the lane vocabulary", async () => {
      expect(await recoverWithPersistedSet(EXPECTED_SET_CONTRACT_VERSION)).toBe(
        "synthesis_narrative",
      );
    });

    it("a set at an OLDER version falls back to the raw submission id", async () => {
      expect(await recoverWithPersistedSet("submission-expected-set/v0")).toBe(
        "synthesis-narrative-lane",
      );
    });
  });

  it("rolls the payload back when the repair cannot be recorded", async () => {
    const { root, artifactsDir, request } = await fixture();
    const submissionId = "synthesis-narrative-lane";

    const good = {
      contract_version: "synthesis-narrative/v1alpha1",
      executive_summary: "the repo is fine",
      themes: ["coupling"],
    };
    const operatorPath = join(root, "operator-fixed.json");
    await writeFile(operatorPath, JSON.stringify(good), "utf8");

    // Make the ledger append fail the way it realistically does — a lock, an
    // EBUSY, a concurrent writer. A directory at the ledger path is the
    // hermetic, cross-platform stand-in.
    await mkdir(submissionLedgerPath(artifactsDir), { recursive: true });

    // A landed payload with no `recovered_by_hand` record is the ONE state this
    // verb must never leave behind: the next next-step consumes it as a clean
    // first-try submission, and the run reads as one that never drifted —
    // exactly the distinguishability the ledger exists to guarantee.
    await expect(
      recoverSubmission(request(submissionId, operatorPath), validateGateSubmission),
    ).rejects.toThrow(/ledger/i);

    const landed = absoluteSubmissionPath(
      { root, submissionDir: submissionsDir(artifactsDir) },
      submissionId,
    );
    await expect(
      readFile(landed, "utf8"),
      "a rescue that could not be recorded must leave nothing behind",
    ).rejects.toThrow();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// ROLLBACK RESTORES; IT DOES NOT JUST DELETE.
//
// "Roll back the landing write" was implemented as an unconditional unlink. That
// is the correct rollback for exactly one case — nothing was at the path before
// — and it was being applied to both. Attempted over an ALREADY-LANDED
// submission it produced "no file" rather than "the previous file", so a rescue
// that merely failed to be RECORDED destroyed bytes the run already had. The
// distinction is what these tests hold apart.
// ───────────────────────────────────────────────────────────────────────────

describe("hand recovery — a failed rescue never destroys what was already landed", () => {
  const good = {
    contract_version: "synthesis-narrative/v1alpha1",
    executive_summary: "the repo is fine",
    themes: ["coupling"],
  };

  /**
   * A recovery whose ledger append is guaranteed to fail. A directory at the
   * ledger path is the hermetic, cross-platform stand-in for the lock / EBUSY /
   * concurrent-writer cases this really happens under.
   */
  async function recoveryWithUnwritableLedger(options: {
    seedLandingWith?: string;
  }): Promise<{ landed: string; call: () => Promise<unknown> }> {
    const { root, artifactsDir, request } = await fixture();
    const submissionId = "synthesis-narrative-lane";
    const operatorPath = join(root, "operator-fixed.json");
    await writeFile(operatorPath, JSON.stringify(good), "utf8");

    const landed = absoluteSubmissionPath(
      { root, submissionDir: submissionsDir(artifactsDir) },
      submissionId,
    );
    if (options.seedLandingWith !== undefined) {
      await mkdir(dirname(landed), { recursive: true });
      await writeFile(landed, options.seedLandingWith, "utf8");
    }
    await mkdir(submissionLedgerPath(artifactsDir), { recursive: true });

    return {
      landed,
      call: () =>
        recoverSubmission(request(submissionId, operatorPath), validateGateSubmission),
    };
  }

  it("restores the pre-existing payload byte-for-byte when the ledger append fails", async () => {
    // Deliberately NOT a re-serialization of the same object: odd spacing and
    // key order make "restored the bytes" distinguishable from "wrote something
    // that parses the same".
    const prior = '{"prior":true,\n  "note":"do not lose me"}';
    const { landed, call } = await recoveryWithUnwritableLedger({
      seedLandingWith: prior,
    });

    await expect(call()).rejects.toThrow(/ledger/i);

    expect(
      await readFile(landed, "utf8"),
      "the submission that was already landed must come back exactly as it was",
    ).toBe(prior);
  });

  it("says the prior submission was restored, and does not claim a clean rollback", async () => {
    const { call } = await recoveryWithUnwritableLedger({
      seedLandingWith: '{"prior":true}',
    });

    await expect(call()).rejects.toThrow(/restored byte-for-byte/u);
  });

  it("deletes the newly-written file when nothing was there before", async () => {
    const { landed, call } = await recoveryWithUnwritableLedger({});

    // The single-failure message, distinct from the double-failure one below.
    await expect(call()).rejects.toThrow(/could not record the ledger event/u);
    expect(
      existsSync(landed),
      "with nothing there before, deleting IS the correct rollback",
    ).toBe(false);
  });

  it("does not claim a restore when there was nothing to restore", async () => {
    const { call } = await recoveryWithUnwritableLedger({});

    // ONE recovery, and its rejection pinned directly: re-running a
    // side-effecting operation to make a second assertion tests a different
    // call than the first, and `rejects.not.toThrow` is vacuously green if the
    // promise ever resolves.
    const error = await call().then(
      () => {
        throw new Error("expected the recovery to reject, but it resolved");
      },
      (reason: unknown) => reason as Error,
    );

    expect(error.message).toContain("NOT landed (rolled back)");
    expect(
      error.message,
      "nothing was there, so there is nothing to claim restored",
    ).not.toContain("restored byte-for-byte");
  });

  it("refuses up front when the prior payload exists but cannot be read", async () => {
    // A DIRECTORY at the landing path: `readFile` fails with EISDIR on both
    // win32 and linux, so the probe hits a non-ENOENT failure deterministically
    // on either platform. That is the fact "something IS there and I cannot read
    // it" — the opposite of "nothing is there", and the old bare catch collapsed
    // the two, routing rollback to unlink and DELETING what it could not read.
    const { root, artifactsDir, request } = await fixture();
    const submissionId = "synthesis-narrative-lane";
    const operatorPath = join(root, "operator-fixed.json");
    await writeFile(operatorPath, JSON.stringify(good), "utf8");

    const landed = absoluteSubmissionPath(
      { root, submissionDir: submissionsDir(artifactsDir) },
      submissionId,
    );
    await mkdir(landed, { recursive: true });
    await writeFile(join(landed, "witness.txt"), "untouched", "utf8");

    const outcome = await recoverSubmission(
      request(submissionId, operatorPath),
      validateGateSubmission,
    );

    expect(outcome.ok, "an unreadable prior state is a refusal, not a guess").toBe(
      false,
    );
    if (outcome.ok) throw new Error("expected a refusal");
    expect(outcome.issue.code).toBe("submission_rejected");
    expect(outcome.issue.message).toContain("EISDIR");
    expect(outcome.issue.submission_id).toBe(submissionId);

    // Nothing was written, nothing was deleted, nothing was recorded.
    expect(
      await readFile(join(landed, "witness.txt"), "utf8"),
      "the unreadable prior state must be left exactly as found",
    ).toBe("untouched");
    expect(existsSync(submissionLedgerPath(artifactsDir))).toBe(false);
  });

  it("writes nothing and records nothing when the validator rejects", async () => {
    const { root, artifactsDir, request } = await fixture();
    const submissionId = "synthesis-narrative-lane";
    const operatorPath = join(root, "operator-fixed.json");
    // Rejected by the gate schema: `themes` is the wrong type.
    await writeFile(
      operatorPath,
      JSON.stringify({ ...good, themes: "nope" }),
      "utf8",
    );

    const outcome = await recoverSubmission(
      request(submissionId, operatorPath),
      validateGateSubmission,
    );
    expect(outcome.ok).toBe(false);

    const landed = absoluteSubmissionPath(
      { root, submissionDir: submissionsDir(artifactsDir) },
      submissionId,
    );
    expect(existsSync(landed), "a refusal writes nothing").toBe(false);
    expect(
      existsSync(submissionLedgerPath(artifactsDir)),
      "a run must never look hand-repaired because a repair was ATTEMPTED",
    ).toBe(false);
  });

  it("refuses a missing source, and a malformed one, without touching either surface", async () => {
    for (const [contents, code] of [
      [null, "submission_missing"],
      ["not json at all", "submission_malformed"],
    ] as const) {
      const { root, artifactsDir, request } = await fixture();
      const submissionId = "synthesis-narrative-lane";
      const operatorPath = join(root, "operator-fixed.json");
      if (contents !== null) await writeFile(operatorPath, contents, "utf8");

      const outcome = await recoverSubmission(
        request(submissionId, operatorPath),
        validateGateSubmission,
      );
      expect(outcome.ok, code).toBe(false);
      if (outcome.ok) throw new Error("expected a refusal");
      expect(outcome.issue.code).toBe(code);
      expect(outcome.issue.submission_id).toBe(submissionId);

      const landed = absoluteSubmissionPath(
        { root, submissionDir: submissionsDir(artifactsDir) },
        submissionId,
      );
      expect(existsSync(landed), code).toBe(false);
      expect(existsSync(submissionLedgerPath(artifactsDir)), code).toBe(false);
    }
  });
});
