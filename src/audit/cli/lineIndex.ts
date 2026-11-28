// sites-pinned: tests/audit/line-index-measurements.test.ts
import { resolve } from "node:path";
import { countLines } from "./args.js";
import { isFileMissingError } from "audit-tools/shared";
import { uniqueSorted } from "../../shared/compareCodeUnits.js";
import { errorMessage } from "../../shared/io/json.js";

// Line-count helpers extracted from cli.ts. Pure functions over the repo
// manifest / task file paths — used to annotate audit tasks with per-file line
// counts and to build line indexes for prompt rendering.

// How many files to read concurrently when counting lines, bounding open file
// descriptors so a large repo manifest does not exhaust the fd limit.
const LINE_COUNT_BATCH_SIZE = 25;

/**
 * Sentinel line-count value marking a file as UNMEASURED after a read failure,
 * distinct from a genuine zero-line file (CP-NODE-6). Deliberately stays within
 * the `number` domain (`Record<string, number>` is unchanged as the index's
 * shape, so no consumer's type signature needs to change to read it) while
 * every ordinary numeric comparison against it (`=== 0`, `<= 1`, `> 0`) is
 * `false` by IEEE 754 definition — an unmeasured entry can never be silently
 * read as a genuine empty file by an unaware call site. A schema-validated
 * contract field that can only ever hold a real count (`AuditTask.file_line_counts`,
 * `z.number().int().min(0)`) must never persist this value.
 */
export const UNMEASURED_LINE_COUNT = Number.NaN;

/** Measure the adapter's exact sequence, including repeated manifest paths. */
async function measureLinePaths(
  root: string,
  preparedPaths: readonly string[],
): Promise<Record<string, number>> {
  const entries: Array<readonly [string, number]> = [];
  let failureCount = 0;
  for (let i = 0; i < preparedPaths.length; i += LINE_COUNT_BATCH_SIZE) {
    const batch = preparedPaths.slice(i, i + LINE_COUNT_BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (path) => {
        try {
          return [path, await countLines(resolve(root, path))] as const;
        } catch (err) {
          // Distinguish file-not-found from other IO errors so callers are not
          // misled into treating a missing file as an empty one (COR-c868f53d).
          const kind = isFileMissingError(err) ? "file not found" : "IO error";
          process.stderr.write(
            `[lineIndex] ${kind} counting lines for '${path}': ${errorMessage(err)}\n`,
          );
          failureCount++;
          // Unmeasured, not a silent 0 (CP-NODE-6) — see UNMEASURED_LINE_COUNT.
          return [path, UNMEASURED_LINE_COUNT] as const;
        }
      }),
    );
    entries.push(...results);
  }
  if (failureCount > 0) {
    process.stderr.write(
      `[lineIndex] ${failureCount} of ${preparedPaths.length} file(s) failed line counting; those entries are marked unmeasured.\n`,
    );
  }
  // Promise.all preserves input order: duplicate keys take their last input
  // occurrence's value, independently of read completion order.
  return Object.fromEntries(entries);
}

export async function buildLineIndexForPaths(
  root: string,
  paths: string[],
): Promise<Record<string, number>> {
  // Only this adapter deduplicates and sorts; keys still retain raw spelling.
  return measureLinePaths(root, uniqueSorted(paths));
}
