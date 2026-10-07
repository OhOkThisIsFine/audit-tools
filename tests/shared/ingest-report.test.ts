/**
 * THE ingest-report renderer both draws share (prompt 20, owner review
 * 2026-09-18). One renderer, each draw supplying its own remedy map: the
 * section a problem lands in follows the draw's remedy for its CODE.
 */
import { describe, expect, it } from "vitest";

import { renderIngestReportLines } from "../../src/shared/submission/ingestReport.js";
import { auditIngestRemedy } from "../../src/audit/validation/ingestIssueCodes.js";
import { remediationIssueRemedy } from "../../src/remediate/steps/dispatch/hostHandoff.js";
import { reportNamesResultFiles } from "../../src/remediate/steps/nextStep.js";

const OPERATOR_HEADING =
  "## Problems the worker cannot fix — stop and report them to the operator";

describe("renderIngestReportLines", () => {
  it("puts a problem no worker can fix under the operator section", () => {
    const text = renderIngestReportLines({
      issues: [
        {
          code: "dependency_missing",
          work_item_id: "block-a",
          message: "block 'block-a' declares a dependency present in no block",
        },
      ],
      remedy: remediationIssueRemedy,
      workload: "named_above",
    }).join("\n");
    expect(text).toContain(OPERATOR_HEADING);
    expect(text).toContain("`block-a`");
    expect(text).not.toContain("## Results to repair and write again");
    expect(text).not.toContain("## Settled — no action needed");
  });

  it("renders a remediate duplicate as a repair and an audit duplicate as settled", () => {
    const duplicate = {
      code: "duplicate_submission_id" as const,
      work_item_id: "item-1",
      message: "result_id item-1-abc is duplicated",
    };
    const remediate = renderIngestReportLines({
      issues: [duplicate],
      remedy: remediationIssueRemedy,
      workload: "named_above",
    }).join("\n");
    expect(remediate).toContain("## Results to repair and write again");
    expect(remediate).not.toContain("## Settled — no action needed");
    const audit = renderIngestReportLines({
      issues: [duplicate],
      remedy: auditIngestRemedy,
      workload: "follows",
    }).join("\n");
    expect(audit).toContain("## Settled — no action needed");
    expect(audit).not.toContain("## Results to repair and write again");
  });

  it("states pending work as a count, so the report does not grow with the run", () => {
    // Dogfood 2026-10-05: one bullet per pending item put 167-250 KB of
    // "not yet written" bullets above each step's own instructions. The workload
    // republishes every pending item with its bound `result_path`, so the report
    // states how many wait and points at the workload.
    const missing = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        code: "submission_missing" as const,
        work_item_id: `task-${index}`,
        message: "no result file exists for this pending work item",
        result_path: `runs/r/results/task-${index}.json`,
      }));
    for (const workload of ["follows", "named_above", "next_call"] as const) {
      const one = renderIngestReportLines({
        issues: missing(1),
        remedy: auditIngestRemedy,
        workload,
      });
      const many = renderIngestReportLines({
        issues: missing(500),
        remedy: auditIngestRemedy,
        workload,
      });
      expect(many.length, workload).toBe(one.length);
      const text = many.join("\n");
      expect(text).toContain("## Results not yet written");
      expect(text).toContain("500");
      expect(text).not.toContain("task-499");
    }
  });

  it("tells the remediate host to change only named result files only when the report names one", () => {
    const pending = {
      code: "submission_missing" as const,
      work_item_id: "block-a",
      message: "no result file exists for this pending work item",
    };
    // Pending results render as a count: the report names no result file.
    expect(
      reportNamesResultFiles({ issues: [pending], work_item_outcomes: new Map() }),
    ).toBe(false);
    expect(
      reportNamesResultFiles({
        issues: [pending],
        work_item_outcomes: new Map([["block-a", "missing_result_with_commit" as const]]),
      }),
    ).toBe(true);
    expect(
      reportNamesResultFiles({
        issues: [{ code: "submission_malformed" as const, work_item_id: "block-b", message: "bad JSON" }],
        work_item_outcomes: new Map(),
      }),
    ).toBe(true);
  });

  it("lists a commit that landed without a result once, under its own section", () => {
    const text = renderIngestReportLines({
      issues: [
        {
          code: "submission_missing",
          work_item_id: "block-a",
          message: "no result file exists for this pending work item",
        },
      ],
      remedy: remediationIssueRemedy,
      workload: "named_above",
      landedWithoutResult: ["block-a"],
    }).join("\n");
    expect(text).toContain("## Commits that landed without a result file");
    expect(text).toContain(
      "write the result for the commit that is already on HEAD. Do not do the edit again.",
    );
    expect(text).not.toContain("## Results not yet written");
  });
});
