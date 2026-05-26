import { readdir, readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, relative, resolve } from "node:path";
import type { RepoManifest } from "../types.js";
import { buildRepoManifest } from "./fileInventory.js";

export interface IntakeOptions {
  root: string;
  ignore?: string[];
  hash_files?: boolean;
  max_file_size_bytes?: number;
}

const DEFAULT_IGNORES = [
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".artifacts",
  ".audit-artifacts",
  ".audit-code/install",
  ".agent",
  ".claude",
  "coverage",
];

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/");
}

function shouldIgnore(relativePath: string, ignores: string[]): boolean {
  const normalized = normalizePath(relativePath);
  return ignores.some((ignore) => {
    const value = normalizePath(ignore);
    return (
      normalized === value ||
      normalized.startsWith(`${value}/`) ||
      normalized.includes(`/${value}/`) ||
      normalized.endsWith(`/${value}`)
    );
  });
}

async function maybeHashFile(
  path: string,
  enabled: boolean,
): Promise<string | undefined> {
  if (!enabled) return undefined;
  const content = await readFile(path);
  return createHash("sha256").update(content).digest("hex");
}

async function walk(
  root: string,
  current: string,
  ignores: string[],
  hashFiles: boolean,
  maxFileSizeBytes: number,
  results: Array<{ path: string; size_bytes: number; hash?: string }>,
): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true });

  for (const entry of entries) {
    const absolutePath = join(current, entry.name);
    const relativePath = normalizePath(relative(root, absolutePath));
    if (!relativePath || shouldIgnore(relativePath, ignores)) {
      continue;
    }

    if (entry.isDirectory()) {
      await walk(
        root,
        absolutePath,
        ignores,
        hashFiles,
        maxFileSizeBytes,
        results,
      );
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const info = await stat(absolutePath);
    const hash =
      info.size <= maxFileSizeBytes
        ? await maybeHashFile(absolutePath, hashFiles)
        : undefined;
    results.push({
      path: relativePath,
      size_bytes: info.size,
      hash,
    });
  }
}

export async function buildRepoManifestFromFs(
  options: IntakeOptions,
): Promise<RepoManifest> {
  const root = resolve(options.root);
  const ignore = [...DEFAULT_IGNORES, ...(options.ignore ?? [])];
  const files: Array<{ path: string; size_bytes: number; hash?: string }> = [];

  await walk(
    root,
    root,
    ignore,
    options.hash_files ?? false,
    options.max_file_size_bytes ?? 1024 * 1024,
    files,
  );
  return buildRepoManifest(root.split(/[\\/]/).pop() ?? "repo", files);
}
