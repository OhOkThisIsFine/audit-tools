import { quoteForShellInterpreterCmd } from "../tooling/exec.js";

/**
 * Resolve how to spawn a package-manager-installed CLI shim per platform. On
 * Windows an npm/pnpm/bun-installed CLI on PATH is a `.cmd` / `.ps1` batch shim
 * (or the bare launcher name) that Node's `spawn` cannot execute without a
 * shell, so it must go through `cmd.exe`. On every other platform the command
 * and args pass through unchanged. Single-sourced so every provider that drives
 * such a shim (opencode, codex, …) routes through identical, correctly-quoted
 * logic rather than each re-deriving — and accidentally diverging on — it.
 *
 * `shimBaseNames` are the bare launcher names that must be wrapped even without a
 * recognized extension (e.g. `opencode`, `codex`, `npx`). The per-token cmd.exe
 * quoting reuses the canonical `quoteForShellInterpreterCmd` from exec.ts.
 */
export function resolveWindowsShimSpawnCommand(
  command: string,
  args: string[],
  shimBaseNames: readonly string[],
  platform: NodeJS.Platform = process.platform,
  shellCommand: string = process.env.ComSpec ?? "cmd.exe",
): { command: string; args: string[] } {
  if (platform !== "win32") {
    return { command, args };
  }
  const base = command.replace(/\.(cmd|bat|exe|ps1)$/i, "").toLowerCase();
  if (
    shimBaseNames.includes(base) ||
    command.endsWith(".cmd") ||
    command.endsWith(".ps1")
  ) {
    return {
      command: shellCommand,
      args: ["/d", "/s", "/c", [command, ...args].map(quoteForShellInterpreterCmd).join(" ")],
    };
  }
  return { command, args };
}

/**
 * Resolve how to spawn an `opencode` invocation per platform. Thin wrapper over
 * the shared {@link resolveWindowsShimSpawnCommand} with opencode's launcher
 * names. Shared by the opencode provider in both orchestrators so neither
 * silently loses the Windows shim.
 */
export function resolveOpenCodeSpawnCommand(
  command: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
  shellCommand: string = process.env.ComSpec ?? "cmd.exe",
): { command: string; args: string[] } {
  return resolveWindowsShimSpawnCommand(
    command,
    args,
    ["opencode", "npx"],
    platform,
    shellCommand,
  );
}
