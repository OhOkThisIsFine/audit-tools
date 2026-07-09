/**
 * Seam test: artifact/IPC envelope contract between the auditor and remediator.
 *
 * The auditor writes `audit-findings.json`; the remediator reads it. The
 * contract_version string written by the auditor MUST equal the value that
 * audit-tools/shared (and therefore the remediator) validates against.
 *
 * This test exercises the full cross-module seam and fails whenever either
 * side diverges from the shared contract.
 *
 * Finding: N-TEST-SEAM-artifact-ipc-envelope
 */

import { test, expect } from "vitest";

// ── Shared validator (remediator's expectation) ─────────────────────────────
const {
  AUDIT_FINDINGS_CONTRACT_VERSION: SHARED_CONTRACT_VERSION,
  validateAuditFindingsReport,
  isValidAuditFindingsReport,
} = await import("audit-tools/shared");

// ── Auditor's local constant (what the auditor actually writes) ─────────────
// This is the value stamped onto the `contract_version` field in every
// audit-findings.json that the auditor emits.
const { AUDIT_FINDINGS_CONTRACT_VERSION: AUDITOR_CONTRACT_VERSION } =
  await import("../../src/audit/reporting/synthesis.ts");

// ── 1. Contract-version identity ────────────────────────────────────────────

test("auditor AUDIT_FINDINGS_CONTRACT_VERSION matches shared AUDIT_FINDINGS_CONTRACT_VERSION", () => {
  // If this assertion fails the auditor and remediator have drifted:
  //   auditor writes:       AUDITOR_CONTRACT_VERSION
  //   remediator expects:   SHARED_CONTRACT_VERSION
  // Fix: make packages/audit-code/src/reporting/synthesis.ts import and
  // re-export AUDIT_FINDINGS_CONTRACT_VERSION from audit-tools/shared rather
  // than defining its own copy.
  expect(AUDITOR_CONTRACT_VERSION, `contract_version mismatch: auditor writes "${AUDITOR_CONTRACT_VERSION}" but shared (remediator) expects "${SHARED_CONTRACT_VERSION}"`).toBe(SHARED_CONTRACT_VERSION);
});

// ── 2. Shared validator accepts a minimal auditor-shaped payload ─────────────

/**
 * Build a minimal audit-findings.json payload as the auditor would write it
 * (using AUDITOR_CONTRACT_VERSION, which is what hits disk).
 */
function buildAuditorPayload(overrides = {}) {
  return {
    contract_version: AUDITOR_CONTRACT_VERSION,
    summary: {
      finding_count: 1,
      work_block_count: 1,
      severity_breakdown: { high: 1 },
      audited_file_count: 1,
      excluded_file_count: 0,
      runtime_validation_status_breakdown: {},
    },
    findings: [
      {
        id: "SEAM-001",
        title: "Seam test finding",
        category: "correctness",
        severity: "high",
        confidence: "high",
        lens: "correctness",
        summary: "Seam test finding summary.",
        affected_files: [{ path: "src/foo.ts" }],
        evidence: ["src/foo.ts:1: example evidence"],
      },
    ],
    work_blocks: [
      {
        id: "WB-001",
        finding_ids: ["SEAM-001"],
        unit_ids: ["u-1"],
        owned_files: ["src/foo.ts"],
        max_severity: "high",
        rationale: "Seam test block.",
        depends_on: [],
      },
    ],
    ...overrides,
  };
}

test("isValidAuditFindingsReport accepts a payload stamped with AUDITOR_CONTRACT_VERSION", () => {
  const payload = buildAuditorPayload();
  // When the two constants are in sync, the shared validator accepts the
  // auditor's output. When they diverge this assertion may still pass (the
  // mismatch surfaces as a warning, not an error) but the version-identity
  // test above will fail first.
  const result = isValidAuditFindingsReport(payload);
  expect(result, `Shared validator rejected the auditor payload. Issues: ${JSON.stringify(validateAuditFindingsReport(payload))}`).toBe(true);
});

test("validateAuditFindingsReport returns no errors for a valid auditor payload", () => {
  const issues = validateAuditFindingsReport(buildAuditorPayload());
  const errors = issues.filter((i) => i.severity === "error");
  expect(errors, `Unexpected validation errors: ${JSON.stringify(errors)}`).toEqual([]);
});

test("validateAuditFindingsReport flags absent contract_version as error", () => {
  const { contract_version: _, ...noVersion } = buildAuditorPayload();
  const issues = validateAuditFindingsReport(noVersion);
  const errors = issues.filter((i) => i.severity === "error");
  expect(errors.some((e) => e.message.includes("contract_version")), `Expected a contract_version error, got: ${JSON.stringify(errors)}`).toBeTruthy();
});

test("validateAuditFindingsReport flags absent findings array as error", () => {
  const { findings: _, ...noFindings } = buildAuditorPayload();
  const issues = validateAuditFindingsReport(noFindings);
  const errors = issues.filter((i) => i.severity === "error");
  expect(errors.some((e) => e.message.toLowerCase().includes("findings")), `Expected a findings error, got: ${JSON.stringify(errors)}`).toBeTruthy();
});

// ── 3. WorkBlock → RemediationBlock mapping ──────────────────────────────────
// The WorkBlock.id → RemediationBlock.block_id mapping (formerly exercised here
// via a cross-package import of the remediator's parseAuditFindingsReport) is
// covered directly in the remediator's own suite. The remediate-code peer-package
// import never resolved from audit-code (package boundary), so those two mapping
// assertions were always skipped and carried no coverage — removed. The
// contract_version identity + validator-acceptance seam above still enforces the
// cross-module contract.
