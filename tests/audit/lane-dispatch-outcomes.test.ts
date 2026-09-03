/**
 * Every DISPATCHED lane leaves a row, and none of those rows is an expectation.
 *
 * The ledger recorded OWED submissions, not dispatches. `materializeFanoutLanes`
 * filters `expected: false` lanes out before `recordExpectedLanes`, which is the
 * only writer of `kind: "expected"`, so a dispatched perspective that exited 0
 * having written nothing left no row anywhere. Measured in a real run: of eight
 * dispatched design-review lanes, five reported process exit 0 while writing no
 * artifact at all, and the final artifact tree was byte-indistinguishable from a
 * run where all eight succeeded first try.
 *
 * THE P25 CONSTRAINT IS STRUCTURAL, NOT CONVENTIONAL. `94f1a4d0` made
 * perspectives `expected: false` because the tool never reads a perspective's
 * findings, so an expectation against one can never be satisfied or dropped —
 * it accumulates as a permanent, false shortfall. Dispatch rows are appended
 * from `params.lanes` directly, on the OTHER side of that filter, and shortfall
 * is a diff over the expected SET (`diffExpectedSet`), a path that never reads
 * ledger events. Expecting an artifact is a claim the tool will be owed
 * something and will re-ask; recording an outcome is a statement about what was
 * observed once.
 *
 * THE OBSERVATION BOUNDARY IS THE INGEST, NOT THE EMISSION. An emission-time
 * observer can never see the LAST delivery: once the judge's submission lands
 * and is ingested, the perspective lanes are never re-materialized, so a fully
 * delivered deep pass would report 0 of N. Outcomes are therefore observed at
 * the fold that ingests the round's terminal submission, and a superseded
 * round's still-open rows are closed when the next round is minted.
 */
import { describe, expect, it, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { FanoutLaneSpec } from "../../src/audit/cli/fanoutLanes.js";
import type { SubmissionLedgerEvent } from "../../src/shared/submission/submissionLedger.js";

const { materializeFanoutLanes } = await import(
  "../../src/audit/cli/fanoutLanes.js"
);
const {
  AUDIT_GATE_SUBMISSION_SCOPE,
  closeDispatchedLaneOutcomes,
  laneSubmissionId,
  laneSubmissionPath,
  recordLaneOutcome,
} = await import("../../src/audit/cli/laneSubmissions.js");
const { readSubmissionLedger } = await import(
  "../../src/shared/submission/submissionLedger.js"
);
const { renderAuditReportMarkdown } = await import(
  "../../src/audit/reporting/synthesis.js"
);

const EMPTY_REPORT = {
  contract_version: "audit-findings/v1alpha1",
  summary: {
    finding_count: 0,
    work_block_count: 0,
    severity_breakdown: {},
    audited_file_count: 0,
    excluded_file_count: 0,
    runtime_validation_status_breakdown: {},
  },
  findings: [],
  coherence_trace: { normalized_items: [], components: [] },
  work_blocks: [],
  work_block_seams: [],
} as unknown as Parameters<typeof renderAuditReportMarkdown>[0];

const cleanups: string[] = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    await rm(cleanups.pop()!, { recursive: true, force: true });
  }
});

async function artifactsDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "lane-dispatch-outcomes-"));
  cleanups.push(root);
  const dir = join(root, ".audit-tools", "audit");
  await mkdir(dir, { recursive: true });
  return dir;
}

function lanes(roundLaneIds: readonly string[]): FanoutLaneSpec[] {
  return [
    ...roundLaneIds.map((id) => ({
      id,
      label: `Perspective ${id}`,
      promptFilename: `${id}-prompt.md`,
      promptText: `# ${id}`,
      // The tool is owed nothing here — the judge reads it, not this tool.
      expected: false,
    })),
    {
      id: "design_review_conceptual",
      label: "Judge",
      promptFilename: "judge-prompt.md",
      promptText: "# judge",
    },
  ];
}

async function deliver(
  dir: string,
  lane: string,
  body: string,
): Promise<void> {
  const path = laneSubmissionPath(dir, lane, AUDIT_GATE_SUBMISSION_SCOPE);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body, "utf8");
}

function rowsOf(
  events: readonly SubmissionLedgerEvent[],
  kind: string,
): readonly SubmissionLedgerEvent[] {
  return events.filter((event) => event.kind === kind);
}

describe("dispatch rows", () => {
  it("records EVERY dispatched lane, expected or not, and never as an expectation", async () => {
    const dir = await artifactsDir();
    await materializeFanoutLanes({
      artifactsDir: dir,
      runId: AUDIT_GATE_SUBMISSION_SCOPE,
      roundId: "round-a",
      lanes: lanes(["p1", "p2"]),
    });

    const events = await readSubmissionLedger(dir);
    expect(
      rowsOf(events, "dispatched").map((event) => event.lane).sort(),
      "a dispatched lane leaves a row whether or not the tool is owed its output",
    ).toEqual(["design_review_conceptual", "p1", "p2"]);
    expect(
      rowsOf(events, "expected").map((event) => event.lane),
      "only the lane the tool itself ingests is owed a submission (P25)",
    ).toEqual(["design_review_conceptual"]);
    expect(
      rowsOf(events, "dispatched").every((event) => event.round_id === "round-a"),
      "a dispatch row carries the round it belongs to, so a rate is per round",
    ).toBe(true);
  });

  it("does not duplicate a dispatch row when the same round is re-emitted", async () => {
    const dir = await artifactsDir();
    const emit = () =>
      materializeFanoutLanes({
        artifactsDir: dir,
        runId: AUDIT_GATE_SUBMISSION_SCOPE,
        roundId: "round-a",
        lanes: lanes(["p1", "p2"]),
      });
    await emit();
    await emit();
    await emit();
    expect(rowsOf(await readSubmissionLedger(dir), "dispatched")).toHaveLength(3);
  });
});

describe("outcome observation at the ingest boundary", () => {
  it("reports N of N when every lane delivered", async () => {
    const dir = await artifactsDir();
    await materializeFanoutLanes({
      artifactsDir: dir,
      runId: AUDIT_GATE_SUBMISSION_SCOPE,
      roundId: "round-a",
      lanes: lanes(["p1", "p2"]),
    });
    await deliver(dir, "p1", '{"findings":[{"id":"DR-001"}]}');
    await deliver(dir, "p2", '{"findings":[]}');
    // The judge's own submission is ingested by the tool, so its terminal row
    // is the ordinary `accepted` — it needs no lane_outcome of its own.
    await recordLaneOutcome(dir, "design_review_conceptual", { kind: "accepted" });

    await closeDispatchedLaneOutcomes(dir, {
      lanes: ["p1", "p2"],
      roundId: "round-a",
    });

    const outcomes = rowsOf(await readSubmissionLedger(dir), "lane_outcome");
    expect(
      outcomes.map((event) => [event.lane, event.outcome]).sort(),
    ).toEqual([
      ["p1", "findings"],
      ["p2", "clean"],
    ]);
  });

  it("records a lane that exited having written nothing as not_run", async () => {
    const dir = await artifactsDir();
    await materializeFanoutLanes({
      artifactsDir: dir,
      runId: AUDIT_GATE_SUBMISSION_SCOPE,
      roundId: "round-a",
      lanes: lanes(["p1", "p2"]),
    });
    await deliver(dir, "p1", '{"findings":[{"id":"DR-001"}]}');
    // p2 exited 0 and wrote nothing at all — the case that used to be invisible.

    await closeDispatchedLaneOutcomes(dir, {
      lanes: ["p1", "p2"],
      roundId: "round-a",
    });

    const outcomes = rowsOf(await readSubmissionLedger(dir), "lane_outcome");
    expect(outcomes.map((event) => [event.lane, event.outcome]).sort()).toEqual([
      ["p1", "findings"],
      ["p2", "not_run"],
    ]);
  });

  it("classifies bytes that are not a readable submission as degraded", async () => {
    const dir = await artifactsDir();
    await materializeFanoutLanes({
      artifactsDir: dir,
      runId: AUDIT_GATE_SUBMISSION_SCOPE,
      roundId: "round-a",
      lanes: lanes(["p1"]),
    });
    // The single word "Let", after 909 seconds. Present, and unusable.
    await deliver(dir, "p1", "Let");
    await closeDispatchedLaneOutcomes(dir, { lanes: ["p1"], roundId: "round-a" });
    expect(
      rowsOf(await readSubmissionLedger(dir), "lane_outcome")[0]?.outcome,
    ).toBe("degraded");
  });

  it("closes a superseded round's still-open rows, once, without touching the new round", async () => {
    const dir = await artifactsDir();
    await materializeFanoutLanes({
      artifactsDir: dir,
      runId: AUDIT_GATE_SUBMISSION_SCOPE,
      roundId: "round-a",
      lanes: lanes(["p1_a", "p2_a"]),
    });
    await deliver(dir, "p1_a", '{"findings":[]}');
    // Round A is superseded before p2_a ever delivered.
    await closeDispatchedLaneOutcomes(dir, {
      lanes: ["p1_a", "p2_a"],
      roundId: "round-a",
    });
    await materializeFanoutLanes({
      artifactsDir: dir,
      runId: AUDIT_GATE_SUBMISSION_SCOPE,
      roundId: "round-b",
      lanes: lanes(["p1_b"]),
    });

    // Closing again must append nothing: an outcome is observed once.
    await closeDispatchedLaneOutcomes(dir, {
      lanes: ["p1_a", "p2_a"],
      roundId: "round-a",
    });
    const events = await readSubmissionLedger(dir);
    expect(
      rowsOf(events, "lane_outcome").map((e) => [e.lane, e.outcome, e.round_id]),
    ).toEqual([
      ["p1_a", "clean", "round-a"],
      ["p2_a", "not_run", "round-a"],
    ]);
    expect(
      rowsOf(events, "dispatched")
        .filter((e) => e.round_id === "round-b")
        .map((e) => e.lane),
      // Only the new PERSPECTIVE gets a round-b row: the judge lane's identity
      // is deliberately stable across rounds (P25 keeps its resume semantics),
      // so it is one submission and it is dispatched once. Counting it again
      // per round would double it in the delivery rate.
      "the new round's lane is recorded, and the stable judge lane is not re-dispatched",
    ).toEqual(["p1_b"]);
  });
});

describe("the new kinds do not corrupt the readers that already existed", () => {
  it("keeps a refusal readable after a re-dispatch (B2: last INGEST event, not last event)", async () => {
    const dir = await artifactsDir();
    const lane = "design_review_contract";
    await materializeFanoutLanes({
      artifactsDir: dir,
      runId: AUDIT_GATE_SUBMISSION_SCOPE,
      lanes: [
        {
          id: lane,
          label: "Contract review",
          promptFilename: "contract-prompt.md",
          promptText: "# contract",
        },
      ],
    });
    await recordLaneOutcome(dir, lane, {
      kind: "rejected",
      issueCode: "submission_malformed",
      message: "not JSON",
    });
    // The lane is re-materialized (a quarantined submission reads as ENOENT, so
    // the lane is still pending) — which appends nothing new, and must not
    // erase the refusal by becoming the trailing event.
    const again = await materializeFanoutLanes({
      artifactsDir: dir,
      runId: AUDIT_GATE_SUBMISSION_SCOPE,
      lanes: [
        {
          id: lane,
          label: "Contract review",
          promptFilename: "contract-prompt.md",
          promptText: "# contract",
        },
      ],
    });

    expect(
      again.shortfall.outstanding.map((entry) => entry.issue_code),
      'a submitted-and-refused lane must not be told it "submitted nothing"',
    ).toEqual(["submission_rejected"]);
  });

  it("does not count a refused submission as resolved because a dispatch row follows it", async () => {
    const dir = await artifactsDir();
    const lane = "design_review_contract";
    const submissionId = laneSubmissionId(lane, AUDIT_GATE_SUBMISSION_SCOPE);
    await recordLaneOutcome(dir, lane, {
      kind: "rejected",
      issueCode: "submission_malformed",
      message: "not JSON",
    });
    await materializeFanoutLanes({
      artifactsDir: dir,
      runId: AUDIT_GATE_SUBMISSION_SCOPE,
      lanes: [
        {
          id: lane,
          label: "Contract review",
          promptFilename: "contract-prompt.md",
          promptText: "# contract",
        },
      ],
    });

    const events = await readSubmissionLedger(dir);
    expect(events.some((event) => event.submission_id === submissionId)).toBe(true);
    const markdown = renderAuditReportMarkdown(EMPTY_REPORT, {
      submission_ledger: events,
    });
    expect(markdown).toContain("1 submission(s) were refused");
    expect(
      markdown,
      "the refusal is still the last word — nothing accepted it or re-landed it",
    ).toContain("0 of them were later accepted");
  });

  it("reports the delivery rate per round, even on a run with no refusals at all", async () => {
    const dir = await artifactsDir();
    await materializeFanoutLanes({
      artifactsDir: dir,
      runId: AUDIT_GATE_SUBMISSION_SCOPE,
      roundId: "round-a",
      lanes: lanes(["p1", "p2"]),
    });
    await deliver(dir, "p1", '{"findings":[{"id":"DR-001"}]}');
    await closeDispatchedLaneOutcomes(dir, {
      lanes: ["p1", "p2"],
      roundId: "round-a",
    });
    await recordLaneOutcome(dir, "design_review_conceptual", { kind: "accepted" });

    const markdown = renderAuditReportMarkdown(EMPTY_REPORT, {
      submission_ledger: await readSubmissionLedger(dir),
    });
    // The section used to render NOTHING unless something was rejected, so a run
    // in which lanes silently under-delivered read as clean.
    expect(markdown).toContain("round-a");
    expect(markdown).toContain("2 of 3");
    expect(markdown).toContain("not_run 1");
  });
});

