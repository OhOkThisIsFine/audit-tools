/**
 * Contract-pipeline artifact contracts. These represent the seven bounded
 * roles of the contract-driven implementation pipeline used by remediate-code
 * for free-form feature/change requests that flow through the full
 * goal→context→design→critique→obligations→assessment→implementation DAG
 * before producing a remediation plan.
 *
 * Each artifact carries a `contract_version` field that must match the
 * exported constant so callers can detect version skew without reading the
 * payload.
 */

// ── Version constants ────────────────────────────────────────────────────────

export const CONTRACT_PIPELINE_GOAL_SPEC_VERSION =
  "remediate-code-contract-pipeline/goal-spec/v1alpha1" as const;

export const CONTRACT_PIPELINE_CONTEXT_BUNDLE_VERSION =
  "remediate-code-contract-pipeline/context-bundle/v1alpha1" as const;

export const CONTRACT_PIPELINE_DESIGN_SPEC_VERSION =
  "remediate-code-contract-pipeline/design-spec/v1alpha1" as const;

export const CONTRACT_PIPELINE_CONCEPTUAL_DESIGN_CRITIQUE_VERSION =
  "remediate-code-contract-pipeline/conceptual-design-critique/v1alpha1" as const;

export const CONTRACT_PIPELINE_OBLIGATION_LEDGER_VERSION =
  "remediate-code-contract-pipeline/obligation-ledger/v1alpha1" as const;

export const CONTRACT_PIPELINE_CONTRACT_ASSESSMENT_REPORT_VERSION =
  "remediate-code-contract-pipeline/contract-assessment-report/v1alpha1" as const;

export const CONTRACT_PIPELINE_COUNTEREXAMPLE_VERSION =
  "remediate-code-contract-pipeline/counterexample/v1alpha1" as const;

export const CONTRACT_PIPELINE_JUDGE_REPORT_VERSION =
  "remediate-code-contract-pipeline/judge-report/v1alpha1" as const;

export const CONTRACT_PIPELINE_IMPLEMENTATION_DAG_VERSION =
  "remediate-code-contract-pipeline/implementation-dag/v1alpha1" as const;

export const CONTRACT_PIPELINE_VERIFICATION_REPORT_VERSION =
  "remediate-code-verification-report/v1alpha1" as const;

// ── GoalSpec ─────────────────────────────────────────────────────────────────

/** Normalized, bounded description of the remediation objective. */
export interface GoalSpec {
  contract_version: typeof CONTRACT_PIPELINE_GOAL_SPEC_VERSION;
  /** Stable identifier for this goal normalization run. */
  goal_id: string;
  /** Single-sentence primary objective. */
  objective: string;
  /** What explicitly lies outside the scope of this change. */
  non_goals: string[];
  /** Success criteria the implementation must satisfy. */
  success_criteria: string[];
  /** Source type that produced this goal spec. */
  source_type: "conversation" | "document" | "structured_audit" | "mixed";
  /** ISO-8601 timestamp when this goal spec was created. */
  created_at: string;
}

// ── ContextBundle ─────────────────────────────────────────────────────────────

/** Relevant code and documentation context collected for the goal. */
export interface ContextBundleEntry {
  path: string;
  kind: "source" | "test" | "config" | "doc";
  /** Brief rationale for why this file is relevant to the goal. */
  relevance_reason: string;
}

export interface ContextBundle {
  contract_version: typeof CONTRACT_PIPELINE_CONTEXT_BUNDLE_VERSION;
  goal_id: string;
  entries: ContextBundleEntry[];
  /** Free-text summary of the collected context landscape. */
  context_summary: string;
  /** ISO-8601 timestamp when this bundle was created. */
  created_at: string;
}

// ── DesignSpec ────────────────────────────────────────────────────────────────

/** Proposed design for satisfying the goal. */
export interface DesignSpecInvariant {
  id: string;
  description: string;
}

export interface DesignSpec {
  contract_version: typeof CONTRACT_PIPELINE_DESIGN_SPEC_VERSION;
  goal_id: string;
  /** High-level narrative description of the proposed design. */
  design_narrative: string;
  /** Public/module boundaries this design must preserve. */
  invariants: DesignSpecInvariant[];
  /** Affected source paths identified by the design. */
  affected_paths: string[];
  /** ISO-8601 timestamp when this design was created. */
  created_at: string;
}

// ── ConceptualDesignCritique ──────────────────────────────────────────────────

/** Philosophy/alternatives/directions critique of the proposed design. */
export interface DesignCritiqueItem {
  id: string;
  kind: "concern" | "alternative" | "suggestion";
  description: string;
  severity: "blocking" | "advisory";
}

export interface ConceptualDesignCritique {
  contract_version: typeof CONTRACT_PIPELINE_CONCEPTUAL_DESIGN_CRITIQUE_VERSION;
  goal_id: string;
  items: DesignCritiqueItem[];
  /** Overall assessment of the design. */
  verdict: "approved" | "approved_with_concerns" | "rejected";
  /** ISO-8601 timestamp when this critique was created. */
  created_at: string;
}

// ── ObligationLedger ──────────────────────────────────────────────────────────

/** One implementation obligation derived from the design. */
export interface ObligationEntry {
  id: string;
  description: string;
  kind: "invariant" | "behavioral" | "structural" | "test";
  /** Obligation IDs that must be satisfied before this one. */
  depends_on: string[];
  /** Current status of this obligation. */
  status: "pending" | "satisfied" | "failed";
}

export interface ObligationLedger {
  contract_version: typeof CONTRACT_PIPELINE_OBLIGATION_LEDGER_VERSION;
  goal_id: string;
  obligations: ObligationEntry[];
  /** ISO-8601 timestamp when this ledger was created. */
  created_at: string;
}

// ── ContractAssessmentReport ──────────────────────────────────────────────────

/** Invariant/boundary/obligation assessment of the design spec. */
export interface ContractAssessmentFinding {
  obligation_id: string;
  status: "satisfied" | "violated" | "uncertain";
  evidence: string[];
  rationale: string;
}

export interface ContractAssessmentReport {
  contract_version: typeof CONTRACT_PIPELINE_CONTRACT_ASSESSMENT_REPORT_VERSION;
  goal_id: string;
  findings: ContractAssessmentFinding[];
  /** Overall pass/fail verdict for the contract assessment. */
  verdict: "passed" | "failed" | "partial";
  /** ISO-8601 timestamp when this report was created. */
  created_at: string;
}

// ── Counterexample ────────────────────────────────────────────────────────────

/** A concrete example that falsifies a design claim. */
export interface Counterexample {
  contract_version: typeof CONTRACT_PIPELINE_COUNTEREXAMPLE_VERSION;
  goal_id: string;
  /** The design claim being falsified. */
  claim: string;
  /** Concrete steps that reproduce the failure. */
  reproduction_steps: string[];
  /** Expected vs. actual behavior. */
  expected: string;
  actual: string;
  /** Which obligation(s) this counterexample violates. */
  violated_obligation_ids: string[];
  /** ISO-8601 timestamp when this counterexample was created. */
  created_at: string;
}

// ── JudgeReport ───────────────────────────────────────────────────────────────

/** Adversarial judge verdict on the design + assessment. */
export interface JudgeReport {
  contract_version: typeof CONTRACT_PIPELINE_JUDGE_REPORT_VERSION;
  goal_id: string;
  /** Overall verdict. */
  verdict: "approved" | "rejected" | "needs_repair";
  /** Detailed findings from the adversarial review. */
  findings: {
    id: string;
    description: string;
    severity: "blocking" | "advisory";
    related_obligation_ids: string[];
  }[];
  /** Required repairs before the design may proceed to implementation. */
  required_repairs: string[];
  /** ISO-8601 timestamp when this report was created. */
  created_at: string;
}

// ── ImplementationDAG ─────────────────────────────────────────────────────────

/** One node in the implementation DAG. */
export interface ImplementationDAGNode {
  id: string;
  title: string;
  description: string;
  /** Obligation IDs this task satisfies. */
  satisfies_obligations: string[];
  /** Task IDs that must complete before this task starts. */
  depends_on: string[];
  /** Verification obligation IDs that must pass after this task. */
  verification_obligation_ids: string[];
  /** Commands to run to verify this task's output. */
  targeted_commands: string[];
  /** Current status of this task. */
  status: "pending" | "in_progress" | "resolved" | "blocked";
}

/** One directed edge in the implementation DAG. */
export interface ImplementationDAGEdge {
  from: string;
  to: string;
  kind: "dependency" | "verification";
}

export interface ImplementationDAG {
  contract_version: typeof CONTRACT_PIPELINE_IMPLEMENTATION_DAG_VERSION;
  goal_id: string;
  nodes: ImplementationDAGNode[];
  edges: ImplementationDAGEdge[];
  /** ISO-8601 timestamp when this DAG was created. */
  created_at: string;
}

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

/** Per-finding verification trace. */
export interface FindingVerificationTrace {
  finding_id: string;
  traces: VerificationTraceEntry[];
  overall_status: "passed" | "failed";
}

export interface VerificationReport {
  contract_version: typeof CONTRACT_PIPELINE_VERIFICATION_REPORT_VERSION;
  goal_id?: string;
  /** Per-finding verification traces. */
  findings: FindingVerificationTrace[];
  /** Overall report verdict. */
  overall_status: "passed" | "failed";
  /** ISO-8601 timestamp when this report was created. */
  created_at: string;
}
