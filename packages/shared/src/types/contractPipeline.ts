/**
 * Contract-pipeline artifact contracts. These represent the bounded roles of
 * the contract-driven implementation pipeline used by remediate-code for
 * free-form feature/change requests that flow through the full
 * goal→context→design→critique→obligations→assessment→critic→judge→
 * implementation DAG before producing a remediation plan.
 *
 * Each artifact carries a `contract_version` field that must match the
 * exported constant so callers can detect version skew without reading the
 * payload.
 */

import type { FindingSeverity } from "./finding.js";

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

export const CONTRACT_PIPELINE_SEAM_NEGOTIATION_VERSION =
  "remediate-code-contract-pipeline/seam-negotiation/v1alpha1" as const;

export const CONTRACT_PIPELINE_TEST_VALIDATOR_PLAN_VERSION =
  "remediate-code-contract-pipeline/test-validator-plan/v1alpha1" as const;

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

/** Optional structured annotation: one module with declared inputs and outputs. */
export interface DesignSpecModule {
  id: string;
  inputs: string[];
  outputs: string[];
}

/** Optional structured annotation: one side effect with a declared owner. */
export interface DesignSpecSideEffect {
  id: string;
  owner: string;
}

/** Optional structured annotation: one external dependency with failure semantics. */
export interface DesignSpecExternalDependency {
  id: string;
  failure_semantics: string;
}

/** Optional structured annotation: one trust boundary with untrusted inputs and a validation ref. */
export interface DesignSpecTrustBoundary {
  id: string;
  untrusted_inputs: string[];
  validation_ref: string;
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
  /** Optional: structured module annotations (id, inputs, outputs). */
  modules?: DesignSpecModule[];
  /** Optional: structured side-effect annotations (id, owner). */
  side_effects?: DesignSpecSideEffect[];
  /** Optional: structured external-dependency annotations (id, failure_semantics). */
  external_dependencies?: DesignSpecExternalDependency[];
  /** Optional: structured trust-boundary annotations (id, untrusted_inputs, validation_ref). */
  trust_boundaries?: DesignSpecTrustBoundary[];
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
  /** Lower value = higher priority; enables first-class scheduling. */
  priority?: number;
  /** Traceability: where this obligation originated. */
  source?: "design_spec" | "critique" | "counterexample" | "manual";
}

export interface ObligationLedger {
  contract_version: typeof CONTRACT_PIPELINE_OBLIGATION_LEDGER_VERSION;
  goal_id: string;
  obligations: ObligationEntry[];
  /** ISO-8601 timestamp when this ledger was created. */
  created_at: string;
}

// ── TestValidatorPlan ─────────────────────────────────────────────────────────

/** One test spec derived from a ledger obligation, to be created before code. */
export interface TestSpec {
  /** The obligation ID from the ObligationLedger this test spec covers. */
  obligation_id: string;
  /** Short name for this test. */
  name: string;
  /** Kind of test. */
  kind: "unit" | "integration" | "schema" | "invariant" | "e2e";
  /** Concrete, falsifiable assertion strings for this test. Must be non-empty. */
  assertions: string[];
  /**
   * When present, declares this test inapplicable. The claim must cite the
   * specific obligation ID and provide a falsifiable reason checkable against
   * the ledger — bare rationale is insufficient.
   */
  inapplicable_claim?: {
    /** The obligation ID this claim disputes (must match obligation_id above). */
    obligation_id: string;
    /** Falsifiable reason why this test is inapplicable per the ledger. */
    reason: string;
  };
}

/**
 * Pre-code test specification plan: converts ledger obligations into concrete
 * test specs, validators, and schemas BEFORE any implementation begins.
 */
export interface TestValidatorPlan {
  contract_version: typeof CONTRACT_PIPELINE_TEST_VALIDATOR_PLAN_VERSION;
  goal_id: string;
  test_specs: TestSpec[];
  /** ISO-8601 timestamp when this plan was created. */
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

/** A concrete example produced by the adversarial critic that falsifies a design claim. */
export interface Counterexample {
  /** Stable identifier (referenced by the judge report and implementation DAG). */
  id: string;
  /** The design claim being falsified. */
  claim: string;
  /** Concrete steps that reproduce the failure. */
  reproduction_steps: string[];
  /** Expected vs. actual behavior. */
  expected: string;
  actual: string;
  /** Which obligation(s) this counterexample violates. */
  violated_obligation_ids: string[];
}

/** The critic phase's output artifact: all counterexamples found against the design. */
export interface CounterexampleReport {
  contract_version: typeof CONTRACT_PIPELINE_COUNTEREXAMPLE_VERSION;
  goal_id: string;
  /** Empty when the critic found no way to falsify the design. */
  counterexamples: Counterexample[];
  /** ISO-8601 timestamp when this report was created. */
  created_at: string;
}

// ── JudgeReport ───────────────────────────────────────────────────────────────

/** Judge classification of one counterexample. */
export type CounterexampleClassification =
  | "accepted"
  | "out_of_scope"
  | "duplicate"
  | "invalid"
  | "residual_risk";

export interface JudgedCounterexample {
  counterexample_id: string;
  classification: CounterexampleClassification;
  rationale: string;
}

/** Contract artifacts the judge may order regenerated. */
export type JudgeRepairTarget =
  | "design_spec"
  | "obligation_ledger"
  | "contract_assessment_report";

/** On a failing verdict, the single targeted repair the loop performs next. */
export interface JudgeRepairDirective {
  target: JudgeRepairTarget;
  /** Bounded instruction for the regeneration worker. */
  instruction: string;
}

/** Adversarial judge verdict on the critic's counterexamples. */
export interface JudgeReport {
  contract_version: typeof CONTRACT_PIPELINE_JUDGE_REPORT_VERSION;
  goal_id: string;
  /**
   * `approved` when no accepted counterexample demands a contract repair
   * (residual risks may remain, recorded in `classifications`); `needs_repair`
   * when at least one accepted counterexample requires regenerating a contract
   * artifact before implementation planning.
   */
  verdict: "approved" | "needs_repair";
  /** One classification per critic counterexample. */
  classifications: JudgedCounterexample[];
  /** Required when verdict is `needs_repair`; names the artifact to regenerate. */
  repair_directive?: JudgeRepairDirective;
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
  /** Accepted counterexample IDs (from the judge report) this task addresses. */
  addresses_counterexamples?: string[];
  /** Task IDs that must complete before this task starts. */
  depends_on: string[];
  /** Verification obligation IDs that must pass after this task. */
  verification_obligation_ids: string[];
  /** Commands to run to verify this task's output. */
  targeted_commands: string[];
  /** Current status of this task. */
  status: "pending" | "in_progress" | "resolved" | "blocked";
  /** Repo-relative paths this node will modify (write scope). */
  affected_files?: string[];
  /**
   * Repo-relative paths this node will create or modify (declared outputs).
   * Written by the implementation-planning LLM. Promoted to `affected_files`
   * in the extracted plan so the document worker gets a non-degenerate read
   * allowlist. Optional: existing DAGs without it remain valid.
   */
  output_files?: string[];
  /** Repo-relative paths the worker must read (context scope). */
  read_scope?: string[];
  /** Audit lens this node targets (mirrors Finding.lens). */
  lens?: string;
  /** Severity inherited from the driving finding. */
  severity?: FindingSeverity;
  /** Repo-relative files this node is expected to touch (from finalized module contract scope). */
  files_likely_touched?: string[];
  /** Upstream contracts' declared outputs this node depends on (preconditions). */
  preconditions?: string[];
  /** Human-readable description of the concrete changes this node is expected to produce. */
  expected_changes?: string;
  /** Human-readable verification checks beyond targeted_commands. */
  verification?: string[];
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
