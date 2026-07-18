import { spawnSync } from "node:child_process";
import type {
  ProviderName,
  ResolvedProviderName,
} from "../types/sessionConfig.js";
import { isHeadlessPrimaryProvider } from "./inProcessWorkers.js";

/**
 * Single-sourced PATH detection + self-spawn guard for the provider subsystem.
 *
 * Both `providerFactory.ts` (auto-resolution) and `providerConfirmation.ts`
 * (Gate-0 discovery) used to carry their OWN copy of `commandExists` and their
 * own ad-hoc `env.CLAUDECODE` / `env.CODEX` self-spawn checks. Two copies of a
 * security-relevant guard is exactly the drift hazard the project's
 * "single-source the guard" invariant exists to prevent — a fix to one copy
 * silently leaves the other exploitable. This module is the ONE place that
 * owns:
 *   - probing PATH for a command (`commandExists`),
 *   - deciding whether a provider would be self-spawn-blocked
 *     (`isSelfSpawnBlocked`) from inside an active session of that same agent.
 *
 * A test-injectable PATH-detection hook (`setCommandExistsForTesting`) lets
 * tests drive discovery deterministically without a real CLI on PATH — the
 * security obligations (self-spawn-blocked exclusion) must be testable
 * red-before-green without depending on what happens to be installed in CI.
 */

/** The real PATH probe: `where`/`which` exits 0 iff the command resolves. */
function probeCommandOnPath(command: string): boolean {
  const lookupCommand = process.platform === "win32" ? "where" : "which";
  // windowsHide: a windowless parent (node launched by an IDE/agent) spawning a
  // console child pops a console window on win32 unless suppressed — this probe
  // runs on every provider discovery, so it is the most frequent offender.
  const result = spawnSync(lookupCommand, [command], {
    stdio: "ignore",
    windowsHide: true,
  });
  return result.status === 0;
}

let commandExistsImpl: (command: string) => boolean = probeCommandOnPath;

/**
 * Probe PATH for a single command. Returns true if the command resolves.
 * Routed through the injectable hook so tests can drive it deterministically.
 */
export function commandExists(command: string): boolean {
  return commandExistsImpl(command);
}

/**
 * Override the PATH-detection implementation for tests. Pass `null` to restore
 * the real `where`/`which` probe. The hook is process-global; tests MUST restore
 * it in a `finally` so they don't leak state into sibling tests.
 */
export function setCommandExistsForTesting(
  impl: ((command: string) => boolean) | null,
): void {
  commandExistsImpl = impl ?? probeCommandOnPath;
}

/**
 * The in-session env signals that mark a host as already running INSIDE an agent
 * of a given kind — a fresh subprocess of that same agent cannot be spawned from
 * within one (it would self-spawn). Single-sourced so the auto-resolver and the
 * Gate-0 discovery path agree byte-for-byte on what "self-spawn-blocked" means.
 *
 * Only `claude-code` and `codex` have a self-spawn hazard: they are headless
 * CLIs auto-spawned as fresh subprocesses. The other providers are either
 * IDE/template-bound, an API pool, or the always-available worker-command
 * fallback — none can self-spawn.
 */
const SELF_SPAWN_ENV_SIGNAL: Partial<Record<ResolvedProviderName, string>> = {
  "claude-code": "CLAUDECODE",
};

/**
 * Is `provider` self-spawn-blocked in the given environment? True iff the host
 * is currently inside an active session of that same agent (e.g. `claude-code`
 * while `CLAUDECODE` is set, `codex` while `CODEX` is set). Machine-readable,
 * single-sourced, and the basis for both the auto-resolver's `*Available`
 * guards and the Gate-0 `self_spawn_blocked` exclusion flag.
 */
export function isSelfSpawnBlocked(
  provider: ResolvedProviderName,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (provider === "codex") {
    return Boolean(
      env.CODEX ||
        env.CODEX_SHELL ||
        env.CODEX_THREAD_ID ||
        env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE,
    );
  }
  if (provider === "agy") {
    // Note: checks both agy/antigravity and the legacy gemini in-session env variables.
    // Gated for July 18, 2026 sunset cleanup: env.GEMINI_CLI
    return Boolean(
      env.AGY_CLI ||
        env.ANTIGRAVITY_CLI ||
        env.GEMINI_CLI
    );
  }
  const signal = SELF_SPAWN_ENV_SIGNAL[provider];
  return signal !== undefined && Boolean(env[signal]);
}

/**
 * The provider identity of the CONVERSATION HOST actually driving this
 * next-step process — the agent whose account meter dispatch fan-out is charged
 * against (a quota-ATTRIBUTION key). This is NOT `sessionConfig.provider`, which
 * may name a headless backend that is merely the per-packet worker; it is "who
 * is running me right now".
 *
 * Resolution order (first wins):
 *   1. explicit override (`--host-provider`), when a real provider (not `auto`);
 *   2. `sessionConfig.host_provider`, when a real provider (not `auto`);
 *   3. env auto-detection — the SAME in-session signals the self-spawn guard
 *      reads: inside a Codex session (`isSelfSpawnBlocked("codex")`) ⇒ `codex`;
 *      inside a Claude Code session (`CLAUDECODE`) ⇒ `claude-code`;
 *   4. default `claude-code` (the conversation-first host).
 *
 * B1 host-identity sourcing: keying the host fan-out off THIS (rather than
 * literal `claude-code`) is what stops a Codex host from charging its packets to
 * the exhausted Claude pool. Codex is checked before claude-code so a Codex host
 * that also inherited `CLAUDECODE` resolves to its own meter; the explicit
 * override remains the escape hatch for any genuinely ambiguous nesting.
 * [[capability-is-per-auditor-not-per-audit]] / [[host-provider-misattribution-nim-codex]].
 */
export function resolveConversationHostProvider(options?: {
  explicit?: ProviderName;
  sessionConfig?: { host_provider?: ProviderName } | null;
  env?: NodeJS.ProcessEnv;
}): ResolvedProviderName {
  const explicit = options?.explicit;
  if (explicit !== undefined && explicit !== "auto") return explicit;
  const configured = options?.sessionConfig?.host_provider;
  if (configured !== undefined && configured !== "auto") return configured;
  const env = options?.env ?? process.env;
  if (isSelfSpawnBlocked("codex", env)) return "codex";
  if (isSelfSpawnBlocked("claude-code", env)) return "claude-code";
  if (isSelfSpawnBlocked("agy", env)) return "agy";
  return "claude-code";
}

/**
 * The host's resolved provider identity for quota-key / driver-classification:
 * an EXPLICIT `sessionConfig.provider` passes through; an unset / `auto`
 * provider falls back to the auto-detected {@link resolveConversationHostProvider}
 * (the `--host-provider` override / `host_provider` config / env detection /
 * `claude-code`). Single-sourced so the fallback and the `auto`-exclusion live
 * in ONE place rather than being re-spelled at each dispatch call site across
 * both orchestrators.
 *
 * NOTE: this returns the configured provider verbatim when set — a run with
 * `provider: codex` (codex as the driving host) keys to codex. The host-DISPATCH
 * paths additionally treat a headless in-process backend as a worker, not a
 * driver (see {@link resolveHostDispatchProviderName}), routing the driver
 * identity through {@link resolveConversationHostProvider} instead.
 */
export function resolveHostProviderName(
  sessionConfig: { provider?: ProviderName; host_provider?: ProviderName } | null | undefined,
  options?: { explicit?: ProviderName; env?: NodeJS.ProcessEnv },
): ResolvedProviderName {
  const provider = sessionConfig?.provider;
  if (provider === undefined || provider === "auto") {
    return resolveConversationHostProvider({
      explicit: options?.explicit,
      sessionConfig,
      env: options?.env,
    });
  }
  return provider;
}

/**
 * The identity of the agent DRIVING the host fan-out this invocation — what the
 * host-dispatch pool / host-session quota key is keyed to (and charged against).
 * When `sessionConfig.provider` names a headless in-process backend (codex /
 * opencode / openai-compatible / agy — plus the command-shaped backends under a
 * draw whose `commandWorkers` policy admits them), that provider is a WORKER,
 * never the driver: the conversation host that reached the host-dispatch path
 * resolves via {@link resolveConversationHostProvider} (auto-detected, and
 * overridable via `--host-provider` / `host_provider` — NOT the literal
 * `claude-code`, which mis-charged a Codex host's fan-out to the Claude pool).
 * An explicit conversation-host provider (vscode-task / antigravity /
 * claude-code — and, for audit's policy, worker-command / subprocess-template)
 * IS a driver and passes through unchanged.
 *
 * This is the founding-bug fix ([[capability-is-per-auditor-not-per-audit]]): a
 * run started with `provider: codex` and later resumed by a Claude host never
 * keys or charges the host fan-out against codex's meter. Hoisted to shared
 * (H2+H4 collapse, plan D5) so audit and remediate key their fan-outs through
 * the ONE resolver; the `isHeadlessPrimaryProvider` read here is DRIVER
 * IDENTITY, not branch selection — it survives the branch-pair deletion.
 * [[host-provider-misattribution-nim-codex]]
 */
export function resolveHostDispatchProviderName(
  sessionConfig: { provider?: ProviderName; host_provider?: ProviderName } | null | undefined,
  options?: { commandWorkers?: boolean; env?: NodeJS.ProcessEnv },
): ResolvedProviderName {
  if (isHeadlessPrimaryProvider(sessionConfig?.provider, options)) {
    return resolveConversationHostProvider({ sessionConfig, env: options?.env });
  }
  return resolveHostProviderName(sessionConfig, { env: options?.env });
}
