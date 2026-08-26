import { readFile } from "node:fs/promises";

/**
 * Default byte cap for a bounded extractor read: a file larger than this is
 * skipped rather than pulled into memory.
 */
export const DEFAULT_MAX_BYTES = 512 * 1024;

/**
 * The ONE bounded, non-throwing file read every extractor defaults to. A file
 * that is unreadable, or larger than `maxBytes`, yields `undefined` — extraction
 * degrades to "no content" rather than aborting the whole pass.
 */
export async function defaultReadFileText(
  absPath: string,
  maxBytes: number,
): Promise<string | undefined> {
  try {
    const buf = await readFile(absPath);
    if (buf.byteLength > maxBytes) return undefined;
    return buf.toString("utf8");
  } catch {
    return undefined;
  }
}
