import { spawnSync, type SpawnSyncOptions } from "node:child_process";

type SpawnResult = ReturnType<typeof spawnSync>;

export function quoteForCmd(arg: string): string {
  if (arg.length === 0) return '""';
  if (!/[\s"]/u.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

function resolveWindowsScript(
  command: string,
  args: string[],
): { command: string; args: string[] } {
  if (!(process.platform === "win32" && /\.(cmd|bat)$/iu.test(command))) {
    return { command, args };
  }

  return {
    command: process.env.ComSpec ?? "cmd.exe",
    args: ["/d", "/s", "/c", [command, ...args].map(quoteForCmd).join(" ")],
  };
}

export function platformCommand(command: string): string {
  if (process.platform !== "win32") return command;
  if (/\.(?:cmd|bat|com|exe)$/iu.test(command)) return command;
  if (command === "npm" || command === "npx" || command === "pnpm") {
    return `${command}.cmd`;
  }
  return command;
}

export function runCommand(
  command: string,
  args: string[],
  options: SpawnSyncOptions = {},
): SpawnResult {
  const resolved = resolveWindowsScript(platformCommand(command), args);
  return spawnSync(resolved.command, resolved.args, {
    ...options,
    shell: false,
  });
}

export function runShellCommand(
  command: string,
  options: SpawnSyncOptions = {},
): SpawnResult {
  return spawnSync(command, {
    ...options,
    shell: true,
  });
}
