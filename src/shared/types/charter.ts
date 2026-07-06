// The conceptual/design-review CHARTER + GOAL-DAG spine (Phase A of the
// conceptual-design-review build; design of record: spec/conceptual-design-review-design.md).
//
// This module is the deterministic, tool-owned data model every later phase plugs
// into: the four charters (Stated/Inferred/Revealed/True), the goal DAG, the
// ceiling (consent) meta-intent, and the routed pairwise CharterDelta. No LLM
// content lives here — extraction and delta emission are Phase C. Language-neutral
// by contract: goals/charters are telos statements, never code, model, provider,
// or ecosystem literals.

import { z } from "zod";

/**
 * The four charters, mined for their PAIRWISE DELTAS (never reconciled into one
 * truth). Each states a subsystem's purpose in telos terms:
 * - `stated`: user-expressed (docs, feedback) — the anchor of intent.
 * - `inferred`: the LLM's model of that intent — `inferred − stated` = an unstated
 *   assumption / miscommunication.
 * - `revealed`: what the code actually optimizes for — the objective anchor;
 *   `stated − revealed` = spec drift.
 * - `true`: the "shining city" ideal, possibly inexpressible and the user may be
 *   unaware of it — `revealed/stated − true` = serving the wrong goal. Nominatable,
 *   never assertable (see the True-charter gate in validation/charterGate.ts).
 */
export const CharterKindSchema = z.enum(["stated", "inferred", "revealed", "true"]);
export type CharterKind = z.infer<typeof CharterKindSchema>;

/**
 * Source confidence of a charter. Defined SEPARATELY from `FindingConfidence`
 * even though the enum values coincide today: the semantics differ (charter-source
 * strength vs finding strength) and coupling them would let a change to one
 * silently move the other. A `low`-confidence charter downgrades any dependent
 * review to "flag for human intent input, never opine" (charterReviewDisposition).
 */
export const CharterConfidenceSchema = z.enum(["high", "medium", "low"]);
export type CharterConfidence = z.infer<typeof CharterConfidenceSchema>;

/**
 * Where a charter's purpose claim comes from, so a delta is adjudicable — each side
 * of a delta must be attributable. `ref` points at the source (a doc path, an
 * intent-checkpoint field, a component id); `quote` is the optional verbatim
 * evidence. Grounding that `ref` actually exists on disk is a Phase-C gate, not
 * enforced here.
 */
export const CharterProvenanceSchema = z
  .object({
    kind: z.enum([
      "doc",
      "intent_checkpoint",
      "user_feedback",
      "code",
      "comment",
      "inferred",
    ]),
    ref: z.string(),
    quote: z.string().optional(),
  })
  .strict();
export type CharterProvenance = z.infer<typeof CharterProvenanceSchema>;

/**
 * A single charter. `purpose` MUST be stated in telos terms ("quota/dispatch exists
 * so N cooperating auditors extract max value from finite provider budgets"), never
 * mechanism ("it manages quota") — a charter that restates the code collapses the
 * delta against the impl to zero and the review can never find under-delivery.
 *
 * `nominated_alternative` + `nominated_cost` are the falsifiable-or-drop payload of a
 * `true` charter (a concrete alternative + a concrete cost the user seems to pay
 * unaware — "Quicken exists; you're rebuilding a worse one"). They are optional in
 * the schema and REQUIRED-IFF-`kind==="true"` at the validator layer
 * (applyTrueCharterGate): a discriminated union here would fragment the array embed
 * on the intent checkpoint, and the design wants the gate to be a droppable runtime
 * check, not a parse failure.
 */
export const CharterSchema = z
  .object({
    charter_id: z.string(),
    kind: CharterKindSchema,
    /** Purpose in telos terms, never mechanism. */
    purpose: z.string(),
    /** May be `[]` for a `true` nomination (the ideal cites no source). */
    provenance: z.array(CharterProvenanceSchema),
    confidence: CharterConfidenceSchema,
    /** `true`-charter gate: the concrete better alternative it nominates. */
    nominated_alternative: z.string().optional(),
    /** `true`-charter gate: the concrete cost the user seems to pay unaware. */
    nominated_cost: z.string().optional(),
  })
  .strict();
export type Charter = z.infer<typeof CharterSchema>;

/**
 * A goal-DAG node. `premise_height` is an integer (0 = the telos, higher = closer to
 * a leaf mechanism), NEVER a fixed L0/L1/L2 enum — telos depth is EMERGENT (it falls
 * out of stable-across-scale decomposition), so mandating levels would hardcode the
 * thing the design rejects.
 */
export const GoalNodeSchema = z
  .object({
    node_id: z.string(),
    premise_height: z.number().int().min(0),
    statement: z.string(),
  })
  .strict();
export type GoalNode = z.infer<typeof GoalNodeSchema>;

/**
 * A goal-DAG edge: `from` (the child goal) serves `to` (its parent goal). Goals form
 * a DAG, not a tree — a node may serve multiple parents.
 */
export const GoalEdgeSchema = z
  .object({
    from: z.string(),
    to: z.string(),
  })
  .strict();
export type GoalEdge = z.infer<typeof GoalEdgeSchema>;

/** The goal DAG (nodes + edges). Multi-parent nodes are legal by construction. */
export const GoalGraphSchema = z
  .object({
    nodes: z.array(GoalNodeSchema),
    edges: z.array(GoalEdgeSchema),
  })
  .strict();
export type GoalGraph = z.infer<typeof GoalGraphSchema>;

/**
 * The CEILING meta-intent (control-surface dial #2): how far up the premise stack a
 * finding may reach. This is the consent axis, captured at `intent_checkpoint`, NOT a
 * CLI flag — the top rung is the tool telling the user to abandon/rescope, so it
 * requires explicit opt-in:
 * - `shallow` — leaf + contract findings, Stated−Revealed drift (low blast).
 * - `deep` — charter-deltas, smeared-purpose, accidental-cluster findings (mid–high).
 * - `deepest` — Revealed−True / Stated−True provocations (max blast); `explicit_opt_in`.
 */
export const CeilingSchema = z
  .object({
    rung: z.enum(["shallow", "deep", "deepest"]),
    explicit_opt_in: z.boolean().optional(),
  })
  .strict();
export type Ceiling = z.infer<typeof CeilingSchema>;

/**
 * A routed pairwise charter delta — the product of the overlay-and-delta operator at
 * the charter layer (produced in Phase C). `pair` is a SYMMETRIC tuple of the two
 * charter kinds compared: the design forbids anointing Stated as ground truth, so a
 * delta is never modeled as `{ from: stated, to: X }`. `routed_to` names who acts on
 * it (a low-confidence side forces `human` regardless of kind — gateCharterDelta):
 * - `unstated_assumption` (inferred − stated) → `clarification`.
 * - `spec_drift` (stated − revealed) → `remediator`.
 * - `wrong_goal` (revealed − true / stated − true) → `human` (provocation only).
 */
export const CharterDeltaSchema = z
  .object({
    delta_id: z.string(),
    pair: z.tuple([CharterKindSchema, CharterKindSchema]),
    kind: z.enum(["unstated_assumption", "spec_drift", "wrong_goal"]),
    routed_to: z.enum(["remediator", "clarification", "human"]),
    summary: z.string(),
  })
  .strict();
export type CharterDelta = z.infer<typeof CharterDeltaSchema>;

// ── Phase D — the charter-alignment clarification / triangulation loop ──────────
//
// The True charter is inexpressible cold; the review converts it into a decidable
// question ("your code optimizes X, your docs say Y, which governs?"). Charter
// alignment is therefore a LOOP interleaved with re-review, not a post-step:
//   show delta → user picks → charters update → deltas re-derive → next question.
// (design of record spec/conceptual-design-review-design.md §"The triangulation
// loop" + §"Control surface — three currencies, three dials".)
//
// This is the AUDIT-side, charter-keyed ClarificationRequest — sourced from a
// routed CharterDelta, NOT the remediate-side finding-keyed ClarificationRequest
// (src/remediate/state/types.ts). The two are deliberately separate: a charter
// question moves any of the four charters (including Stated), whereas a remediate
// question resolves an implementation ambiguity for one finding.

/**
 * How answerable a charter question is — the axes the VOI ranking scores. A
 * `blast_radius` is how far up the goal DAG the answer ripples (goals are a DAG,
 * not a tree, so one answer can force reframes on multiple parents); a
 * `cascade_count` is how many other still-open deltas the answer is expected to
 * settle. High on both = highest value-of-information (resolve it first).
 */
export const ClarificationValueSchema = z
  .object({
    /** How far up the goal DAG the fix ripples (0 = leaf). Priority AND risk. */
    blast_radius: z.number().int().min(0),
    /** How many other open deltas this answer is expected to cascade-settle. */
    cascade_count: z.number().int().min(0),
  })
  .strict();
export type ClarificationValue = z.infer<typeof ClarificationValueSchema>;

/**
 * A single charter-alignment question — the audit-side ClarificationRequest,
 * sourced from a routed CharterDelta. `options` are SYMMETRIC (any of the four
 * charters may move, including Stated; "leave open" is a first-class answer), so a
 * question never silently anoints Stated as ground truth. `value` carries the
 * blast-radius + cascade estimate the VOI queue ranks on. `answer` is set once the
 * user (or the autonomous zero-attention mode) resolves it.
 */
export const CharterClarificationAnswerSchema = z.enum([
  "this_side_wins",
  "that_side_wins",
  "rewrite_both",
  "leave_open",
]);
export type CharterClarificationAnswer = z.infer<
  typeof CharterClarificationAnswerSchema
>;

export const CharterClarificationRequestSchema = z
  .object({
    /** Stable id, derived from the source delta (`${delta_id}:q`). */
    request_id: z.string(),
    /** The routed delta this question triangulates. */
    delta_id: z.string(),
    /** The subsystem the delta belongs to (for grouping + reporting). */
    node_id: z.string(),
    /** The symmetric charter pair in tension. */
    pair: z.tuple([CharterKindSchema, CharterKindSchema]),
    /** The decidable question ("code optimizes X, docs say Y — which governs?"). */
    question: z.string(),
    /** The VOI axes this question is ranked on. */
    value: ClarificationValueSchema,
    /**
     * Whether this question is CLEARED for the interactive human channel or must
     * only be written as a finding. A high-blast question that has not cleared the
     * risk gate's higher adversarial bar (or any question under zero attention) is
     * `finding_only`. `interactive` questions form the VOI queue the user answers.
     */
    disposition: z.enum(["interactive", "finding_only"]),
    /** Resolved answer (symmetric); absent while the question is still open. */
    answer: CharterClarificationAnswerSchema.optional(),
  })
  .strict();
export type CharterClarificationRequest = z.infer<
  typeof CharterClarificationRequestSchema
>;
