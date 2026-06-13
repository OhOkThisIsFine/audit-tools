import { resolve } from "node:path";
import { countLines } from "./args.js";
import type { AuditTask, RepoManifest } from "../types.js";
import { isFileMissingError } from "@audit-tools/shared";

// Line-count helpers extracted from cli.ts. Pure functions over the repo
// manifest / task file paths — used to annotate audit tasks with per-file line
// counts and to build line indexes for prompt rendering.

// How many files to read concurrently when counting lines, bounding open file
// descriptors so a large repo manifest does not exhaust the fd limit.
const LINE_COUNT_BATCH_SIZE = 25;

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
          return [file.path, 0] as const;
        }
      }),
    );
    entries.push(...results);
  }
  if (failureCount > 0) {
    process.stderr.write(
      `[lineIndex] ${failureCount} of ${repoManifest.files.length} file(s) failed line counting; those entries default to 0.\n`,
    );
  }
  return Object.fromEntries(entries);
}

export async function buildLineIndexForPaths(
  root: string,
  paths: string[],
): Promise<Record<string, number>> {
  const uniquePaths = [...new Set(paths)].sort();
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
          return [path, 0] as const;
        }
      }),
    );
    entries.push(...results);
  }
  if (failureCount > 0) {
    process.stderr.write(
      `[lineIndex] ${failureCount} of ${uniquePaths.length} file(s) failed line counting; those entries default to 0.\n`,
    );
  }
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
  return tasks.map((task) => ({
    ...task,
    file_line_counts: Object.fromEntries(
      task.file_paths.map((path) => [path, lineIndex[path] ?? 0]),
    ),
  }));
}
