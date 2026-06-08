import { createHash } from "node:crypto";
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
    return createHash("sha256").update(content).digest("hex");
  } catch (err) {
    reportHashIoError(absolutePath, err);
    return undefined;
  }
}

export async function hashFile(absolutePath: string): Promise<string | undefined> {
  if (!existsSync(absolutePath)) return undefined;
  try {
    const content = await readFile(absolutePath);
    return createHash("sha256").update(content).digest("hex");
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

function hashDirectorySync(root: string, absolutePath: string): string {
  const digest = createHash("sha256");
  digest.update("directory\n");

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
      digest
        .update(toDisplayRelativePath(root, child))
        .update("\0")
        .update(createHash("sha256").update(content).digest("hex"))
        .update("\0");
    }
  };

  visit(absolutePath);
  return digest.digest("hex");
}

async function hashDirectory(root: string, absolutePath: string): Promise<string> {
  const digest = createHash("sha256");
  digest.update("directory\n");

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
      digest
        .update(toDisplayRelativePath(root, child))
        .update("\0")
        .update(createHash("sha256").update(content).digest("hex"))
        .update("\0");
    }
  };

  await visit(absolutePath);
  return digest.digest("hex");
}

function resolveAffectedPath(root: string, affectedPath: string): string {
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
  const changed: string[] = [];
  const missing: string[] = [];
  const ioErrors: string[] = [];
  const checked = new Set<string>();

  for (const finding of findings) {
    for (const af of finding.affected_files) {
      if (!af.hash_at_plan_time || checked.has(af.path)) continue;
      checked.add(af.path);
      const absolute = resolveAffectedPath(root, af.path);
      // Distinguish an absent file (missing) from a file that exists but cannot
      // be read (io_errors): a non-ENOENT failure is a real I/O error, not a
      // missing file, so it must not be folded into `missing`.
      if (!existsSync(absolute)) {
        missing.push(af.path);
        continue;
      }
      try {
        const currentHash = await hashAffectedPath(root, af.path);
        if (!currentHash) {
          ioErrors.push(af.path);
          continue;
        }
        if (currentHash !== af.hash_at_plan_time) {
          changed.push(af.path);
        }
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          missing.push(af.path);
        } else {
          reportHashIoError(absolute, err);
          ioErrors.push(af.path);
        }
      }
    }
  }

  return {
    changed,
    missing,
    io_errors: ioErrors,
    is_clean:
      changed.length === 0 && missing.length === 0 && ioErrors.length === 0,
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
