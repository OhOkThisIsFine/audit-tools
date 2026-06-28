import { z } from "zod";
import type { DispatchModelTier } from "./stepContract.js";

export const PROVIDER_NAMES = [
  "auto",
  "local-subprocess",
  "subprocess-template",
  "claude-code",
  "codex",
  "opencode",
  "openai-compatible",
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
 * Codex CLI backend config. Codex is a headless coding CLI (like claude-code):
 * the non-interactive entrypoint is `codex exec`, which reads the rendered prompt
 * from stdin and runs to completion editing files (verified against codex-cli
 * 0.140.0). The provider manages the invocation; these fields tune it.
 */
export interface CodexConfig {
  /** Launcher on PATH (default "codex"; on Windows resolved through cmd.exe). */
  command?: string;
  /**
   * `codex exec --sandbox` policy. Default "workspace-write" — writes confined to
   * the working root (the node's worktree) plus the result dir (granted via
   * `--add-dir`), which reinforces worktree isolation. "danger-full-access" drops
   * the sandbox (use only when the run is already externally isolated).
   */
  sandbox_mode?: "read-only" | "workspace-write" | "danger-full-access";
  /** Model the agent should use (`codex exec --model`). Never defaulted here — codex's own default applies when unset (no hardcoded model identity). */
  model?: string;
  /** Extra argv appended after the managed `codex exec` flags. */
  extra_args?: string[];
}

/**
 * OpenAI-compatible chat-completions backend config (NVIDIA NIM, vLLM, LM Studio,
 * OpenRouter, any `/chat/completions` endpoint). Unlike the agentic-CLI providers,
 * this needs no installed agent — the provider itself is a single-shot worker that
 * calls the endpoint and applies the returned edits to the worktree. Because it
 * only needs an API key + URL, it is a portable, always-available background
 * dispatch pool. The endpoint, model id, and key source are all operator-supplied
 * (no hardcoded model identity); NIM is just one instance:
 * `{ base_url: "https://integrate.api.nvidia.com/v1", model: "openai/gpt-oss-120b",
 *    api_key_env: "NVIDIA_API_KEY" }`.
 */
export interface OpenAiCompatibleConfig {
  /** Base URL of the OpenAI-compatible API, e.g. `https://integrate.api.nvidia.com/v1`. */
  base_url?: string;
  /** Model id (e.g. `openai/gpt-oss-120b`). Never defaulted — no hardcoded model identity. */
  model?: string;
  /** Name of the env var holding the API key (e.g. `NVIDIA_API_KEY`). Preferred over `api_key`. */
  api_key_env?: string;
  /** Inline API key. Discouraged (prefer `api_key_env` so the key never lands in config files). */
  api_key?: string;
  /** Extra HTTP headers merged into the request. */
  headers?: Record<string, string>;
  /** Sampling temperature (default 0 for deterministic edits). */
  temperature?: number;
  /** Completion token budget (`max_tokens`). Defaults to a generous value so full files fit. */
  max_output_tokens?: number;
  /**
   * Send `response_format: {type:"json_object"}`. ON by default (nullish: enabled
   * unless explicitly `false`). If the endpoint rejects it (HTTP 400/422), the
   * provider retries once without it, so leaving it on is safe for any endpoint.
   */
  response_format_json?: boolean;
  /** Inline current contents of prompt-referenced files so edits are grounded. Default true. */
  include_referenced_files?: boolean;
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
  "openai-compatible": "openai_compatible",
  "vscode-task": "vscode_task",
  antigravity: "antigravity",
} as const;

/**
 * The non-IDE backends a {@link DispatchableSource} can run. Excludes the
 * conversation host (`claude-code`) and the IDE-bound providers (`vscode-task` /
 * `antigravity`), which are driven through their host/IDE, not as a generic
 * dispatchable source with an endpoint + parameters.
 */
export const DISPATCHABLE_SOURCE_PROVIDERS = [
  "openai-compatible",
  "codex",
  "opencode",
  "local-subprocess",
  "subprocess-template",
] as const;
export type DispatchableSourceProvider =
  (typeof DISPATCHABLE_SOURCE_PROVIDERS)[number];

/**
 * A generic dispatchable backend source — the uniform shape the dispatch engine
 * spills work onto, applicable to ANY non-IDE source (an OpenAI-compatible API like
 * NIM / vLLM / LM Studio, a headless CLI like codex / opencode, a subprocess
 * template, …). A source is its `{provider, endpoint, parameters, quota}`, so the
 * operator can configure MANY of them (two NIM endpoints, a local vLLM + a hosted
 * model, a CLI pool) and each becomes its own CapacityPool with its own rate limit.
 *
 * `endpoint` + `parameters` are interpreted per provider: for `openai-compatible`
 * the endpoint is the API `base_url` and `parameters` carries `temperature` /
 * `headers` / `max_output_tokens` / …; for a CLI (`codex` / `opencode` /
 * `local-subprocess`) the endpoint is the launcher command and `parameters` carries
 * `extra_args` / `sandbox_mode` / `command_template` / …. The bridge to each
 * provider's concrete config block lives in `sourceProviderConfig` (shared).
 */
export interface DispatchableSource {
  /**
   * Stable id for this source — the CapacityPool id + the key learned quota is
   * recorded under. Defaults to `${provider}:${model ?? endpoint}` when omitted, so
   * two sources of the same provider stay distinct as long as their model/endpoint
   * differ (give them explicit ids otherwise).
   */
  id?: string;
  /** The non-IDE backend that runs this source. */
  provider: DispatchableSourceProvider;
  /** API base URL (`openai-compatible`) or launcher command (CLI providers). */
  endpoint?: string;
  /** Model id, where the backend takes one. Never defaulted (no hardcoded model identity). */
  model?: string;
  /** Env var holding the API key (API sources). Preferred over `api_key`. */
  api_key_env?: string;
  /** Inline API key (discouraged — prefer `api_key_env`). */
  api_key?: string;
  /**
   * Backend-specific extra parameters, merged into the provider's config block:
   * `temperature` / `headers` / `max_output_tokens` / `response_format_json` /
   * `include_referenced_files` (openai-compatible); `extra_args` / `sandbox_mode`
   * (codex); `extra_args` (opencode); `command_template` / `env` (subprocess).
   */
  parameters?: Record<string, unknown>;
  /** Per-source quota / rate-limit (rpm, tpm, context/output tokens). */
  quota?: QuotaModelLimits;
  /**
   * Path to THIS source's own credential file, when it authenticates as a
   * different account than the host (e.g. a Claude CLI signed into a second
   * account: its own `.credentials.json`; a second Codex `auth.json`). The
   * source's quota probe + account id are read from here, so the source forms a
   * pool keyed on its OWN `(provider, account)` — distinct budget from the host's
   * same-provider pool (docs/quota-dispatch-design.md §5b). Omit when the source
   * shares the host's account.
   */
  credentials_path?: string;
  /**
   * Explicit account id override for the pool key, when it can't be read from a
   * credential (e.g. an API-key source). Takes precedence over the credential-read
   * account. Omit to auto-resolve from {@link credentials_path} / the host cred.
   */
  account?: string;
}

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

/**
 * Relative cut points (on the normalized [0,1] risk scale) that map a packet's
 * `routing_risk` (max member risk) to a relative model rank. These are NOT
 * model names or per-model windows — ranks stay relative and windows are
 * discovered at the dispatch handshake (no-hardcoded-models invariant).
 */
export interface DispatchRoutingTiers {
  /** routing_risk >= deep_at routes to the top rank. Default 0.66. */
  deep_at?: number;
  /** routing_risk >= standard_at routes to the middle rank. Default 0.33. */
  standard_at?: number;
}

export interface DispatchConfig {
  /**
   * When `agent_count` (packets dispatched this run, after budget
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
  /**
   * Risk-mass ceiling for the just-in-time graph partition (Phase B of the
   * plan/dispatch seam): the maximum aggregate node-risk a single packet may
   * accumulate before the partitioner splits a coherent cluster along its
   * weakest internal edge. Node risk is in [0,1]. A ceiling, not a quota —
   * high-risk clusters are never padded with low-risk filler. Model-parameterized
   * in principle (a stronger model warrants a higher ceiling); until per-model
   * values are discovered at handshake it defaults to DEFAULT_RISK_MASS_BUDGET.
   */
  risk_mass_budget?: number;
  /**
   * Override the relative risk→rank cut points used to derive each packet's
   * `model_hint.tier` from its `routing_risk` at dispatch.
   */
  routing_tiers?: DispatchRoutingTiers;
  /**
   * Opt IN to the in-process rolling dispatch engine for remediate's implement
   * phase (quota-derived concurrency + dispatch-next-on-complete + worktree
   * isolation + per-node verify into merge). Defaults to OFF: the proven
   * host-fanned wave path remains the default until a real multi-worker rolling
   * dispatch has been validated end-to-end (CE-001 anti-wedge — the atomic
   * removal of the host-wave fallback is gated on that proof). Also enabled via
   * the `REMEDIATE_ROLLING_ENGINE=true` env var. Honoured only when a
   * programmatic per-node dispatcher is available (a subprocess/CLI provider);
   * the conversation host, which fans out its own subagents, never engages it.
   */
  rolling_engine?: boolean;
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
 * External-analyzer acquisition (Slice D). Acquisition is default-ON on the real
 * CLI next-step path; `enabled: false` opts the whole pass out. `consent_token`
 * unlocks the consent-gated, non-default candidates (semgrep / eslint); gitleaks
 * (the default-run secret scanner) runs without one.
 */
export interface ExternalAcquisitionConfig {
  enabled?: boolean;
  consent_token?: string;
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
export const AnalyzerSettingSchema = z.enum(ANALYZER_SETTINGS);
export type AnalyzerSetting = z.infer<typeof AnalyzerSettingSchema>;

export interface DesignReviewConfig {
  /**
   * Maximum number of highest-risk units to include in the focused reading list
   * rendered into the design-review prompt. The reviewer is asked to prioritise
   * these units but may follow any thread that demands more context.
   * Defaults to a value that scales with repo size (see renderDesignReviewPrompt).
   */
  max_units?: number;
  /**
   * Controls the depth of the conceptual design review pass.
   * - `"shallow"` (default): single-agent conceptual review.
   * - `"deep"`: instructs the host to fan out independent reviewers with
   *   maximally dissimilar perspectives, then compile via an independent judge.
   * Mirrors `IntentCheckpoint.design_review.conceptual_depth`; the checkpoint is
   * the user-confirmed source and this config the host/session override.
   */
  conceptual_depth?: "shallow" | "deep";
  /**
   * Number of independent perspective subagents to fan out when
   * `conceptual_depth` is `"deep"`. Ignored when shallow. Clamped to the
   * supported range (2 … number of built-in perspectives); defaults to
   * `DEFAULT_CONCEPTUAL_PERSPECTIVES`. Mirrors
   * `IntentCheckpoint.design_review.perspectives`, which is the user-confirmed
   * source; this config is the host/session override.
   */
  perspectives?: number;
  /**
   * Relative model rank for the deep conceptual pass's perspective subagents
   * (divergent ideation rarely needs the top rank). Defaults to `"standard"`.
   * The judge always routes `"deep"` — it merges/dedups/ranks across every
   * perspective output, the hardest reasoning step in the pass.
   */
  perspective_tier?: DispatchModelTier;
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
  /**
   * Run unattended (nightly autonomous pipeline). Host-agnostic — ONE flag
   * drives the whole path, with no cloud/local fork. When set, the
   * review-approval gate does NOT halt for a human: it auto-approves only the
   * findings whose ambiguity tier is "safe" AND whose change-kind is positively
   * on the fail-closed non-destructiveness ALLOWLIST (additive / localized /
   * reversible — see src/remediate/review/autonomousGate.ts). Every other
   * finding is left LIVE and re-emitted as a re-consumable audit deliverable
   * pair (audit-findings.json + audit-report.md); leftovers are NEVER durably
   * rejected, so the next nightly run re-evaluates them fresh. Ambiguity-only:
   * there is NO cost / severity / run-budget gate.
   */
  autonomous_mode?: boolean;
  subprocess_template?: SubprocessTemplateConfig;
  claude_code?: ClaudeCodeConfig;
  codex?: CodexConfig;
  opencode?: OpenCodeConfig;
  openai_compatible?: OpenAiCompatibleConfig;
  vscode_task?: VSCodeTaskConfig;
  antigravity?: AntigravityConfig;
  /**
   * Additional dispatchable backend sources the engine spills onto, beyond the
   * primary `provider`. Each is a generic `{provider, endpoint, parameters, quota}`
   * (see {@link DispatchableSource}) and becomes its own CapacityPool — so any
   * non-IDE source (multiple NIM/vLLM endpoints, a CLI pool, …) is dispatchable
   * uniformly. A legacy `openai_compatible` block (when it isn't the primary
   * provider) is folded in as one implicit source for back-compat.
   */
  sources?: DispatchableSource[];
  agent_task_batch_size?: number;
  parallel_workers?: number;
  block_quota?: BlockQuotaConfig;
  quota?: QuotaConfig;
  observability?: ObservabilityConfig;
  synthesis?: SynthesisConfig;
  /** Per-analyzer resolution policy for the optional graph-enrichment pass. */
  analyzers?: Record<string, AnalyzerSetting>;
  /**
   * External-analyzer acquisition (Slice D — gitleaks + consent-gated
   * semgrep/eslint). Acquisition is default-ON on the real CLI next-step path
   * (high-value, low-overhead secret scanning); set `enabled: false` to opt out.
   * `consent_token` unlocks the non-default candidates (semgrep / eslint).
   */
  external_acquisition?: ExternalAcquisitionConfig;
  /** Optional graph-enrichment tuning (Phase 4B edge reasoning). */
  graph?: GraphConfig;
  /** Dispatch fan-out controls (confirmation threshold, packet budget). */
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
