import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendSubmissionEvent,
  readSubmissionLedger,
  submissionLedgerPath,
  SUBMISSION_EVENT_KINDS,
  type SubmissionLedgerEvent,
} from "../../src/shared/submission/submissionLedger.js";

// P25-c / design record §5 #4.
//
// A run that was repaired (a submission rejected, then re-submitted and accepted)
// must be distinguishable after the fact from a run that was clean on the first
// try. The only way that survives the call is an append-only ledger: the
// rejection event stays on the record even after the acceptance lands.
//
// The ledger is NDJSON at `<artifactsDir>/submissions/submission-ledger.jsonl`
// (BRIEF D1 — artifactsDir-scoped, not run-scoped, because the incoming/ gates
// carry no runId), appended via the shared `appendNdjsonFile`, so ARRIVAL order
// is the file order. Nothing on the write path may re-sort.

const cleanups: string[] = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const dir = cleanups.pop()!;
    await rm(dir, { recursive: true, force: true });
  }
});

async function tempArtifactsDir(): Promise<{ root: string; artifactsDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "p25-submission-ledger-"));
  cleanups.push(root);
  return { root, artifactsDir: join(root, ".audit-tools", "audit") };
}

function event(
  overrides: Partial<SubmissionLedgerEvent> & Pick<SubmissionLedgerEvent, "submission_id" | "kind">,
): SubmissionLedgerEvent {
  return {
    contract_version: "submission-ledger-event/v1alpha1",
    run_id: "run-p25",
    lane: "synthesis_narrative",
    recorded_at: "2026-08-12T00:00:00.000Z",
    ...overrides,
  } as SubmissionLedgerEvent;
}

describe("submission ledger — a repaired run stays distinguishable from a clean one", () => {
  it("keeps both the rejection and the later acceptance for the same submission_id", async () => {
    const { artifactsDir } = await tempArtifactsDir();
    const submissionId = "synthesis-narrative-lane";

    await appendSubmissionEvent(
      artifactsDir,
      event({
        submission_id: submissionId,
        kind: "rejected",
        issue_code: "submission_malformed",
        message: "unexpected token in JSON at position 1",
        // Deliberately LATER than the acceptance below: a ledger that sorted by
        // recorded_at would reverse these two and hide which came first.
        recorded_at: "2026-08-12T09:00:00.000Z",
      }),
    );
    await appendSubmissionEvent(
      artifactsDir,
      event({
        submission_id: submissionId,
        kind: "accepted",
        recorded_at: "2026-08-12T08:00:00.000Z",
      }),
    );

    const events = await readSubmissionLedger(artifactsDir);
    const forSubmission = events.filter((e) => e.submission_id === submissionId);

    expect(forSubmission).toHaveLength(2);
    expect(forSubmission.map((e) => e.kind)).toEqual(["rejected", "accepted"]);

    // The whole point: the rejection is still on the record after acceptance,
    // so "this run was repaired by hand" is a readable fact, not a lost one.
    const rejection = forSubmission[0]!;
    expect(rejection.issue_code).toBe("submission_malformed");
    expect(rejection.message).toContain("unexpected token");
    expect(forSubmission.some((e) => e.kind === "accepted")).toBe(true);
  });

  it("preserves arrival order — appends never re-sort by timestamp or submission_id", async () => {
    const { artifactsDir } = await tempArtifactsDir();

    // Appended last, but sorts FIRST by submission_id and has the EARLIEST
    // recorded_at — so any re-sort on either key moves it off the tail.
    const arrival: readonly SubmissionLedgerEvent[] = [
      event({
        submission_id: "zz-lane",
        kind: "rejected",
        recorded_at: "2026-08-12T09:00:00.000Z",
      }),
      event({
        submission_id: "zz-lane",
        kind: "accepted",
        recorded_at: "2026-08-12T08:00:00.000Z",
      }),
      event({
        submission_id: "aa-lane",
        kind: "expected",
        recorded_at: "2026-08-12T07:00:00.000Z",
      }),
    ];

    for (const e of arrival) {
      await appendSubmissionEvent(artifactsDir, e);
    }

    const events = await readSubmissionLedger(artifactsDir);
    expect(events.map((e) => [e.submission_id, e.kind])).toEqual(
      arrival.map((e) => [e.submission_id, e.kind]),
    );

    // ...and the on-disk file is the same append-only NDJSON, one event per line,
    // in the same arrival order.
    const path = submissionLedgerPath(artifactsDir);
    expect(path.replaceAll("\\", "/")).toMatch(/\/submissions\/submission-ledger\.jsonl$/u);

    const lines = (await readFile(path, "utf8"))
      .split(/\r?\n/u)
      .filter((line) => line.trim().length > 0);
    expect(lines).toHaveLength(arrival.length);
    expect(lines.map((line) => (JSON.parse(line) as SubmissionLedgerEvent).submission_id)).toEqual(
      arrival.map((e) => e.submission_id),
    );
  });

  it("declares the event kinds a repaired run needs", () => {
    for (const kind of ["expected", "accepted", "rejected", "recovered_by_hand"] as const) {
      expect(SUBMISSION_EVENT_KINDS).toContain(kind);
    }
  });
});
