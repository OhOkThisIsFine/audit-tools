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
   * The finalized module this obligation belongs to (design_spec-sourced
   * obligations only). Lets the implementation-DAG scaffold group a module's
   * obligations into ONE node by construction — a 1-module change derives 1
   * node instead of N (B2) — without the host having to merge. Absent on
   * obligations with no module home (e.g. counterexample/critique-sourced),
   * which fall back to one node each.
   */
  module?: string;
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

/**
 * `judge_report.repair_directive.target` — the artifacts a repair may name.
 *
 * DECLARED HERE, in `src/shared`, because this module is the base layer and the
 * type below derives from it: `src/shared` must not import an orchestrator, and
 * a declaration living in `src/remediate` was exactly that. The remediate side
 * re-exports these through `contractPipeline/sketchSource.ts`, so the validator
 * and every prompt sketch still read them from there.
 *
 * `design_spec` is the PRE-REDESIGN name for what `finalized_module_contracts`
 * holds, and it stays here on purpose: the validator has a named back-compat
 * test for it, and a judge report written by an older release must still be
 * admissible. It is NOT offered in the prompt sketch
 * ({@link CONTRACT_REPAIR_TARGETS_OFFERED}), because no new report should be
 * authored against a name the repair loop normalizes away — the asymmetry is
 * the same accept-legacy / emit-current split the store's version policy uses.
 */
export const CONTRACT_REPAIR_TARGETS = [
  "finalized_module_contracts",
  "obligation_ledger",
  "contract_assessment_report",
  "counterexample",
  "design_spec",
] as const;

/**
 * The values a validator still ACCEPTS but no sketch OFFERS — the
 * accept-legacy / emit-current split, declared as data.
 *
 * Why it is a declaration rather than an `offeredExclusions` entry in the drift
 * test. The exclusion WAS declared in the test, and that is exactly the shape
 * this vocabulary bans: a hand-kept list that has to be edited in lockstep with
 * the declaration it describes. The test's own `CONTRACT_REPAIR_TARGETS_OFFERED`
 * import made the drift worse — the SKETCH's offered set and the TEST's expected
 * offered set came from one expression, so a target quietly dropped from the
 * offered set would move both sides together and stay green.
 *
 * Single-sourced instead: the offered set is {@link CONTRACT_REPAIR_TARGETS}
 * minus THIS list, the sketch renders that set, and the drift test derives its
 * expectation from the same subtraction. A new legacy alias is one entry here
 * and nothing else moves.
 */
export const CONTRACT_REPAIR_TARGETS_LEGACY = ["design_spec"] as const;

/**
 * The subset a prompt OFFERS: everything admissible except the legacy aliases.
 *
 * Derived, not a second list — the live targets are
 * {@link CONTRACT_REPAIR_TARGETS_LEGACY}'s complement in
 * {@link CONTRACT_REPAIR_TARGETS}, so adding a target adds it to the sketch
 * automatically and removing one cannot leave a stale alternation behind.
 */
export const CONTRACT_REPAIR_TARGETS_OFFERED = CONTRACT_REPAIR_TARGETS.filter(
  (target) =>
    !(CONTRACT_REPAIR_TARGETS_LEGACY as readonly string[]).includes(target),
);

/**
 * Contract artifacts the judge may order regenerated — DERIVED from the one
 * declaration above, which the validator and every prompt sketch also read.
 * Restating the members on the type is how it came to disagree with the
 * validator once already: the sketch offered three, the validator four, and the
 * type a third set.
 *
 * `finalized_module_contracts` is the post-redesign name for what `design_spec`
 * used to hold, and the four non-legacy members are exactly the artifacts a
 * repair can regenerate. `finalized_module_contracts` and `counterexample` are
 * absent from this union's history only because the union predated them.
 *
 * A `design_spec` directive is ADMITTED by the validator (back-compat) but is
 * not a repair order the loop acts on: it falls through to
 * `inferRepairDirective` (`contractPipeline.ts`) rather than being normalized
 * onto `finalized_module_contracts`.
 */
export type JudgeRepairTarget = (typeof CONTRACT_REPAIR_TARGETS)[number];

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
