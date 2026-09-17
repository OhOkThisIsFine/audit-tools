// The conceptual/design-review CHARTER + GOAL-DAG spine (Phase A of the
// conceptual-design-review build; design of record: spec/conceptual-design-review-design.md).
//
// This module is the deterministic, tool-owned data model every later phase plugs
// into: the channel-pure estimator charters (Stated/Structural/Revealed) plus the
// downstream-nominated True, per-kind leveled teleologies with file scopes, the
// goal DAG, the ceiling (consent) meta-intent, the routed pairwise CharterDelta,
// and the miner's triangulated telos. No LLM content lives here — extraction and
// delta emission are Phase C. Language-neutral by contract: goals/charters are
// telos statements, never code, model, provider, or ecosystem literals.

import { z } from "zod";

/**
 * The charter kinds. The first three are CHANNEL-PURE ESTIMATORS of a subsystem's
 * telos — each fed a disjoint evidence channel (blindness is a property of the
 * INPUT packet, never an instruction), held un-merged and mined for their pairwise
 * deltas. The deltas stay the primary product; the miner's triangulated telos is a
 * downstream ESTIMATE (a lead the owner reacts to), never a reconciliation.
 * - `stated`: testimony — docs + extracted comments (what the authors SAY).
 * - `structural`: intent frozen into organization — file tree / exports /
 *   signatures / names / import graph; no bodies, no docs, no comments.
 * - `revealed`: behavior — comment-stripped code bodies (what the code DOES).
 * - `true`: the "shining city" ideal, possibly inexpressible and the user may be
 *   unaware of it. Nominatable, never assertable (True-charter gate in
 *   validation/charterGate.ts); nominated by the delta miner DOWNSTREAM of
 *   triangulation, at the `deepest` ceiling only — never an extraction lane.
 */
export const CharterKindSchema = z.enum([
  "stated",
  "structural",
  "revealed",
  "true",
]);
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

// sites-pinned: tests/audit/charter-lane-gate.test.ts, tests/audit/charter-extraction-executor.test.ts
//   The partition below has exactly two consumers, and each suite drives one of
//   them: the lane gate's span-quote refinement, and the executor's
//   quote-presence leg. Shrink the set and both go red.

/**
 * The provenance kinds whose `ref` names a repository path, so a path-grounded or
 * quote-grounded citation check applies to them. The other three name a
 * non-repository source (`intent_checkpoint`, `user_feedback`) or name nothing on
 * disk at all (`inferred`), and a grounding check against the tree would red them
 * falsely.
 *
 * ONE home, beside the enum it partitions. Two callers need the same partition —
 * the lane gate in `laneValidators` and the executor's citation check — and a
 * second hand-written copy is exactly how a set like this drifts when a kind is
 * added. The assertion below runs at module load, so a rename or an addition
 * throws here instead of silently shrinking the checked set.
 */
export const PATH_SHAPED_PROVENANCE_KINDS = new Set<CharterProvenance["kind"]>([
  "doc",
  "code",
  "comment",
]);

{
  const known = new Set<string>(CharterProvenanceSchema.shape.kind.options);
  const unknown = [...PATH_SHAPED_PROVENANCE_KINDS].filter((k) => !known.has(k));
  if (unknown.length > 0) {
    throw new Error(
      `PATH_SHAPED_PROVENANCE_KINDS names provenance kind(s) the schema does not declare: ${unknown.join(", ")}`,
    );
  }
}

/**
 * A single charter. `purpose` MUST be stated in telos terms ("the audit pipeline
 * exists so maintainers can act on trustworthy findings"), never mechanism
 * ("it builds a graph") — a charter that restates the code collapses the
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

// ── Phase D — the charter-alignment clarification / triangulation loop ──────────
//
// The True charter is inexpressible cold; the review converts it into a decidable
// question ("your code optimizes X, your docs say Y, which governs?"). Charter
// alignment is therefore a LOOP interleaved with re-review, not a post-step:
//   show difference → user picks → charters update → differences re-derive → next.
// (design of record spec/conceptual-design-review-design.md §"The triangulation
// loop" + §"Control surface — three currencies, three dials".)
//
// This is the AUDIT-side, charter-keyed question — sourced from a verified
// CharterDifference (below), NOT the remediate-side finding-keyed
// ClarificationRequest (src/remediate/state/types.ts). The two are deliberately
// separate: a charter question moves any account (including Stated), whereas a
// remediate question resolves an implementation ambiguity for one finding.

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

// ── The five-step charter layer (design of record 2026-09-15) ───────────────────
// sites-pinned: tests/shared/charter-layer.test.ts, tests/shared/charter-lane-dag.test.ts
//
// spec/conceptual-design-review-design.md §"The estimator charters", steps 1–5:
// three lane goal DAGs → tool-proposed + host-confirmed correspondences → typed
// n-ary differences → fidelity verdicts → a rendered discrepancy report. These
// shapes are the persisted spine of that layer. Decision record:
// docs/reviews/charter-redesign-feedback-2026-09-15.md.

/** The three ESTIMATOR kinds — the lanes that author a goal DAG. `true` is never a lane. */
export const CharterLaneKindSchema = z.enum(["stated", "structural", "revealed"]);
export type CharterLaneKind = z.infer<typeof CharterLaneKindSchema>;

/**
 * One node of a lane's goal DAG as PERSISTED. `node_id` is the lane's own local
 * slug (never a join key); `premise_height` is DERIVED by the tool from the edges
 * (longest path from a root purpose), never lane-stated; `files` is optional —
 * the Stated lane may cite provenance only (step 1, "scope follows the evidence").
 */
export const LaneGoalNodeSchema = z
  .object({
    node_id: z.string().min(1),
    /** Purpose in telos terms, never mechanism. */
    purpose: z.string().min(1),
    premise_height: z.number().int().min(0),
    files: z.array(z.string()).optional(),
    provenance: z.array(CharterProvenanceSchema),
    confidence: CharterConfidenceSchema,
  })
  .strict();
export type LaneGoalNode = z.infer<typeof LaneGoalNodeSchema>;

/** One edge of a lane's goal DAG: `from` SERVES `to`, with its own evidence. */
export const LaneGoalEdgeSchema = z
  .object({
    from: z.string().min(1),
    to: z.string().min(1),
    provenance: z.array(CharterProvenanceSchema),
  })
  .strict();
export type LaneGoalEdge = z.infer<typeof LaneGoalEdgeSchema>;

/** A lane's whole goal DAG, persisted as its own graph — never merged with the others. */
export const CharterLaneGraphSchema = z
  .object({
    kind: CharterLaneKindSchema,
    nodes: z.array(LaneGoalNodeSchema),
    edges: z.array(LaneGoalEdgeSchema),
  })
  .strict();
export type CharterLaneGraph = z.infer<typeof CharterLaneGraphSchema>;

/** A reference to a set of nodes in ONE lane's DAG (one node, several, or a subgraph). */
export const CorrespondenceMemberSchema = z
  .object({
    kind: CharterLaneKindSchema,
    node_ids: z.array(z.string().min(1)).min(1),
  })
  .strict();
export type CorrespondenceMember = z.infer<typeof CorrespondenceMemberSchema>;

/**
 * A TOOL-PROPOSED correspondence candidate (step 2): two lanes' nodes related by
 * file-scope overlap or by a provenance cross-reference. Always exactly two members;
 * the host may widen it.
 */
export const CorrespondenceCandidateSchema = z
  .object({
    candidate_id: z.string().min(1),
    members: z.array(CorrespondenceMemberSchema).length(2),
    basis: z.enum(["file_overlap", "cross_ref"]),
    /** What the basis rested on: overlapping paths, or the cross-referenced path. */
    evidence_paths: z.array(z.string()).min(1),
  })
  .strict();
export type CorrespondenceCandidate = z.infer<typeof CorrespondenceCandidateSchema>;

/**
 * A CONFIRMED correspondence (step 2 product): regions of two or three lane DAGs
 * that speak about the same thing. A record ABOUT the graphs, never a merge of them.
 */
export const CharterCorrespondenceSchema = z
  .object({
    correspondence_id: z.string().min(1),
    members: z.array(CorrespondenceMemberSchema).min(2),
    /** `tool` = a confirmed candidate; `host` = added by the comparison reader. */
    basis: z.enum(["tool", "host"]),
    /** The candidate this confirmed or widened, when any. */
    candidate_id: z.string().optional(),
    evidence: z.array(CharterProvenanceSchema),
  })
  .strict();
export type CharterCorrespondence = z.infer<typeof CharterCorrespondenceSchema>;

/** The closed dimension enum (step 3, seven dimensions with decision rules in the spec). */
export const DifferenceDimensionSchema = z.enum([
  "purpose",
  "presence",
  "responsibility",
  "hierarchy",
  "scope",
  "standing",
  "standard",
]);
export type DifferenceDimension = z.infer<typeof DifferenceDimensionSchema>;

/** The relation judged across ALL accounts in the correspondence. */
export const DifferenceRelationSchema = z.enum([
  "equivalent",
  "complementary",
  "incompatible",
]);
export type DifferenceRelation = z.infer<typeof DifferenceRelationSchema>;

/** An incompatible record's split: two-against-one (naming the odd channel) or three-way. */
export const DifferenceSplitSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("two_against_one"), odd: CharterLaneKindSchema }).strict(),
  z.object({ kind: z.literal("three_way") }).strict(),
]);
export type DifferenceSplit = z.infer<typeof DifferenceSplitSchema>;

/** One channel's account of the goal under comparison, with the provenance it rests on. */
export const DifferenceAccountSchema = z
  .object({
    kind: CharterLaneKindSchema,
    claim: z.string().min(1),
    provenance: z.array(CharterProvenanceSchema),
  })
  .strict();
export type DifferenceAccount = z.infer<typeof DifferenceAccountSchema>;

/** Who acts on a difference — derived by the tool from `(dimension, relation, split)`. */
export const DifferenceRouteSchema = z.enum(["remediator", "clarification", "human", "none"]);
export type DifferenceRoute = z.infer<typeof DifferenceRouteSchema>;

/** The fidelity lane's verdict on one difference (step 4). */
export const FidelityVerdictSchema = z
  .object({
    verdict: z.enum(["supported", "interpretation", "unverifiable"]),
    /** Only with `interpretation`: the channel whose claim over-read its source. */
    over_read_side: CharterLaneKindSchema.optional(),
    rationale: z.string().min(1),
    /** `tool` when the mechanical pre-check settled it (a missing quote); `lane` otherwise. */
    decided_by: z.enum(["tool", "lane"]),
  })
  .strict();
export type FidelityVerdict = z.infer<typeof FidelityVerdictSchema>;

/**
 * The account minimum is CONDITIONAL on the dimension (owner, 2026-09-17), never
 * flat. A `presence` difference names its silent channel by OMITTING it from
 * `accounts`, so it carries one account fewer than its correspondence has
 * channels — on a two-channel correspondence, exactly one. Every other dimension
 * needs two, because an account that contradicts no other account is not a
 * difference.
 *
 * `DifferenceInputSchema` (the host-submitted half, in
 * `src/shared/decompose/charterExtraction.ts`) already states this rule. It is
 * applied here too because the two DECLARED records were left at a flat minimum
 * of two when the input half was relaxed: the exported contract then refused a
 * one-account presence record that `assembleComparison` produces.
 */
function refineAccountMinimum(
  value: { dimension: DifferenceDimension; accounts: readonly unknown[] },
  ctx: z.RefinementCtx,
): void {
  if (value.dimension !== "presence" && value.accounts.length < 2) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["accounts"],
      message: `a ${value.dimension} difference holds an account from at least two channels; only a presence difference may hold one`,
    });
  }
}

/**
 * A DIFFERENCE record (step 3 product, stamped by steps 4 and 5): what the
 * corresponding accounts disagree on, typed on one dimension and one relation,
 * holding every channel's account in its correspondence EXCEPT a `presence`
 * difference's silent channel, which is named by its absence.
 */
export const CharterDifferenceSchema = z
  .object({
    difference_id: z.string().min(1),
    correspondence_id: z.string().min(1),
    dimension: DifferenceDimensionSchema,
    relation: DifferenceRelationSchema,
    /** Required when `relation` is `incompatible`; absent otherwise. */
    split: DifferenceSplitSchema.optional(),
    accounts: z.array(DifferenceAccountSchema).min(1),
    /** One-sentence statement of the gap. */
    gap: z.string().min(1),
    /** For `presence`: the silent channel SHOULD have covered the goal. */
    covered_channel_gap: z.boolean().optional(),
    /** Tool-derived routing from the fixed `(dimension, relation, split)` table. */
    routed_to: DifferenceRouteSchema,
    /** Whether this record is a finding candidate (incompatible, or a covered-channel gap). */
    finding_candidate: z.boolean(),
    /** Set by the fidelity step; absent until it runs. */
    fidelity: FidelityVerdictSchema.optional(),
  })
  .strict()
  .superRefine(refineAccountMinimum);
export type CharterDifference = z.infer<typeof CharterDifferenceSchema>;

/**
 * The n-ary clarification answer (decision 6): the governing channel by name, a
 * rewrite of all accounts, or a deliberate held tension.
 */
export const CharterDifferenceAnswerSchema = z.union([
  z.object({ governs: CharterLaneKindSchema }).strict(),
  z.literal("rewrite_all"),
  z.literal("leave_open"),
]);
export type CharterDifferenceAnswer = z.infer<typeof CharterDifferenceAnswerSchema>;

/**
 * A charter-alignment question sourced from a DIFFERENCE (the n-ary successor of
 * {@link CharterClarificationRequestSchema}). Every account the difference holds
 * is shown — which is every channel except a `presence` difference's silent one —
 * and the answer names the channel that governs.
 */
export const CharterDifferenceQuestionSchema = z
  .object({
    request_id: z.string().min(1),
    difference_id: z.string().min(1),
    /** The report's grouping subsystem (structure-decomposition unit), when placed. */
    subsystem_id: z.string().optional(),
    dimension: DifferenceDimensionSchema,
    relation: DifferenceRelationSchema,
    split: DifferenceSplitSchema.optional(),
    accounts: z.array(DifferenceAccountSchema).min(1),
    question: z.string().min(1),
    value: ClarificationValueSchema,
    disposition: z.enum(["interactive", "finding_only"]),
    answer: CharterDifferenceAnswerSchema.optional(),
  })
  .strict()
  .superRefine(refineAccountMinimum);
export type CharterDifferenceQuestion = z.infer<typeof CharterDifferenceQuestionSchema>;
