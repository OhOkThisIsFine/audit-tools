import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isAuditorAuditReport, parseAuditReport } from "../src/phases/plan.js";

const AUDITOR_CONTRACT_FIXTURE = join(
  __dirname,
  "fixtures",
  "auditor-contract-audit-report.md",
);

const SAMPLE = `
# Audit Report

## Summary
- Findings: 2

## Work Blocks

### block-1

- Max severity: high
- Units: src-foo
- Owned files: src/foo.ts
- Findings: ABC-001, ABC-002
- Depends on: none
- Rationale: co-located

### block-2

- Max severity: low
- Units: src-bar
- Owned files: src/bar.ts
- Findings: ABC-003
- Depends on: block-1
- Rationale: depends on block-1

## Findings

### ABC-001 — Example finding one

- Severity: high
- Confidence: high
- Lens: correctness
- Files: src/foo.ts
- Summary: Something is wrong
- Evidence:
  - src/foo.ts:10 - broken thing
  - runtime:unit: confirmed

### ABC-002 — Example finding two

- Severity: low
- Confidence: medium
- Lens: maintainability
- Files: src/foo.ts, src/bar.ts
- Summary: Another issue
- Evidence:
  - src/foo.ts:20 - another thing

### ABC-003 — Example finding three

- Severity: low
- Confidence: high
- Lens: tests
- Files: src/bar.ts
- Summary: Missing tests
- Evidence:
  - tests/ - no test file

## Scope and Coverage
`.trim();

describe("parseAuditReport", () => {
  it("parses correct number of blocks and findings", () => {
    const { findings, blocks } = parseAuditReport(SAMPLE);
    expect(findings).toHaveLength(3);
    expect(blocks).toHaveLength(2);
  });

  it("extracts block fields correctly", () => {
    const { blocks } = parseAuditReport(SAMPLE);
    const b1 = blocks.find((b) => b.block_id === "block-1");
    expect(b1).toBeDefined();
    expect(b1!.items).toEqual(["ABC-001", "ABC-002"]);
    expect(b1!.dependencies).toEqual([]);
    expect(b1!.parallel_safe).toBe(true);

    const b2 = blocks.find((b) => b.block_id === "block-2");
    expect(b2!.dependencies).toEqual(["block-1"]);
    expect(b2!.parallel_safe).toBe(false);
  });

  it("extracts finding fields correctly", () => {
    const { findings } = parseAuditReport(SAMPLE);
    const f1 = findings.find((f) => f.id === "ABC-001");
    expect(f1).toBeDefined();
    expect(f1!.title).toBe("Example finding one");
    expect(f1!.severity).toBe("high");
    expect(f1!.confidence).toBe("high");
    expect(f1!.lens).toBe("correctness");
    expect(f1!.affected_files).toEqual([{ path: "src/foo.ts" }]);
    expect(f1!.evidence).toHaveLength(2);
    expect(f1!.evidence[0]).toContain("broken thing");
  });

  it("handles multiple affected files", () => {
    const { findings } = parseAuditReport(SAMPLE);
    const f2 = findings.find((f) => f.id === "ABC-002");
    expect(f2!.affected_files).toEqual([
      { path: "src/foo.ts" },
      { path: "src/bar.ts" },
    ]);
  });

  it("returns empty arrays for empty input", () => {
    const { findings, blocks } = parseAuditReport("");
    expect(findings).toHaveLength(0);
    expect(blocks).toHaveLength(0);
  });

  it("returns empty arrays when sections are absent", () => {
    const { findings, blocks } = parseAuditReport(
      "# Just a heading\n\nsome text",
    );
    expect(findings).toHaveLength(0);
    expect(blocks).toHaveLength(0);
  });

  it("parses the auditor-rendered contract fixture", async () => {
    const fixture = await readFile(AUDITOR_CONTRACT_FIXTURE, "utf8");
    const { findings, blocks } = parseAuditReport(fixture);

    expect(isAuditorAuditReport(fixture)).toBe(true);
    expect(findings.map((finding) => finding.id)).toEqual([
      "AUD-001",
      "AUD-002",
      "AUD-003",
    ]);
    expect(blocks.map((block) => block.block_id)).toEqual([
      "block-1",
      "block-2",
    ]);
    expect(blocks[0]).toMatchObject({
      items: ["AUD-001", "AUD-002"],
      dependencies: [],
      parallel_safe: true,
    });
    expect(blocks[1]).toMatchObject({
      items: ["AUD-003"],
      dependencies: ["block-1"],
      parallel_safe: false,
    });
    expect(findings[1]).toMatchObject({
      title: "Session refresh path lacks regression coverage",
      lens: "tests",
      affected_files: [{ path: "src/api/auth.ts" }, { path: "src/lib/session.ts" }],
    });
  });

  it("requires Work Blocks for deterministic auditor report detection", () => {
    const incompleteReport = `# Audit Report\n\n## Findings\n\n### AUD-001 — Missing section\n`;

    expect(isAuditorAuditReport(incompleteReport)).toBe(false);
  });
});
