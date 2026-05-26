#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const auditorRoot = resolve(
  process.env.AUDITOR_LAMBDA_ROOT ?? join(repoRoot, "..", "auditor-lambda"),
);
const rendererPath = join(auditorRoot, "dist", "reporting", "synthesis.js");
const outputPath = join(
  repoRoot,
  "tests",
  "fixtures",
  "auditor-contract-audit-report.md",
);

if (!existsSync(rendererPath)) {
  console.error(
    `auditor renderer not found at ${rendererPath}. Build auditor-lambda first or set AUDITOR_LAMBDA_ROOT.`,
  );
  process.exit(1);
}

const { renderAuditReportMarkdown } = await import(pathToFileURL(rendererPath).href);

const model = {
  summary: {
    finding_count: 3,
    work_block_count: 2,
    severity_breakdown: {
      high: 1,
      medium: 1,
      low: 1,
    },
    audited_file_count: 3,
    excluded_file_count: 1,
    runtime_validation_status_breakdown: {},
  },
  work_blocks: [
    {
      id: "block-1",
      finding_ids: ["AUD-001", "AUD-002"],
      unit_ids: ["src-auth"],
      owned_files: ["src/api/auth.ts", "src/lib/session.ts"],
      max_severity: "high",
      depends_on: [],
      rationale:
        "All findings map to the same owned unit and should be remediated together.",
    },
    {
      id: "block-2",
      finding_ids: ["AUD-003"],
      unit_ids: ["src-billing"],
      owned_files: ["src/billing/invoice.ts"],
      max_severity: "low",
      depends_on: ["block-1"],
      rationale:
        "Findings share owned units transitively and should remain one non-overlapping remediation block.",
    },
  ],
  findings: [
    {
      id: "AUD-001",
      title: "Session token accepted without expiry validation",
      category: "security",
      severity: "high",
      confidence: "high",
      lens: "security",
      summary: "Authentication accepts session tokens even when their expiry timestamp is stale.",
      affected_files: [{ path: "src/api/auth.ts" }],
      evidence: [
        "src/api/auth.ts:42 - token.exp is decoded but never checked against the current time.",
        "runtime:auth-expiry: expired token still returned 200.",
      ],
    },
    {
      id: "AUD-002",
      title: "Session refresh path lacks regression coverage",
      category: "tests",
      severity: "medium",
      confidence: "medium",
      lens: "tests",
      summary: "The refresh-token branch has no regression test for rejected expired sessions.",
      affected_files: [
        { path: "src/api/auth.ts" },
        { path: "src/lib/session.ts" },
      ],
      evidence: ["tests/auth.test.ts - no case covers expired refresh sessions."],
    },
    {
      id: "AUD-003",
      title: "Invoice status can be overwritten after finalization",
      category: "correctness",
      severity: "low",
      confidence: "high",
      lens: "correctness",
      summary: "Finalized invoices can be moved back to draft by a generic status update.",
      affected_files: [{ path: "src/billing/invoice.ts" }],
      evidence: ["src/billing/invoice.ts:88 - updateStatus does not guard finalized invoices."],
    },
  ],
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, renderAuditReportMarkdown(model), "utf8");
console.log(`wrote ${outputPath}`);
