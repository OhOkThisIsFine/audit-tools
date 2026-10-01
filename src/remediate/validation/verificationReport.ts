// sites-pinned: tests/remediate/phase-close.test.ts
import { isRecord, type ValidationIssue } from "audit-tools/shared";
export function validateVerificationReport(value: unknown, path = "verification_report"): ValidationIssue[] {
  const errors: string[] = [];
  if (!isRecord(value)) errors.push("Report must be an object.");
  else {
    if (!Array.isArray(value.findings)) errors.push("findings must be an array.");
    if (value.overall_status !== "passed" && value.overall_status !== "failed") errors.push("overall_status must be passed or failed.");
    if (typeof value.created_at !== "string") errors.push("created_at must be a string.");
    for (const finding of Array.isArray(value.findings) ? value.findings : []) {
      if (!isRecord(finding) || typeof finding.finding_id !== "string" || !Array.isArray(finding.traces)) { errors.push("Each finding must identify its source and evidence traces."); continue; }
      if (!["passed", "failed", "skipped"].includes(String(finding.overall_status))) errors.push("Finding status is invalid.");
      for (const trace of finding.traces) if (!isRecord(trace) || typeof trace.trace_id !== "string" || typeof trace.label !== "string" || !Array.isArray(trace.evidence) || !trace.evidence.every(value => typeof value === "string") || !["passed", "failed"].includes(String(trace.status))) errors.push("Malformed verification trace.");
    }
  }
  return errors.map(message => ({path, severity:"error", message}));
}
