import { z } from "zod";
import type { DispatchModelTier } from "./stepContract.js";

export const PROVIDER_NAMES = [
  "auto",
  "worker-command",
  "subprocess-template",
  "claude-code",
  "claude-worker",
  "codex",
  "opencode",
  "openai-compatible",
  "vscode-task",
  "antigravity",
  "agy",
] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];
export type ResolvedProviderName = Exclude<ProviderName, "auto">;

/**
 * Validate a `--host-provider` CLI value against {@link PROVIDER_NAMES}, throwing
 * the same message both orchestrators surface on a typo (host_provider is a
 * quota-ATTRIBUTION key — a silently-wrong value would mis-charge dispatch fan-out
 * to the wrong account). Single-sourced so audit's `getHostProvider` and
 * remediate's `parseHostProviderOption` cannot drift.
 */
export function assertHostProviderName(
  value: string,
): asserts value is ProviderName {
  // claude-worker is the proxied dispatch WORKER class — it can never be the
  // conversation host driving a run, and host_provider is a quota-ATTRIBUTION
  // key, so admitting it here would mis-charge fan-out to a worker identity.
  if (
    value === "claude-worker" ||
    !(PROVIDER_NAMES as readonly string[]).includes(value)
  ) {
    const hostNames = PROVIDER_NAMES.filter((n) => n !== "claude-worker");
    throw new Error(
      `--host-provider must be one of: ${hostNames.join(", ")} (got "${value}")`,
    );
  }
}

/**
 * The attended-vs-headless discriminator for dispatch (defect-1). TRUE (default,
 * conversation-first) means an attended conversation host is driving THIS invocation
 * and can fan out subagents — so a configured in-process backend (codex / opencode /
 * openai-compatible) is DEMOTED to a source pool and the host + backend + any NIM
 * source fan out concurrently. FALSE (declared headless) means no attended dispatcher
 * is present, so a configured in-process backend self-drives the whole frontier.
 *
 * Resolution order: explicit per-invocation value → `sessionConfig.host_can_dispatch_subagents`
 * → the tool-specific env var → TRUE. Single-sourced so audit and remediate cannot
 * drift; each passes its own `envVarName` (`AUDIT_CODE_HOST_CAN_DISPATCH` /
 * `REMEDIATE_HOST_CAN_DISPATCH`).
 */
export function resolveHostDispatchCapability(options: {
  explicit?: boolean;
  sessionConfig?: { host_can_dispatch_subagents?: boolean } | null;
  envVarName: string;
  env?: NodeJS.ProcessEnv;
}): boolean {
  if (options.explicit !== undefined) return options.explicit;
  const cfg = options.sessionConfig?.host_can_dispatch_subagents;
  if (cfg !== undefined) return cfg;
  const envValue = (options.env ?? process.env)[options.envVarName];
  if (envValue === "true") return true;
  if (envValue === "false") return false;
  return true;
}

/**
 * Whether the in-process rolling dispatch engine drives an orchestrator's
 * dispatch phase. Single-sourced resolution order (identical for both
 * orchestrators, differing only in the env var name each passes as
 * `envVarName`): explicit per-invocation value → `sessionConfig.dispatch.rolling_engine`
 * → the tool-specific env var (`AUDIT_CODE_ROLLING_ENGINE` /
 * `REMEDIATE_ROLLING_ENGINE`) → default TRUE (the rolling drivers are validated
 * end-to-end; the legacy host-fanned wave path is the explicit opt-OUT). Mirrors
 * the {@link resolveHostDispatchCapability} pattern above.
 */
export function resolveRollingEngineFlag(options: {
  explicit?: boolean;
  sessionConfig?: { dispatch?: { rolling_engine?: boolean } } | null;
  envVarName: string;
  env?: NodeJS.ProcessEnv;
}): boolean {
  if (options.explicit !== undefined) return options.explicit;
  const cfg = options.sessionConfig?.dispatch?.rolling_engine;
  if (cfg !== undefined) return cfg;
  const envValue = (options.env ?? process.env)[options.envVarName];
  if (envValue === "true") return true;
  if (envValue === "false") return false;
  return true;
}

/**
 * Whether the run is unattended (autonomous). Host-agnostic — ONE flag drives the
 * whole path. Resolution order: `sessionConfig.autonomous_mode` →
 * `AUDIT_TOOLS_AUTONOMOUS` env → false (the attended/interactive default, so a gate
 * halts for a human unless autonomy is explicitly requested).
 *
 * Unlike {@link resolveHostDispatchCapability} / {@link resolveRollingEngineFlag},
 * this takes NO per-tool `envVarName`: attendedness is a property of the RUN, not of
 * one tool's invocation, and the same pipeline drives audit→remediate end to end. A
 * run that is unattended for the auditor is unattended for the remediator, so a
 * per-tool name could only ever encode a contradiction. (Lifted out of
 * `src/remediate/` for G3's reconciliation gate — audit needs the same flag; the old
 * `REMEDIATE_AUTONOMOUS` name went with the fork.)
 */
export function resolveAutonomousMode(options: {
  sessionConfig?: { autonomous_mode?: boolean } | null;
  env?: NodeJS.ProcessEnv;
} = {}): boolean {
  const cfg = options.sessionConfig?.autonomous_mode;
  if (cfg !== undefined) return cfg;
  const envValue = (options.env ?? process.env).AUDIT_TOOLS_AUTONOMOUS;
  if (envValue === "true") return true;
  if (envValue === "false") return false;
  return false;
}

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
 * claude-worker launch config — the proxied, ISOLATED Claude-harness worker
 * (`claude -p` fronted by the proxy). Unlike the other provider blocks this
 * is never operator-persisted: it is COMPOSED AT LAUNCH by `sourceProviderConfig`
 * from the {@link DispatchableSource} itself (`endpoint` = the proxy url,
 * `model` = the proxy alias for routing). All three routing fields are
 * constructor invariants of `ClaudeWorkerProvider` — optional here only because
 * config shapes are uniformly partial; construction throws loudly when any is
 * missing/empty (an in-session isolated spawn with NO proxy endpoint must be
 * impossible).
 */
export interface ClaudeWorkerConfig {
  /** The proxy base url the spawn is fronted with (`ANTHROPIC_BASE_URL`). REQUIRED at construction. */
  endpoint?: string;
  /** The backend service the proxy routes to (used for quota/identity, not argv). REQUIRED at construction. */
  service?: string;
  /** Proxy-facing model alias (`--model` argv). REQUIRED at construction. */
  model?: string;
  /** Env var holding the proxy's master key (resolved to `ANTHROPIC_AUTH_TOKEN` at launch; absent = sentinel). */
  api_key_env?: string;
  /** Launcher on PATH (default "claude"). */
  command?: string;
  /** Prompt flag (default "-p"; the prompt itself is piped via stdin). */
  prompt_flag?: string;
  /** Extra argv appended after the managed flags. */
  extra_args?: string[];
  /** Skip permission prompts (`--dangerously-skip-permissions`). Explicit value wins over the per-orchestrator default. */
  dangerously_skip_permissions?: boolean;
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
  /**
   * Plumb the worker's canonical JSON Schema into the request as a per-field
   * emit-time constraint (`response_format: {type:"json_schema"}` for OpenAI /
   * vLLM structured outputs, plus `guided_json` / `nvext.guided_json` for NIM /
   * vLLM guided decoding) whenever the dispatch site supplies a schema (CE-004
   * build lever). ON by default (nullish: enabled unless explicitly `false`) — it
   * is ADDITIVE and degrades cleanly: if the endpoint rejects the schema form
   * (HTTP 400/422) the provider retries with a plain `json_object`, then without
   * any `response_format`, so leaving it on is safe for any endpoint. Set `false`
   * to force the weaker `json_object`-only behavior.
   */
  guided_json?: boolean;
  /** Inline current contents of prompt-referenced files so edits are grounded. Default true. */
  include_referenced_files?: boolean;
  /**
   * Max number of prompt-referenced files inlined into a single-shot request
   * (default 24). Raise for read-heavy AUDIT review packets on a large-context
   * endpoint so every granted file reaches the worker (it has no Read tool) rather
   * than being silently truncated to a coverage hole.
   */
  referenced_files_max?: number;
  /** Per-file byte cap when inlining referenced file contents (default 64 KiB). */
  referenced_file_byte_cap?: number;
  /** Aggregate byte cap across all inlined referenced files (default 256 KiB). */
  referenced_files_total_byte_cap?: number;
  /**
   * Per-endpoint quota / rate-limit — the SAME shape a {@link DispatchableSource}
   * carries in `quota`, so a legacy `openai_compatible` block converges onto the
   * source-pool budget instead of falling to the default context/output floor
   * (`DEFAULT_CONTEXT_TOKENS` / `DEFAULT_OUTPUT_TOKENS`). Set `context_tokens` /
   * `output_tokens` to size dispatch packets against this endpoint's real window
   * (e.g. a 128k NIM deployment), and `max_concurrent` to declare its in-flight
   * cap — both flow through `openAiCompatibleSource` → `buildSourcePool`
   * (`discoveredLimits` / `concurrencyCap`) identically to an explicit
   * `sources[]` entry. Omit for the conservative default floor.
   */
  quota?: QuotaModelLimits;
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

/**
 * Agy CLI backend config. Agy is a headless coding CLI (like claude-code and codex).
 * Built on the same agent harness as the legacy Gemini CLI.
 */
export interface AgyConfig {
  /** Launcher command on PATH (defaults to "agy"; falls back to "gemini" until July 18th sunset). */
  command?: string;
  /** Extra argv appended after default options. */
  extra_args?: string[];
  /** Dangerously skip permissions/prompts (passes --dangerously-skip-permissions on agy, -y on gemini). */
  dangerously_skip_permissions?: boolean;
  /** Model the agent should use (passes --model on agy, -m on gemini). */
  model?: string;
}

export const PROVIDER_SECTION_KEYS = {
  "subprocess-template": "subprocess_template",
  "claude-code": "claude_code",
  "claude-worker": "claude_worker",
  codex: "codex",
  opencode: "opencode",
  "openai-compatible": "openai_compatible",
  "vscode-task": "vscode_task",
  antigravity: "antigravity",
  agy: "agy",
} as const;

/**
 * The non-IDE backends a {@link DispatchableSource} can run. Excludes the
 * conversation host (`claude-code`) and the IDE-bound providers (`vscode-task` /
 * `antigravity`), which are driven through their host/IDE, not as a generic
 * dispatchable source with an endpoint + parameters.
 *
 * `claude-worker` is NOT the conversation host: it is the proxied, ISOLATED
 * Claude-harness worker class — a `claude -p` spawn fronted by a proxy transport
 * (`endpoint` = the proxy url, `--model <service>/<model>` composed at
 * launch). Every self-spawn / Gate-0 refusal layer keys on `claude-code` and never
 * sees this name, so the host guards stay byte-identical
 * (docs/reviews/commit3-proxy-kind1-transport-plan-2026-07-16.md).
 */
export const DISPATCHABLE_TRANSPORTS = [
  "openai-compatible",
  "codex",
  "opencode",
  "worker-command",
  "subprocess-template",
  "agy",
  "claude-worker",
] as const;
export type DispatchableTransport =
  (typeof DISPATCHABLE_TRANSPORTS)[number];

/**
 * The worker-kind axis of the unified dispatch worker model
 * (`spec/unified-dispatch-worker-model.md`): an `agentic` worker drives a tool-using
 * harness inside the node's worktree (Read/Edit/Bash — packet references files by
 * path); a `single_shot` worker is one HTTP round-trip with no tools (packet content
 * must be INLINED). Launch-side enforcement keys on this; admission `capable()`
 * consumption is follow-on.
 */
export const WORKER_KINDS = ["agentic", "single_shot"] as const;
export type WorkerKind = (typeof WORKER_KINDS)[number];

/**
 * Derive a source's {@link WorkerKind}. An explicit `worker_kind` on the source wins
 * (the declarable override for the genuinely-ambiguous case); otherwise the transport
 * determines it — every harness-driving backend (claude-worker / codex / agy /
 * opencode / worker-command / subprocess-template) is `agentic`; `openai-compatible`
 * is the lone `single_shot` (one `/chat/completions` round-trip, no tools).
 */
export function deriveWorkerKind(
  source: Pick<DispatchableSource, "transport" | "worker_kind">,
): WorkerKind {
  if (source.worker_kind !== undefined) return source.worker_kind;
  return source.transport === "openai-compatible" ? "single_shot" : "agentic";
}

/**
 * A generic dispatchable backend source — the uniform shape the dispatch engine
 * spills work onto, applicable to ANY non-IDE source (an OpenAI-compatible API like
 * NIM / vLLM / LM Studio, a headless CLI like codex / opencode, a subprocess
 * template, …). A source is its `{transport, endpoint, parameters, quota}`, so the
 * operator can configure MANY of them (two NIM endpoints, a local vLLM + a hosted
 * model, a CLI pool) and each becomes its own CapacityPool with its own rate limit.
 *
 * `endpoint` + `parameters` are interpreted per provider: for `openai-compatible`
 * the endpoint is the API `base_url` and `parameters` carries `temperature` /
 * `headers` / `max_output_tokens` / …; for a CLI (`codex` / `opencode` /
 * `worker-command`) the endpoint is the launcher command and `parameters` carries
 * `extra_args` / `sandbox_mode` / `command_template` / …. The bridge to each
 * provider's concrete config block lives in `sourceProviderConfig` (shared).
 */
export interface DispatchableSource {
  /**
   * Stable id for this source — the CapacityPool id + the key learned quota is
   * recorded under. Defaults to `${transport}:${model ?? endpoint}` when omitted, so
   * two sources of the same transport stay distinct as long as their model/endpoint
   * differ (give them explicit ids otherwise).
   */
  id?: string;
  /** The non-IDE backend that runs this source. */
  transport: DispatchableTransport;
  /** API base URL (`openai-compatible`) or launcher command (CLI providers). */
  endpoint?: string;
  /** Model id, where the backend takes one. Never defaulted (no hardcoded model identity). */
  model?: string;
  /** Env var holding the API key (API sources). Preferred over `api_key`. */
  api_key_env?: string;
  /** Inline API key (discouraged — prefer `api_key_env`). */
  api_key?: string;
  /**
   * Worker-kind override (see {@link WorkerKind} / {@link deriveWorkerKind}).
   * Normally DERIVED from the transport — declare it only where genuinely ambiguous.
   */
  worker_kind?: WorkerKind;
  /**
   * The BACKEND service actually serving this source when a transport fronts it
   * (`claude-worker`: the proxy transport routes to e.g. `"nim"`). The transport NEVER
   * enters the identity: the quota/ledger key stays
   * `service[#account]/model`, so a proxied lane and a direct lane to the
   * same backend dedup to ONE quota identity. The namespace string
   * `<service>/<model>` is composed AT LAUNCH for argv only, never stored.
   */
  service?: string;
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
   * Operator-declared blended `$/Mtok` for THIS source's endpoint — the a-priori
   * cost signal the admission router ranks on (rung 2 of `deriveCostRank`,
   * authoritative over the models.dev catalog because the operator knows their own
   * endpoint's price). Set `0` for a genuinely-free backend (e.g. a free arbitrage
   * pool) so it routes first; omit to fall back to the models.dev price / tier.
   *
   * This is the a-priori SEED. It is BACKED by reactive cost verification: when a
   * response reports an actual cost (an endpoint that returns a `cost` field, e.g.
   * opencode), a pool declared free (`0`) that reports a positive cost is demoted out
   * of free-first for the rest of the run and a `declared_cost_drift` friction event
   * fires so the operator reconciles the stale declaration. A backend that reports no
   * cost has no such signal, so there `0` remains an operator assertion.
   */
  cost_per_mtok?: number;
  /**
   * Path to THIS source's own credential file, when it authenticates as a
   * different account than the host (e.g. a Claude CLI signed into a second
   * account: its own `.credentials.json`; a second Codex `auth.json`). The
   * source's quota probe + account id are read from here, so the source forms a
   * pool keyed on its OWN `(transport, account)` — distinct budget from the host's
   * same-transport pool (docs/quota-dispatch-design.md §5b). Omit when the source
   * shares the host's account.
   */
  credentials_path?: string;
  /**
   * Explicit account id override for the pool key, when it can't be read from a
   * credential (e.g. an API-key source). Takes precedence over the credential-read
   * account. Omit to auto-resolve from {@link credentials_path} / the host cred.
   */
  account?: string;
  /**
   * Per-`(provider,model)` capability rank from the discovery registry — LOWER =
   * better (the raw `composite_rank` from BFCL/Arena, never collapsed into a tier).
   * Optional — absent leaves ranking unchanged; consumed only as a tiebreak among
   * otherwise cost-equal candidates in `deriveCostRank`/`suggestCostOrdering`, never
   * folded into the cost band itself (so it can't reorder against cost).
   */
  capability_rank?: number;
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
  /**
   * Hard cap on simultaneously in-flight requests to this source's endpoint — the
   * endpoint-declared max-concurrency (e.g. a NIM worker's `N/M` local request
   * limit). Enforced by COUNT of in-flight requests, independent of the token
   * budget: an optimistic (unmetered) source with no token snapshot would
   * otherwise dispatch every ready packet at once and overrun the endpoint. Flows
   * to `CapacityPool.concurrencyCap` → the rolling engine's per-pool in-flight
   * ceiling and the host-path `AdmissionPool.declaredCap`. Omit for no cap.
   */
  max_concurrent?: number;
}

export interface QuotaConfig {
  // No `enabled` toggle: quota self-monitoring is not switchable. Dispatch ALWAYS
  // consults the quota source (Claude /usage + host-session). "Can't find quota"
  // (absent config / dark credential) is a degraded-optimistic state — uncapped
  // per the no-invented-ceiling invariant, and surfaced loudly at the dispatch
  // site — never a configured off-switch.
  safety_margin?: number;
  default_context_tokens?: number;
  reserved_output_tokens?: number;
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

export interface SessionConfig {
  provider?: ProviderName;
  /**
   * The CONVERSATION-HOST identity — the auditor/agent actually driving THIS
   * next-step process, whose account meter the dispatch fan-out is charged against
   * (a quota-ATTRIBUTION key). On the effective config produced by
   * `resolveSessionConfig`, this is set to the SAME value as `provider` from the
   * descriptor's `self.provider` (G2 collapsed the retired inventory's separate
   * `provider`/`host_provider` into one driver identity — a demoted headless backend
   * now rides `sources[]`, not a distinct `provider` field, so the two no longer
   * diverge on the descriptor path). Still honored when a programmatic caller injects
   * an effective config with them distinct (e.g. a test). Normally left unset on the
   * intent: `resolveConversationHostProvider` auto-detects the real host from the same
   * in-session env signals the self-spawn guard reads (`isSelfSpawnBlocked` — CODEX* ⇒
   * codex, CLAUDECODE ⇒ claude-code), defaulting to `claude-code`. The retained
   * `--host-provider` flag folds onto `descriptor.self.provider`. `"auto"` is treated
   * as unset (fall through to env detection).
   */
  host_provider?: ProviderName;
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
  /**
   * claude-worker launch block. Never persisted / operator-authored: composed at
   * launch by `sourceProviderConfig` from a `claude-worker` {@link DispatchableSource}
   * so the factory can build the isolated proxied worker FROM that source.
   */
  claude_worker?: ClaudeWorkerConfig;
  codex?: CodexConfig;
  opencode?: OpenCodeConfig;
  openai_compatible?: OpenAiCompatibleConfig;
  vscode_task?: VSCodeTaskConfig;
  antigravity?: AntigravityConfig;
  agy?: AgyConfig;
  /**
   * Additional dispatchable backend sources the engine spills onto, beyond the
   * primary `provider`. Each is a generic `{transport, endpoint, parameters, quota}`
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
}

/**
 * The flat {@link SessionConfig} fields that constitute DISPATCH INVENTORY (the
 * per-auditor backend/launch set), as opposed to audit INTENT. Single-sourced so
 * the persisted-type derivation ({@link RepoSessionIntent}), the store-level
 * validator (`validateRepoSessionIntent`), and `resolve()` cannot drift on which
 * fields are inventory vs intent. `dispatch.rolling_engine` is deliberately absent
 * from this flat list — it is nested under `dispatch`, so {@link RepoSessionIntent}
 * strips it via {@link RepoDispatchConfig} separately (see there).
 */
export const DISPATCH_INVENTORY_FIELDS = [
  "provider",
  "host_provider",
  "subprocess_template",
  "claude_code",
  "claude_worker",
  "codex",
  "opencode",
  "openai_compatible",
  "vscode_task",
  "antigravity",
  "agy",
  "sources",
  "parallel_workers",
] as const satisfies readonly (keyof SessionConfig)[];

export type DispatchInventoryField = (typeof DISPATCH_INVENTORY_FIELDS)[number];

/**
 * The `dispatch` sub-config as it appears on {@link RepoSessionIntent}: the fan-out
 * INTENT knobs (confirm_threshold / max_packets / risk_mass_budget / routing_tiers)
 * WITHOUT `rolling_engine`, which is per-auditor dispatch capability carried on the
 * {@link AuditorDescriptor}, not repo intent.
 */
export type RepoDispatchConfig = Omit<DispatchConfig, "rolling_engine">;

/**
 * The PERSISTED session type — audit INTENT + policy + budgeting ONLY, with every
 * dispatch-inventory field removed so a resolved backend/launch set is UNREPRESENTABLE
 * on disk (`session-config.json`). Derived from {@link SessionConfig} by omitting the
 * {@link DISPATCH_INVENTORY_FIELDS} and re-typing `dispatch` to {@link RepoDispatchConfig}
 * (dropping `rolling_engine`), so the two can never drift on the intent/inventory line.
 * The store reads/writes ONLY this; every dispatch consumer reads the in-memory EFFECTIVE
 * {@link SessionConfig} produced by `resolve(intent, descriptor)`. The dispatch
 * backend/launch set rides the per-auditor {@link AuditorDescriptor}, never inherited
 * across auditors ([[capability-is-per-auditor-not-per-audit]],
 * `spec/unified-dispatch-worker-model.md`, G2).
 *
 * Honest scope: `quota` / `block_quota` / `host_can_dispatch_subagents` are ALSO capability
 * but remain on the intent type until G4/G5 — so this is a HALF-type (inventory removed;
 * the other capability fields still present). The "zero dispatch/capability fields" endpoint
 * is reached only after G4/G5. (`confirmed_provider_pool` was an inert slot and is GONE as
 * of G3 commit C.)
 */
export type RepoSessionIntent = Omit<
  SessionConfig,
  DispatchInventoryField | "dispatch"
> & {
  dispatch?: RepoDispatchConfig;
};
