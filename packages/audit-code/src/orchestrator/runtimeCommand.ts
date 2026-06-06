import { spawn } from "node:child_process";
import { quoteForOpenTokenCmd, wrapForOpenToken } from "@audit-tools/shared";

// Deterministic runtime-validation command execution: resolve a command to a
// platform-correct spawn invocation (Windows package-manager shims need a
// cmd.exe wrapper), optionally wrap it for opentoken accounting, and run it
// capturing a confirmed/not_confirmed/inconclusive outcome. Hoisted out of
// internalExecutors.ts as a shared, side-effect-only helper module.
//
// The cmd.exe quoting (both for the opentoken wrap and the package-manager
// batch path) reuses the canonical exec.ts helpers so the safe-character set
// stays unified — the two formerly-private copies here diverged on `@`.

function resolveOpentokenWrap(
  resolved: { command: string; args: string[] },
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
  return wrapForOpenToken(resolved.command, resolved.args, "opentoken", platform);
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
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    child.on("error", (error) => {
      const output = `${stdout}\n${stderr}`.trim();
      const lines = output.length > 0 ? output.split(/\r?\n/) : [];
      const truncated = lines.length > 10;
      const evidence = truncated
        ? [`[... truncated: showing last 10 of ${lines.length} lines ...]`, ...lines.slice(-10)]
        : lines;
      resolve({
        status: "inconclusive",
        summary: `Failed to execute ${displayCommand}: ${error.message}`,
        evidence,
      });
    });
    child.on("exit", (code, signal) => {
      exitCode = code;
      exitSignal = signal;
    });
    child.on("close", () => {
      const output = `${stdout}\n${stderr}`.trim();
      const lines = output.length > 0 ? output.split(/\r?\n/) : [];
      const truncated = lines.length > 10;
      const evidence = truncated
        ? [`[... truncated: showing last 10 of ${lines.length} lines ...]`, ...lines.slice(-10)]
        : lines;
      const succeeded = exitCode === 0;
      let summary: string;
      if (succeeded) {
        summary = `Deterministic runtime command succeeded: ${displayCommand}`;
      } else if (exitCode !== null) {
        summary = `Deterministic runtime command failed with exit code ${exitCode}: ${displayCommand}`;
      } else if (exitSignal !== null) {
        summary = `Deterministic runtime command terminated by signal ${exitSignal}: ${displayCommand}`;
      } else {
        summary = `Deterministic runtime command exited with unknown status: ${displayCommand}`;
      }
      resolve({
        status: succeeded ? "confirmed" : "not_confirmed",
        summary,
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
      args: ["/d", "/s", "/c", command.map(quoteForOpenTokenCmd).join(" ")],
    };
  }
  return { command: executable, args };
}
