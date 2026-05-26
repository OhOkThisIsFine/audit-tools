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

/**
 * Context-budget config for implementation block sizing.
 * Mirrors auditor-lambda's quota model — defaults match Claude Sonnet 4.6.
 */
export interface BlockQuotaConfig {
  /** Total context window tokens for the implementation agent. */
  context_tokens?: number;
  /** Tokens reserved for agent output (reduces available input budget). */
  reserved_output_tokens?: number;
  /** Model identifier for looking up known limits (e.g. "anthropic/claude-sonnet-4-6"). */
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
  host_active_subagent_limit?: number;
  models?: Record<string, QuotaModelLimits>;
}

/**
 * Provider names use CLI-friendly hyphenation, while nested provider config
 * sections stay snake_case because they serialize directly into JSON files.
 */
export interface SessionConfig {
  provider?: ProviderName;
  timeout_ms?: number;
  ui_mode?: SessionUiMode;
  subprocess_template?: SubprocessTemplateConfig;
  claude_code?: ClaudeCodeConfig;
  opencode?: OpenCodeConfig;
  vscode_task?: VSCodeTaskConfig;
  agent_task_batch_size?: number;
  parallel_workers?: number;
  block_quota?: BlockQuotaConfig;
  host_can_dispatch_subagents?: boolean;
  quota?: QuotaConfig;
}
