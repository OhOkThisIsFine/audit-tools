/**
 * The value vocabularies a step prompt's schema sketch and its VALIDATOR both
 * read — declared once, here, so they cannot disagree.
 *
 * Why this module exists. A step prompt hands the worker a JSON shape to write,
 * and a validator in `src/remediate/validation/` decides whether what came back
 * is admissible. Those were two independent statements of the same fact: the
 * prompt carried a hand-written sketch (`contractPipelinePrompts.ts`, plus two
 * extra sketches in `contractPipeline.ts`) and the validator carried its own
 * literal list. Measured drifts at HEAD before this module existed:
 *
 *   - `cyclic_seam_resolution.status` — sketch offered 2 values, the validator
 *     admits 4 (`user_decision_required` and `blocked` were unrenderable but
 *     required by the refusal path);
 *   - `judge_report.repair_directive.target` — sketch offered 3, the validator 4
 *     (the fourth, `counterexample`, could never be asked for);
 *   - `verification_report.finding.traces[].kind` — sketch offered 5, the
 *     validator 6;
 *   - `implementation_dag.node.status` — sketch showed exactly 1 of the 4 the
 *     validator admits.
 *
 * Every one is the same failure: a worker reads the sketch, emits a value the
 * sketch allowed, and the tool refuses it — or, worse in the opposite
 * direction, never learns a legal value exists. A drift test made of "remember
 * to update the other one" is exactly the class of guarantee this repo bans
 * (enforce in tooling, never host — or author — discretion), so the fix is not
 * a test that watches two lists. It is ONE declaration, with the validator and
 * the sketch both deriving from it.
 *
 * What is MINED vs DECLARED. The values are declared here; they are NOT read out
 * of the validator module, because a validator states its values as inline
 * `requireOneOf(...)` literals inside a function body — a declaration a test can
 * only reach by parsing source text, which is the brittle thing this replaces.
 * Instead the exported constants are the single declaration and the VALIDATOR
 * imports them, so the drift is impossible by construction rather than detected
 * after the fact. The test in
 * `tests/remediate/step-prompt-sketch-drift.test.ts` then re-derives each
 * vocabulary from what each validator actually REFUSES (by feeding it values),
 * and compares that to the sketch the prompt renders — so a value added to a
 * validator without the sketch still reds, without depending on how the
 * validator happens to spell its list.
 *
 * NOT A LIST. Every value vocabulary that the CONTRACT-PIPELINE role sketches
 * render as an alternation is declared here — the four drifted ones above, the
 * obligation/test-plan pairs, and the nine that were still hand-written literals
 * in `contractPipelinePrompts.ts` (goal `source_type`; context-entry `kind`; the
 * critique item `kind` and `severity`; the critique `verdict`; the assessment
 * finding `status` and report `verdict`; the judge `verdict`; and the judge's
 * counterexample `classification`). That is the whole point: a vocabulary kept
 * as a literal is only safe while someone remembers, and the drift test below
 * sweeps every rendered alternation of those sketches rather than a hand-kept
 * field list, so the next literal to appear reds immediately instead of waiting
 * to be noticed.
 *
 * The scope is those sketches, NOT every sketch in the repository, and the
 * difference is recorded rather than implied: the sweep reaches the modules in
 * `SKETCH_SOURCE_MODULES`, and the clarification-resolution sketch in
 * `steps/prompts.ts` is outside them — a declared-gap row in
 * `tests/shared/promptContractRegistry.ts`. So this module claims nothing about
 * that one, and widening the sweep is its own change.
 */

/**
 * `cyclic_seam_resolution.status`. Four values: two describe a resolution the
 * worker authored, two describe a resolution the tool must escalate or refuse.
 */
export const CYCLIC_SEAM_RESOLUTION_STATUSES = [
  "no_cycles",
  "resolved",
  "user_decision_required",
  "blocked",
] as const;

/** `cyclic_seam_resolution.cycles[].break_strategy`. */
export const CYCLIC_SEAM_BREAK_STRATEGIES = [
  "mediator",
  "single_authority",
] as const;

/**
 * `judge_report.repair_directive.target`, its legacy aliases, and the offered
 * subset — DECLARED in `src/shared/types/contractPipeline/obligations.ts`,
 * beside the `JudgeRepairTarget` type that derives from them, and re-exported
 * here so the validator and the prompt sketches keep reading them from this
 * module.
 *
 * Why they moved. `src/shared` is the base layer; this module lives in
 * `src/remediate`. A value import from the base layer into an orchestrator is
 * the dependency direction inverted, and the declaration had to live on the
 * side the TYPE could reach.
 */
export {
  CONTRACT_REPAIR_TARGETS,
  CONTRACT_REPAIR_TARGETS_LEGACY,
  CONTRACT_REPAIR_TARGETS_OFFERED,
} from "audit-tools/shared";

/** `verification_report` trace `kind`. */
export const VERIFICATION_TRACE_KINDS = [
  "requirement",
  "invariant",
  "counterexample",
  "task",
  "file",
  "command",
] as const;

/** `verification_report` finding-level `overall_status` (report level excludes `skipped`). */
export const VERIFICATION_FINDING_STATUSES = [
  "passed",
  "failed",
  "skipped",
] as const;

/** `verification_report` report-level `overall_status`. */
export const VERIFICATION_REPORT_STATUSES = ["passed", "failed"] as const;

/** `verification_report` trace `status`. */
export const VERIFICATION_TRACE_STATUSES = ["passed", "failed"] as const;

/** `implementation_dag.nodes[].status`. */
export const IMPLEMENTATION_NODE_STATUSES = [
  "pending",
  "in_progress",
  "resolved",
  "blocked",
] as const;

/** `implementation_dag.edges[].kind`. */
export const IMPLEMENTATION_EDGE_KINDS = ["dependency", "verification"] as const;

/**
 * `obligation_ledger.obligations[].status`. `satisfied` is reachable only
 * through the tool's own derivation (`contractPipeline/derive.ts`) — a worker
 * emits `pending` and the tool advances it — but the value is part of the
 * contract the prompt describes, so it is declared here rather than implied.
 */
export const OBLIGATION_STATUSES = [
  "pending",
  "satisfied",
  "failed",
] as const;

/** `obligation_ledger.obligations[].kind`. */
export const OBLIGATION_KINDS = [
  "invariant",
  "behavioral",
  "structural",
  "test",
] as const;

/** `test_validator_plan.test_specs[].kind`. */
export const TEST_SPEC_KINDS = [
  "unit",
  "integration",
  "schema",
  "invariant",
  "e2e",
] as const;

/** `goal_spec.source_type`. */
export const GOAL_SOURCE_TYPES = [
  "conversation",
  "document",
  "structured_audit",
  "mixed",
] as const;

/** `context_bundle.entries[].kind`. */
export const CONTEXT_ENTRY_KINDS = [
  "source",
  "test",
  "config",
  "doc",
] as const;

/** `conceptual_design_critique.items[].kind`. */
export const CRITIQUE_ITEM_KINDS = [
  "concern",
  "alternative",
  "suggestion",
] as const;

/** `conceptual_design_critique.items[].severity`. */
export const CRITIQUE_ITEM_SEVERITIES = ["blocking", "advisory"] as const;

/** `conceptual_design_critique.verdict`. */
export const CRITIQUE_VERDICTS = [
  "approved",
  "approved_with_concerns",
  "rejected",
] as const;

/** `contract_assessment_report.findings[].status`. */
export const ASSESSMENT_FINDING_STATUSES = [
  "satisfied",
  "violated",
  "uncertain",
] as const;

/** `contract_assessment_report.verdict`. */
export const ASSESSMENT_VERDICTS = ["passed", "failed", "partial"] as const;

/** `judge_report.verdict`. */
export const JUDGE_VERDICTS = ["approved", "needs_repair"] as const;

/**
 * `judge_report.classifications[].classification` — what the judge may decide
 * about one counterexample.
 *
 * Declared here rather than in the validator that reads it, because the judge
 * role's prompt sketch states the same five values and a sketch that renders a
 * hand-written copy of a validator's list is the drift this module bans. The
 * validator imports THIS declaration (it was a local `as const` beside
 * `validateJudgeReport`), so the two are one fact.
 */
export const COUNTEREXAMPLE_CLASSIFICATIONS = [
  "accepted",
  "out_of_scope",
  "duplicate",
  "invalid",
  "residual_risk",
] as const;

/**
 * `seam_reconciliation_report.mismatches[].resolution.decision` — which side of
 * a seam adjusts. Declared here beside the rest for ONE reason: the alternative
 * would be to exclude it from the drift test by hand, and an exclusion list is
 * the drift this module exists to make impossible (see the test's alternation
 * sweep, which matches EVERY rendered alternation to a validator probe).
 */
export const SEAM_RESOLUTION_DECISIONS = ["A", "B", "both"] as const;

/**
 * The vocabularies that carry a `created_at`, and the ones that do not.
 *
 * `created_at` asymmetry, resolved in one place. Every contract-pipeline
 * validator ends with `requireString(v.created_at, ...)`, and NO sketch
 * declares the field — the reconciliation is `stampToolCreatedAt`
 * (`contractPipeline/artifactStore.ts`), which the tool calls on the payload at
 * ingest and at the `validate-artifact` self-check. The host has no clock, so
 * asking it for a timestamp is asking it to invent one; the tool owns the field
 * and stamps it.
 *
 * The decision, stated once rather than left implicit: THE VALIDATORS KEEP
 * REQUIRING IT AND THE SKETCHES KEEP OMITTING IT — because the requirement is
 * enforced on the POST-STAMP payload, not on what the worker wrote. The
 * asymmetry is not a drift to be closed in either direction: declaring
 * `created_at` in the sketches would tell the worker to supply a value the tool
 * then overrides (the stamp is `created_at`-wins-if-present, but a host-invented
 * clock reading is still worse than the tool's), and dropping the requirement
 * from the validators would let an artifact that never passed the stamp path —
 * a hand-written file validated directly — carry no timestamp at all.
 *
 * This is a DECISION, not a drift (see the drift test's `created_at` block):
 * the validators keep requiring it and the sketches keep omitting it, because
 * the requirement is enforced on the POST-STAMP payload rather than on what the
 * worker wrote. Closing the asymmetry in either direction is worse — declaring
 * it in the sketches asks the host for a clock reading the tool then overrides,
 * and dropping it from the validators lets a directly-validated hand-written
 * file carry no timestamp at all.
 */
export const CREATED_AT_OWNER = "stampToolCreatedAt" as const;

/**
 * Whether `value` is one of {@link CYCLIC_SEAM_BREAK_STRATEGIES} — the ONE
 * membership test for the vocabulary, so the tool's post-hoc cycle-break check
 * and the prompt's sketch read the same declaration.
 */
export function isCyclicSeamBreakStrategy(
  value: unknown,
): value is (typeof CYCLIC_SEAM_BREAK_STRATEGIES)[number] {
  return (
    typeof value === "string" &&
    (CYCLIC_SEAM_BREAK_STRATEGIES as readonly string[]).includes(value)
  );
}

/**
 * Render a sketch fragment for a value vocabulary: `"a | b | c"`.
 *
 * The ONE renderer for every `requireOneOf`-style vocabulary in the sketches,
 * so the separators and quoting in a prompt cannot drift from each other either.
 */
export function sketchValues(values: readonly string[]): string {
  return values.join(" | ");
}
