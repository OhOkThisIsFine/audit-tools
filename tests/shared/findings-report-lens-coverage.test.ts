/**
 * The validator owns INTERNAL CONSISTENCY of `lens_coverage`, and deliberately
 * not its presence.
 *
 * `validateAuditFindingsReport(value, path)` receives the report and nothing
 * else — no intent checkpoint — so it cannot establish whether a selection was
 * ever made. A gate that cannot ESTABLISH its verdict abstains rather than
 * approximating one: presence is guaranteed at the synthesis boundary, which
 * does hold the checkpoint. What the validator CAN establish from the report
 * alone is that the coverage map does not contradict the findings beside it, and
 * that is what it refuses on — because a drifted map reaches the remediate draw
 * through `projectApprovedFindings`, which throws on any error issue.
 */
import { describe, expect, it } from "vitest";

import {
  AUDIT_FINDINGS_CONTRACT_VERSION,
  projectAuditFindingsReportSubset,
  validateAuditFindingsReport,
} from "../../src/shared/validation/findingsReport.js";
import type { Finding } from "../../src/shared/types/finding.js";

function finding(id: string, lens: string): Finding {
  return {
    id,
    title: `finding ${id}`,
    severity: "medium",
    confidence: "medium",
    lens,
    category: "architecture_pattern",
    summary: "a finding",
    affected_files: [{ path: `src/${id}.ts` }],
  } as unknown as Finding;
}

const FINDINGS = [
  finding("a", "architecture"),
  finding("b", "architecture"),
  finding("c", "performance"),
];

function report(overrides: Record<string, unknown> = {}): unknown {
  return {
    contract_version: AUDIT_FINDINGS_CONTRACT_VERSION,
    summary: {
      finding_count: FINDINGS.length,
      work_block_count: 3,
      severity_breakdown: { medium: 3 },
      lens_breakdown: { architecture: 2, performance: 1 },
      audited_file_count: 3,
      excluded_file_count: 0,
      runtime_validation_status_breakdown: {},
      ...(overrides.summary as Record<string, unknown> | undefined),
    },
    findings: FINDINGS,
    coherence_trace: {
      normalized_items: FINDINGS.map((f) => ({
        id: f.id,
        file_paths: f.affected_files.map((file) => file.path),
        unit_ids: [],
        tags: [f.lens],
      })),
      components: FINDINGS.map((f) => [f.id]),
    },
    work_blocks: FINDINGS.map((f, index) => ({
      id: `block-${index + 1}`,
      finding_ids: [f.id],
      unit_ids: [],
      owned_files: f.affected_files.map((file) => file.path),
      role: "implementation",
      max_severity: "medium",
      rationale: "one finding",
      depends_on: [],
    })),
    work_block_seams: [],
  };
}

function errorsAt(issues: ReturnType<typeof validateAuditFindingsReport>): string[] {
  return issues
    .filter((issue) => issue.severity === "error")
    .map((issue) => issue.path);
}

describe("lens_coverage internal consistency", () => {
  it("refuses a coverage entry whose count contradicts the findings", () => {
    const issues = validateAuditFindingsReport(
      report({
        summary: {
          lens_coverage: [
            { lens: "architecture", selected: true, findings_count: 2, outcome: "findings" },
            // Two findings carry this lens; the map claims none.
            { lens: "performance", selected: true, findings_count: 0, outcome: "clean" },
          ],
        },
      }),
    );
    expect(errorsAt(issues).some((path) => path.includes("lens_coverage"))).toBe(true);
  });

  it("refuses an outcome its own inputs do not derive", () => {
    const issues = validateAuditFindingsReport(
      report({
        summary: {
          lens_coverage: [
            // One finding, so `clean` ("asked, nothing there") is false on its face.
            { lens: "performance", selected: true, findings_count: 1, outcome: "clean" },
            { lens: "architecture", selected: true, findings_count: 2, outcome: "findings" },
          ],
        },
      }),
    );
    expect(errorsAt(issues).some((path) => path.includes("lens_coverage"))).toBe(true);
  });

  it("refuses a lens_breakdown key the coverage map does not mention", () => {
    const issues = validateAuditFindingsReport(
      report({
        summary: {
          lens_coverage: [
            { lens: "architecture", selected: true, findings_count: 2, outcome: "findings" },
          ],
        },
      }),
    );
    expect(errorsAt(issues).some((path) => path.includes("lens_coverage"))).toBe(true);
  });

  it("accepts a consistent map, including a lens that produced nothing", () => {
    const issues = validateAuditFindingsReport(
      report({
        summary: {
          lens_coverage: [
            { lens: "architecture", selected: true, findings_count: 2, outcome: "findings" },
            { lens: "performance", selected: true, findings_count: 1, outcome: "findings" },
            { lens: "tests", selected: true, findings_count: 0, outcome: "not_run" },
          ],
        },
      }),
    );
    expect(errorsAt(issues)).toEqual([]);
  });

  it("ABSTAINS on a report that carries no coverage map at all", () => {
    // No selection was made, or the report predates the field. The validator
    // holds no checkpoint, so it cannot tell those apart and must not guess:
    // turning presence into a validator rule here would refuse every report the
    // recovery deliverable mints.
    expect(errorsAt(validateAuditFindingsReport(report()))).toEqual([]);
  });
});

describe("projecting an approved subset", () => {
  it("re-derives lens_coverage over the surviving findings", () => {
    // The projection copies `...report.summary` and then re-derives the
    // breakdowns. Carrying `lens_coverage` through UNCHANGED would leave it
    // contradicting a re-derived `lens_breakdown`, and the projection validates
    // itself at the write boundary — so the remediate intake that calls this
    // would throw on a subset that drops every finding of one lens.
    const projected = projectAuditFindingsReportSubset(
      report({
        summary: {
          lens_coverage: [
            { lens: "architecture", selected: true, findings_count: 2, outcome: "findings" },
            { lens: "performance", selected: true, findings_count: 1, outcome: "findings" },
          ],
        },
      }),
      [FINDINGS[0]!, FINDINGS[1]!],
    );

    expect(projected.summary.lens_coverage).toEqual([
      { lens: "architecture", selected: true, findings_count: 2, outcome: "findings" },
      // Selected, and every finding it produced was dropped from this subset.
      { lens: "performance", selected: true, findings_count: 0, outcome: "clean" },
    ]);
    expect(projected.summary.lens_breakdown).toEqual({
      architecture: 2,
      performance: 0,
    });
  });
});
