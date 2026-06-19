import { z } from "zod";
import { FileDispositionStatusSchema } from "./disposition.js";

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
     * `lens_proposals` in the scope pre-digest. `include` is additive (always
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
     * `confirm_intent`. Provider-neutral: it records *how much* conceptual review
     * to do, never *which model* runs it (model choice is resolved JIT at dispatch
     * against the active provider's discovered roster).
     * - `conceptual_depth: "shallow"` (default when omitted) — a single conceptual
     *   reviewer.
     * - `conceptual_depth: "deep"` — fan out `perspectives` independent reviewers
     *   with maximally dissimilar perspectives, then compile via an independent
     *   judge.
     * `perspectives` bounds the deep fan-out count; ignored when shallow.
     */
    design_review: z
      .object({
        conceptual_depth: z.enum(["shallow", "deep"]).optional(),
        perspectives: z.number().int().min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type IntentCheckpoint = z.infer<typeof IntentCheckpointSchema>;
