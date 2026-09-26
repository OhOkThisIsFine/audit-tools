// Packet 12 — make host acceptance atomic and retry-safe.
//
// `recordLaneOutcome`'s accepted arm used to `return` early when the ledger
// already had an `accepted` for the submission. The two halves of that arm are
// not atomic — the append lands, then the expected-set drop throws — so a
// re-entry that early-returned left the lane owed forever (a stale expected
// item the next shortfall reports as missing even though the fold consumed its
// submission). The fix suppresses ONLY the duplicate append; the idempotent
// expected-set removal runs unconditionally.
//
// This file injects the failure AT that seam: the accepted APPEND lands (it
// writes the submission ledger, not the expected-submissions.json), then the
// DROP throws. A retry must append nothing new and must remove the stale
// expected item.
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AUDIT_GATE_SUBMISSION_SCOPE,
  laneSubmissionId,
  recordExpectedLanes,
  recordLaneOutcome,
} from "../../src/audit/cli/laneSubmissions.js";
import {
  expectedSubmissionsPath,
  readSubmissionLedger,
  type ExpectedSubmissionSet,
  type SubmissionLedgerEvent,
} from "audit-tools/shared";

// Fail exactly ONE write of the expected-submissions file when armed. This is
// the low-level `writeJsonFile` that `createLockedJsonStore` (and therefore the
// expected-set store) calls, NOT the barrel re-export.
const harness = vi.hoisted(() => ({ failNextExpectedWrite: false }));

vi.mock("../../src/shared/io/json.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/shared/io/json.js")>();
  return {
    ...actual,
    writeJsonFile: async (path: string, value: unknown): Promise<void> => {
      if (
        harness.failNextExpectedWrite &&
        typeof path === "string" &&
        path.endsWith("expected-submissions.json")
      ) {
        harness.failNextExpectedWrite = false;
        throw new Error("simulated crash after the accepted append");
      }
      return actual.writeJsonFile(path, value);
    },
  };
});

const cleanupRoots: string[] = [];
afterEach(async () => {
  await Promise.all(
    cleanupRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function artifactsDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "host-accept-atomicity-"));
  cleanupRoots.push(root);
  const dir = join(root, ".audit-tools", "audit");
  await mkdir(dir, { recursive: true });
  return dir;
}

function acceptedRows(
  events: readonly SubmissionLedgerEvent[],
  submissionId: string,
): readonly SubmissionLedgerEvent[] {
  return events.filter(
    (event) => event.submission_id === submissionId && event.kind === "accepted",
  );
}

async function readExpectedSet(dir: string): Promise<ExpectedSubmissionSet> {
  return JSON.parse(
    await readFile(expectedSubmissionsPath(dir), "utf8"),
  ) as ExpectedSubmissionSet;
}

describe("recordLaneOutcome — accepted append is atomic against its expected-set drop", () => {
  it("retry after a crash between the append and the drop yields one accepted event and no stale expected item", async () => {
    const dir = await artifactsDir();
    const lane = "design_review_contract";
    const submissionId = laneSubmissionId(lane, AUDIT_GATE_SUBMISSION_SCOPE);

    // Establish the expectation first (this writes expected-submissions.json
    // through the very `writeJsonFile` we arm later), so the armed failure only
    // ever hits the DROP.
    await recordExpectedLanes(dir, AUDIT_GATE_SUBMISSION_SCOPE, [
      { lane, promptText: "# contract" },
    ]);
    expect((await readExpectedSet(dir)).entries.map((e) => e.lane)).toEqual([lane]);

    // Arm: the accepted APPEND lands, then the DROP throws.
    harness.failNextExpectedWrite = true;
    await expect(
      recordLaneOutcome(dir, lane, { kind: "accepted" }),
    ).rejects.toThrow(/simulated crash after the accepted append/u);

    // The accepted row landed BEFORE the drop crashed.
    expect(
      acceptedRows(await readSubmissionLedger(dir), submissionId),
    ).toHaveLength(1);

    // The stale expected item still names the lane — the crash left it owed.
    expect((await readExpectedSet(dir)).entries.map((e) => e.lane)).toEqual([lane]);

    // Retry: the append is suppressed (already recorded), but the drop runs.
    await recordLaneOutcome(dir, lane, { kind: "accepted" });

    // ONE accepted event total — no duplicate.
    expect(
      acceptedRows(await readSubmissionLedger(dir), submissionId),
    ).toHaveLength(1);
    // No stale expected item.
    expect((await readExpectedSet(dir)).entries).toEqual([]);
  });

  it("a rejected outcome never touches the expected set and may re-record", async () => {
    const dir = await artifactsDir();
    const lane = "design_review_contract";
    const submissionId = laneSubmissionId(lane, AUDIT_GATE_SUBMISSION_SCOPE);
    await recordExpectedLanes(dir, AUDIT_GATE_SUBMISSION_SCOPE, [
      { lane, promptText: "# contract" },
    ]);
    await recordLaneOutcome(dir, lane, {
      kind: "rejected",
      issueCode: "submission_malformed",
      message: "not JSON",
    });
    // Re-observation is a fresh refusal (deliberately re-records), and the lane
    // stays owed.
    await recordLaneOutcome(dir, lane, {
      kind: "rejected",
      issueCode: "submission_malformed",
      message: "not JSON",
    });
    const events = await readSubmissionLedger(dir);
    expect(
      events.filter((e) => e.submission_id === submissionId && e.kind === "rejected"),
    ).toHaveLength(2);
    expect((await readExpectedSet(dir)).entries.map((e) => e.lane)).toEqual([lane]);
  });
});
