// sites-pinned: tests/remediate/phase-close.test.ts, tests/remediate/unit-source-outcomes.test.ts, tests/remediate/cp-node-1-regressions.test.ts
/** Landed requirement, source-finding and execution-unit verification evidence. */
export const CONTRACT_PIPELINE_VERIFICATION_REPORT_VERSION =
  "remediate-code-verification-report/v1alpha1" as const;

/** One verification trace entry mapping a requirement to evidence. */
export interface VerificationTraceEntry {
  trace_id: string;
  kind:
    | "requirement"
    | "invariant"
    | "counterexample"
    | "task"
    | "file"
    | "command";
  label: string;
  evidence: string[];
  status: "passed" | "failed";
}

/**
 * Per-finding verification trace.
 *
 * `overall_status` is `"skipped"` for findings whose item was settled by user
 * decision (ignored / deemed inappropriate) rather than verified — these are
 * honest, first-class outcomes, not failures and not passes.
 */
export interface FindingVerificationTrace {
  finding_id: string;
  traces: VerificationTraceEntry[];
  overall_status: "passed" | "failed" | "skipped";
}

/**
 * Report-level `overall_status` stays a strict `"passed" | "failed"` — it is
 * a run verdict, not a per-finding trace, so it never itself carries
 * `"skipped"`. Per-finding `"skipped"` results are excluded from the verdict
 * computation entirely (neither pass nor fail it): the report is `"passed"`
 * when every non-skipped finding passed (including the all-skipped case,
 * where the verdict reduces to the combined test/closing-action outcome).
 */
export interface VerificationReport {
  contract_version: typeof CONTRACT_PIPELINE_VERIFICATION_REPORT_VERSION;
  goal_id?: string;
  /** Per-finding verification traces. */
  findings: FindingVerificationTrace[];
  /** Execution-unit traces remain present for source-free conversation requests. */
  units?: Array<{ unit_id: string; source_finding_ids: string[]; traces: VerificationTraceEntry[]; overall_status: "passed" | "failed" | "skipped" }>;
  /** Overall report verdict — never "skipped"; see per-finding doc above. */
  overall_status: "passed" | "failed";
  /** ISO-8601 timestamp when this report was created. */
  created_at: string;
}
