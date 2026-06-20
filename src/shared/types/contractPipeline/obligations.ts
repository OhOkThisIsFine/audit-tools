/**
 * Contract-pipeline artifact: obligations phase.
 *
 * ObligationLedger — implementation obligations derived from the design.
 * TestValidatorPlan — pre-code test specs derived from ledger obligations.
 * ContractAssessmentReport — invariant/boundary/obligation assessment.
 * CounterexampleReport — adversarial critic output.
 * JudgeReport — adversarial judge verdict on counterexamples.
 */

// ── Version constants ────────────────────────────────────────────────────────

export const CONTRACT_PIPELINE_OBLIGATION_LEDGER_VERSION =
  "remediate-code-contract-pipeline/obligation-ledger/v1alpha1" as const;

export const CONTRACT_PIPELINE_TEST_VALIDATOR_PLAN_VERSION =
  "remediate-code-contract-pipeline/test-validator-plan/v1alpha1" as const;

export const CONTRACT_PIPELINE_CONTRACT_ASSESSMENT_REPORT_VERSION =
  "remediate-code-contract-pipeline/contract-assessment-report/v1alpha1" as const;

export const CONTRACT_PIPELINE_COUNTEREXAMPLE_VERSION =
  "remediate-code-contract-pipeline/counterexample/v1alpha1" as const;

export const CONTRACT_PIPELINE_JUDGE_REPORT_VERSION =
  "remediate-code-contract-pipeline/judge-report/v1alpha1" as const;

// ── ObligationLedger ──────────────────────────────────────────────────────────

/**
 * Change-vs-addition classification for one obligation (DC-5 / CE-013).
 *
 * Whether an obligation *changes existing behavior* or *adds new behavior*
 * decides its test burden: a behavior CHANGE must be covered by a PAIRED
 * positive+negative test spec whose negative is scoped to the changed
 * symbol/file (so a regression is caught), whereas a pure ADDITION has no prior
 * behavior to regress and is never forced to pair.
 *
 * The verdict is reached deterministically FIRST — `touches_existing_symbol`
 * means the obligation references a symbol/file that already exists in the
 * baseline corpus — and an LLM may then CONFIRM or OVERRIDE it. The method is
 * recorded on `determined_by` so the classification is never silent (the
 * "deterministic by default; LLM only for judgment — bounded and recorded"
 * invariant).
 */
export interface ObligationChangeClassification {
  /** A `change` touches prior behavior (→ paired test); an `addition` does not. */
  change_kind: "change" | "addition";
  /**
   * Existing symbol/file tokens the change touches. These are the scope anchors
   * a paired negative assertion must name — an unscoped, repo-wide negative
   * (CE-006) is rejected because it matches none of them. Empty for an addition.
   */
  touched_symbols: string[];
  /**
   * How the verdict was reached. The deterministic heuristic runs first; an LLM
   * confirmation/override (when present) is recorded here, never discarded.
   */
  determined_by:
    | "touches_existing_symbol"
    | "no_existing_symbol"
    | "llm_confirmed"
    | "llm_override";
  /** Recorded rationale when an LLM confirmed or overrode the deterministic call. */
  rationale?: string;
}

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
  /**
   * DC-5: change-vs-addition classification. Present on testable
   * (invariant/behavioral) obligations the deriver classified; absent on
   * structural obligations (no test burden) and on obligations from sources
   * that predate the classifier. The paired-test gate treats an *unclassified*
   * testable obligation as a CHANGE (fail-closed): pairing is only relaxed when
   * an obligation is explicitly classified as an addition.
   */
  change_classification?: ObligationChangeClassification;
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
