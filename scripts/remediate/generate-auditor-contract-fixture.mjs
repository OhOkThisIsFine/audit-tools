#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AUDIT_FINDINGS_CONTRACT_VERSION,
  FINDINGS_DRAW_COHERENCE_POLICY,
  buildContentCoherenceTrace,
  deriveWorkBlockSeams,
} from "audit-tools/shared";

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

const findings = [
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
];

const unitIdsByFinding = new Map([
  ["AUD-001", ["src-auth"]],
  ["AUD-002", ["src-auth"]],
  ["AUD-003", ["src-billing"]],
]);
const coherenceTrace = buildContentCoherenceTrace(
  {
    items: findings.map((finding) => ({
      id: finding.id,
      file_paths: finding.affected_files.map((location) => location.path),
      unit_ids: unitIdsByFinding.get(finding.id) ?? [],
      tags: [finding.lens],
    })),
  },
  FINDINGS_DRAW_COHERENCE_POLICY,
);

const model = {
  contract_version: AUDIT_FINDINGS_CONTRACT_VERSION,
  summary: {
    finding_count: 3,
    work_block_count: 3,
    severity_breakdown: {
      high: 1,
      medium: 1,
      low: 1,
    },
    audited_file_count: 3,
    excluded_file_count: 1,
    runtime_validation_status_breakdown: {},
  },
  coherence_trace: coherenceTrace,
  // One block per coherence component (the report contract requires exactly
  // that). The findings draw joins only on shared file AND shared lens, and
  // these three findings carry three different lenses, so each stands alone —
  // AUD-001/AUD-002 contest `src/api/auth.ts`, which the derived seam below
  // records. Only the blocks are hand-written here; the seams come from the ONE
  // shared derivation, so the fixture cannot claim an overlap topology the
  // producer would not emit.
  work_blocks: [
    {
      id: "block-1",
      finding_ids: ["AUD-001"],
      unit_ids: ["src-auth"],
      owned_files: ["src/api/auth.ts"],
      role: "implementation",
      max_severity: "high",
      depends_on: [],
      rationale: "Canonical coherence component with 1 finding(s).",
    },
    {
      id: "block-2",
      finding_ids: ["AUD-002"],
      unit_ids: ["src-auth"],
      owned_files: ["src/api/auth.ts", "src/lib/session.ts"],
      role: "implementation",
      max_severity: "medium",
      depends_on: [],
      rationale: "Canonical coherence component with 1 finding(s).",
    },
    {
      id: "block-3",
      finding_ids: ["AUD-003"],
      unit_ids: ["src-billing"],
      owned_files: ["src/billing/invoice.ts"],
      role: "implementation",
      max_severity: "low",
      depends_on: [],
      rationale: "Canonical coherence component with 1 finding(s).",
    },
  ],
  findings,
};
model.work_block_seams = deriveWorkBlockSeams(model.work_blocks);

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(model, null, 2)}\n`, "utf8");
console.log(`wrote ${outputPath}`);
