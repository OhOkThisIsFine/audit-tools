import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  parseAuditFindingsReport,
  isAuditFindingsReport,
} from "../../src/remediate/phases/plan.js";

const SIMPLE_FIXTURE = join(
  __dirname,
  "fixtures",
  "audit-findings-simple.json",
);

async function loadSimpleReport() {
  return JSON.parse(await readFile(SIMPLE_FIXTURE, "utf8"));
}

// INV-remediate-state-07: contract_version must be present; unknown/absent is rejected.
describe("isAuditFindingsReport — INV-remediate-state-07: contract_version required", () => {
  it("accepts a report with findings and the expected contract_version", () => {
    expect(
      isAuditFindingsReport({
        contract_version: "audit-tools/audit-findings/v1alpha1",
        findings: [],
        work_blocks: [],
        summary: {},
      }),
    ).toBe(true);
  });

  it("rejects a non-canonical contract_version (mismatch is an error, not a warning)", () => {
    // INV-shared-core-06 / OBL-C002-VERSION-TRUST: a contract_version that is
    // present but not exactly AUDIT_FINDINGS_CONTRACT_VERSION is treated as an
    // error (identical to absent), so the report is rejected rather than trusted.
    expect(
      isAuditFindingsReport({
        contract_version: "audit-findings/v1alpha1",
        findings: [],
      }),
    ).toBe(false);
  });

  it("rejects a report with no contract_version field", () => {
    // INV-remediate-state-07: absent contract_version is now an error.
    expect(isAuditFindingsReport({ findings: [], work_blocks: [] })).toBe(false);
  });

  it("rejects non-objects, markdown strings, and shapes without findings", () => {
    expect(isAuditFindingsReport(null)).toBe(false);
    expect(isAuditFindingsReport("# Audit Report\n## Findings\n")).toBe(false);
    expect(isAuditFindingsReport({ work_blocks: [], contract_version: "x" })).toBe(false);
    expect(isAuditFindingsReport({ findings: "nope", contract_version: "x" })).toBe(false);
  });
});

describe("parseAuditFindingsReport", () => {
  it("passes findings through verbatim", async () => {
    const { findings } = parseAuditFindingsReport(await loadSimpleReport());
    expect(findings).toHaveLength(2);
    const f1 = findings.find((f) => f.id === "F-001")!;
    expect(f1.title).toBe("Unvalidated user input in login handler");
    expect(f1.severity).toBe("high");
    expect(f1.lens).toBe("security");
    expect(f1.affected_files[0].path).toBe("src/auth/login.ts");
  });

  it("derives remediation blocks from work_blocks", async () => {
    const { blocks } = parseAuditFindingsReport(await loadSimpleReport());
    expect(blocks).toHaveLength(2);
    const b1 = blocks.find((b) => b.block_id === "B-001")!;
    expect(b1.items).toEqual(["F-001"]);
    expect(b1.parallel_safe).toBe(true);
  });

  it("marks blocks with dependencies as not parallel-safe", () => {
    const { blocks } = parseAuditFindingsReport({
      contract_version: "x",
      findings: [],
      work_blocks: [
        { id: "block-1", finding_ids: ["A"], depends_on: [] },
        { id: "block-2", finding_ids: ["B"], depends_on: ["block-1"] },
      ],
    } as never);
    expect(blocks.find((b) => b.block_id === "block-1")!.parallel_safe).toBe(true);
    const b2 = blocks.find((b) => b.block_id === "block-2")!;
    expect(b2.parallel_safe).toBe(false);
    expect(b2.dependencies).toEqual(["block-1"]);
  });

  it("carries synthesis themes through", () => {
    const { themes } = parseAuditFindingsReport({
      contract_version: "x",
      findings: [],
      work_blocks: [],
      themes: [
        {
          theme_id: "T-1",
          title: "Input validation",
          root_cause: "No central validation layer.",
          finding_ids: ["F-001"],
          suggested_fix_pattern: "Validate at the boundary.",
        },
      ],
    } as never);
    expect(themes).toHaveLength(1);
    expect(themes[0].theme_id).toBe("T-1");
  });

  it("returns empty blocks when work_blocks is absent", () => {
    const { blocks } = parseAuditFindingsReport({
      contract_version: "x",
      findings: [],
    } as never);
    expect(blocks).toEqual([]);
  });
});
