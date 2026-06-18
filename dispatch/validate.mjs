import { validateAuditResults } from "../dist/audit/validation/auditResults.js";

/**
 * @param {object} resultObj  — parsed JSON from a task-results file
 * @param {object|null} task  — the matching AuditTask from pending-audit-tasks.json, or null
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateResult(resultObj, task) {
  const tasks = task ? [task] : [];
  const lineIndex = task?.file_line_counts ?? {};
  const issues = validateAuditResults([resultObj], tasks, { lineIndex });
  const errors = issues
    .filter(i => i.severity === "error")
    .map(i => `${i.path}: ${i.message}`);
  return { valid: errors.length === 0, errors };
}
