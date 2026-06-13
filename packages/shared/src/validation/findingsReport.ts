/**
 * Validation utilities for AuditFindingsReport — the canonical
 * audit-findings.json contract.
 *
 * INV-shared-core-06: AuditFindingsReport.contract_version must be validated
 * on ingestion (presence + expected value), not read blindly. This module is
 * the single place that performs that check so both orchestrators stay in sync.
 */

import type { AuditFindingsReport } from "../types/finding.js";
import type { ValidationIssue } from "./basic.js";
import { isRecord, pushValidationIssue } from "./basic.js";

/**
 * The expected contract_version value for audit-findings.json.
 * Ingestion must check this; absent or mismatched values are flagged.
 */
export const AUDIT_FINDINGS_CONTRACT_VERSION =
  "audit-tools/audit-findings/v1alpha1" as const;

/**
 * Validate an unknown value as an AuditFindingsReport.
 *
 * Returns a list of ValidationIssues. An empty list means the value is a
 * structurally valid AuditFindingsReport. Issues with severity "error" mean
 * the value cannot be used safely; severity "warning" means the value can be
 * used but callers should surface the concern.
 *
 * INV-shared-core-06: contract_version absence or mismatch is flagged as an
 * error, not silently ignored.
 */
export function validateAuditFindingsReport(
  value: unknown,
  path = "",
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!isRecord(value)) {
    pushValidationIssue(
      issues,
      path,
      `Expected an AuditFindingsReport object, got ${typeof value}.`,
    );
    return issues;
  }

  // INV-shared-core-06: contract_version must be present and match the expected value.
  if (!("contract_version" in value)) {
    pushValidationIssue(
      issues,
      path ? `${path}.contract_version` : "contract_version",
      `Missing required field: contract_version. Expected "${AUDIT_FINDINGS_CONTRACT_VERSION}".`,
    );
  } else if (typeof value.contract_version !== "string") {
    pushValidationIssue(
      issues,
      path ? `${path}.contract_version` : "contract_version",
      `contract_version must be a string, got ${typeof value.contract_version}.`,
    );
  } else if (value.contract_version !== AUDIT_FINDINGS_CONTRACT_VERSION) {
    pushValidationIssue(
      issues,
      path ? `${path}.contract_version` : "contract_version",
      `contract_version mismatch: expected "${AUDIT_FINDINGS_CONTRACT_VERSION}", got "${value.contract_version}".`,
      "warning",
    );
  }

  // findings must be an array.
  if (!("findings" in value)) {
    pushValidationIssue(
      issues,
      path ? `${path}.findings` : "findings",
      `Missing required field: findings.`,
    );
  } else if (!Array.isArray(value.findings)) {
    pushValidationIssue(
      issues,
      path ? `${path}.findings` : "findings",
      `findings must be an array, got ${typeof value.findings}.`,
    );
  }

  // work_blocks must be an array if present.
  if ("work_blocks" in value && !Array.isArray(value.work_blocks)) {
    pushValidationIssue(
      issues,
      path ? `${path}.work_blocks` : "work_blocks",
      `work_blocks must be an array, got ${typeof value.work_blocks}.`,
    );
  }

  // summary must be an object if present.
  if ("summary" in value && (typeof value.summary !== "object" || value.summary === null)) {
    pushValidationIssue(
      issues,
      path ? `${path}.summary` : "summary",
      `summary must be an object, got ${typeof value.summary}.`,
    );
  }

  return issues;
}

/**
 * Type-narrowing guard. Returns true only when the value passes structural
 * validation with no errors. Warnings do not block the guard.
 *
 * Unlike the plain `isAuditFindingsReport` in remediate-code/phases/plan.ts,
 * this guard enforces contract_version presence (INV-shared-core-06).
 */
export function isValidAuditFindingsReport(
  value: unknown,
): value is AuditFindingsReport {
  const issues = validateAuditFindingsReport(value);
  return issues.filter((i) => i.severity === "error").length === 0;
}
