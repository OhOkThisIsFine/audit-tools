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
}

export interface OpenCodeConfig {
  command?: string;
  extra_args?: string[];
}

export interface VSCodeTaskConfig {
  command_template: string[];
  env?: Record<string, string>;
}

export interface QuotaModelLimits {
  context_tokens?: number;
  output_tokens?: number;
  requests_per_minute?: number;
  input_tokens_per_minute?: number;
  output_tokens_per_minute?: number;
}

export interface QuotaConfig {
  /** Set to false to disable all quota scheduling (default: true). */
  enabled?: boolean;
  /** Whether to probe the provider for live limits (default: "auto"). */
  probe?: "auto" | "never" | "force";
  /** Fraction of known limits to actually use (default: 0.8). */
  safety_margin?: number;
  /** Concurrency ceiling for hosted providers with no learned data (default: 1). */
  unknown_hosted_concurrency?: number;
  /** Concurrency for local providers with no learned data (default: "unlimited"). */
  unknown_local_concurrency?: number | "unlimited";
  /** Assumed context window when the model is not recognized (default: 32000). */
  default_context_tokens?: number;
  /** Tokens reserved for model output per request (default: 4096). */
  reserved_output_tokens?: number;
  /** Half-life of empirical success/failure evidence in hours (default: 24). */
  empirical_half_life_hours?: number;
  /** Allow the scheduler to try concurrency maxSafe+1 after consecutive successes (default: true). */
  ramp_up_enabled?: boolean;
  /** Conservative concurrency cap for the first wave when no learned history
   *  and no discovered RPM/TPM limits exist (default: 3). */
  first_contact_concurrency?: number;
  /** Hard host ceiling for simultaneously active conversation subagents. */
  host_active_subagent_limit?: number;
  /** Per-model overrides keyed by "provider/model". */
  models?: Record<string, QuotaModelLimits>;
}

export const PROVIDER_SECTION_KEYS = {
  "subprocess-template": "subprocess_template",
  "claude-code": "claude_code",
  opencode: "opencode",
  "vscode-task": "vscode_task",
} as const;

/**
 * Provider names use CLI-friendly hyphenation, while nested provider config
 * sections stay snake_case because they serialize directly into JSON files.
 */
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
  quota?: QuotaConfig;
}
