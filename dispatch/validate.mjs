import { validateAuditResults } from "../dist/audit/validation/auditResults.js";

/**
 * Validate one audit result in the context of its assigned task.
 *
 * Task-identity gate (audit-merge-and-results contract; COR-7602834d cluster):
 * a result validates ONLY in the context of its
 * assigned task from the pending manifest. A null/absent task context hard-fails
 * — validating with no task context would silently skip every identity-match and
 * line-count check (fail-open), admitting results the tool cannot bind to any
 * assigned task.
 *
 * @param {object} resultObj  — parsed JSON from a task-results file
 * @param {object|null} task  — the matching AuditTask from pending-audit-tasks.json, or null
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateResult(resultObj, task) {
  if (!task) {
    return {
      valid: false,
      errors: [
        "No assigned task context: a result validates only against its assigned task " +
          "from pending-audit-tasks.json (fail-closed).",
      ],
    };
  }
  const issues = validateAuditResults([resultObj], [task], {
    lineIndex: task.file_line_counts ?? {},
  });
  const errors = issues
    .filter(i => i.severity === "error")
    .map(i => `${i.path}: ${i.message}`);
  return { valid: errors.length === 0, errors };
}
