import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import type { Finding } from "../state/types.js";

export function hashFileSync(absolutePath: string): string | undefined {
  if (!existsSync(absolutePath)) return undefined;
  try {
    const content = readFileSync(absolutePath);
    return createHash("sha256").update(content).digest("hex");
  } catch {
    return undefined;
  }
}

export async function hashFile(absolutePath: string): Promise<string | undefined> {
  if (!existsSync(absolutePath)) return undefined;
  try {
    const content = await readFile(absolutePath);
    return createHash("sha256").update(content).digest("hex");
  } catch {
    return undefined;
  }
}

export interface AffectedFileIntegrityResult {
  changed: string[];
  missing: string[];
  is_clean: boolean;
}

export async function checkAffectedFileIntegrity(
  root: string,
  findings: Finding[],
): Promise<AffectedFileIntegrityResult> {
  const changed: string[] = [];
  const missing: string[] = [];
  const checked = new Set<string>();

  for (const finding of findings) {
    for (const af of finding.affected_files) {
      if (!af.hash_at_plan_time || checked.has(af.path)) continue;
      checked.add(af.path);
      const absolute = isAbsolute(af.path) ? af.path : join(root, af.path);
      const currentHash = await hashFile(absolute);
      if (!currentHash) {
        missing.push(af.path);
      } else if (currentHash !== af.hash_at_plan_time) {
        changed.push(af.path);
      }
    }
  }

  return {
    changed,
    missing,
    is_clean: changed.length === 0 && missing.length === 0,
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
