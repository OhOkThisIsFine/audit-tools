import { resolve } from "node:path";
import { countLines } from "./args.js";
import type { AuditTask, RepoManifest } from "../types.js";

// Line-count helpers extracted from cli.ts. Pure functions over the repo
// manifest / task file paths — used to annotate audit tasks with per-file line
// counts and to build line indexes for prompt rendering.

export async function buildLineIndex(
  root: string,
  repoManifest: RepoManifest,
): Promise<Record<string, number>> {
  const entries: Array<readonly [string, number]> = [];
  const batchSize = 25;
  for (let i = 0; i < repoManifest.files.length; i += batchSize) {
    const batch = repoManifest.files.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map(async (file) => {
        try {
          return [
            file.path,
            await countLines(resolve(root, file.path)),
          ] as const;
        } catch {
          return [file.path, 0] as const;
        }
      }),
    );
    entries.push(...results);
  }
  return Object.fromEntries(entries);
}

export async function buildLineIndexForPaths(
  root: string,
  paths: string[],
): Promise<Record<string, number>> {
  const uniquePaths = [...new Set(paths)].sort();
  const entries = await Promise.all(
    uniquePaths.map(async (path) => {
      try {
        return [path, await countLines(resolve(root, path))] as const;
      } catch {
        return [path, 0] as const;
      }
    }),
  );
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
