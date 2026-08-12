import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
