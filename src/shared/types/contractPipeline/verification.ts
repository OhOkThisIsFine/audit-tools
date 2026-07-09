/**
 * Contract-pipeline artifact: verification phase.
 *
 * VerificationReport — per-finding verification traces and overall verdict.
 * SeamNegotiationRecord — multi-agent seam negotiation record.
 */

// ── Version constants ────────────────────────────────────────────────────────

export const CONTRACT_PIPELINE_VERIFICATION_REPORT_VERSION =
  "remediate-code-verification-report/v1alpha1" as const;

export const CONTRACT_PIPELINE_SEAM_NEGOTIATION_VERSION =
  "remediate-code-contract-pipeline/seam-negotiation/v1alpha1" as const;

// ── VerificationReport ────────────────────────────────────────────────────────

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
  /** Overall report verdict — never "skipped"; see per-finding doc above. */
  overall_status: "passed" | "failed";
  /** ISO-8601 timestamp when this report was created. */
  created_at: string;
}

// ── Multi-agent seam negotiation ──────────────────────────────────────────────

/** Role an agent plays at a multi-agent seam boundary. */
export type SeamRole = "author" | "reviewer" | "verifier" | "judge";

/** One agent's participation in a seam at a DAG node boundary. */
export interface AgentSeam {
  /** Stable identifier for this seam instance. */
  seam_id: string;
  /** DAG node this seam is attached to. */
  node_id: string;
  /** Role this agent plays at the seam. */
  role: SeamRole;
  /** Advisory hint for selecting the agent backend (e.g. "claude-code"). */
  agent_hint?: string;
  /** Artifact path the previous agent writes and this agent reads as handoff. */
  handoff_artifact: string;
  /** Artifact paths this agent must read before starting. */
  read_artifacts: string[];
  /** Artifact paths this agent is allowed to write. */
  write_artifacts: string[];
  /** Constraints the agent must respect (e.g. "must not modify unrelated files"). */
  constraints: string[];
}

/** Record of a seam negotiation pass for a goal's implementation DAG. */
export interface SeamNegotiationRecord {
  contract_version: typeof CONTRACT_PIPELINE_SEAM_NEGOTIATION_VERSION;
  /** Goal this negotiation belongs to. */
  goal_id: string;
  /** All seams across all DAG nodes for this goal. */
  seams: AgentSeam[];
  /** ISO-8601 timestamp when this record was created. */
  created_at: string;
}
