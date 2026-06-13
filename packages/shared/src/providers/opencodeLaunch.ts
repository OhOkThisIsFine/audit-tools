import { quoteForShellInterpreterCmd } from "../tooling/exec.js";

/**
 * Resolve how to spawn an `opencode` invocation per platform. On Windows the
 * `opencode` / `npx` launchers (and any explicit `*.cmd` shim) must go through
 * `cmd.exe`, because Node's `spawn` cannot execute a `.cmd` batch file without
 * a shell. On every other platform the command and args pass through
 * unchanged. Shared by the opencode provider in both orchestrators so neither
 * silently loses the Windows shim.
 *
 * The per-token cmd.exe quoting reuses the canonical `quoteForShellInterpreterCmd`
 * from exec.ts (charset includes `@`); the former private copy here omitted
 * `@`, the one real divergence the audit flagged.
 */
export function resolveOpenCodeSpawnCommand(
  command: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
  shellCommand: string = process.env.ComSpec ?? "cmd.exe",
): { command: string; args: string[] } {
  if (platform !== "win32") {
    return { command, args };
  }
  const base = command.replace(/\.(cmd|bat|exe)$/i, "").toLowerCase();
  if (base === "opencode" || base === "npx" || command.endsWith(".cmd")) {
    return {
      command: shellCommand,
      args: ["/d", "/s", "/c", [command, ...args].map(quoteForShellInterpreterCmd).join(" ")],
    };
  }
  return { command, args };
}
