import { isAbsolute, join, relative, resolve } from "node:path";
import { readJsonFile, isFileMissingError } from "audit-tools/shared";
import type { DispatchResultMap, DispatchResultMapEntry } from "./types.js";
import { DISPATCH_RESULT_MAP_FILENAME } from "./types.js";
import { getFlag, fromBase64Url } from "../args.js";

// Path utilities for the dispatch pipeline: path containment guard,
// result-map path helpers, result-map I/O, and small arg/entry utilities.

export function withinRoot(root: string, path: string): string {
  const rootPath = resolve(root);
  const absolutePath = resolve(rootPath, path);
  const relativePath = relative(rootPath, absolutePath);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`Path '${path}' escapes repository root '${rootPath}'.`);
  }
  return absolutePath;
}

export function dispatchResultMapPath(runDir: string): string {
  return join(runDir, DISPATCH_RESULT_MAP_FILENAME);
}

export async function loadDispatchResultMap(
  runDir: string,
): Promise<DispatchResultMap | null> {
  try {
    return await readJsonFile<DispatchResultMap>(dispatchResultMapPath(runDir));
  } catch (error) {
    if (!isFileMissingError(error)) {
      throw error;
    }
    return null;
  }
}

export function entriesByTaskId(
  entries: DispatchResultMapEntry[],
): Map<string, DispatchResultMapEntry> {
  return new Map(entries.map((entry) => [entry.task_id, entry]));
}

export function resolveRunScopedArg(
  argv: string[],
  rawFlag: string,
  b64Flag: string,
): string | undefined {
  const raw = getFlag(argv, rawFlag);
  const encoded = getFlag(argv, b64Flag);
  return raw ?? (encoded ? fromBase64Url(encoded) : undefined);
}
