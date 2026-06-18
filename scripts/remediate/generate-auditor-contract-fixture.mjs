#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AUDIT_FINDINGS_CONTRACT_VERSION } from "audit-tools/shared";

// The remediator consumes the auditor's canonical audit-findings.json (Phase 6/7),
// so this fixture is that machine contract. The `model` below mirrors the shape
// the auditor's buildAuditFindingsReport emits; serialising it keeps the fixture
// in sync without requiring a built auditor-lambda.
const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const committedFixturePath = join(
  repoRoot,
  "tests",
  "remediate",
  "fixtures",
  "auditor-contract-audit-findings.json",
);

// Allow callers (e.g. the drift-guard test) to redirect output to a temp dir
// without touching the committed fixture. Priority: argv[2] > env var > committed path.
const outputPath =
  process.argv[2] ??
  process.env["REMEDIATE_FIXTURE_OUT"] ??
  committedFixturePath;

const model = {
  contract_version: AUDIT_FINDINGS_CONTRACT_VERSION,
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
await writeFile(outputPath, `${JSON.stringify(model, null, 2)}\n`, "utf8");
console.log(`wrote ${outputPath}`);
