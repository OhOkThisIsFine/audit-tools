// The charter evidence coverage block reaches the DELIVERABLE.
//
// The measured incident: the "stated" channel delivered 0 of 72 source-comment
// blocks and nothing downstream said so — `validation_issues` appeared 0 times in
// a 9,935-line audit-report.md, and no coverage figure for the charter channel
// existed in it at all. A correct measurement that dies in the JSON is not a fix.
import { test, expect } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSampleAuditBundle } from "../../src/audit/cli/sampleRunCommand.js";
import { readQuestionReportCharterOptions } from "../../src/audit/io/artifacts.js";
import { CHARTER_REGISTER_SCHEMA_VERSION } from "../../src/audit/types/charterRegister.js";
import { charterPacketArchiveDir, charterPacketArchiveFilename, charterPacketIndexPath } from "../../src/audit/orchestrator/charterPacketArchive.js";
import { hashContent } from "../../src/shared/hash.js";
import type { RenderableAuditReport } from "../../src/audit/reporting/synthesis.js";
import type { CharterPacketCoverage } from "audit-tools/shared";
import { renderAuditReportMarkdown } from "../../src/audit/reporting/synthesis.js";

const BASE: RenderableAuditReport = {
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

const SHORT_DELIVERY: CharterPacketCoverage = {
  kind: "stated",
  classes: [
    {
      evidence_class: "comment",
      named: 72,
      delivered: 71,
      omitted: [{ path: "src/a.ts", reason: "unreadable_or_oversized" }],
    },
    { evidence_class: "doc", named: 95, delivered: 95, omitted: [] },
  ],
};

test("the coverage block renders UNCONDITIONALLY, so 'complete' cannot read as 'not measured'", () => {
  const rendered = renderAuditReportMarkdown(BASE, {});
  expect(rendered).toContain("### Charter evidence coverage");
  expect(rendered).toContain("No charter evidence packets were measured");
  // …and it does NOT drag the Process Feedback heading along with it: that
  // section's presence is its own statement.
  expect(rendered).not.toMatch(/## Process Feedback/);
});

test("a short-delivering channel is stated as a figure, not left to prose inside a deleted file", () => {
  const rendered = renderAuditReportMarkdown(BASE, {
    charter_evidence_coverage: [SHORT_DELIVERY],
  });
  expect(rendered).toContain("comment: 71 of 72 delivered");
  expect(rendered).toContain("doc: 95 of 95 delivered");
  expect(rendered).toContain("src/a.ts (unreadable_or_oversized)");
});

test("a FAILED packet archive is surfaced beside the coverage figures", () => {
  const rendered = renderAuditReportMarkdown(BASE, {
    charter_evidence_coverage: [SHORT_DELIVERY],
    charter_packet_archive: [
      {
        kind: "revealed",
        sha256: "a".repeat(64),
        byte_length: 10,
        archived_at: "2026-09-03T00:00:00.000Z",
        source_filename: "charter-extraction-revealed-packet.md",
        archived: false,
        reason: "archive write failed: EPERM",
      },
      {
        kind: "stated",
        sha256: "b".repeat(64),
        byte_length: 10,
        archived_at: "2026-09-03T00:00:00.000Z",
        source_filename: "charter-extraction-stated-packet.md",
        archived: true,
      },
    ],
  });
  expect(rendered).toContain("Packet retention FAILED");
  expect(rendered).toContain("`revealed`");
  expect(rendered).toContain("EPERM");
  // A successful row says nothing — only the failure is news.
  expect(rendered).not.toMatch(/Packet retention FAILED for.*`stated`/);
});

test("question Markdown distinguishes what the charter saw from what the archive still verifies", async () => {
  const dir = await mkdtemp(join(tmpdir(), "question-charter-coverage-"));
  try {
    const text = "Synthetic archived charter packet.\n";
    const sha256 = hashContent(text);
    const missingHash = hashContent("Another packet");
    await mkdir(charterPacketArchiveDir(dir));
    await writeFile(join(dir, "charter_register.json"), JSON.stringify({
      schema_version: CHARTER_REGISTER_SCHEMA_VERSION, evidence_coverage: [SHORT_DELIVERY],
    }));
    await writeFile(charterPacketIndexPath(dir), JSON.stringify([
      { kind: "stated", sha256, byte_length: Buffer.byteLength(text), archived: true },
      { kind: "revealed", sha256: missingHash, byte_length: 14, archived: true },
    ]));
    const retained = join(charterPacketArchiveDir(dir), charterPacketArchiveFilename("stated", sha256));
    await writeFile(retained, text);
    const { auditFindings } = buildSampleAuditBundle();
    const first = renderAuditReportMarkdown(auditFindings, await readQuestionReportCharterOptions(dir));
    expect(first).toContain("comment: 71 of 72 delivered");
    expect(first).toContain("src/a.ts (unreadable_or_oversized)");
    expect(first).toContain("Verified retained packet: stated");
    expect(first).toContain("Packet retention FAILED");
    expect(first).toContain("revealed");
    expect(first).not.toContain("evidence still exists");
    expect(first).toBe(renderAuditReportMarkdown(auditFindings, await readQuestionReportCharterOptions(dir)));
    await writeFile(retained, text.replace("Synthetic", "Different"));
    const altered = renderAuditReportMarkdown(auditFindings, await readQuestionReportCharterOptions(dir));
    expect(altered).toContain("No verified charter packet retention record");
    expect(altered).not.toContain("Verified retained packet:");
    expect(JSON.stringify(auditFindings)).not.toContain("unreadable_or_oversized");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
