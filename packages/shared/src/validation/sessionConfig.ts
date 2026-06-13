/**
 * SessionConfig validation utilities.
 *
 * INV-shared-core-08: ClaudeCodeConfig.dangerously_skip_permissions is a
 * security-sensitive flag that must be validated/surfaced rather than silently
 * honored. This module provides the canonical validation pass for SessionConfig
 * so both orchestrators produce consistent, auditable warnings.
 */

import type { SessionConfig } from "../types/sessionConfig.js";
import type { ValidationIssue } from "./basic.js";
import { pushValidationIssue } from "./basic.js";

/**
 * Validate a SessionConfig for security-sensitive and misconfiguration issues.
 *
 * Returns a (possibly empty) list of ValidationIssues. Severity "error" means
 * the config cannot be used safely; severity "warning" means the caller should
 * surface the concern before proceeding.
 *
 * INV-shared-core-08: dangerously_skip_permissions=true is flagged as a
 * high-severity warning so operators are always aware when host permission
 * checks are being bypassed.
 */
export function validateSessionConfig(
  config: unknown,
  path = "",
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (config === null || typeof config !== "object") {
    pushValidationIssue(
      issues,
      path,
      `Expected a SessionConfig object, got ${typeof config}.`,
    );
    return issues;
  }

  const c = config as Record<string, unknown>;

  // INV-shared-core-08: flag dangerously_skip_permissions so it is never
  // silently honored. This is a security-sensitive flag — bypasses host
  // permission checks that are the primary guard against unintended writes.
  if (
    c["claude_code"] !== null &&
    typeof c["claude_code"] === "object" &&
    (c["claude_code"] as Record<string, unknown>)["dangerously_skip_permissions"] === true
  ) {
    pushValidationIssue(
      issues,
      path ? `${path}.claude_code.dangerously_skip_permissions` : "claude_code.dangerously_skip_permissions",
      "dangerously_skip_permissions is set to true — this bypasses host permission controls and should only be used in fully trusted, isolated environments. Verify this is intentional.",
      "warning",
    );
  }

  return issues;
}
