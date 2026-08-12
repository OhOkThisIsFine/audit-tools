/**
 * The submission record has READERS — it is not write-only bookkeeping.
 *
 * P25 built three reporting surfaces and wired none of them: the expected set
 * was written and never diffed, the ledger was appended and never read, and the
 * host-handoff ingest classified every failed submission into an `issues` array
 * its only caller dropped on the floor. Each one LOOKS like the property is
 * implemented — the artifact exists, the type is right — which is exactly the
 * "write-only data looks authoritative" class: the run still re-emitted an
 * identical step with no statement of what was owed or what had failed.
 *
 * This file pins a reader for each: a shortfall reaches the host, a classified
 * ingest failure reaches the ledger, and the ledger reaches the report.
 */
import { describe, expect, it, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

import type { RenderableAuditReport } from "../../src/audit/reporting/synthesis.js";

const {
  AUDIT_GATE_SUBMISSION_SCOPE,
  laneSubmissionPath,
  recordExpectedLanes,
  recordHostResultOutcomes,
  recordLaneOutcome,
  renderLaneShortfallLines,
} = await import("../../src/audit/cli/laneSubmissions.js");
const { readSubmissionLedger } = await import(
  "../../src/shared/submission/submissionLedger.js"
);
const { renderAuditReportMarkdown } = await import(
  "../../src/audit/reporting/synthesis.js"
);

const cleanups: string[] = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    await rm(cleanups.pop()!, { recursive: true, force: true });
  }
});

async function artifactsDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "p25-reporting-reader-"));
  cleanups.push(root);
  const dir = join(root, ".audit-tools", "audit");
  await mkdir(dir, { recursive: true });
  return dir;
}

const LANES = [
  { lane: "charter_extraction_stated", promptText: "author the stated charter" },
  { lane: "charter_extraction_revealed", promptText: "author the revealed charter" },
];

describe("the expected set is diffed and the shortfall reaches the host", () => {
  it("says nothing on a first emission and names the dropped lane on the next", async () => {
    const dir = await artifactsDir();

    const first = await recordExpectedLanes(dir, AUDIT_GATE_SUBMISSION_SCOPE, LANES);
    expect(
      renderLaneShortfallLines(first),
      "a first emission owes nothing yet — every lane is absent because it is being asked for now",
    ).toEqual([]);

    // The host delivers one lane and drops the other.
    const delivered = laneSubmissionPath(dir, "charter_extraction_stated");
    await mkdir(dirname(delivered), { recursive: true });
    await writeFile(delivered, JSON.stringify({ nodes: [] }), "utf8");

    const second = await recordExpectedLanes(dir, AUDIT_GATE_SUBMISSION_SCOPE, LANES);
    expect(second.expected).toBe(2);
    expect(second.accepted).toBe(1);
    expect(second.outstanding.map((entry) => entry.lane)).toEqual([
      "charter_extraction_revealed",
    ]);
    expect(second.outstanding[0]!.issue_code).toBe("submission_missing");

    const rendered = renderLaneShortfallLines(second).join("\n");
    expect(rendered, "the shortfall is stated BY LANE, not as a bare count").toContain(
      "charter_extraction_revealed",
    );
    expect(rendered).toContain("submission_missing");
    expect(rendered, "lane vocabulary — never shard, packet, or transport").not.toMatch(
      /shard|packet|wave|transport/iu,
    );
  });

  it("publishes the bound path in the step contract's own form — absolute, like access.write_paths", async () => {
    const dir = await artifactsDir();
    await recordExpectedLanes(dir, AUDIT_GATE_SUBMISSION_SCOPE, LANES);
    const shortfall = await recordExpectedLanes(dir, AUDIT_GATE_SUBMISSION_SCOPE, LANES);

    // The expected SET records its paths relative to the artifact tree root
    // (`audit/submissions/<sha>.json`). Publishing that form on the step
    // contract would name a base the contract declares nowhere — every other
    // path a consumer reads there is absolute — so a consumer joining it
    // against repo_root or artifacts_dir would build a path that never existed.
    for (const entry of shortfall.outstanding) {
      expect(
        entry.submission_path,
        "the published path must be the same string as the lane's access.write_paths entry",
      ).toBe(laneSubmissionPath(dir, entry.lane));
      expect(isAbsolute(entry.submission_path)).toBe(true);
    }
  });

  it("a REFUSED lane re-reports as refused, never as 'submitted nothing'", async () => {
    const dir = await artifactsDir();
    await recordExpectedLanes(dir, AUDIT_GATE_SUBMISSION_SCOPE, LANES);

    // The host submitted and the gate refused it: quarantine moves the file off
    // the bound path, and only an ACCEPTED lane is dropped from the expected
    // set — so the next diff sees ENOENT for a lane that did submit.
    await recordLaneOutcome(dir, "charter_extraction_revealed", {
      kind: "rejected",
      issueCode: "submission_contract_invalid",
      message: "nodes[0].kind: lane 'revealed' may only carry kind 'revealed'",
    });
    const delivered = laneSubmissionPath(dir, "charter_extraction_stated");
    await mkdir(dirname(delivered), { recursive: true });
    await writeFile(delivered, JSON.stringify({ nodes: [] }), "utf8");

    const shortfall = await recordExpectedLanes(dir, AUDIT_GATE_SUBMISSION_SCOPE, LANES);
    expect(shortfall.outstanding).toHaveLength(1);
    const [entry] = shortfall.outstanding;
    expect(entry!.issue_code, "the disk says ENOENT; the RECORD says refused").toBe(
      "submission_rejected",
    );
    expect(entry!.message).toContain("may only carry kind");
    expect(entry!.message).toContain("resubmit at the bound path");
    expect(
      renderLaneShortfallLines(shortfall).join("\n"),
      "telling a host that submitted 'you submitted nothing' points it at the wrong repair",
    ).not.toContain("submitted nothing");
  });

  it("a lane that genuinely never arrived is still submission_missing", async () => {
    const dir = await artifactsDir();
    await recordExpectedLanes(dir, AUDIT_GATE_SUBMISSION_SCOPE, LANES);
    const shortfall = await recordExpectedLanes(dir, AUDIT_GATE_SUBMISSION_SCOPE, LANES);
    expect(shortfall.outstanding.map((entry) => entry.issue_code)).toEqual([
      "submission_missing",
      "submission_missing",
    ]);
  });
});

describe("a classified ingest failure reaches the ledger", () => {
  const issue = {
    code: "submission_malformed",
    message: "work item 'audit-task-a' submitted bytes that are not JSON: Unexpected token",
    work_item_id: "audit-task-a",
    result_path: ".audit-tools/audit/runs/r1/host-results/aa.json",
  } as const;

  it("records the failure once and re-records it only when the classification changes", async () => {
    const dir = await artifactsDir();

    await recordHostResultOutcomes(dir, "run-1", { issues: [issue], acceptedIds: [] });
    // Ingest runs on every next-step; an unchanged classification must not
    // append the same line again, or the state changes drown in poll noise.
    await recordHostResultOutcomes(dir, "run-1", { issues: [issue], acceptedIds: [] });
    expect((await readSubmissionLedger(dir)).length).toBe(1);

    await recordHostResultOutcomes(dir, "run-1", {
      issues: [
        {
          ...issue,
          code: "submission_missing",
          message: "work item 'audit-task-a' submitted nothing at its bound path",
        },
      ],
      acceptedIds: [],
    });
    const events = await readSubmissionLedger(dir);
    expect(events.map((event) => event.issue_code)).toEqual([
      "submission_malformed",
      "submission_missing",
    ]);
    expect(events[0]!.submission_id).toBe("audit-task-a");
    expect(events.every((event) => event.kind === "rejected")).toBe(true);
  });

  it("closes a repaired work item's record, and stays silent for a clean first try", async () => {
    const dir = await artifactsDir();

    // A clean first try says nothing: the ledger is a drift record, not an
    // inventory of every work item the run completed.
    await recordHostResultOutcomes(dir, "run-1", {
      issues: [],
      acceptedIds: ["audit-task-clean"],
    });
    expect(await readSubmissionLedger(dir)).toEqual([]);

    // A refused item that later lands MUST close its own story. Without the
    // acceptance, a run where every failure was repaired reports its refusals
    // with no matching repair and reads as one that never recovered.
    await recordHostResultOutcomes(dir, "run-1", { issues: [issue], acceptedIds: [] });
    await recordHostResultOutcomes(dir, "run-1", {
      issues: [],
      acceptedIds: ["audit-task-a", "audit-task-clean"],
    });
    const events = await readSubmissionLedger(dir);
    expect(events.map((event) => [event.submission_id, event.kind])).toEqual([
      ["audit-task-a", "rejected"],
      ["audit-task-a", "accepted"],
    ]);

    // ...and a repeat ingest of the same accepted item does not re-append.
    await recordHostResultOutcomes(dir, "run-1", {
      issues: [],
      acceptedIds: ["audit-task-a"],
    });
    expect((await readSubmissionLedger(dir)).length).toBe(2);
  });
});

describe("the ledger reaches the report's process section", () => {
  const base: RenderableAuditReport = {
    summary: {
      finding_count: 0,
      work_block_count: 0,
      severity_breakdown: {},
      audited_file_count: 0,
      excluded_file_count: 0,
      runtime_validation_status_breakdown: {},
    },
    findings: [],
    work_blocks: [],
    work_block_seams: [],
  };

  const event = (
    submissionId: string,
    kind: "expected" | "accepted" | "rejected" | "recovered_by_hand",
    extra: Record<string, string> = {},
  ) => ({
    contract_version: "submission-ledger-event/v1alpha1" as const,
    run_id: "run-1",
    submission_id: submissionId,
    lane: "synthesis_narrative",
    kind,
    recorded_at: "2026-08-12T00:00:00.000Z",
    ...extra,
  });

  it("states drift and repair totals, and stays silent for a run that never drifted", () => {
    const clean = renderAuditReportMarkdown(base, {
      submission_ledger: [event("lane-a", "expected"), event("lane-a", "accepted")],
    });
    expect(
      clean,
      "a run whose submissions were all accepted first try has no drift to report",
    ).not.toMatch(/Submission drift/);

    const repaired = renderAuditReportMarkdown(base, {
      submission_ledger: [
        event("lane-a", "expected"),
        event("lane-a", "rejected", { issue_code: "submission_malformed" }),
        event("lane-a", "accepted"),
        event("lane-b", "recovered_by_hand"),
      ],
    });
    expect(repaired).toMatch(/### Submission drift and repair/);
    expect(repaired).toContain("submission_malformed 1");
    // Counted PER SUBMISSION off each one's trailing state, not as a raw
    // `rejected N / accepted M` pair: the two totals cover different
    // populations (every gate-lane acceptance is recorded, a work item's only
    // where a refusal precedes it), so the pair invited reading M as "of those
    // N" and a fully-repaired run could render as `rejected 3, accepted 0`.
    expect(repaired).toContain("1 submission(s) were refused at least once");
    expect(repaired).toContain("1 of them were later accepted or re-landed by hand");
    expect(repaired).toContain("1 by an operator's hand recovery");
  });

  it("a refusal that was never resolved is reported as unrepaired", () => {
    const stuck = renderAuditReportMarkdown(base, {
      submission_ledger: [
        event("lane-a", "expected"),
        event("lane-a", "rejected", { issue_code: "submission_contract_invalid" }),
        event("lane-b", "rejected", { issue_code: "submission_missing" }),
        event("lane-b", "accepted"),
      ],
    });
    expect(stuck).toContain("2 submission(s) were refused at least once");
    expect(
      stuck,
      "only the submission whose trailing state left the refusal behind counts as repaired",
    ).toContain("1 of them were later accepted or re-landed by hand");
  });
});
