import { hashContent, checkFileIntegrityRecords, resolveWithinRoot, compareCodeUnits } from "audit-tools/shared";
import {
  lstat,
  readFile,
  readdir,
  readlink,
  realpath,
  stat,
} from "node:fs/promises";
import { join, isAbsolute, relative, resolve, sep } from "node:path";
import {
  existsSync,
  lstatSync,
  realpathSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  statSync,
  type Dirent,
} from "node:fs";
import type { Finding } from "../state/types.js";

/**
 * On a non-ENOENT read failure, surface a structured stderr line before
 * swallowing the error, so a genuine I/O problem leaves a trace rather than
 * disappearing into an `undefined` return. ENOENT is silent here — an absent
 * file is the caller's `missing` concern, not an error.
 */
function reportHashIoError(absolutePath: string, err: unknown): void {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "ENOENT") return;
  process.stderr.write(
    JSON.stringify({
      level: "warn",
      event: "file_integrity_io_error",
      path: absolutePath,
      code: code ?? null,
      message: String(err),
      ts: new Date().toISOString(),
    }) + "\n",
  );
}

export async function hashFile(absolutePath: string): Promise<string | undefined> {
  if (!existsSync(absolutePath)) return undefined;
  try {
    const content = await readFile(absolutePath);
    return hashContent(content);
  } catch (err) {
    reportHashIoError(absolutePath, err);
    return undefined;
  }
}

function toDisplayRelativePath(root: string, absolutePath: string): string {
  return relative(root, absolutePath).split(sep).join("/");
}

function sortDirents(a: Dirent, b: Dirent): number {
  return compareCodeUnits(a.name, b.name);
}

function pushDirectorySymlinkHash(
  parts: string[],
  root: string,
  logicalPath: string,
  linkText: string,
): void {
  parts.push(
    toDisplayRelativePath(root, logicalPath),
    "\0",
    "symlink\0",
    hashContent(linkText),
    "\0",
  );
}

// Directory digest: build a canonical manifest string (a "directory" marker,
// then NUL-separated relpath/file-hash pairs) from a depth-first, name-sorted
// walk, then hash it once via the shared primitive. Per-file content hashes
// also route through hashContent — no inline createHash remains.
async function hashDirectory(
  root: string,
  logicalPath: string,
  physicalPath: string,
): Promise<string> {
  const parts: string[] = ["directory\n"];

  const visit = async (
    logicalDirectory: string,
    physicalDirectory: string,
  ): Promise<void> => {
    const entries = (
      await readdir(physicalDirectory, { withFileTypes: true })
    ).sort(sortDirents);
    for (const entry of entries) {
      const logicalChild = join(logicalDirectory, entry.name);
      const physicalChild = join(physicalDirectory, entry.name);
      if (entry.isSymbolicLink()) {
        pushDirectorySymlinkHash(
          parts,
          root,
          logicalChild,
          await readlink(physicalChild),
        );
        continue;
      }
      if (entry.isDirectory()) {
        await visit(logicalChild, physicalChild);
        continue;
      }
      if (!entry.isFile()) continue;
      const content = await readFile(physicalChild);
      parts.push(
        toDisplayRelativePath(root, logicalChild),
        "\0",
        hashContent(content),
        "\0",
      );
    }
  };

  await visit(logicalPath, physicalPath);
  return hashContent(parts.join(""));
}

export function resolveAffectedPath(root: string, affectedPath: string): string {
  return isAbsolute(affectedPath) ? affectedPath : join(root, affectedPath);
}


export async function hashAffectedPath(
  root: string,
  affectedPath: string,
): Promise<string | undefined> {
  const absoluteRoot = resolve(root);
  const absolutePath = resolveAffectedPath(absoluteRoot, affectedPath);
  if (!existsSync(absolutePath)) return undefined;
  try {
    if (resolveWithinRoot(absoluteRoot, absolutePath) === null) {
      throw new Error("affected path escapes the repository root");
    }
    const lexicalPathStat = await lstat(absolutePath);
    if (lexicalPathStat.isSymbolicLink()) {
      throw new Error("top-level symlinks cannot be trusted affected paths");
    }
    const physicalRoot = await realpath(absoluteRoot);
    const physicalPath = await realpath(absolutePath);
    if (resolveWithinRoot(physicalRoot, physicalPath) === null) {
      throw new Error("resolved affected path escapes the repository root");
    }
    const pathStat = await stat(physicalPath);
    if (pathStat.isDirectory()) {
      return await hashDirectory(absoluteRoot, absolutePath, physicalPath);
    }
    if (pathStat.isFile()) return await hashFile(physicalPath);
    return undefined;
  } catch (err) {
    reportHashIoError(absolutePath, err);
    return undefined;
  }
}

export interface AffectedFileIntegrityResult {
  changed: string[];
  missing: string[];
  /**
   * Files that exist on disk but could not be read (a real I/O error such as
   * EACCES/EISDIR). Kept distinct from `missing` so a genuine read failure is
   * not silently reclassified as an absent file. Mirrors the audit-code
   * `FileIntegrityResult.io_errors` channel.
   */
  io_errors: string[];
  is_clean: boolean;
}

export async function checkAffectedFileIntegrity(
  root: string,
  findings: Finding[],
): Promise<AffectedFileIntegrityResult> {
  const checked = new Set<string>();
  const records: { path: string; hash_at_plan_time?: string }[] = [];
  for (const finding of findings) {
    for (const af of finding.affected_files) {
      if (!af.hash_at_plan_time || checked.has(af.path)) continue;
      checked.add(af.path);
      records.push(af);
    }
  }

  const buckets = await checkFileIntegrityRecords({
    records,
    getPath: (record) => record.path,
    getExpectedHash: (record) => record.hash_at_plan_time,
    resolveAbsolute: (path) => resolveAffectedPath(root, path),
    // Distinguish an absent file (missing) from a file that exists but cannot
    // be read (io_errors): a non-ENOENT failure is a real I/O error, not a
    // missing file, so it must not be folded into `missing`.
    exists: existsSync,
    hash: async (absolute, record) => {
      try {
        const currentHash = await hashAffectedPath(root, record.path);
        if (!currentHash) return { kind: "io_error" };
        return { kind: "ok", hash: currentHash };
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return { kind: "missing" };
        reportHashIoError(absolute, err);
        return { kind: "io_error" };
      }
    },
  });

  return {
    changed: buckets.changed,
    missing: buckets.missing,
    io_errors: buckets.ioErrors,
    is_clean: buckets.isClean,
  };
}

function planningBaselineError(
  affectedPath: string,
  reason: string,
  cause?: unknown,
): Error {
  return new Error(
    `Cannot snapshot planning baseline for "${affectedPath}": ${reason}`,
    cause === undefined ? undefined : { cause },
  );
}

function hashPlanningDirectorySync(
  absoluteRoot: string,
  absolutePath: string,
  physicalRoot: string,
  physicalPath: string,
  affectedPath: string,
): string {
  const parts: string[] = ["directory\n"];

  const visit = (logicalDirectory: string, physicalDirectory: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(physicalDirectory, { withFileTypes: true }).sort(
        sortDirents,
      );
    } catch (error) {
      throw planningBaselineError(
        affectedPath,
        "directory content is unreadable",
        error,
      );
    }

    for (const entry of entries) {
      const logicalChild = join(logicalDirectory, entry.name);
      const unresolvedPhysicalChild = join(physicalDirectory, entry.name);
      if (entry.isSymbolicLink()) {
        try {
          pushDirectorySymlinkHash(
            parts,
            absoluteRoot,
            logicalChild,
            readlinkSync(unresolvedPhysicalChild),
          );
        } catch (error) {
          throw planningBaselineError(
            affectedPath,
            `directory symlink ${JSON.stringify(
              toDisplayRelativePath(absoluteRoot, logicalChild),
            )} is unreadable`,
            error,
          );
        }
        continue;
      }
      if (!entry.isDirectory() && !entry.isFile()) continue;

      let physicalChild: string;
      try {
        physicalChild = realpathSync(unresolvedPhysicalChild);
      } catch (error) {
        throw planningBaselineError(
          affectedPath,
          `directory entry ${JSON.stringify(
            toDisplayRelativePath(absoluteRoot, logicalChild),
          )} is unreadable`,
          error,
        );
      }
      if (resolveWithinRoot(physicalRoot, physicalChild) === null) {
        throw planningBaselineError(
          affectedPath,
          `resolved directory entry ${JSON.stringify(
            toDisplayRelativePath(absoluteRoot, logicalChild),
          )} escapes the repository root`,
        );
      }

      if (entry.isDirectory()) {
        visit(logicalChild, physicalChild);
        continue;
      }

      try {
        const content = readFileSync(physicalChild);
        parts.push(
          toDisplayRelativePath(absoluteRoot, logicalChild),
          "\0",
          hashContent(content),
          "\0",
        );
      } catch (error) {
        throw planningBaselineError(
          affectedPath,
          `directory file ${JSON.stringify(
            toDisplayRelativePath(absoluteRoot, logicalChild),
          )} is unreadable`,
          error,
        );
      }
    }
  };

  visit(absolutePath, physicalPath);
  return hashContent(parts.join(""));
}

/**
 * Strict plan-time baseline policy. Only readable regular files and directories
 * lexically and physically contained by the repository root may become trusted
 * baselines.
 * A genuinely absent path is deterministic future work and
 * contributes no baseline; every other unsafe or unreadable path is refused
 * loudly.
 */
function hashPlanningBaselineSync(
  root: string,
  affectedPath: string,
): string | undefined {
  if (isAbsolute(affectedPath)) {
    throw planningBaselineError(affectedPath, "absolute paths are not allowed");
  }

  const absoluteRoot = resolve(root);
  const absolutePath = resolve(absoluteRoot, affectedPath);
  if (resolveWithinRoot(absoluteRoot, absolutePath) === null) {
    throw planningBaselineError(affectedPath, "path escapes the repository root");
  }

  let pathStat;
  let lexicalPathStat;
  try {
    lexicalPathStat = lstatSync(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw planningBaselineError(affectedPath, "path metadata is unreadable", error);
  }
  if (lexicalPathStat.isSymbolicLink()) {
    throw planningBaselineError(
      affectedPath,
      "top-level symlinks cannot become trusted affected paths",
    );
  }
  try {
    pathStat = statSync(absolutePath);
  } catch (error) {
    throw planningBaselineError(affectedPath, "path metadata is unreadable", error);
  }
  if (!pathStat.isFile() && !pathStat.isDirectory()) {
    throw planningBaselineError(
      affectedPath,
      "existing path is not a regular file or directory",
    );
  }
  let physicalRoot: string;
  try {
    physicalRoot = realpathSync(absoluteRoot);
  } catch (error) {
    throw planningBaselineError(affectedPath, "repository root is unreadable", error);
  }

  let physicalPath: string;
  try {
    physicalPath = realpathSync(absolutePath);
  } catch (error) {
    throw planningBaselineError(affectedPath, "path content is unreadable", error);
  }
  if (resolveWithinRoot(physicalRoot, physicalPath) === null) {
    throw planningBaselineError(
      affectedPath,
      "resolved path escapes the repository root",
    );
  }

  if (pathStat.isDirectory()) {
    return hashPlanningDirectorySync(
      absoluteRoot,
      absolutePath,
      physicalRoot,
      physicalPath,
      affectedPath,
    );
  }

  try {
    return hashContent(readFileSync(physicalPath));
  } catch (error) {
    throw planningBaselineError(affectedPath, "path content is unreadable", error);
  }
}

export function snapshotAffectedFileHashes(
  root: string,
  findings: Finding[],
): void {
  for (const finding of findings) {
    for (const af of finding.affected_files) {
      const hash = hashPlanningBaselineSync(root, af.path);
      if (!af.hash_at_plan_time) af.hash_at_plan_time = hash;
    }
  }
}
