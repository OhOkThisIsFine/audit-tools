import { hashContent, checkFileIntegrityRecords } from "audit-tools/shared";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, isAbsolute, relative, sep } from "node:path";
import {
  existsSync,
  readFileSync,
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

export function hashFileSync(absolutePath: string): string | undefined {
  if (!existsSync(absolutePath)) return undefined;
  try {
    const content = readFileSync(absolutePath);
    return hashContent(content);
  } catch (err) {
    reportHashIoError(absolutePath, err);
    return undefined;
  }
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
  return a.name.localeCompare(b.name);
}

// Directory digest: build a canonical "directory\n" + (relpath \0 file-hash \0)
// manifest string from a depth-first, name-sorted walk, then hash it once via
// the shared primitive. Per-file content hashes also route through hashContent —
// no inline createHash remains.
function hashDirectorySync(root: string, absolutePath: string): string {
  const parts: string[] = ["directory\n"];

  const visit = (dir: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort(sortDirents);
    for (const entry of entries) {
      const child = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(child);
        continue;
      }
      if (!entry.isFile()) continue;
      const content = readFileSync(child);
      parts.push(toDisplayRelativePath(root, child), "\0", hashContent(content), "\0");
    }
  };

  visit(absolutePath);
  return hashContent(parts.join(""));
}

async function hashDirectory(root: string, absolutePath: string): Promise<string> {
  const parts: string[] = ["directory\n"];

  const visit = async (dir: string): Promise<void> => {
    const entries = (await readdir(dir, { withFileTypes: true })).sort(sortDirents);
    for (const entry of entries) {
      const child = join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(child);
        continue;
      }
      if (!entry.isFile()) continue;
      const content = await readFile(child);
      parts.push(toDisplayRelativePath(root, child), "\0", hashContent(content), "\0");
    }
  };

  await visit(absolutePath);
  return hashContent(parts.join(""));
}

export function resolveAffectedPath(root: string, affectedPath: string): string {
  return isAbsolute(affectedPath) ? affectedPath : join(root, affectedPath);
}

export function hashAffectedPathSync(
  root: string,
  affectedPath: string,
): string | undefined {
  const absolutePath = resolveAffectedPath(root, affectedPath);
  if (!existsSync(absolutePath)) return undefined;
  try {
    const pathStat = statSync(absolutePath);
    if (pathStat.isDirectory()) return hashDirectorySync(root, absolutePath);
    if (pathStat.isFile()) return hashFileSync(absolutePath);
    return undefined;
  } catch (err) {
    reportHashIoError(absolutePath, err);
    return undefined;
  }
}

export async function hashAffectedPath(
  root: string,
  affectedPath: string,
): Promise<string | undefined> {
  const absolutePath = resolveAffectedPath(root, affectedPath);
  if (!existsSync(absolutePath)) return undefined;
  try {
    const pathStat = await stat(absolutePath);
    if (pathStat.isDirectory()) return await hashDirectory(root, absolutePath);
    if (pathStat.isFile()) return await hashFile(absolutePath);
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

export function snapshotAffectedFileHashes(
  root: string,
  findings: Finding[],
): void {
  for (const finding of findings) {
    for (const af of finding.affected_files) {
      if (af.hash_at_plan_time) continue;
      af.hash_at_plan_time = hashAffectedPathSync(root, af.path);
    }
  }
}

/**
 * Force-update every affected file's stored hash to its current content. Use
 * after the implement phase legitimately rewrites files, so a later integrity
 * check does not flag the run's own edits as a stale plan.
 */
export function resnapshotAffectedFileHashes(
  root: string,
  findings: Finding[],
): void {
  for (const finding of findings) {
    for (const af of finding.affected_files) {
      af.hash_at_plan_time = hashAffectedPathSync(root, af.path);
    }
  }
}
