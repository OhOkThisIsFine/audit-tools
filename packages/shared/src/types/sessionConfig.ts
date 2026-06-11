export const PROVIDER_NAMES = [
  "auto",
  "local-subprocess",
  "subprocess-template",
  "claude-code",
  "codex",
  "opencode",
  "vscode-task",
  "antigravity",
] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];
export type ResolvedProviderName = Exclude<ProviderName, "auto">;

export const SESSION_UI_MODES = ["visible", "headless"] as const;
export type SessionUiMode = (typeof SESSION_UI_MODES)[number];

export interface SubprocessTemplateConfig {
  command_template: string[];
  env?: Record<string, string>;
}

export interface ClaudeCodeConfig {
  command?: string;
  extra_args?: string[];
  dangerously_skip_permissions?: boolean;
  prompt_flag?: string;
}

export interface OpenCodeConfig {
  command?: string;
  extra_args?: string[];
}

/**
 * Codex CLI backend config. Codex is a headless CLI (like claude-code), so it is
 * driven by a binary + flags rather than a command template. `prompt_flag` is the
 * non-interactive prompt-delivery flag (see CodexProvider; the default is a
 * TODO(verify) assumption until confirmed against the real Codex CLI).
 */
export interface CodexConfig {
  command?: string;
  extra_args?: string[];
  prompt_flag?: string;
}

export interface VSCodeTaskConfig {
  command_template: string[];
  env?: Record<string, string>;
}

/**
 * Antigravity backend config. Antigravity is an agentic IDE with no headless
 * invocation, so it is driven by an operator-configured command/task template —
 * the same shape as vscode_task.
 */
export interface AntigravityConfig {
  command_template: string[];
  env?: Record<string, string>;
}

export const PROVIDER_SECTION_KEYS = {
  "subprocess-template": "subprocess_template",
  "claude-code": "claude_code",
  codex: "codex",
  opencode: "opencode",
  "vscode-task": "vscode_task",
  antigravity: "antigravity",
} as const;

export interface BlockQuotaConfig {
  context_tokens?: number;
  reserved_output_tokens?: number;
  host_model?: string;
}

export interface QuotaModelLimits {
  context_tokens?: number;
  output_tokens?: number;
  requests_per_minute?: number;
  input_tokens_per_minute?: number;
  output_tokens_per_minute?: number;
}

export interface QuotaConfig {
  enabled?: boolean;
  safety_margin?: number;
  unknown_hosted_concurrency?: number;
  unknown_local_concurrency?: number | "unlimited";
  default_context_tokens?: number;
  reserved_output_tokens?: number;
  empirical_half_life_hours?: number;
  ramp_up_enabled?: boolean;
  first_contact_concurrency?: number;
  host_active_subagent_limit?: number;
  models?: Record<string, QuotaModelLimits>;
}

export interface OpenTokenConfig {
  enabled?: boolean;
  command?: string;
}

export interface ObservabilityConfig {
  /** Emit the structured run log (run.log.jsonl). Defaults to true. */
  run_log?: boolean;
}

export interface SynthesisConfig {
  /**
   * Generate the optional LLM synthesis narrative (themes, executive summary,
   * top risks) and append it to `audit-findings.json` / `audit-report.md`.
   * Defaults to on when a provider/host agent is available; the deterministic
   * report is unchanged when omitted.
   */
  narrative?: boolean;
}

export interface DispatchConfig {
  /**
   * Dispatch only the top-priority packet on first contact (phase "canary"),
   * then fan out the remaining packets once the canary produces an accepted
   * result. No-op when a run has <=1 packet. Defaults to true (on).
   */
  canary?: boolean;
  /**
   * When `agent_count` (packets dispatched this run, after canary/budget
   * filtering) exceeds this value the loader should pause and ask the user to
   * confirm before fan-out. Defaults to 10.
   */
  confirm_threshold?: number;
  /**
   * Hard cap on the number of review packets dispatched in a single run.
   * Packets are already priority-ordered (high -> medium -> low) by
   * `prepareDispatchArtifacts`; when `max_packets` is set, only the first K
   * packets are emitted and the remainder are recorded as DEFERRED.
   * Default: all packets (no cap).
   */
  max_packets?: number;
}

export interface GraphConfig {
  /**
   * Phase 4B: run the optional, bounded edge-reasoning pass that rewrites the
   * human-readable `reason` of low-confidence graph edges (never the edge set
   * itself). Defaults to off; it is a no-op without host-supplied rewrites.
   */
  llm_edge_reasoning?: boolean;
  /** Model override for the edge-reasoning pass (host's choice otherwise). */
  model?: string;
}

/**
 * Per-analyzer resolution policy for the optional graph-enrichment pass
 * (`analyzers.<id>`). Resolution order is repo node_modules → version-keyed
 * analyzer cache → (for `ephemeral`/`permanent`) install into the cache, else
 * the regex floor.
 *
 * - `repo`     — use only the audited repo's node_modules; absent ⇒ regex floor.
 * - `ephemeral`/`permanent` — resolve repo→cache, installing into the shared
 *   cache if absent (never touches the audited project). `permanent` is a
 *   durable opt-in; `ephemeral` is a one-time/per-need install. Both behave the
 *   same for resolution.
 * - `skip`     — never run this analyzer.
 * - `auto`     — resolve repo→cache; if absent and the analyzer has in-scope
 *   files, the conversation-first flow proposes an install. Unanswered ⇒ skip.
 */
export const ANALYZER_SETTINGS = [
  "repo",
  "ephemeral",
  "permanent",
  "skip",
  "auto",
] as const;
export type AnalyzerSetting = (typeof ANALYZER_SETTINGS)[number];

export interface DesignReviewConfig {
  /**
   * Maximum number of highest-risk units to include in the focused reading list
   * rendered into the design-review prompt. The reviewer is asked to prioritise
   * these units but may follow any thread that demands more context.
   * Defaults to a value that scales with repo size (see renderDesignReviewPrompt).
   */
  max_units?: number;
}

/**
 * Forward-declared shape for ConfirmedProviderPool so SessionConfig does not
 * take a hard dependency on the providerConfirmation module (which imports from
 * this file). The authoritative definition lives in providers/providerConfirmation.ts.
 */
export interface ConfirmedProviderPoolRef {
  providers: unknown[];
  excluded: string[];
  addedUndetected: unknown[];
}

export interface SessionConfig {
  provider?: ProviderName;
  timeout_ms?: number;
  ui_mode?: SessionUiMode;
  host_can_dispatch_subagents?: boolean;
  subprocess_template?: SubprocessTemplateConfig;
  claude_code?: ClaudeCodeConfig;
  codex?: CodexConfig;
  opencode?: OpenCodeConfig;
  vscode_task?: VSCodeTaskConfig;
  antigravity?: AntigravityConfig;
  agent_task_batch_size?: number;
  parallel_workers?: number;
  block_quota?: BlockQuotaConfig;
  quota?: QuotaConfig;
  opentoken?: OpenTokenConfig;
  observability?: ObservabilityConfig;
  synthesis?: SynthesisConfig;
  /** Per-analyzer resolution policy for the optional graph-enrichment pass. */
  analyzers?: Record<string, AnalyzerSetting>;
  /** Optional graph-enrichment tuning (Phase 4B edge reasoning). */
  graph?: GraphConfig;
  /** Dispatch fan-out controls (canary, confirmation threshold, packet budget). */
  dispatch?: DispatchConfig;
  /** Optional design-review tuning (focused reading list budget). */
  design_review?: DesignReviewConfig;
  /**
   * Confirmed provider pool persisted after Gate-0 confirmation. Carries the
   * operator-validated set of available providers across the audit→remediate
   * session (INV-S03). Typed as ConfirmedProviderPoolRef here to avoid a
   * circular import; the full ConfirmedProviderPool type lives in
   * providers/providerConfirmation.ts.
   */
  confirmed_provider_pool?: ConfirmedProviderPoolRef;
}
