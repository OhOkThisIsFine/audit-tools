// sites-pinned: tests/shared/ignored-root-logs.test.ts
import type { Dirent } from "node:fs";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { compareCodeUnits } from "../compareCodeUnits.js";
import { isGitRepo } from "../git.js";
import { AUDIT_TOOLS_DIRNAME } from "../io/auditToolsPaths.js";
import { writeJsonFile } from "../io/json.js";
import { runTrackedAsync, TRACKED_CHILD_DEADLINE_MS } from "../tooling/exec.js";
import { resolveWithinRoot } from "../io/pathContainment.js";

/**
 * Recognizes log filenames in repository root:
 * - files ending in `.log` (e.g. `test.log`, `npm-debug.log`, `pkt.log`)
 * - files ending in `.log.jsonl`
 */
export function isLogFilename(name: string): boolean {
  return /\.log(?:\.jsonl)?$/iu.test(name);
}

function isWithinOrEqual(parent: string, target: string): boolean {
  return resolveWithinRoot(parent, target, { allowRoot: true }) !== null;
}

/** The run-scoped path storing the pre-execution ignored root log inventory. */
export function ignoredRootLogsPrePath(runDir: string): string {
  return join(runDir, "ignored_root_logs_pre.json");
}

/** Check which paths are git-ignored in the given repository root. */
export async function gitCheckIgnore(
  root: string,
  paths: readonly string[],
): Promise<string[]> {
  if (paths.length === 0) return [];
  const result = await runTrackedAsync(
    ["git", "check-ignore", "--", ...paths],
    {
      cwd: root,
      encoding: "utf8",
      timeout: TRACKED_CHILD_DEADLINE_MS,
    },
  );
  if (result.status !== 0 && result.status !== 1) return [];
  return result.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim().replace(/\\/gu, "/"))
    .filter((line) => line.length > 0);
}

/**
 * Bounded inventory of ignored root log outputs.
 * Reads only direct children of the repository root, excludes sanctioned artifact
 * destinations (`.audit-tools`, `artifactsDir`, `.git`), and filters to files
 * matching log output patterns that are ignored by git.
 */
export async function inventoryIgnoredRootLogs(params: {
  readonly root: string;
  readonly artifactsDir?: string;
}): Promise<string[]> {
  const { root, artifactsDir } = params;
  let dirents: Dirent[];
  try {
    dirents = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const candidateNames: string[] = [];
  const absArtifacts = artifactsDir ? resolve(artifactsDir) : undefined;
  const absAuditTools = resolve(root, AUDIT_TOOLS_DIRNAME);

  for (const dirent of dirents) {
    if (!dirent.isFile() && !dirent.isSymbolicLink()) continue;

    const name = dirent.name;
    if (!isLogFilename(name)) continue;

    if (name === AUDIT_TOOLS_DIRNAME || name === ".git") continue;
    const absPath = resolve(root, name);
    if (
      absArtifacts &&
      (absPath === absArtifacts || isWithinOrEqual(absArtifacts, absPath))
    ) {
      continue;
    }
    if (absPath === absAuditTools || isWithinOrEqual(absAuditTools, absPath)) {
      continue;
    }

    candidateNames.push(name);
  }

  if (candidateNames.length === 0) return [];

  if (await isGitRepo(root)) {
    const ignored = await gitCheckIgnore(root, candidateNames);
    return [...new Set(ignored)].sort(compareCodeUnits);
  }

  const gitignorePath = join(root, ".gitignore");
  if (existsSync(gitignorePath)) {
    try {
      const content = await readFile(gitignorePath, "utf8");
      const patterns = content
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("#"));
      const matched = candidateNames.filter((name) =>
        patterns.some((pattern) => {
          if (pattern === "*.log") return name.endsWith(".log");
          if (pattern === "*.log.jsonl") return name.endsWith(".log.jsonl");
          if (pattern.startsWith("*.")) return name.endsWith(pattern.slice(1));
          return name === pattern || `/${name}` === pattern;
        }),
      );
      return matched.sort(compareCodeUnits);
    } catch {
      return [];
    }
  }

  return [];
}

/**
 * Compare current ignored root log inventory against pre-execution inventory,
 * reporting only newly created relevant logs.
 */
export async function detectNewlyCreatedIgnoredRootLogs(params: {
  readonly root: string;
  readonly artifactsDir?: string;
  readonly preInventory: readonly string[];
}): Promise<string[]> {
  const current = await inventoryIgnoredRootLogs(params);
  const preSet = new Set(params.preInventory.map((p) => p.replace(/\\/gu, "/")));
  return current
    .filter((file) => !preSet.has(file.replace(/\\/gu, "/")))
    .sort(compareCodeUnits);
}

/**
 * Records the pre-execution inventory of ignored root logs in `paths.runDir`
 * before host execution begins, preserving existing baseline if already recorded.
 */
export async function recordIgnoredRootLogsPreInventory(params: {
  readonly root: string;
  readonly artifactsDir: string;
  readonly runDir: string;
}): Promise<void> {
  const preInventoryPath = ignoredRootLogsPrePath(params.runDir);
  if (!existsSync(preInventoryPath)) {
    const preInventory = await inventoryIgnoredRootLogs({
      root: params.root,
      artifactsDir: params.artifactsDir,
    });
    await mkdir(params.runDir, { recursive: true });
    await writeJsonFile(preInventoryPath, preInventory);
  }
}

/**
 * Reads the recorded pre-execution inventory and compares against current state
 * to report newly created ignored root logs.
 */
export async function readNewlyCreatedIgnoredRootLogs(params: {
  readonly root: string;
  readonly artifactsDir: string;
  readonly runDir: string;
}): Promise<string[]> {
  const preInventoryPath = ignoredRootLogsPrePath(params.runDir);
  let preInventory: string[] = [];
  if (existsSync(preInventoryPath)) {
    try {
      const read = JSON.parse(await readFile(preInventoryPath, "utf8"));
      if (Array.isArray(read)) {
        preInventory = read.filter(
          (item): item is string => typeof item === "string",
        );
      }
    } catch {
      preInventory = [];
    }
  }
  return await detectNewlyCreatedIgnoredRootLogs({
    root: params.root,
    artifactsDir: params.artifactsDir,
    preInventory,
  });
}
