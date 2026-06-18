import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Count the lines of the file at `join(root, relativePath)`, matching the
 * line-counting convention the auditor uses for `file_coverage[].total_lines`:
 * a trailing newline does not count as an extra line, and an empty file is 0.
 *
 * Hoisted here because several test files (and the provider-assisted bridge
 * helper) had byte-identical copies of this function.
 */
export async function countLines(root, relativePath) {
  const content = await readFile(join(root, relativePath), "utf8");
  if (content.length === 0) {
    return 0;
  }
  return content.endsWith("\n")
    ? content.split(/\r?\n/).length - 1
    : content.split(/\r?\n/).length;
}
