export type ValidationSeverity = "error" | "warning";

export interface ValidationIssue {
  path: string;
  message: string;
  severity: ValidationSeverity;
}

export function describeValue(value: unknown): string {
  if (Array.isArray(value)) {
    return "array";
  }
  if (value === null) {
    return "null";
  }
  return typeof value;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createValidationIssue(
  path: string,
  message: string,
  severity: ValidationSeverity = "error",
): ValidationIssue {
  return { path, message, severity };
}

export function pushValidationIssue(
  issues: ValidationIssue[],
  path: string,
  message: string,
  severity: ValidationSeverity = "error",
): void {
  issues.push(createValidationIssue(path, message, severity));
}

export function prefixValidationIssues(
  prefix: string,
  issues: ValidationIssue[],
): ValidationIssue[] {
  return issues.map((issue) => ({
    ...issue,
    path:
      issue.path.length === 0
        ? prefix
        : issue.path === prefix || issue.path.startsWith(`${prefix}.`)
          ? issue.path
          : `${prefix}.${issue.path}`,
  }));
}

export function formatValidationIssues(issues: ValidationIssue[]): string {
  return issues
    .map((issue) => `  [${issue.severity}] ${issue.path}: ${issue.message}`)
    .join("\n");
}

export function requireKeys(
  value: unknown,
  path: string,
  keys: readonly string[],
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!isRecord(value)) {
    pushValidationIssue(
      issues,
      path,
      `Expected an object, got ${describeValue(value)}.`,
    );
    return issues;
  }

  for (const key of keys) {
    if (!(key in value)) {
      pushValidationIssue(issues, path, `Missing required key: ${key}`);
    }
  }
  return issues;
}
