import { z } from "zod";
import { FileDispositionStatusSchema } from "./disposition.js";
import { CeilingSchema } from "./charter.js";
import { CLOSING_ACTIONS } from "./closingActions.js";

/**
 * The accepted scope and intent for a run, confirmed by the host before
 * planning. Single-sourced so both orchestrators share one shape: audit-code
 * uses `excluded_scope`/`must_not_touch`/`free_form_intent`; remediate-code
 * additionally uses `filters` to narrow findings. `scope_summary`/
 * `intent_summary` are human renders; the structured fields are what downstream
 * planning, worker prompts, and reports actually consume.
 */
export const IntentCheckpointSchema = z
  .object({
    schema_version: z.literal("intent-checkpoint/v1"),
    confirmed_at: z.string(),
    /**
     * `"host"` — checkpoint has been reviewed and confirmed by the host agent.
     * `"draft"` — preliminary checkpoint pre-populated by synthesize_intake worker;
     *   not yet confirmed; planning must not begin and filtering must not apply.
     */
    confirmed_by: z.enum(["host", "draft"]),
    /** Human-readable description of the confirmed scope. */
    scope_summary: z.string(),
    /** Human-readable description of the goal (e.g. full-audit / delta). */
    intent_summary: z.string(),
    /**
     * Free-form intent; interpreted into priority/lens/scope signals at planning
     * time via freeFormIntentInterpreter. Never threaded verbatim into worker or
     * dispatch prompts (see freeFormIntentInterpreter, INV-S04).
     */
    free_form_intent: z.string().optional(),
    /** Paths intentionally excluded from the run, each with a reason. */
    excluded_scope: z
      .array(z.object({ path: z.string(), reason: z.string() }).strict())
      .optional(),
    /** Path globs that must never be written to. */
    must_not_touch: z.array(z.string()).optional(),
    /** Remediate-only finding filters; audit-code ignores these. */
    filters: z
      .object({
        severity: z.array(z.string()).optional(),
        lenses: z.array(z.string()).optional(),
        packages: z.array(z.string()).optional(),
        themes: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    /**
     * Remediate-only: the closing action the HOST chose at confirmation, from
     * the candidates the tool detected and presented (owner decision
     * 92b0e2dd7cfdc06d — the tool never selects one). Absent means `none`:
     * no closing side effect is ever inferred. audit-code ignores it.
     */
    closing_action: z.enum(CLOSING_ACTIONS).optional(),
    /**
     * Remediate-only: the argv the close phase runs when `closing_action` is
     * `custom`. Required with `custom` (the confirm step refuses a `custom`
     * without it) and meaningless otherwise. Host-authored: writing it is the
     * authorization, so `custom` needs no second preview at close.
     */
    closing_custom_command: z.array(z.string().min(1)).min(1).optional(),
    /**
     * Remediate-only, draft checkpoints: the intake worker's open questions,
     * carried into the confirmation prompt. `blocking: true` alone blocks
     * (INV-remediate-state-06).
     */
    pre_draft_questions: z
      .array(
        z
          .object({
            id: z.string(),
            question: z.string(),
            blocking: z.boolean().optional(),
          })
          .strict(),
      )
      .optional(),
    /** Remediate-only, draft checkpoints: how free-form intent was read. */
    intent_interpretation: z.string().optional(),
    /**
     * Clauses from free_form_intent that could not be encoded as lens-weight,
     * priority, or scope signals. Each entry carries the original clause text,
     * the blocking checkpoint question raised for it, and the optional host
     * answer once resolved. These survive as explicit machine-checkable
     * contract constraints threaded into planning and worker prompts.
     */
    constraint_clauses: z
      .array(
        z
          .object({
            /**
             * Stable clause identity — the RESOLUTION KEY (CE-004). An entry
             * resolves the clause whose identity equals this id, regardless of
             * how the question renders. Keyed off the clause text by
             * `clauseIdentity`; optional for back-compat (a legacy entry without
             * it falls back to matching on `checkpoint_question`), but every
             * fresh entry carries it so two distinct clauses that render to the
             * same question are answered individually.
             */
            clause_id: z.string().optional(),
            /** The original unencodable clause text. */
            text: z.string(),
            /** The blocking checkpoint question generated for this clause. */
            checkpoint_question: z.string(),
            /** The host's answer to the checkpoint question once resolved. */
            host_answer: z.string().optional(),
          })
          .strict(),
      )
      .optional(),
    /**
     * Per-file or per-prefix status corrections accepted by the host. Applied
     * before coverage initialization so overridden files never become audit
     * tasks. Typically sourced from `disposition_override_proposals` in the
     * scope pre-digest shown during the `confirm_intent` step.
     */
    disposition_overrides: z
      .array(
        z
          .object({
            path: z.string(),
            status: FileDispositionStatusSchema,
            reason: z.string(),
          })
          .strict(),
      )
      .optional(),
    /**
     * Accepted or modified lens set from the host, derived from the
     * lens proposition table in the scope pre-digest. `include` is additive (always
     * merged with mandatory lenses); `exclude` removes non-mandatory lenses.
     */
    lens_selection: z
      .object({
        include: z.array(z.string()).optional(),
        exclude: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    /**
     * Conceptual design-review depth, confirmed by the host during
     * `confirm_intent`. It records *how much* conceptual review to do, never how
     * the host chooses to execute that work.
     * - `conceptual_depth: "shallow"` (default when omitted) — a single conceptual
     *   reviewer.
     * - `conceptual_depth: "deep"` — fan out `perspectives` independent reviewers
     *   with maximally dissimilar perspectives, then compile via an independent
     *   judge.
     * `perspectives` bounds the deep fan-out count; ignored when shallow.
     */
    design_review: z
      .object({
        /**
         * The `confirmed_at` of the confirmation that ANSWERED this block —
         * the run the depth was chosen for.
         *
         * These dials are PER-RUN choices (owner, 2026-08-21: "a user may not
         * want the same settings every audit"), and the checkpoint is the only
         * durable record between the confirm-intent answer and the design-review
         * emission. Recording WHICH confirmation answered them is what lets the
         * reader tell this run's answer from a prior run's block copied forward
         * with a fresh `confirmed_at`; without it the two are byte-identical and
         * the tool announces `Reusing intent … conceptual depth deep` to an
         * operator who never chose it.
         *
         * ABSENT MEANS UNANSWERED — a missing `answered_at` is never
         * back-filled from `confirmed_at`, because the only value that proves
         * this confirmation answered the block is one this confirmation's write
         * supplied. Treating absence as agreement would let a checkpoint
         * carrying a PRIOR run's block (a host that copied the file forward and
         * rewrote `confirmed_at` but not this field) read as freshly answered,
         * which is precisely the announcement the owner directive forbids. See
         * `resolveDesignReviewBinding` for how a PRESENT value is compared.
         */
        answered_at: z.string().optional(),
        conceptual_depth: z.enum(["shallow", "deep"]).optional(),
        perspectives: z.number().int().min(1).optional(),
        /**
         * The premise-height consent dial (how far up a finding may reach),
         * captured at `confirm_intent`. Optional and additive — a legacy
         * checkpoint carrying only `conceptual_depth`/`perspectives` stays
         * valid. NOTE: the checkpoint deliberately carries the ceiling as
         * INPUT only — charters/teleologies/goal graph live on
         * `charter_register.json` (the OUTPUT artifact), never here; embedding
         * them would create a staleness cycle with the checkpoint the register
         * depends on. (Never-written `charters`/`goal_graph` embeds were
         * deleted 2026-08-06, design resolution 4.)
         */
        ceiling: CeilingSchema.optional(),
        /**
         * The ATTENTION dial (Phase D control surface, currency #3) — how much the
         * user will converse to align the charters: how many VOI-ranked
         * charter-clarification questions they answer this round. `0` is the
         * autonomous mode (every charter-delta becomes a written finding, nothing
         * interactive); a finite N takes the top-N of the VOI queue; `"all"` takes
         * every interactive question. Attended and unattended are two settings of
         * ONE dial, not a forked path. Optional + additive; defaults to `0`
         * (conversation-first: no human loop unless the user opts in).
         */
        attention: z.union([z.number().int().min(0), z.literal("all")]).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type IntentCheckpoint = z.infer<typeof IntentCheckpointSchema>;

/**
 * The per-run dials a confirmation answers, or `undefined` when it answered
 * none.
 *
 * NOT every key of the block is RUN-BOUND. The three CHOICE dials —
 * `conceptual_depth`, `perspectives`, `attention` — are per-run answers, so
 * every reader reaches them through {@link resolveRunBoundDesignReview} and a
 * block inherited from a prior confirmation governs nothing. `ceiling` is a
 * separate dial with its own semantics and is read UNBOUND (see
 * `resolveCharterCeiling`: "the explicit `ceiling` field is a separate dial with
 * its own semantics and is deliberately NOT bound here"). `answered_at` is the
 * block's own provenance — which confirmation answered it — and is read by
 * neither a compared projection nor the canonical hash
 * ({@link DESIGN_REVIEW_PROVENANCE_FIELDS}).
 */
export type DesignReviewSettings = NonNullable<IntentCheckpoint["design_review"]>;

/**
 * The keys INSIDE the `design_review` block that are PROVENANCE rather than
 * meaning: they record WHICH confirmation answered the block, they are not the
 * answer. `answered_at` is the whole list today.
 *
 * SINGLE-SOURCED because two independent surfaces must both exclude it, for the
 * same reason and with the same consequence if either forgets:
 *
 *  - the O2 semantic gate's structured projection (`DEFAULT_NORMALIZE_CONFIG`);
 *  - the canonical artifact content hash (`NON_SEMANTIC_FIELDS_BY_ARTIFACT`).
 *
 * A re-confirm of the SAME depth stamps a fresh `answered_at` (it must — see
 * `resolveRunBoundDesignReview`, which binds the block to the run that answered
 * it). Left inside either surface, that provenance-only edit reads as a
 * `structured_changed` delta and re-stales the entire planning cascade — the
 * exact churn both strip lists exist to prevent.
 */
export const DESIGN_REVIEW_PROVENANCE_FIELDS: readonly string[] = ["answered_at"];

/**
 * How `design_review` relates to the confirmation the checkpoint records.
 *
 *  - `unanswered` — the checkpoint carries NO block at all. Nothing was
 *    claimed, so there is nothing to notice.
 *  - `bound` — the block IS this confirmation's answer; its dials apply.
 *  - `unbound` — a block is present and does NOT bind. `reason` states, in
 *    operator-facing prose, which confirmation it belongs to instead — so a
 *    consumer can SAY that the block was ignored rather than silently fall back
 *    to the schema default (the silent downgrade is the defect: a host that
 *    wrote `deep` sees a `shallow` step arrive with no explanation).
 */
export type DesignReviewBinding =
  | { readonly kind: "unanswered" }
  | { readonly kind: "bound"; readonly settings: DesignReviewSettings }
  | { readonly kind: "unbound"; readonly reason: string };

/**
 * Parse one recorded instant to epoch milliseconds, or `undefined` when it is
 * not a readable instant. THE normalization the binding compare runs through:
 * a host authoring `2026-04-22T00:00:00Z` and the same moment as
 * `2026-04-22T00:00:00.000Z` is one instant written two ways, and a comparison
 * on the raw strings reads that as "a different run".
 */
function parseInstant(value: string | undefined): number | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * Resolve how the checkpoint's `design_review` block relates to THIS run.
 *
 * These dials are per-run (owner, 2026-08-21). The checkpoint is the one durable
 * record between the confirm-intent answer and the design-review emission, so
 * the block must carry its own provenance: `answered_at` names this
 * confirmation exactly when this confirmation supplied the block.
 *
 * The comparison is on the two instants, NORMALIZED to epoch milliseconds —
 * never on the raw strings, and never on their order. Not the raw strings,
 * because the value is host-authored free text and a formatting difference
 * (`…00Z` vs `…00.000Z`, a prompt placeholder left in) would otherwise read as
 * "a different run" and silently downgrade `deep` to `shallow`. Not an
 * ordering ("is this block newer than that confirmation?"), because host clocks
 * are not a trust anchor and an ordering would silently accept a block from a
 * LATER write than the confirmation it is being attributed to. An instant that
 * does not parse is UNBOUND — never a match.
 *
 * ONE home for the question, because more than one consumer asks it — the
 * conceptual dispatch resolves its depth here, the charter extraction resolves
 * the ceiling, the clarification loop resolves its attention — and the failure
 * mode of a second, weaker copy is an operator-facing announcement of a setting
 * nobody chose.
 */
export function resolveDesignReviewBinding(
  checkpoint: IntentCheckpoint | undefined,
): DesignReviewBinding {
  const block = checkpoint?.design_review;
  if (!block) return { kind: "unanswered" };
  const confirmedAt = checkpoint.confirmed_at;
  const answeredAt = parseInstant(block.answered_at);
  if (answeredAt === undefined) {
    return {
      kind: "unbound",
      reason:
        `its \`answered_at\` (${
          block.answered_at === undefined
            ? "absent"
            : `\`${block.answered_at}\``
        }) is not a readable instant, so nothing records which confirmation answered it`,
    };
  }
  const thisRun = parseInstant(confirmedAt);
  if (thisRun === undefined) {
    return {
      kind: "unbound",
      reason:
        `this confirmation's \`confirmed_at\` (\`${confirmedAt}\`) is not a readable ` +
        "instant, so the block cannot be attributed to it",
    };
  }
  if (answeredAt !== thisRun) {
    return {
      kind: "unbound",
      reason:
        `it belongs to an earlier confirmation (answered at ` +
        `\`${block.answered_at}\`; this run's confirmation is \`${confirmedAt}\`)`,
    };
  }
  return { kind: "bound", settings: block };
}

/**
 * The `design_review` block, but ONLY when the confirmation the checkpoint
 * records is the one that ANSWERED it — the narrowed view of
 * {@link resolveDesignReviewBinding} for the consumers that only need the
 * dials. `undefined` for both non-bound outcomes, so every consumer falls back
 * to the schema default rather than honoring a depth the operator never chose.
 *
 * A consumer that must TELL the operator the block was ignored asks
 * {@link resolveDesignReviewBinding} instead and states its `reason`.
 */
export function resolveRunBoundDesignReview(
  checkpoint: IntentCheckpoint | undefined,
): DesignReviewSettings | undefined {
  const binding = resolveDesignReviewBinding(checkpoint);
  return binding.kind === "bound" ? binding.settings : undefined;
}
