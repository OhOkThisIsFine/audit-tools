import { describe, it, expect, afterEach } from "vitest";
import { appendFile, mkdir, mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  appendSubmissionEvent,
  readSubmissionLedger,
  submissionLedgerPath,
  SUBMISSION_EVENT_KINDS,
  SUBMISSION_LEDGER_EVENT_CONTRACT_VERSION,
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

  // The reader is a REPORTING surface: callers read `kind`, `issue_code` and
  // `message` off these events to decide whether a lane is outstanding BECAUSE
  // it was refused, and to dedupe against the last recorded event. An event
  // written by another release carries those fields under another contract's
  // semantics, so it is skipped exactly like a torn line — per event, never by
  // rewriting the file, which stays the faithful historical record it is.
  it("skips an event from another contract version while newer lines still load", async () => {
    const { artifactsDir } = await tempArtifactsDir();

    await appendSubmissionEvent(
      artifactsDir,
      event({ submission_id: "before-lane", kind: "rejected", issue_code: "submission_malformed" }),
    );
    // Byte-for-byte the shape this module writes, except the contract version —
    // i.e. exactly what an older release left on the ledger. Written raw,
    // because the append helper would stamp the current version.
    await appendFile(
      submissionLedgerPath(artifactsDir),
      JSON.stringify({
        contract_version: "submission-ledger-event/v0",
        run_id: "run-p25",
        submission_id: "foreign-lane",
        lane: "synthesis_narrative",
        kind: "rejected",
        issue_code: "submission_malformed",
        recorded_at: "2026-08-12T00:00:00.000Z",
      }) + "\n",
      "utf8",
    );
    await appendSubmissionEvent(
      artifactsDir,
      event({ submission_id: "after-lane", kind: "accepted" }),
    );

    const events = await readSubmissionLedger(artifactsDir);

    expect(
      events.map((e) => e.submission_id),
      "the foreign event is skipped; the events on either side of it still load, in arrival order",
    ).toEqual(["before-lane", "after-lane"]);
    for (const e of events) {
      expect(e.contract_version).toBe(SUBMISSION_LEDGER_EVENT_CONTRACT_VERSION);
    }

    // The record itself is untouched — skipping is a READ policy, not a rewrite.
    const lines = (await readFile(submissionLedgerPath(artifactsDir), "utf8"))
      .split(/\r?\n/u)
      .filter((line) => line.trim().length > 0);
    expect(lines).toHaveLength(3);
  });

  it("skips an event with no contract_version at all", async () => {
    const { artifactsDir } = await tempArtifactsDir();

    // The stamped event goes first so the append helper creates the directory.
    await appendSubmissionEvent(
      artifactsDir,
      event({ submission_id: "stamped-lane", kind: "accepted" }),
    );
    await appendFile(
      submissionLedgerPath(artifactsDir),
      JSON.stringify({
        run_id: "run-p25",
        submission_id: "unstamped-lane",
        lane: "synthesis_narrative",
        kind: "rejected",
        recorded_at: "2026-08-12T00:00:00.000Z",
      }) + "\n",
      "utf8",
    );

    const events = await readSubmissionLedger(artifactsDir);
    expect(events.map((e) => e.submission_id)).toEqual(["stamped-lane"]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// A SKIP IS REPORTED, NEVER SILENT.
//
// Skipping a torn or foreign-version line is correct; doing it silently is not.
// With no counter, no warning and nothing in the return value, a `rejected` or
// `recovered_by_hand` event that was dropped read exactly like one that had
// never been recorded — which defeats the single thing the ledger exists to
// guarantee, that a drifted-and-repaired run stays distinguishable after the
// fact. Every skipped line now carries its 1-based line number and a classified
// reason.
// ───────────────────────────────────────────────────────────────────────────

describe("the ledger reader reports what it could not read", () => {
  /** Write raw lines verbatim, so torn and foreign-version lines are exact. */
  async function writeLedgerLines(
    artifactsDir: string,
    lines: string[],
  ): Promise<void> {
    await mkdir(dirname(submissionLedgerPath(artifactsDir)), { recursive: true });
    await writeFile(
      submissionLedgerPath(artifactsDir),
      lines.join("\n") + "\n",
      "utf8",
    );
  }

  function validLine(submissionId: string): string {
    return JSON.stringify(
      event({ submission_id: submissionId, kind: "accepted" }),
    );
  }

  function foreignVersionLine(submissionId: string): string {
    return JSON.stringify({
      ...event({ submission_id: submissionId, kind: "rejected" }),
      contract_version: "submission-ledger-event/v0",
    });
  }

  it("reports an empty dropped list, and the full event set, for a clean ledger", async () => {
    const { artifactsDir } = await tempArtifactsDir();
    await writeLedgerLines(artifactsDir, [
      validLine("one"),
      validLine("two"),
      validLine("three"),
    ]);

    const read = await readSubmissionLedger(artifactsDir);

    expect(read.dropped, "a clean ledger drops nothing").toEqual([]);
    expect(read.events.map((e) => e.submission_id)).toEqual([
      "one",
      "two",
      "three",
    ]);
    // Still the events array itself, for every consumer that has not adapted.
    expect(read.map((e) => e.submission_id)).toEqual(["one", "two", "three"]);
  });

  it("classifies a torn line and a foreign-version line by line number and reason", async () => {
    const { artifactsDir } = await tempArtifactsDir();
    // Lines 1, 3 and 5 are valid; line 2 is torn; line 4 carries another
    // release's contract version.
    await writeLedgerLines(artifactsDir, [
      validLine("first"),
      '{"contract_version":"submission-ledger-eve',
      validLine("third"),
      foreignVersionLine("foreign"),
      validLine("fifth"),
    ]);

    const read = await readSubmissionLedger(artifactsDir);

    expect(
      read.dropped,
      "each skipped line is named by number and classified by reason",
    ).toEqual([
      { line: 2, reason: "unparsable" },
      { line: 4, reason: "schema_version_mismatch" },
    ]);
    expect(
      read.events.map((e) => e.submission_id),
      "every complete, current-version event on either side of a bad line loads",
    ).toEqual(["first", "third", "fifth"]);
  });

  it("still surfaces a drop when the only bad line is a foreign version", async () => {
    const { artifactsDir } = await tempArtifactsDir();
    await writeLedgerLines(artifactsDir, [
      validLine("before"),
      foreignVersionLine("foreign"),
      validLine("after"),
    ]);

    const read = await readSubmissionLedger(artifactsDir);

    expect(read.events).toHaveLength(2);
    expect(
      read.dropped,
      "a version-skipped event is not the same fact as one never recorded",
    ).toEqual([{ line: 2, reason: "schema_version_mismatch" }]);
  });

  it("counts blank lines so a reported number finds the real line in the file", async () => {
    const { artifactsDir } = await tempArtifactsDir();
    await mkdir(dirname(submissionLedgerPath(artifactsDir)), { recursive: true });
    // A blank line before the torn one: an index over the non-blank subset would
    // report line 2 and send a reader to the wrong line.
    await writeFile(
      submissionLedgerPath(artifactsDir),
      `${validLine("first")}\n\nnot json at all\n`,
      "utf8",
    );

    const read = await readSubmissionLedger(artifactsDir);
    expect(read.dropped).toEqual([{ line: 3, reason: "unparsable" }]);
  });

  it("reads an absent ledger, and an empty submissions dir, as clean and empty", async () => {
    const { artifactsDir } = await tempArtifactsDir();

    const absent = await readSubmissionLedger(artifactsDir);
    expect(absent).toEqual([]);
    expect(absent.dropped).toEqual([]);

    // The directory exists but holds no ledger — still empty, still not a throw.
    await mkdir(dirname(submissionLedgerPath(artifactsDir)), { recursive: true });
    const empty = await readSubmissionLedger(artifactsDir);
    expect(empty).toEqual([]);
    expect(empty.events).toEqual([]);
    expect(empty.dropped).toEqual([]);
  });
});
