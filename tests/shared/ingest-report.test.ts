/**
 * THE ingest-report renderer both draws share (prompt 20, owner review
 * 2026-09-18). One renderer, each draw supplying its own remedy map: the
 * section a problem lands in follows the draw's remedy for its CODE.
 */
import { describe, expect, it } from "vitest";

import { renderIngestReportLines } from "../../src/shared/submission/ingestReport.js";
import { auditIngestRemedy } from "../../src/audit/validation/ingestIssueCodes.js";
import { remediationIssueRemedy } from "../../src/remediate/steps/dispatch/hostHandoff.js";

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
