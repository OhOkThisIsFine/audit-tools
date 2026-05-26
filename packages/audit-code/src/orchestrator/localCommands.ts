import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { delimiter, extname, isAbsolute, join } from "node:path";

export interface LocalCommandCandidate {
  command: string;
  args: string[];
  display?: string;
}

export interface LocalCommandResult {
  candidate: LocalCommandCandidate;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

function isWindowsBatchCommand(path: string): boolean {
  return process.platform === "win32" && /\.(cmd|bat)$/i.test(path);
}

function quoteForCmd(arg: string): string {
  if (arg.length === 0) return '""';
  if (!/[\s"]/u.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

function toSpawnTuple(candidate: LocalCommandCandidate): {
  command: string;
  args: string[];
} {
  if (!isWindowsBatchCommand(candidate.command)) {
    return {
      command: candidate.command,
      args: candidate.args,
    };
  }

  return {
    command: process.env.ComSpec ?? "cmd.exe",
    args: [
      "/d",
      "/s",
      "/c",
      [candidate.command, ...candidate.args].map(quoteForCmd).join(" "),
    ],
  };
}

function resolveFromPath(command: string): string | null {
  if (command.trim().length === 0) {
    return null;
  }

  if (
    command.includes("\\") ||
    command.includes("/") ||
    isAbsolute(command)
  ) {
    return existsSync(command) ? command : null;
  }

  const pathValue = process.env.PATH ?? "";
  const pathEntries = pathValue
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
          .split(";")
          .map((ext) => ext.trim().toLowerCase())
          .filter((ext) => ext.length > 0)
          .map((ext) => (ext.startsWith(".") ? ext : `.${ext}`))
      : [""];

  for (const dir of pathEntries) {
    const directPath = join(dir, command);
    if (process.platform === "win32" && extname(command).length === 0) {
      for (const ext of extensions) {
        const candidatePath = join(dir, `${command}${ext}`);
        if (existsSync(candidatePath)) {
          return candidatePath;
        }
      }
      if (existsSync(directPath)) {
        return directPath;
      }
      continue;
    }

    if (existsSync(directPath)) {
      return directPath;
    }
    for (const ext of extensions) {
      const candidatePath = join(dir, `${command}${ext}`);
      if (existsSync(candidatePath)) {
        return candidatePath;
      }
    }
  }

  return null;
}

function resolveCandidate(
  root: string,
  candidate: LocalCommandCandidate,
): LocalCommandCandidate | null {
  if (candidate.command === process.execPath) {
    return candidate;
  }

  const resolvedPath = resolveFromPath(candidate.command);
  if (resolvedPath) {
    return {
      ...candidate,
      command: resolvedPath,
    };
  }

  const repoLocalPath = join(root, candidate.command);
  if (existsSync(repoLocalPath)) {
    return {
      ...candidate,
      command: repoLocalPath,
    };
  }

  return null;
}

export function runFirstAvailableCommand(
  root: string,
  candidates: LocalCommandCandidate[],
): LocalCommandResult | null {
  for (const candidate of candidates) {
    const resolved = resolveCandidate(root, candidate);
    if (!resolved) {
      continue;
    }

    const spawnTarget = toSpawnTuple(resolved);
    const result = spawnSync(spawnTarget.command, spawnTarget.args, {
      cwd: root,
      env: process.env,
      encoding: "utf8",
      windowsHide: true,
      stdio: "pipe",
    });

    return {
      candidate: {
        ...resolved,
        display:
          candidate.display ?? [candidate.command, ...candidate.args].join(" "),
      },
      exitCode: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      error: result.error
        ? new Error(result.error.message, { cause: result.error })
        : undefined,
    };
  }

  return null;
}

export function resolveNodeTool(
  root: string,
  relativePath: string,
  args: string[],
  display: string,
): LocalCommandCandidate[] {
  const localToolPath = join(root, relativePath);
  const candidates: LocalCommandCandidate[] = [];
  if (existsSync(localToolPath)) {
    candidates.push({
      command: process.execPath,
      args: [localToolPath, ...args],
      display,
    });
  }
  return candidates;
}
