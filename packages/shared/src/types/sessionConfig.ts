export const PROVIDER_NAMES = [
  "auto",
  "local-subprocess",
  "subprocess-template",
  "claude-code",
  "opencode",
  "vscode-task",
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

export interface VSCodeTaskConfig {
  command_template: string[];
  env?: Record<string, string>;
}

export const PROVIDER_SECTION_KEYS = {
  "subprocess-template": "subprocess_template",
  "claude-code": "claude_code",
  opencode: "opencode",
  "vscode-task": "vscode_task",
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
  probe?: "auto" | "never" | "force";
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

export interface SessionConfig {
  provider?: ProviderName;
  timeout_ms?: number;
  ui_mode?: SessionUiMode;
  host_can_dispatch_subagents?: boolean;
  subprocess_template?: SubprocessTemplateConfig;
  claude_code?: ClaudeCodeConfig;
  opencode?: OpenCodeConfig;
  vscode_task?: VSCodeTaskConfig;
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
}
