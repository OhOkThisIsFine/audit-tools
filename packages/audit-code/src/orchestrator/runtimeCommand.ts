import { spawn } from "node:child_process";

// Deterministic runtime-validation command execution: resolve a command to a
// platform-correct spawn invocation (Windows package-manager shims need a
// cmd.exe wrapper), optionally wrap it for opentoken accounting, and run it
// capturing a confirmed/not_confirmed/inconclusive outcome. Hoisted out of
// internalExecutors.ts as a shared, side-effect-only helper module.

function resolveOpentokenWrap(
  resolved: { command: string; args: string[] },
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
  if (platform === "win32") {
    const shell = process.env.ComSpec ?? "cmd.exe";
    const inner = [resolved.command, ...resolved.args]
      .map((v) => (/^[A-Za-z0-9_./:=@+-]+$/.test(v) ? v : `"${v.replace(/(["^&|<>%])/g, "^$1")}"`))
      .join(" ");
    return { command: shell, args: ["/d", "/s", "/c", `opentoken wrap ${inner}`] };
  }
  return { command: "opentoken", args: ["wrap", resolved.command, ...resolved.args] };
}

export async function runCommand(
  command: string[],
  cwd: string,
  options: { opentoken?: boolean } = {},
): Promise<{
  status: "confirmed" | "not_confirmed" | "inconclusive";
  summary: string;
  evidence: string[];
}> {
  let spawnCommand = resolveRuntimeValidationSpawnCommand(command);
  if (options.opentoken) {
    spawnCommand = resolveOpentokenWrap(spawnCommand);
  }
  const displayCommand = command.join(" ");
  return await new Promise((resolve) => {
    const child = spawn(spawnCommand.command, spawnCommand.args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      resolve({
        status: "inconclusive",
        summary: `Failed to execute ${displayCommand}: ${error.message}`,
        evidence: [],
      });
    });
    child.on("exit", (code) => {
      const output = `${stdout}\n${stderr}`.trim();
      const evidence = output.length > 0 ? output.split(/\r?\n/).slice(-10) : [];
      resolve({
        status: code === 0 ? "confirmed" : "not_confirmed",
        summary:
          code === 0
            ? `Deterministic runtime command succeeded: ${displayCommand}`
            : `Deterministic runtime command failed with exit code ${code}: ${displayCommand}`,
        evidence,
      });
    });
  });
}

export function resolveRuntimeValidationSpawnCommand(
  command: string[],
  platform: NodeJS.Platform = process.platform,
  shellCommand = process.env.ComSpec ?? "cmd.exe",
): { command: string; args: string[] } {
  const [executable, ...args] = command;
  if (!executable) {
    return { command: "", args: [] };
  }
  if (platform !== "win32") {
    return { command: executable, args };
  }
  const packageManager = executable.replace(/\.(cmd|bat)$/i, "").toLowerCase();
  if (["npm", "npx", "pnpm", "yarn"].includes(packageManager)) {
    return {
      command: shellCommand,
      args: ["/d", "/s", "/c", command.map(quoteCmdArg).join(" ")],
    };
  }
  return { command: executable, args };
}

function quoteCmdArg(value: string): string {
  if (/^[A-Za-z0-9_./:=+-]+$/.test(value)) {
    return value;
  }
  return `"${value.replace(/(["^&|<>%])/g, "^$1")}"`;
}
