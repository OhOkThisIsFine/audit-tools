// sites-pinned: tests/shared/check-shared-primitives.test.ts
/**
 * Single-sourced deterministic file collection across directory hierarchies.
 *
 * Walks `targetPath` recursively, sorting directory entries with
 * {@link compareCodeUnits} at each level to guarantee filesystem/readdir-independent
 * order. Missing paths or mid-walk disappeared files are handled consistently:
 * `options.onMissingEntry` can return a sentinel marker (e.g. for digest tracking);
 * otherwise missing entries return empty arrays. Non-missing IO errors throw.
 */
import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { compareCodeUnits } from "../compareCodeUnits.js";
import { isFileMissingError } from "./json.js";

export interface CollectFilesOptions {
  /**
   * Called when an entry vanishes or is missing.
   * If it returns a string, that string is included in the output.
   * If omitted or undefined, missing paths produce no entries.
   */
  onMissingEntry?: (path: string) => string | undefined;
}

export async function collectFilesSorted(
  targetPath: string,
  options?: CollectFilesOptions,
): Promise<string[]> {
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(targetPath);
  } catch (error) {
    if (!isFileMissingError(error)) throw error;
    const missingMarker = options?.onMissingEntry?.(targetPath);
    return missingMarker !== undefined ? [missingMarker] : [];
  }

  if (info.isFile()) {
    return [targetPath];
  }
  if (!info.isDirectory()) {
    return [];
  }

  let entries: Dirent[];
  try {
    entries = await readdir(targetPath, { withFileTypes: true });
  } catch (error) {
    if (!isFileMissingError(error)) throw error;
    const missingMarker = options?.onMissingEntry?.(targetPath);
    return missingMarker !== undefined ? [missingMarker] : [];
  }

  const files: string[] = [];
  const sortedEntries = entries.sort((a, b) => compareCodeUnits(a.name, b.name));
  for (const entry of sortedEntries) {
    files.push(...(await collectFilesSorted(join(targetPath, entry.name), options)));
  }
  return files;
}
