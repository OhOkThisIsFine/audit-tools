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
  confirmed_by: "host";
  /** Human-readable description of the confirmed scope. */
  scope_summary: string;
  /** Human-readable description of the goal (e.g. full-audit / delta). */
  intent_summary: string;
  /** Free-form intent threaded into worker/dispatch prompts. */
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
}
