import { spawnSync } from "node:child_process";
import type { ResolvedProviderName } from "../types/sessionConfig.js";

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
  const result = spawnSync(lookupCommand, [command], { stdio: "ignore" });
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
 * IDE/template-bound, an API pool, or the always-available local-subprocess
 * fallback — none can self-spawn.
 */
const SELF_SPAWN_ENV_SIGNAL: Partial<Record<ResolvedProviderName, string>> = {
  "claude-code": "CLAUDECODE",
  codex: "CODEX",
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
  const signal = SELF_SPAWN_ENV_SIGNAL[provider];
  return signal !== undefined && Boolean(env[signal]);
}
