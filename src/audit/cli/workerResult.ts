import { formatAuditResultIssues } from "../validation/auditResults.js";

export function formatAuditResultValidationError(
  issues: ReturnType<typeof import("../validation/auditResults.js").validateAuditResults>,
): string {
  return (
    `audit-results validation failed with ${issues.length} error(s):\n` +
    formatAuditResultIssues(issues)
  );
}
