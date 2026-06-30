import type { ResolvedProviderName, SessionConfig } from "../types/sessionConfig.js";
import type { FreshSessionProvider, ProviderRateLimits } from "./types.js";
import {
  resolveFreshSessionProviderName,
  hasConfiguredOpenAiCompatible,
  hasConfiguredOpenCode,
} from "./providerFactory.js";
import { commandExists, isSelfSpawnBlocked } from "./providerPathGuard.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CapabilityTier = "frontier" | "capable" | "fast" | "unknown";

export interface DiscoveredProvider {
  name: ResolvedProviderName;
  command?: string;
  capabilityTier: CapabilityTier;
  quotaState?: ProviderRateLimits | null;
  detected: boolean;
  /**
   * Machine-readable self-spawn-blocked flag. True when the provider is detected
   * on PATH but cannot be launched as a fresh subprocess because the host is
   * already inside an active session of that same agent (claude-code while
   * `CLAUDECODE` is set, codex while `CODEX` is set). The Gate-0 confirmation
   * EXCLUDES a self-spawn-blocked provider from the dispatchable pool unless the
   * operator explicitly includes it — a free-text `reason` string is advisory
   * only and must never be the thing a downstream consumer parses to make that
   * security decision.
   */
  selfSpawnBlocked?: boolean;
  reason?: string;
}

export interface ConfirmedProviderPool {
  providers: DiscoveredProvider[];
  excluded: ResolvedProviderName[];
  addedUndetected: DiscoveredProvider[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Default capability tier for a given provider name.
 *
 * This is a fallback used only when no session-config override is available.
 * Tiers are intentionally coarse and static here; the scheduler discovery
 * path (HostModelRosterEntry / DiscoveredRateLimitsInput) is the authoritative
 * source of per-model capability at dispatch time.
 *
 * INV-shared-core-02: provider-name → tier mapping must NOT be a flat lookup
 * table that gates dispatch routing. Capability tier on DiscoveredProvider is
 * a declared/discoverable input, not an opaque internal enum. This function
 * is the single place where a default is applied; all routing uses the
 * DispatchModelTier vocabulary on CapacityPool, not this field.
 */
function defaultCapabilityTier(name: ResolvedProviderName): CapabilityTier {
  switch (name) {
    case "claude-code":
      return "frontier";
    case "opencode":
    case "codex":
    case "openai-compatible":
    case "subprocess-template":
    case "vscode-task":
    case "antigravity":
      return "capable";
    case "local-subprocess":
      return "unknown";
  }
}

/**
 * CLI probe table: maps the binary name as it appears on PATH to the canonical
 * ResolvedProviderName and any config command override to try first.
 */
interface CliProbe {
  providerName: ResolvedProviderName;
  /** Default CLI binary name when no config override present. */
  defaultCommand: string;
  /** Retrieve the configured command override from sessionConfig, if any. */
  configCommand: (cfg: SessionConfig) => string | undefined;
}

const CLI_PROBES: CliProbe[] = [
  {
    providerName: "claude-code",
    defaultCommand: "claude",
    configCommand: (cfg) => cfg.claude_code?.command,
  },
  {
    providerName: "opencode",
    defaultCommand: "opencode",
    configCommand: (cfg) => cfg.opencode?.command,
  },
  {
    providerName: "codex",
    defaultCommand: "codex",
    configCommand: (cfg) => cfg.codex?.command,
  },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Probe PATH for each known CLI and return a DiscoveredProvider entry for each
 * detected tool. Uses `resolveFreshSessionProviderName` to honour session-config
 * overrides when determining which CLI name to probe.
 *
 * @param sessionConfig - Current session config (may be empty `{}`).
 * @param env           - Process env snapshot; defaults to `process.env`.
 * @param detectCommand - Injectable PATH-detection hook (defaults to the
 *   single-sourced `commandExists`). Lets tests drive discovery deterministically
 *   without a real CLI on PATH, so the self-spawn-blocked security obligations are
 *   testable red-before-green regardless of what is installed in CI.
 */
export function discoverProviders(
  sessionConfig: SessionConfig,
  env: NodeJS.ProcessEnv = process.env,
  detectCommand: (command: string) => boolean = commandExists,
): DiscoveredProvider[] {
  const discovered: DiscoveredProvider[] = [];

  for (const probe of CLI_PROBES) {
    const command =
      (probe.configCommand(sessionConfig) ?? "").trim() || probe.defaultCommand;
    const available = detectCommand(command);

    if (!available) continue;

    // PB-1: a bare-PATH opencode (no opencode.* config) is OPT-IN, not an
    // eligible auto-dispatch target. Surfacing it here would let it join the
    // confirmed pool and be launched unprompted. Only surface opencode when the
    // operator has explicitly configured it (opencode.command / opencode.extra_args);
    // all other PATH-detected providers are surfaced as before.
    if (probe.providerName === "opencode" && !hasConfiguredOpenCode(sessionConfig)) {
      continue;
    }

    // Self-spawn guard: mirror providerFactory — don't surface claude-code when
    // already inside a claude-code session, codex when inside codex, etc.
    const resolvedName = resolveFreshSessionProviderName("auto", sessionConfig, {
      env,
      commandExists: (cmd: string) => cmd === command,
    });

    // Machine-readable self-spawn-blocked flag, derived from the single-sourced
    // guard. A self-spawn-blocked provider is still SURFACED (the operator may
    // override) but carries the flag so Gate-0 can EXCLUDE it from the
    // dispatchable pool without parsing the advisory `reason` string.
    const blocked = isSelfSpawnBlocked(probe.providerName, env);

    discovered.push({
      name: probe.providerName,
      command,
      capabilityTier: defaultCapabilityTier(probe.providerName),
      detected: true,
      selfSpawnBlocked: blocked,
      reason: blocked
        ? `detected on PATH but cannot self-spawn from within an active ${probe.providerName} session`
        : resolvedName === probe.providerName
          ? undefined
          : `detected on PATH; auto-resolution may prefer a higher-priority provider`,
    });
  }

  // openai-compatible (NIM / vLLM / LM Studio / …) is an API pool, not a CLI: it
  // is config-gated (base_url + model), never PATH-probed, so the CLI loop above
  // can't surface it. Surface it here when configured so it joins the confirmed
  // pool as a real spill target (INV-QD-14) alongside the PATH-detected CLIs.
  if (hasConfiguredOpenAiCompatible(sessionConfig.openai_compatible)) {
    discovered.push({
      name: "openai-compatible",
      command: sessionConfig.openai_compatible?.model,
      capabilityTier: defaultCapabilityTier("openai-compatible"),
      detected: true,
      reason: "configured background API pool (base_url + model); not PATH-probed",
    });
  }

  return discovered;
}

/**
 * Query the rate-limit state from a live provider if the `queryLimits` method
 * is available. Returns `null` on timeout/error — never throws.
 *
 * OBS-9a9091ad: a `queryLimits` rejection was previously swallowed with no
 * signal, so a provider whose rate-limit query consistently fails was invisible
 * to operators (the sibling CompositeQuotaSource logs the same swallow). Accept
 * an optional injectable `log` (mirroring analyzerDeps' injectable-log pattern)
 * that is invoked with the provider name + error on the swallowed-error path.
 * The contract is unchanged — `log` is optional, the function still never throws
 * and still returns null — so existing callers need no change while a caller
 * that cares can route the diagnostic into its RunLogger.
 */
export async function queryProviderQuota(
  provider: DiscoveredProvider,
  freshSessionProvider: FreshSessionProvider,
  log?: (providerName: string, error: unknown) => void,
): Promise<ProviderRateLimits | null> {
  if (typeof freshSessionProvider.queryLimits !== "function") {
    return null;
  }
  try {
    return await freshSessionProvider.queryLimits(null);
  } catch (error) {
    log?.(provider.name, error);
    return null;
  }
}

/**
 * Build a markdown table summarising the discovered provider pool for display
 * in Gate-0 confirmation prompts.
 *
 * | Provider | Tier | Quota | Default |
 */
export function buildProviderConfirmationDisplay(
  discovered: DiscoveredProvider[],
): string {
  if (discovered.length === 0) {
    return "No providers detected on PATH.";
  }

  const rows = discovered.map((p) => {
    const tier = p.capabilityTier;
    const quota =
      p.quotaState == null
        ? "—"
        : [
            p.quotaState.requests_per_minute != null
              ? `${p.quotaState.requests_per_minute} rpm`
              : null,
            p.quotaState.input_tokens_per_minute != null
              ? `${p.quotaState.input_tokens_per_minute} itpm`
              : null,
          ]
            .filter(Boolean)
            .join(", ") || "—";

    // Local-subprocess requires explicit addition because it blocks auto-dispatch.
    const isDefault = p.name !== "local-subprocess";
    const defaultCol = isDefault ? "included" : "add explicitly";
    const statusNote = p.reason ? ` *(${p.reason})*` : "";
    return `| ${p.name}${statusNote} | ${tier} | ${quota} | ${defaultCol} |`;
  });

  return [
    "| Provider | Tier | Quota | Default |",
    "| --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

/**
 * Apply user selections to the discovered pool, returning a ConfirmedProviderPool
 * suitable for persistence in SessionConfig.confirmed_provider_pool.
 *
 * @param discovered      - Output of `discoverProviders`.
 * @param exclude         - Provider names to remove from the pool.
 * @param addUndetected   - Manually specified providers not found on PATH.
 */
export function applyProviderConfirmationSelections(
  discovered: DiscoveredProvider[],
  exclude: ResolvedProviderName[],
  addUndetected: DiscoveredProvider[],
): ConfirmedProviderPool {
  const excludeSet = new Set<ResolvedProviderName>(exclude);
  const filtered = discovered.filter((p) => !excludeSet.has(p.name));
  const undetectedNormalized = addUndetected.map((p) => ({
    ...p,
    detected: false,
  }));
  return {
    providers: [...filtered, ...undetectedNormalized],
    excluded: exclude,
    addedUndetected: undetectedNormalized,
  };
}
