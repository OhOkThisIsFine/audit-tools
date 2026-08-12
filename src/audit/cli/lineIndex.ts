import { resolve } from "node:path";
import { countLines } from "./args.js";
import type { AuditTask, RepoManifest } from "../types.js";
import { isFileMissingError } from "audit-tools/shared";
import {
  canonicalizeAuditTasks,
  compareCodeUnits,
} from "../../shared/affinityArtifacts.js";

// Line-count helpers extracted from cli.ts. Pure functions over the repo
// manifest / task file paths — used to annotate audit tasks with per-file line
// counts and to build line indexes for prompt rendering.

// How many files to read concurrently when counting lines, bounding open file
// descriptors so a large repo manifest does not exhaust the fd limit.
const LINE_COUNT_BATCH_SIZE = 25;

/**
 * Sentinel line-count value marking a file as UNMEASURED (a read failure, or —
 * via {@link isUnmeasuredLineCount} — a key entirely absent from the index),
 * distinct from a genuine zero-line file (CP-NODE-6). Deliberately stays within
 * the `number` domain (`Record<string, number>` is unchanged as the index's
 * shape, so no consumer's type signature needs to change to read it) while
 * every ordinary numeric comparison against it (`=== 0`, `<= 1`, `> 0`) is
 * `false` by IEEE 754 definition — an unmeasured entry can never be silently
 * read as a genuine empty file by an unaware call site. A schema-validated
 * contract field that can only ever hold a real count (`AuditTask.file_line_counts`,
 * `z.number().int().min(0)`) must never persist this value — see
 * `addFileLineCountHints` below, which is the boundary that degrades it to 0
 * before the value crosses into that schema-constrained artifact.
 */
export const UNMEASURED_LINE_COUNT = Number.NaN;

/**
 * True when `value` denotes "unmeasured" rather than a genuine line count:
 * either the key is entirely ABSENT from the index (`undefined` — e.g. a
 * caller queries a path the index was never built for, or a normalization
 * mismatch against the index's key form) or present but marked
 * {@link UNMEASURED_LINE_COUNT} (a read failure). A real zero-line file reads
 * as `0`, which is neither. Prefer this predicate over a bare `?? 0` fallback
 * so a read failure or a missing key is never silently treated as a genuine
 * empty file — the distinction is a VALUE this module emits, not a habit each
 * call site must remember to reimplement (CP-NODE-6).
 */
export function isUnmeasuredLineCount(value: number | undefined): boolean {
  return value === undefined || Number.isNaN(value);
}

export async function buildLineIndex(
  root: string,
  repoManifest: RepoManifest,
): Promise<Record<string, number>> {
  const entries: Array<readonly [string, number]> = [];
  let failureCount = 0;
  for (let i = 0; i < repoManifest.files.length; i += LINE_COUNT_BATCH_SIZE) {
    const batch = repoManifest.files.slice(i, i + LINE_COUNT_BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (file) => {
        try {
          return [
            file.path,
            await countLines(resolve(root, file.path)),
          ] as const;
        } catch (err) {
          // Distinguish file-not-found from other IO errors so callers are not
          // misled into treating a missing file as an empty one (COR-c868f53d).
          const kind = isFileMissingError(err) ? "file not found" : "IO error";
          process.stderr.write(
            `[lineIndex] ${kind} counting lines for '${file.path}': ${err instanceof Error ? err.message : String(err)}\n`,
          );
          failureCount++;
          // Unmeasured, not a silent 0 (CP-NODE-6) — see UNMEASURED_LINE_COUNT.
          return [file.path, UNMEASURED_LINE_COUNT] as const;
        }
      }),
    );
    entries.push(...results);
  }
  if (failureCount > 0) {
    process.stderr.write(
      `[lineIndex] ${failureCount} of ${repoManifest.files.length} file(s) failed line counting; those entries are marked unmeasured.\n`,
    );
  }
  // Keys are `file.path` VERBATIM (no transform) — the same field
  // `initializeCoverageFromPlan` seeds `coverage.files[].path` from
  // (src/audit/orchestrator/planning.ts), so a lookup against a coverage path
  // always round-trips against this index's keys.
  return Object.fromEntries(entries);
}

export async function buildLineIndexForPaths(
  root: string,
  paths: string[],
): Promise<Record<string, number>> {
  const uniquePaths = [...new Set(paths)].sort(compareCodeUnits);
  const entries: Array<readonly [string, number]> = [];
  let failureCount = 0;
  const batchSize = LINE_COUNT_BATCH_SIZE;
  for (let i = 0; i < uniquePaths.length; i += batchSize) {
    const batch = uniquePaths.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map(async (path) => {
        try {
          return [path, await countLines(resolve(root, path))] as const;
        } catch (err) {
          const kind = isFileMissingError(err) ? "file not found" : "IO error";
          process.stderr.write(
            `[lineIndex] ${kind} counting lines for '${path}': ${err instanceof Error ? err.message : String(err)}\n`,
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
      `[lineIndex] ${failureCount} of ${uniquePaths.length} file(s) failed line counting; those entries are marked unmeasured.\n`,
    );
  }
  // Keys are the input `paths` VERBATIM (no transform) — same round-trip
  // guarantee as buildLineIndex above.
  return Object.fromEntries(entries);
}

export async function addFileLineCountHints(
  root: string,
  tasks: AuditTask[],
): Promise<AuditTask[]> {
  const lineIndex = await buildLineIndexForPaths(
    root,
    tasks.flatMap((task) => task.file_paths),
  );
  return canonicalizeAuditTasks(
    tasks.map((task) => ({
      ...task,
      file_line_counts: Object.fromEntries(
        task.file_paths.map((path) => {
          const measured = lineIndex[path];
          // `file_line_counts` is the schema-constrained contract field
          // (`z.number().int().min(0)` — schemas/audit_result.schema.json,
          // src/audit/types.ts) with no "unmeasured" concept of its own: degrade
          // explicitly to 0 HERE, at the boundary where the value leaves this
          // diagnostic index and enters a persisted, schema-validated artifact,
          // rather than leaking the UNMEASURED_LINE_COUNT sentinel into it.
          return [path, isUnmeasuredLineCount(measured) ? 0 : measured] as const;
        }),
      ),
    })),
  );
}
