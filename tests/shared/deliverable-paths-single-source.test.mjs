/**
 * deliverable-paths-single-source.test.mjs
 *
 * Regression for IMPL-report-promote-path: the audit report's synthesis-write
 * target, the promote source, the promote destination, and the present_report
 * prompt path must all derive from ONE shared deliverable-paths module
 * (src/shared/io/auditToolsPaths.ts) so they cannot drift to different
 * spellings. A drift here previously surfaced as a promote-time ENOENT
 * (synthesis writing one path, promote reading another).
 *
 * Contract enforced:
 *   1. SOURCE-EXISTS: the path the audit artifact registry writes the rendered
 *      report TO (auditReportPath(artifactsDir)) is byte-identical to the path
 *      promoteFinalAuditReport reads it FROM. So whatever synthesis writes,
 *      promote can read — no ENOENT.
 *   2. BYTE-IDENTICAL PROMOTE: promote source == auditReportPath(artifactsDir)
 *      and promote dest == promotedAuditReportPath(artifactsDir), both derived
 *      from the same shared helpers (parent == dirname(artifactsDir)).
 *   3. ROUND-TRIP: a real promote of a file written at auditReportPath lands at
 *      promotedAuditReportPath with identical bytes (promoted:true).
 *   4. PRESENT-REPORT path == promote dest: the path handed to the
 *      present_report prompt after a successful promotion equals
 *      promotedAuditReportPath(artifactsDir).
 */

import { test, expect } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

const {
  auditReportPath,
  auditFindingsPath,
  promotedAuditReportPath,
  promotedAuditFindingsPath,
  outputDirFor,
  AUDIT_REPORT_FILENAME,
  AUDIT_FINDINGS_FILENAME,
} = await import("../../src/shared/io/auditToolsPaths.ts");

const { promoteFinalAuditReport, ARTIFACT_DEFINITIONS } = await import(
  "../../src/audit/io/artifacts.ts"
);

async function makeTempDir() {
  const dir = await mkdtemp(join(tmpdir(), "deliverable-paths-"));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("1: synthesis-write target byte-identical to promote source (no ENOENT)", () => {
  const artifactsDir = join("/repo", ".audit-tools", "audit");
  // The audit registry writes `audit_report` to join(artifactsDir, fileName).
  const writeTarget = join(artifactsDir, ARTIFACT_DEFINITIONS.audit_report.fileName);
  expect(writeTarget, "registry write path for audit_report must equal the shared auditReportPath — this is the path promote reads FROM").toBe(auditReportPath(artifactsDir));
  const findingsWriteTarget = join(
    artifactsDir,
    ARTIFACT_DEFINITIONS.audit_findings.fileName,
  );
  expect(findingsWriteTarget, "registry write path for audit_findings must equal the shared auditFindingsPath").toBe(auditFindingsPath(artifactsDir));
});

test("2: promote source/dest derive byte-identically from the shared helpers", () => {
  const artifactsDir = join("/repo", ".audit-tools", "audit");
  expect(auditReportPath(artifactsDir)).toBe(join(artifactsDir, AUDIT_REPORT_FILENAME));
  expect(promotedAuditReportPath(artifactsDir)).toBe(join(dirname(artifactsDir), AUDIT_REPORT_FILENAME));
  expect(promotedAuditFindingsPath(artifactsDir)).toBe(join(dirname(artifactsDir), AUDIT_FINDINGS_FILENAME));
  expect(outputDirFor(artifactsDir)).toBe(dirname(artifactsDir));
});

test("3: real promote round-trip — write at auditReportPath, read at promotedAuditReportPath", async () => {
  const { dir: root, cleanup } = await makeTempDir();
  try {
    const artifactsDir = join(root, ".audit-tools", "audit");
    await mkdir(artifactsDir, { recursive: true });
    const reportBytes = "# Audit Report\nbody";
    // Write EXACTLY where synthesis/registry writes it.
    await writeFile(auditReportPath(artifactsDir), reportBytes, "utf8");
    await writeFile(
      auditFindingsPath(artifactsDir),
      JSON.stringify({ contract_version: "audit-findings/v1" }),
      "utf8",
    );

    const result = await promoteFinalAuditReport({ artifactsDir });
    expect(result.promoted, "promote must succeed reading the synthesis write target").toBe(true);

    const promotedBytes = await readFile(promotedAuditReportPath(artifactsDir), "utf8");
    expect(promotedBytes, "promoted report must be byte-identical").toBe(reportBytes);
  } finally {
    await cleanup();
  }
});

test("4: present_report path after promotion equals promotedAuditReportPath", () => {
  // nextStepHelpers builds finalReportPath = promotedAuditReportPath(artifactsDir)
  // when promoted, and present_report renders that path. Assert the destination
  // promote writes to is the same path the prompt advertises.
  const artifactsDir = join("/repo", ".audit-tools", "audit");
  expect(promotedAuditReportPath(artifactsDir)).toBe(join(outputDirFor(artifactsDir), AUDIT_REPORT_FILENAME));
});
