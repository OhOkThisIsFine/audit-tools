// sites-pinned: tests/shared/collect-files-sorted.test.ts
import { readdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { compareCodeUnits } from "../compareCodeUnits.js";
import { isFileMissingError } from "./json.js";

interface WalkPolicy {
  /** Follow descendant links; otherwise return them as leaf entries. Root links are followed. */
  followSymlinks?: boolean;
  /** The consumer decides whether a vanished entry is omitted or represented. */
  onMissing?: (path: string) => string[];
}

/** Stable traversal shared by hashing and artifact validation; their missing-entry policies stay local. */
export async function collectFilesSorted(path: string, policy: WalkPolicy = {}): Promise<string[]> {
  async function walk(current: string, ancestors: ReadonlySet<string>): Promise<string[]> {
    try {
      const info = await stat(current);
      if (info.isFile()) return [current];
      if (!info.isDirectory()) return [];
      const canonical = await realpath(current);
      if (ancestors.has(canonical)) throw new Error(`Directory symlink cycle while reading ${current}`);
      const nextAncestors = new Set([...ancestors, canonical]);
      const entries = await readdir(current, { withFileTypes: true });
      const files: string[] = [];
      for (const entry of entries.sort((a, b) => compareCodeUnits(a.name, b.name))) {
        const child = join(current, entry.name);
        if (entry.isDirectory() || policy.followSymlinks) files.push(...await walk(child, nextAncestors));
        else files.push(child);
      }
      return files;
    } catch (error) {
      if (isFileMissingError(error) && policy.onMissing) return policy.onMissing(current);
      throw error;
    }
  }
  return (await walk(path, new Set())).sort(compareCodeUnits);
}
