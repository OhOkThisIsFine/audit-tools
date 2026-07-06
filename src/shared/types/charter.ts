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
