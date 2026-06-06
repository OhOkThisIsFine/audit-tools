import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { existsSync, readFileSync } from "node:fs";
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
      const absolute = isAbsolute(af.path) ? af.path : join(root, af.path);
      // Distinguish an absent file (missing) from a file that exists but cannot
      // be read (io_errors): a non-ENOENT failure is a real I/O error, not a
      // missing file, so it must not be folded into `missing`.
      if (!existsSync(absolute)) {
        missing.push(af.path);
        continue;
      }
      try {
        const content = await readFile(absolute);
        const currentHash = createHash("sha256").update(content).digest("hex");
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
      const absolute = isAbsolute(af.path) ? af.path : join(root, af.path);
      af.hash_at_plan_time = hashFileSync(absolute);
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
      const absolute = isAbsolute(af.path) ? af.path : join(root, af.path);
      af.hash_at_plan_time = hashFileSync(absolute);
    }
  }
}
