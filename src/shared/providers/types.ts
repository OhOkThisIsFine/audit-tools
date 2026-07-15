export interface WorkerProgress {
  type: "heartbeat" | "output";
  runId: string;
  obligationId: string | null;
  elapsedMs: number;
  message?: string;
}

export interface LaunchFreshSessionInput {
  repoRoot: string;
  runId: string;
  obligationId: string | null;
  promptPath: string;
  taskPath: string;
  resultPath: string;
  stdoutPath: string;
  stderrPath: string;
  uiMode: "visible" | "headless";
  timeoutMs: number;
  stdinText?: string;
  onProgress?: (update: WorkerProgress) => void;
  /**
   * Optional JSON Schema (draft-07 / 2020-12) describing the shape the worker's
   * `result` payload must take. Populated by the dispatch site from the canonical
   * zod worker schema (single-sourced — the caller passes the derived JSON Schema,
   * never a forked hand-authored copy). Providers that can constrain decoding to a
   * schema (the OpenAI-compatible / NIM / vLLM backends via `response_format`
   * `json_schema` / `guided_json`) read this ONCE and attach it to the request as
   * an ADDITIVE emit-time constraint (CE-004 build lever); providers with no
   * schema-constrained decoding (the agentic CLIs) ignore it and degrade to the
   * emit-validate-repair seam. A `null`/absent schema means "no constraint" — the
   * request behaves exactly as before.
   */
  outputSchema?: Record<string, unknown> | null;
  /**
   * The authoritative, repo-relative set of files the worker is granted to READ
   * for this task (audit review: the packet's `access.read_paths`; remediate
   * implement: the block's `access.read_paths`). A single-shot / no-file-access
   * provider (openai-compatible / NIM) inlines the CURRENT CONTENTS of these files
   * into the prompt deterministically — it has no Read tool, so paths alone are
   * useless to it. The agentic-CLI providers (claude-code / codex / opencode)
   * ignore this: they read the files themselves via their own tools.
   *
   * Distinct from the prose-scavenge fallback the openai-compatible provider also
   * runs: this list is the CONTRACT (every existing member MUST inline or the
   * launch refuses as unroutable), whereas scavenge is a best-effort supplement for
   * paths mentioned in prompt prose but not granted. A member that does not exist
   * on disk is a to-be-created file (a declared `touched_files` output) and is NOT
   * a failure — the worker writes it from scratch.
   */
  referencedFiles?: string[];
}

export interface LaunchFreshSessionResult {
  accepted: boolean;
  processId?: number;
  exitCode?: number | null;
  signal?: string | null;
  command?: string;
  args?: string[];
  stdoutPath?: string;
  stderrPath?: string;
  error?: string;
  /**
   * Endpoint-REPORTED cost for this request in USD, when the backend returns one
   * on its response (e.g. opencode's `cost` field on the chat.completion). This is
   * the provider's OWN reported charge read post-hoc from a completed response —
   * NOT an estimate and NOT a planning token count (the "token estimates stay
   * local / never API-call token counting" rule governs PLANNING; reading a
   * finished response's reported cost is after-the-fact measurement, allowed).
   * Absent when the backend reports no cost (standard OpenAI endpoints omit it) —
   * the reactive cost-verification seam only fires on a present, finite, positive
   * value, so a no-cost backend never triggers a demotion.
   */
  observedCostUsd?: number | null;
  /**
   * Endpoint-REPORTED token usage for this request, when the backend returns
   * structured usage counts on its response (the openai-compatible
   * chat-completions `usage` object). Read post-hoc from a completed response —
   * NOT a planning estimate (same allowed-measurement rule as
   * {@link observedCostUsd}; the "token estimates stay local" policy governs
   * PLANNING only). Individual fields are each independently optional — a field
   * the backend omitted stays `undefined` rather than being fabricated as 0.
   * Absent entirely when the backend reports no usage at all: the agentic-CLI
   * providers (claude-code / codex / opencode) spawn an external process with no
   * structured completion body and never populate this, so a consumer can tell
   * "unmeasured" apart from "measured zero."
   */
  observedUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  } | null;
}

export interface ProviderRateLimits {
  requests_per_minute?: number | null;
  input_tokens_per_minute?: number | null;
  output_tokens_per_minute?: number | null;
}

/**
 * The strongest output-constraint mode a backend can enforce at emit time (F3:
 * schema-enforced-generation). Modes ONLY — there is intentionally no concurrency
 * field here (concurrency is the broker's concern, F4). Ordered loosely strongest
 * → weakest:
 *
 *   - `forced_tool_call`        — the backend can be forced to answer through a
 *                                 single typed tool/function call, so the emitted
 *                                 shape is structurally guaranteed by the API.
 *   - `json_schema_constrained` — the backend accepts a JSON Schema and constrains
 *                                 decoding to it (grammar/JSON-schema mode).
 *   - `structured_output`       — the backend can be asked for a JSON object
 *                                 (e.g. `response_format: {type:"json_object"}`)
 *                                 but without per-field schema enforcement.
 *   - `none`                    — no API-level output constraint is available
 *                                 (e.g. an agentic CLI that only takes a prompt);
 *                                 the emit path MUST degrade to the O3
 *                                 emit-validate-repair seam.
 */
export type OutputConstraintMode =
  | "forced_tool_call"
  | "json_schema_constrained"
  | "structured_output"
  | "none";

/**
 * Per-backend output-constraint capability descriptor (F3 ↔ F4 seam: "descriptor
 * discovered once on the provider contract"). It is DISCOVERED ONCE at provider
 * construction — provider-agnostic, never keyed off a hardcoded model id — and
 * read (never recomputed) at the dispatch/emit site. A `mode` of `none` means the
 * emit path has no structural guarantee and must run results through the O3
 * emit-validate-repair seam.
 */
export interface OutputConstraintCapability {
  /** The strongest constraint this backend can enforce at emit time. */
  mode: OutputConstraintMode;
  /** Human-readable rationale for the discovered mode (provider-agnostic). */
  reason: string;
}

export interface FreshSessionProvider {
  name: string;
  launch(input: LaunchFreshSessionInput): Promise<LaunchFreshSessionResult>;
  queryLimits?(model: string | null): Promise<ProviderRateLimits | null>;
  /**
   * Output-constraint capability discovered ONCE at construction (F3). Optional on
   * the interface only so providers built before discovery wiring still satisfy
   * the type; the factory populates it for every provider it constructs.
   */
  outputConstraint?: OutputConstraintCapability;
}
