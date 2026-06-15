/**
 * seam-schema-validation-single-source.test.mjs
 *
 * Cross-module seam test: schema-validation-single-source
 *
 * Verifies that the runtime validation vocabulary exported by @audit-tools/shared
 * (LENSES, SEVERITIES, CONFIDENCES and their derived Sets) is the ONLY source of
 * truth for lens / severity / confidence validation across both orchestrators.
 * Any drift between:
 *   • shared/src/types/lens.ts  (the authoritative runtime sets), and
 *   • schemas/lens.schema.json  (the authoritative schema enum), and
 *   • remediate-code/schemas/finding.schema.json  (inline enums that must shadow
 *       the shared sets), and
 *   • audit-code/src/validation/auditResults.ts  (hand-rolled validators that must
 *       delegate to the shared sets),
 * will cause at least one assertion in this file to fail.
 *
 * Seam contract (SEAM-schema-validation-single-source):
 *   1. LENSES from shared == enum in audit-code's lens.schema.json.
 *   2. SEVERITIES from shared == severity enum in audit-code's finding.schema.json.
 *   3. CONFIDENCES from shared == confidence enum in audit-code's finding.schema.json.
 *   4. LENSES from shared == lens enum in remediate-code's finding.schema.json.
 *   5. SEVERITIES from shared == severity enum in remediate-code's finding.schema.json.
 *   6. CONFIDENCES from shared == confidence enum in remediate-code's finding.schema.json.
 *   7. validateAuditResults uses the shared VALID_LENSES set (not a hand-rolled copy):
 *      a value accepted by VALID_LENSES passes; one rejected by VALID_LENSES is rejected
 *      by validateAuditResults with a message citing the same member list.
 *   8. validateAuditFindingsReport (shared) enforces contract_version on ingestion and
 *      returns a typed AuditFindingsReport — the single ingestion gate used by both
 *      orchestrators.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const auditCodeRoot = join(here, "..");
const repoRoot = join(auditCodeRoot, "..");

// ── Shared runtime vocabulary ─────────────────────────────────────────────────

const {
  LENSES,
  VALID_LENSES,
  SEVERITIES,
  VALID_SEVERITIES,
  CONFIDENCES,
  VALID_CONFIDENCES,
  AUDIT_FINDINGS_CONTRACT_VERSION,
  validateAuditFindingsReport,
  isValidAuditFindingsReport,
} = await import("@audit-tools/shared");

// ── audit-infra validator (must delegate to shared vocabulary) ────────────────

const { validateAuditResults } = await import(
  "../src/validation/auditResults.ts"
);

// ── Schema files ──────────────────────────────────────────────────────────────

const auditCodeSchemasDir = join(auditCodeRoot, "schemas");
const remediateCodeSchemasDir = join(repoRoot, "remediate-code", "schemas");

async function loadSchema(dir, name) {
  return JSON.parse(await readFile(join(dir, name), "utf8"));
}

// Minimal valid AuditTask for use in validateAuditResults tests
const VALID_TASK = {
  task_id: "seam-task:correctness",
  unit_id: "seam-unit",
  pass_id: "pass:correctness",
  lens: "correctness",
  file_paths: ["src/seam.ts"],
  rationale: "seam test task",
};

// Minimal valid audit result
const VALID_RESULT = {
  task_id: "seam-task:correctness",
  unit_id: "seam-unit",
  pass_id: "pass:correctness",
  lens: "correctness",
  file_coverage: [{ path: "src/seam.ts", total_lines: 10 }],
  findings: [
    {
      id: "SEAM-F001",
      title: "Seam test finding",
      category: "correctness",
      severity: "high",
      confidence: "high",
      lens: "correctness",
      summary: "Seam test.",
      affected_files: [{ path: "src/seam.ts", line_start: 1, line_end: 5 }],
      evidence: ["src/seam.ts:1 — seam test"],
    },
  ],
};

// ── Seam contract 1: LENSES matches audit-code lens.schema.json ───────────────

test("SEAM-1: shared LENSES tuple matches audit-code lens.schema.json enum (same values, same order)", async () => {
  const lensSchema = await loadSchema(auditCodeSchemasDir, "lens.schema.json");
  assert.deepEqual(
    [...LENSES],
    lensSchema.enum,
    "shared LENSES and audit-code lens.schema.json enum must be identical — add to both atomically",
  );
});

// ── Seam contract 2: SEVERITIES matches audit-code finding.schema.json ─────────

test("SEAM-2: shared SEVERITIES tuple matches audit-code finding.schema.json severity enum", async () => {
  const findingSchema = await loadSchema(auditCodeSchemasDir, "finding.schema.json");
  assert.deepEqual(
    [...SEVERITIES],
    findingSchema.properties.severity.enum,
    "shared SEVERITIES and audit-code finding.schema.json severity enum must be identical",
  );
});

// ── Seam contract 3: CONFIDENCES matches audit-code finding.schema.json ────────

test("SEAM-3: shared CONFIDENCES tuple matches audit-code finding.schema.json confidence enum", async () => {
  const findingSchema = await loadSchema(auditCodeSchemasDir, "finding.schema.json");
  assert.deepEqual(
    [...CONFIDENCES],
    findingSchema.properties.confidence.enum,
    "shared CONFIDENCES and audit-code finding.schema.json confidence enum must be identical",
  );
});

// ── Seam contract 4: LENSES matches remediate-code finding.schema.json ─────────

test("SEAM-4: shared LENSES tuple matches remediate-code finding.schema.json lens enum", async () => {
  const findingSchema = await loadSchema(remediateCodeSchemasDir, "finding.schema.json");
  assert.deepEqual(
    [...LENSES],
    findingSchema.properties.lens.enum,
    "shared LENSES and remediate-code finding.schema.json lens enum must be identical — update both atomically",
  );
});

// ── Seam contract 5: SEVERITIES matches remediate-code finding.schema.json ─────

test("SEAM-5: shared SEVERITIES tuple matches remediate-code finding.schema.json severity enum", async () => {
  const findingSchema = await loadSchema(remediateCodeSchemasDir, "finding.schema.json");
  assert.deepEqual(
    [...SEVERITIES],
    findingSchema.properties.severity.enum,
    "shared SEVERITIES and remediate-code finding.schema.json severity enum must be identical",
  );
});

// ── Seam contract 6: CONFIDENCES matches remediate-code finding.schema.json ────

test("SEAM-6: shared CONFIDENCES tuple matches remediate-code finding.schema.json confidence enum", async () => {
  const findingSchema = await loadSchema(remediateCodeSchemasDir, "finding.schema.json");
  assert.deepEqual(
    [...CONFIDENCES],
    findingSchema.properties.confidence.enum,
    "shared CONFIDENCES and remediate-code finding.schema.json confidence enum must be identical",
  );
});

// ── Seam contract 7a: validateAuditResults accepts all VALID_LENSES values ─────

test("SEAM-7a: validateAuditResults accepts every VALID_LENSES member as a result.lens value", () => {
  for (const lens of VALID_LENSES) {
    const result = {
      ...VALID_RESULT,
      task_id: `seam-task:${lens}`,
      lens,
      findings: [
        {
          ...VALID_RESULT.findings[0],
          lens,
        },
      ],
    };
    const task = { ...VALID_TASK, task_id: `seam-task:${lens}`, lens };
    const issues = validateAuditResults([result], [task]);
    const lensErrors = issues.filter(
      (i) => i.severity === "error" && i.field === "lens",
    );
    assert.equal(
      lensErrors.length,
      0,
      `validateAuditResults must accept lens '${lens}' — it is in VALID_LENSES (shared) but was rejected`,
    );
  }
});

// ── Seam contract 7b: validateAuditResults rejects non-VALID_LENSES values ─────

test("SEAM-7b: validateAuditResults rejects a lens value not in VALID_LENSES", () => {
  const bogusLens = "bogus_nonexistent_lens";
  assert.equal(
    VALID_LENSES.has(bogusLens),
    false,
    "Test precondition: bogus lens must not be in shared VALID_LENSES",
  );

  const result = { ...VALID_RESULT, lens: bogusLens };
  const issues = validateAuditResults([result], []);
  const lensErrors = issues.filter(
    (i) => i.severity === "error" && i.field === "lens",
  );
  assert.ok(
    lensErrors.length > 0,
    `validateAuditResults must reject lens '${bogusLens}' which is absent from shared VALID_LENSES`,
  );
  // Error message must cite the same member list that VALID_LENSES would produce
  const validLensesString = [...VALID_LENSES].join(", ");
  assert.ok(
    lensErrors[0].message.includes(validLensesString),
    `rejection message must list the canonical VALID_LENSES values '${validLensesString}'; got: '${lensErrors[0].message}'`,
  );
});

// ── Seam contract 7c: validateAuditResults rejects non-VALID_SEVERITIES values ─

test("SEAM-7c: validateAuditResults rejects a severity value not in VALID_SEVERITIES", () => {
  const bogusSeverity = "extreme";
  assert.equal(
    VALID_SEVERITIES.has(bogusSeverity),
    false,
    "Test precondition: bogus severity must not be in shared VALID_SEVERITIES",
  );

  const result = {
    ...VALID_RESULT,
    findings: [
      { ...VALID_RESULT.findings[0], severity: bogusSeverity },
    ],
  };
  const issues = validateAuditResults([result], []);
  const severityErrors = issues.filter(
    (i) => i.severity === "error" && i.field.includes(".severity"),
  );
  assert.ok(
    severityErrors.length > 0,
    `validateAuditResults must reject severity '${bogusSeverity}' absent from shared VALID_SEVERITIES`,
  );
  const validSeveritiesString = [...VALID_SEVERITIES].join(", ");
  assert.ok(
    severityErrors[0].message.includes(validSeveritiesString),
    `rejection message must list canonical VALID_SEVERITIES '${validSeveritiesString}'; got: '${severityErrors[0].message}'`,
  );
});

// ── Seam contract 7d: validateAuditResults rejects non-VALID_CONFIDENCES values ─

test("SEAM-7d: validateAuditResults rejects a confidence value not in VALID_CONFIDENCES", () => {
  const bogusConfidence = "certain";
  assert.equal(
    VALID_CONFIDENCES.has(bogusConfidence),
    false,
    "Test precondition: bogus confidence must not be in shared VALID_CONFIDENCES",
  );

  const result = {
    ...VALID_RESULT,
    findings: [
      { ...VALID_RESULT.findings[0], confidence: bogusConfidence },
    ],
  };
  const issues = validateAuditResults([result], []);
  const confidenceErrors = issues.filter(
    (i) => i.severity === "error" && i.field.includes(".confidence"),
  );
  assert.ok(
    confidenceErrors.length > 0,
    `validateAuditResults must reject confidence '${bogusConfidence}' absent from shared VALID_CONFIDENCES`,
  );
  const validConfidencesString = [...VALID_CONFIDENCES].join(", ");
  assert.ok(
    confidenceErrors[0].message.includes(validConfidencesString),
    `rejection message must list canonical VALID_CONFIDENCES '${validConfidencesString}'; got: '${confidenceErrors[0].message}'`,
  );
});

// ── Seam contract 8a: validateAuditFindingsReport is the single ingestion gate ──

test("SEAM-8a: validateAuditFindingsReport accepts a well-formed AuditFindingsReport", () => {
  const report = {
    contract_version: AUDIT_FINDINGS_CONTRACT_VERSION,
    findings: [],
  };
  const issues = validateAuditFindingsReport(report);
  const errors = issues.filter((i) => i.severity === "error");
  assert.equal(
    errors.length,
    0,
    `validateAuditFindingsReport must accept a well-formed report; errors: ${JSON.stringify(errors)}`,
  );
});

// ── Seam contract 8b: contract_version absence is flagged as an error ─────────

test("SEAM-8b: validateAuditFindingsReport flags missing contract_version as an error", () => {
  const report = { findings: [] };
  const issues = validateAuditFindingsReport(report);
  const errors = issues.filter((i) => i.severity === "error");
  assert.ok(
    errors.length > 0 && errors.some((i) => i.path.includes("contract_version")),
    "missing contract_version must produce at least one error on the contract_version path",
  );
});

// ── Seam contract 8c: contract_version mismatch is flagged as an error ────────

test("SEAM-8c: validateAuditFindingsReport flags mismatched contract_version as an error", () => {
  const report = { contract_version: "stale-version/v0", findings: [] };
  const issues = validateAuditFindingsReport(report);
  const errors = issues.filter((i) => i.severity === "error");
  assert.ok(
    errors.some((i) => i.path.includes("contract_version")),
    "contract_version mismatch must be an error so the report is rejected (ARC-a8bef662 / OBL-C002)",
  );
});

// ── Seam contract 8d: isValidAuditFindingsReport narrows type correctly ───────

test("SEAM-8d: isValidAuditFindingsReport returns true for valid reports and false for invalid ones", () => {
  const valid = {
    contract_version: AUDIT_FINDINGS_CONTRACT_VERSION,
    findings: [],
  };
  assert.equal(
    isValidAuditFindingsReport(valid),
    true,
    "isValidAuditFindingsReport must return true for a valid report",
  );
  assert.equal(
    isValidAuditFindingsReport(null),
    false,
    "isValidAuditFindingsReport must return false for null",
  );
  assert.equal(
    isValidAuditFindingsReport({ findings: [] }),
    false,
    "isValidAuditFindingsReport must return false when contract_version is missing",
  );
  assert.equal(
    isValidAuditFindingsReport({ contract_version: AUDIT_FINDINGS_CONTRACT_VERSION }),
    false,
    "isValidAuditFindingsReport must return false when findings array is missing",
  );
});

// ── Seam contract 9: no schema adds a new lens without touching shared ─────────
// (drift guard: if someone adds a lens to only one side, this test catches it)

test("SEAM-9: VALID_LENSES set size equals the lens enum length in audit-code lens.schema.json", async () => {
  const lensSchema = await loadSchema(auditCodeSchemasDir, "lens.schema.json");
  assert.equal(
    VALID_LENSES.size,
    lensSchema.enum.length,
    `VALID_LENSES.size (${VALID_LENSES.size}) must equal lens.schema.json enum length (${lensSchema.enum.length}) — both must be updated atomically`,
  );
});

test("SEAM-9b: VALID_LENSES set size equals the lens enum length in remediate-code finding.schema.json", async () => {
  const findingSchema = await loadSchema(remediateCodeSchemasDir, "finding.schema.json");
  assert.equal(
    VALID_LENSES.size,
    findingSchema.properties.lens.enum.length,
    `VALID_LENSES.size (${VALID_LENSES.size}) must equal remediate-code finding.schema.json lens enum length (${findingSchema.properties.lens.enum.length})`,
  );
});
