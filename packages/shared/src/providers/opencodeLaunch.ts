/**
 * Resolve how to spawn an `opencode` invocation per platform. On Windows the
 * `opencode` / `npx` launchers (and any explicit `*.cmd` shim) must go through
 * `cmd.exe`, because Node's `spawn` cannot execute a `.cmd` batch file without
 * a shell. On every other platform the command and args pass through
 * unchanged. Shared by the opencode provider in both orchestrators so neither
 * silently loses the Windows shim.
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
      args: ["/d", "/s", "/c", [command, ...args].map(quoteOpenCodeCmdArg).join(" ")],
    };
  }
  return { command, args };
}

function quoteOpenCodeCmdArg(value: string): string {
  if (/^[A-Za-z0-9_./:=+-]+$/.test(value)) {
    return value;
  }
  return `"${value.replace(/(["^&|<>%])/g, "^$1")}"`;
}
