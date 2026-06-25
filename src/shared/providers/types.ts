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
