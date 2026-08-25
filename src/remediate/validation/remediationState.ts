import {
  type ValidationIssue,
  isRecord,
  pushValidationIssue,
  prefixValidationIssues,
  requireKeys,
} from "audit-tools/shared";

const VALID_SEVERITIES = new Set(["critical", "high", "medium", "low", "info"]);
const VALID_CONFIDENCES = new Set(["high", "medium", "low"]);
const VALID_CLARIFICATION_CATEGORIES = new Set([
  "public_contract",
  "behavioral_semantics",
  "scope_of_fix",
  "dependency_introduction",
  "compatibility_policy",
  "intent_vs_symptom",
  "issue_appropriateness",
]);

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

export function validateRemediationBlock(
  value: unknown,
  path = "block",
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  issues.push(
    ...requireKeys(value, path, [
      "block_id",
      "items",
      "parallel_safe",
      "touched_files",
    ]),
  );
  if (!isRecord(value)) return issues;

  if (!Array.isArray(value.items)) {
    pushValidationIssue(issues, `${path}.items`, "Expected an array.");
  }
  if (typeof value.parallel_safe !== "boolean") {
    pushValidationIssue(issues, `${path}.parallel_safe`, "Expected a boolean.");
  }
  // touched_files is REQUIRED and array-typed; an empty array is allowed (the
  // block legitimately touches nothing extra), but an omitted field is rejected
  // (requireKeys above) so producers cannot silently drop the surface
  // declaration the file-ownership scheduler depends on (CE-001 chain head).
  if (
    value.touched_files !== undefined &&
    (!Array.isArray(value.touched_files) ||
      value.touched_files.some((f) => typeof f !== "string"))
  ) {
    pushValidationIssue(
      issues,
      `${path}.touched_files`,
      "Expected an array of strings.",
    );
  }
  if (
    value.dependencies !== undefined &&
    (!Array.isArray(value.dependencies) ||
      value.dependencies.some((d) => typeof d !== "string"))
  ) {
    pushValidationIssue(
      issues,
      `${path}.dependencies`,
      "Expected an array of strings when present.",
    );
  }
  return issues;
}

export function validateRemediationPlan(
  value: unknown,
  path = "remediation_plan",
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  issues.push(
    ...requireKeys(value, path, [
      "plan_id",
      "findings",
      "blocks",
      "project_type",
      "candidate_closing_actions",
    ]),
  );
  if (!isRecord(value)) return issues;

  if (!Array.isArray(value.findings)) {
    pushValidationIssue(issues, `${path}.findings`, "Expected an array.");
  } else {
    for (const [i, finding] of value.findings.entries()) {
      issues.push(
        ...prefixValidationIssues(
          `${path}.findings[${i}]`,
          validateFinding(finding, `${path}.findings[${i}]`),
        ),
      );
    }
  }

  if (!Array.isArray(value.blocks)) {
    pushValidationIssue(issues, `${path}.blocks`, "Expected an array.");
  } else {
    for (const [i, block] of value.blocks.entries()) {
      issues.push(
        ...prefixValidationIssues(
          `${path}.blocks[${i}]`,
          validateRemediationBlock(block, `${path}.blocks[${i}]`),
        ),
      );
    }
  }

  if (!Array.isArray(value.candidate_closing_actions)) {
    pushValidationIssue(
      issues,
      `${path}.candidate_closing_actions`,
      "Expected an array.",
    );
  }

  return issues;
}

export function validateClarificationRequest(
  value: unknown,
  path = "clarification",
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  issues.push(
    ...requireKeys(value, path, ["finding_id", "category", "description"]),
  );
  if (!isRecord(value)) return issues;

  if (
    typeof value.category === "string" &&
    !VALID_CLARIFICATION_CATEGORIES.has(value.category)
  ) {
    pushValidationIssue(
      issues,
      `${path}.category`,
      `Invalid category "${value.category}"; expected one of ${[...VALID_CLARIFICATION_CATEGORIES].join(", ")}.`,
    );
  }
  return issues;
}

export function validateTriageResolution(
  value: unknown,
  path = "triage_resolution",
  knownFindingIds?: ReadonlySet<string>,
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
      if (typeof item.finding_id !== "string") {
        pushValidationIssue(
          issues,
          `${path}.items[${i}].finding_id`,
          "Expected a string.",
        );
      } else if (knownFindingIds && !knownFindingIds.has(item.finding_id)) {
        // Uniform id-join contract: an unknown finding_id is an ERROR, never a
        // silent no-op — the entry it names would otherwise be dropped whole,
        // losing the user's triage decision on a typo'd id.
        pushValidationIssue(
          issues,
          `${path}.items[${i}].finding_id`,
          `Unknown finding_id "${item.finding_id}" — not in this run's items. ` +
            `Valid ids: ${[...knownFindingIds].join(", ")}.`,
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
