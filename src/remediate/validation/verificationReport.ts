// sites-pinned: tests/remediate/phase-close.test.ts, tests/remediate/artifacts-validation.test.ts
import { CONTRACT_PIPELINE_VERIFICATION_REPORT_VERSION, isRecord, type ValidationIssue } from "audit-tools/shared";

export function validateVerificationReport(value: unknown, path = "verification_report"): ValidationIssue[] {
  const errors: string[] = [];
  function validateEntries(entries: unknown, identity: "finding_id" | "unit_id"): void {
    if (!Array.isArray(entries)) { errors.push(`${identity === "finding_id" ? "findings" : "units"} must be an array.`); return; }
    for (const entry of entries) {
      if (!isRecord(entry) || typeof entry[identity] !== "string" || !entry[identity] || !Array.isArray(entry.traces)) {
        errors.push(`Each ${identity} must identify its source and evidence traces.`);
        continue;
      }
      if (identity === "unit_id" && (!Array.isArray(entry.source_finding_ids) || !entry.source_finding_ids.every(id => typeof id === "string" && id.length > 0))) {
        errors.push("Unit source_finding_ids must be an array of non-empty strings.");
      }
      if (!["passed", "failed", "skipped"].includes(String(entry.overall_status))) errors.push(`${identity} status is invalid.`);
      for (const trace of entry.traces) {
        if (!isRecord(trace) || typeof trace.trace_id !== "string" || typeof trace.label !== "string" ||
            !["requirement", "invariant", "counterexample", "task", "file", "command"].includes(String(trace.kind)) ||
            !Array.isArray(trace.evidence) || !trace.evidence.every(value => typeof value === "string") ||
            !["passed", "failed"].includes(String(trace.status))) errors.push("Malformed verification trace.");
      }
    }
  }
  if (!isRecord(value)) errors.push("Report must be an object.");
  else {
    if (value.contract_version !== CONTRACT_PIPELINE_VERIFICATION_REPORT_VERSION) errors.push("Unsupported verification report contract_version.");
    if (value.overall_status !== "passed" && value.overall_status !== "failed") errors.push("overall_status must be passed or failed.");
    if (typeof value.created_at !== "string") errors.push("created_at must be a string.");
    validateEntries(value.findings, "finding_id");
    // Optional in the owning contract; archive identity checks require planned units.
    if (value.units !== undefined) validateEntries(value.units, "unit_id");
  }
  return errors.map(message => ({ path, severity: "error", message }));
}
