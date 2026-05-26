import {
  type ValidationIssue,
  isRecord,
  pushValidationIssue,
  prefixValidationIssues,
  requireKeys,
} from "./basic.js";

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
    ...requireKeys(value, path, ["block_id", "items", "parallel_safe"]),
  );
  if (!isRecord(value)) return issues;

  if (!Array.isArray(value.items)) {
    pushValidationIssue(issues, `${path}.items`, "Expected an array.");
  }
  if (typeof value.parallel_safe !== "boolean") {
    pushValidationIssue(issues, `${path}.parallel_safe`, "Expected a boolean.");
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

export function validateItemSpec(
  value: unknown,
  path = "item_spec",
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  issues.push(
    ...requireKeys(value, path, [
      "finding_id",
      "concrete_change",
      "tests_to_write",
      "not_applicable_steps",
    ]),
  );
  if (!isRecord(value)) return issues;

  if (!Array.isArray(value.tests_to_write)) {
    pushValidationIssue(issues, `${path}.tests_to_write`, "Expected an array.");
  } else {
    for (const [i, test] of value.tests_to_write.entries()) {
      if (!isRecord(test) || typeof test.name !== "string") {
        pushValidationIssue(
          issues,
          `${path}.tests_to_write[${i}]`,
          "Each test must be an object with a string 'name' field.",
        );
      }
      if (isRecord(test) && !Array.isArray(test.assertions)) {
        pushValidationIssue(
          issues,
          `${path}.tests_to_write[${i}].assertions`,
          "Expected an array.",
        );
      }
    }
  }

  if (!Array.isArray(value.not_applicable_steps)) {
    pushValidationIssue(
      issues,
      `${path}.not_applicable_steps`,
      "Expected an array.",
    );
  } else {
    const validSteps = new Set([
      "Document",
      "Write Tests",
      "Refactor Code",
      "Verify Code Against Tests",
      "Verify Code Against Documentation",
    ]);
    for (const [i, step] of value.not_applicable_steps.entries()) {
      if (
        !isRecord(step) ||
        typeof step.step !== "string" ||
        !validSteps.has(step.step)
      ) {
        pushValidationIssue(
          issues,
          `${path}.not_applicable_steps[${i}]`,
          `Each not-applicable step must be an object with a valid 'step' field.`,
        );
      }
      if (isRecord(step) && typeof step.rationale !== "string") {
        pushValidationIssue(
          issues,
          `${path}.not_applicable_steps[${i}].rationale`,
          "Expected a string rationale.",
        );
      }
    }
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

export function validateDocumentResponse(
  value: unknown,
  path = "document_response",
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!isRecord(value)) {
    pushValidationIssue(issues, path, "Expected an object.");
    return issues;
  }

  if (value.type !== "item_spec" && value.type !== "clarification_request") {
    pushValidationIssue(
      issues,
      `${path}.type`,
      `Expected "item_spec" or "clarification_request", got "${value.type}".`,
    );
    return issues;
  }

  if (value.type === "item_spec") {
    if (!isRecord(value.item_spec)) {
      pushValidationIssue(
        issues,
        `${path}.item_spec`,
        "Expected an object when type is 'item_spec'.",
      );
    } else {
      issues.push(...validateItemSpec(value.item_spec, `${path}.item_spec`));
    }
  }

  if (value.type === "clarification_request") {
    if (
      !Array.isArray(value.clarifications) ||
      value.clarifications.length === 0
    ) {
      pushValidationIssue(
        issues,
        `${path}.clarifications`,
        "Expected a non-empty array when type is 'clarification_request'.",
      );
    } else {
      for (const [i, clar] of value.clarifications.entries()) {
        issues.push(
          ...validateClarificationRequest(clar, `${path}.clarifications[${i}]`),
        );
      }
    }
  }

  return issues;
}

export function validateTriageResolution(
  value: unknown,
  path = "triage_resolution",
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
