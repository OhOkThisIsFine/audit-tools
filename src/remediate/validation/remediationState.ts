import { RemediationPlanSchema } from "../state/types.js";
import { executionPlanReferenceIssues } from "../../shared/types/executionPlan.js";
// sites-pinned: tests/remediate/validation.test.ts, tests/remediate/clarification-round-contract.test.ts
import {
  type ValidationIssue,
  isRecord,
  pushValidationIssue,
  requireKeys,
} from "audit-tools/shared";
import type { ZodIssue } from "zod";

/** One schema issue as a validation error under `path`. */
function schemaIssue(path: string, issue: ZodIssue): ValidationIssue {
  return { path: `${path}.${issue.path.join(".")}`, message: issue.message, severity: "error" };
}

const VALID_TRIAGE_ACTIONS: ReadonlySet<string> = new Set(["retry", "ignore", "halt"]);

export function validateRemediationPlan(value: unknown, path = "remediation_plan"): ValidationIssue[] {
  const result = RemediationPlanSchema.safeParse(value);
  return result.success
    ? executionPlanReferenceIssues(result.data, result.data.findings.map(finding => finding.id)).map(message => ({ path, message, severity: "error" as const }))
    : result.error.issues.map(issue => schemaIssue(path, issue));
}

export function validateTriageResolution(
  value: unknown,
  path = "triage_resolution",
  knownUnitIds?: ReadonlySet<string>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  issues.push(...requireKeys(value, path, ["items"]));
  if (!isRecord(value)) return issues;

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
      if (typeof item.action !== "string" || !VALID_TRIAGE_ACTIONS.has(item.action)) {
        pushValidationIssue(
          issues,
          `${path}.items[${i}].action`,
          `Expected one of ${[...VALID_TRIAGE_ACTIONS].join(", ")}.`,
        );
      }
    }
  }
  return issues;
}
