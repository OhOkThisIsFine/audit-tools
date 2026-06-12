import type { FileDispositionStatus } from "./disposition.js";

/**
 * The accepted scope and intent for a run, confirmed by the host before
 * planning. Single-sourced so both orchestrators share one shape: audit-code
 * uses `excluded_scope`/`must_not_touch`/`free_form_intent`; remediate-code
 * additionally uses `filters` to narrow findings. `scope_summary`/
 * `intent_summary` are human renders; the structured fields are what downstream
 * planning, worker prompts, and reports actually consume.
 */
export interface IntentCheckpoint {
  schema_version: "intent-checkpoint/v1";
  confirmed_at: string;
  /**
   * `"host"` — checkpoint has been reviewed and confirmed by the host agent.
   * `"draft"` — preliminary checkpoint pre-populated by synthesize_intake worker;
   *   not yet confirmed; planning must not begin and filtering must not apply.
   */
  confirmed_by: "host" | "draft";
  /** Human-readable description of the confirmed scope. */
  scope_summary: string;
  /** Human-readable description of the goal (e.g. full-audit / delta). */
  intent_summary: string;
  /**
   * Free-form intent; interpreted into priority/lens/scope signals at planning
   * time via freeFormIntentInterpreter. Never threaded verbatim into worker or
   * dispatch prompts (see freeFormIntentInterpreter, INV-S04).
   */
  free_form_intent?: string;
  /** Paths intentionally excluded from the run, each with a reason. */
  excluded_scope?: Array<{ path: string; reason: string }>;
  /** Path globs that must never be written to. */
  must_not_touch?: string[];
  /** Remediate-only finding filters; audit-code ignores these. */
  filters?: {
    severity?: string[];
    lenses?: string[];
    packages?: string[];
    themes?: string[];
  };
  /**
   * Clauses from free_form_intent that could not be encoded as lens-weight,
   * priority, or scope signals. Each entry carries the original clause text,
   * the blocking checkpoint question raised for it, and the optional host
   * answer once resolved. These survive as explicit machine-checkable
   * contract constraints threaded into planning and worker prompts.
   */
  constraint_clauses?: Array<{
    /** The original unencodable clause text. */
    text: string;
    /** The blocking checkpoint question generated for this clause. */
    checkpoint_question: string;
    /** The host's answer to the checkpoint question once resolved. */
    host_answer?: string;
  }>;
  /**
   * Per-file or per-prefix status corrections accepted by the host. Applied
   * before coverage initialization so overridden files never become audit
   * tasks. Typically sourced from `disposition_override_proposals` in the
   * scope pre-digest shown during the `confirm_intent` step.
   */
  disposition_overrides?: Array<{
    path: string;
    status: FileDispositionStatus;
    reason: string;
  }>;
  /**
   * Accepted or modified lens set from the host, derived from the
   * `lens_proposals` in the scope pre-digest. `include` is additive (always
   * merged with mandatory lenses); `exclude` removes non-mandatory lenses.
   */
  lens_selection?: {
    include?: string[];
    exclude?: string[];
  };
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
  design_review?: {
    conceptual_depth?: "shallow" | "deep";
    perspectives?: number;
  };
}
