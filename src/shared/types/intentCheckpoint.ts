import { z } from "zod";
import { FileDispositionStatusSchema } from "./disposition.js";
import { CeilingSchema } from "./charter.js";
import { CLOSING_ACTIONS } from "./closingActions.js";
import { readOptionalJsonFile } from "../io/json.js";

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

// ── The validated read ────────────────────────────────────────────────────────

/**
 * A checkpoint whose bytes did NOT satisfy {@link IntentCheckpointSchema}, with
 * the zod issues rendered as paths.
 *
 * A refusal is a THROW rather than `undefined` because "the file is not a
 * checkpoint" and "there is no file" are different facts with different
 * remedies: absent means the host has not confirmed yet (a normal fresh-run
 * state), while present-but-unparseable means a write went wrong and the run's
 * confirmed scope is not what the file appears to say. Returning `undefined`
 * for both would let a corrupted checkpoint silently re-enter the pre-confirm
 * path — the run would re-ask, and an operator would never learn that a
 * confirmation they made had been discarded.
 */
export class IntentCheckpointInvalidError extends Error {
  readonly path: string;
  readonly issues: readonly string[];
  constructor(path: string, issues: readonly string[]) {
    super(`${path} is not a valid intent checkpoint: ${issues.join("; ")}`);
    this.name = "IntentCheckpointInvalidError";
    this.path = path;
    this.issues = issues;
  }
}

/**
 * One top-level key the schema refused, with the value as it was WRITTEN.
 *
 * The value is carried here rather than left on the returned checkpoint because
 * the returned checkpoint must satisfy {@link IntentCheckpointSchema} — and a
 * key that failed validation is not part of a schema-valid value. A gate that
 * reports `closing_action: "deploy" is not one of …` needs to name the value it
 * is refusing, so the raw one travels beside the parsed value rather than
 * inside it.
 */
export interface RejectedCheckpointField {
  /** The top-level key the schema refused, exactly as written. */
  readonly key: string;
  /** The value that was written there, unvalidated and unmodified. */
  readonly value: unknown;
}

/**
 * The result of a lenient read: the checkpoint as far as it satisfies the
 * schema, plus the offending top-level fields the schema refused.
 *
 * `checkpoint` is `undefined` only when the file is not a checkpoint at all
 * (absent, non-object, or too damaged to prune to a valid value) — the same
 * cases the strict read treats as absent-or-invalid.
 */
export interface LenientIntentCheckpointRead {
  /**
   * A value {@link IntentCheckpointSchema} ACCEPTS. Every key that failed
   * validation is ABSENT from it — including keys inside a nested record,
   * which take their whole offending top-level record with them.
   */
  readonly checkpoint: IntentCheckpoint | undefined;
  /** The offending top-level fields, for a gate to quote by name. */
  readonly rejected: readonly RejectedCheckpointField[];
}

/**
 * Parse LENIENTLY: the checkpoint as far as it satisfies the schema, with the
 * offending FIELDS DROPPED rather than failing the whole read, and the raw
 * rejected values carried beside it.
 *
 * Why this is not just `safeParse`-and-undefined. The checkpoint's consumers
 * split into two kinds. Some act on a field as a VALUE and must see only
 * validated data (`customCommandOf`, the free-form-intent interpreter). Others
 * ask a PRESENCE question — "is this checkpoint confirmed by the host?" — whose
 * answer is a different field entirely, and which must still be answerable when
 * some OTHER field is out of vocabulary. A whole-file rejection conflates the
 * two: the gate that exists to report `closing_action: "deploy" is not one of …`
 * would lose the `confirmed_by` it needs to even reach that branch.
 *
 * THE RETURNED `checkpoint` IS SCHEMA-VALID, and a rejected key is ABSENT from
 * it. The earlier version of this function pruned the offending keys, re-parsed,
 * then re-attached them VERBATIM — which is unsound the moment the defect is
 * nested, because `IntentCheckpointSchema` is `.strict()` at every level: a
 * `filters` object carrying one bad member was deleted as a whole, re-parsed,
 * and then put back whole, so `{severity: ["high"], bogus: 1}` came back with
 * `filters.bogus === 1` on a value the schema REJECTS. A consumer reading it as
 * a value was reading unvalidated data through a function whose contract said
 * otherwise. The offending raw value travels on {@link
 * LenientIntentCheckpointRead.rejected} instead, so a caller that needs to
 * QUOTE a refused value can, and a caller that needs to USE one must still
 * validate it itself.
 *
 * A nested defect therefore takes its whole top-level record: the record is
 * what the schema refused, and re-attaching the record would reintroduce the
 * same unsoundness one level in. The gate can still quote the offending member
 * — it reads it from `rejected` — but nothing downstream can mistake it for
 * validated.
 */
function parseIntentCheckpointLenient(raw: unknown): LenientIntentCheckpointRead {
  const wholesale = IntentCheckpointSchema.safeParse(raw);
  if (wholesale.success) return { checkpoint: wholesale.data, rejected: [] };
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { checkpoint: undefined, rejected: [] };
  }
  const record = raw as Record<string, unknown>;
  // Drop each top-level key the schema complained about, then retry. One pass is
  // enough: dropping a key cannot make a DIFFERENT key's value valid or invalid,
  // so the second parse either succeeds or fails on keys that were already
  // reported. A nested issue names its top-level head here — that is the record
  // the second parse drops.
  const offending = new Set<string>();
  for (const issue of wholesale.error.issues) {
    const [head] = issue.path;
    if (typeof head === "string") offending.add(head);
    else offending.add("<root>");
  }
  if (offending.has("<root>")) return { checkpoint: undefined, rejected: [] };
  const pruned: Record<string, unknown> = { ...record };
  for (const key of offending) delete pruned[key];
  const second = IntentCheckpointSchema.safeParse(pruned);
  if (!second.success) return { checkpoint: undefined, rejected: [] };
  return {
    checkpoint: second.data,
    rejected: [...offending]
      .filter((key) => key in record)
      .map((key) => ({ key, value: record[key] })),
  };
}

/**
 * Read and validate an intent checkpoint — the ONE reader for both
 * orchestrators.
 *
 * Why this exists rather than each caller doing
 * `readOptionalJsonFile<IntentCheckpoint>(path)`. That call's type parameter is
 * an ASSERTION the compiler erases: it checks nothing, and the value it returns
 * is whatever JSON happened to be at the path, cast. Every remediate-side read
 * of `intent_checkpoint.json` was exactly that cast (five sites in
 * `steps/nextStep.ts`), while the schema that defines the file — this module's
 * — sat unused outside tests. A shape the reader never checked is a shape no
 * reader can rely on: `confirmed_by`, `closing_action` and `free_form_intent`
 * were each read off an unchecked object.
 *
 * ABSENT IS `undefined`, not an error (the fresh-run case). PRESENT AND INVALID
 * THROWS, per {@link IntentCheckpointInvalidError}.
 *
 * `lenient: true` does NOT loosen that guarantee: the value returned is always
 * one {@link IntentCheckpointSchema} accepts, with every offending field
 * dropped. A caller that must report an offending value reads it from
 * {@link readIntentCheckpointLenient}, which returns the raw rejections beside
 * the parsed value.
 */
export async function readIntentCheckpoint(
  path: string,
  opts: { readonly lenient?: boolean } = {},
): Promise<IntentCheckpoint | undefined> {
  const raw = await readOptionalJsonFile<unknown>(path);
  if (raw === undefined || raw === null) return undefined;
  const parsed = IntentCheckpointSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  if (opts.lenient) return parseIntentCheckpointLenient(raw).checkpoint;
  throw new IntentCheckpointInvalidError(
    path,
    parsed.error.issues.map(
      (issue) =>
        `${issue.path.length > 0 ? issue.path.join(".") : "<root>"}: ${issue.message}`,
    ),
  );
}

/**
 * Read an intent checkpoint LENIENTLY, keeping the fields the schema refused.
 *
 * The one reader for a caller that must NAME an offending value — the
 * confirm-intent gate renders `closing_action: "deploy" is not one of …`, and it
 * cannot do that from a value the field was dropped out of. Every other lenient
 * caller wants only {@link readIntentCheckpoint}'s `checkpoint` and should use
 * that instead: this function exists for the reporting case, not as a wider
 * door onto unvalidated data.
 *
 * `rejected` carries each refused TOP-LEVEL key with the value as written. A
 * defect nested inside a record appears under that record's key — the record is
 * what the schema refused, and the whole record is what stays out of the
 * returned checkpoint.
 */
export async function readIntentCheckpointLenient(
  path: string,
): Promise<LenientIntentCheckpointRead> {
  const raw = await readOptionalJsonFile<unknown>(path);
  if (raw === undefined || raw === null) {
    return { checkpoint: undefined, rejected: [] };
  }
  return parseIntentCheckpointLenient(raw);
}
