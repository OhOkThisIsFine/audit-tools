import { RemediationPlanSchema } from "../state/types.js";
import { ExecutionUnitSchema, executionPlanReferenceIssues } from "../../shared/types/executionPlan.js";
// sites-pinned: tests/remediate/validation.test.ts, tests/remediate/clarification-round-contract.test.ts
import {
  type ValidationIssue,
  VALID_SEVERITIES,
  VALID_CONFIDENCES,
  isRecord,
  pushValidationIssue,
  requireKeys,
} from "audit-tools/shared";

export function validateFinding(
  value: unknown,
  path = "finding",
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  issues.push(
    ...requireKeys(value, path, [
      "id",
      "title",
      "category",
      "severity",
      "confidence",
      "lens",
      "summary",
      "affected_files",
    ]),
  );
  if (!isRecord(value)) return issues;

  if (
    typeof value.severity === "string" &&
    !VALID_SEVERITIES.has(value.severity)
  ) {
    pushValidationIssue(
      issues,
      `${path}.severity`,
      `Invalid severity "${value.severity}"; expected one of ${[...VALID_SEVERITIES].join(", ")}.`,
    );
  }
  if (
    typeof value.confidence === "string" &&
    !VALID_CONFIDENCES.has(value.confidence)
  ) {
    pushValidationIssue(
      issues,
      `${path}.confidence`,
      `Invalid confidence "${value.confidence}"; expected one of ${[...VALID_CONFIDENCES].join(", ")}.`,
    );
  }
  if (!Array.isArray(value.affected_files)) {
    pushValidationIssue(issues, `${path}.affected_files`, "Expected an array.");
  } else {
    for (const [i, file] of value.affected_files.entries()) {
      if (!isRecord(file) || typeof file.path !== "string") {
        pushValidationIssue(
          issues,
          `${path}.affected_files[${i}]`,
          "Each affected file must be an object with a string 'path' field.",
        );
      }
    }
  }
  if (!Array.isArray(value.evidence) || value.evidence.length === 0) {
    pushValidationIssue(
      issues,
      `${path}.evidence`,
      "Expected a non-empty array.",
      "error",
    );
  }
  return issues;
}

export function validateExecutionUnit(value: unknown, path = "unit"): ValidationIssue[] {
  const result = ExecutionUnitSchema.safeParse(value);
  return result.success ? [] : result.error.issues.map(issue => ({ path: `${path}.${issue.path.join(".")}`, message: issue.message, severity: "error" as const }));
}

export function validateRemediationPlan(value: unknown, path = "remediation_plan"): ValidationIssue[] {
  const result = RemediationPlanSchema.safeParse(value);
  return result.success
    ? executionPlanReferenceIssues(result.data, result.data.findings.map(finding => finding.id)).map(message => ({ path, message, severity: "error" as const }))
    : result.error.issues.map(issue => ({ path: `${path}.${issue.path.join(".")}`, message: issue.message, severity: "error" as const }));
}

export function validateTriageResolution(
  value: unknown,
  path = "triage_resolution",
  knownUnitIds?: ReadonlySet<string>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  issues.push(...requireKeys(value, path, ["items"]));
  if (!isRecord(value)) return issues;

  const validActions = new Set(["retry", "ignore", "halt"]);
  if (!Array.isArray(value.items)) {
    pushValidationIssue(issues, `${path}.items`, "Expected an array.");
  } else {
    for (const [i, item] of value.items.entries()) {
      if (!isRecord(item)) {
        pushValidationIssue(
          issues,
          `${path}.items[${i}]`,
          "Expected an object.",
        );
        continue;
      }
      if (typeof item.unit_id !== "string") {
        pushValidationIssue(
          issues,
          `${path}.items[${i}].unit_id`,
          "Expected a string.",
        );
      } else if (knownUnitIds && !knownUnitIds.has(item.unit_id)) {
        // Uniform id-join contract: an unknown unit_id is an ERROR, never a
        // silent no-op — the entry it names would otherwise be dropped whole,
        // losing the user's triage decision on a typo'd id.
        pushValidationIssue(
          issues,
          `${path}.items[${i}].unit_id`,
          `Unknown unit_id "${item.unit_id}" — not in this run's items. ` +
            `Valid ids: ${[...knownUnitIds].join(", ")}.`,
        );
      }
      if (typeof item.action !== "string" || !validActions.has(item.action)) {
        pushValidationIssue(
          issues,
          `${path}.items[${i}].action`,
          `Expected one of ${[...validActions].join(", ")}.`,
        );
      }
    }
  }
  return issues;
}
