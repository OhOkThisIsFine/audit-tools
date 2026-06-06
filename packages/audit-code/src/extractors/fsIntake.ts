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

interface WalkContext {
  root: string;
  ignores: string[];
  hashFiles: boolean;
  maxFileSizeBytes: number;
}

async function walk(
  ctx: WalkContext,
  current: string,
  results: Array<{ path: string; size_bytes: number; hash?: string }>,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch (err) {
    console.warn(
      `[fsIntake] skipping unreadable directory: ${current} (${(err as Error).message})`,
    );
    return;
  }

  for (const entry of entries) {
    const absolutePath = join(current, entry.name);
    const relativePath = normalizePath(relative(ctx.root, absolutePath));
    if (!relativePath || shouldIgnore(relativePath, ctx.ignores)) {
      continue;
    }

    if (entry.isDirectory()) {
      await walk(ctx, absolutePath, results);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    let info;
    try {
      info = await stat(absolutePath);
    } catch (err) {
      console.warn(
        `[fsIntake] skipping unreadable file: ${relativePath} (${(err as Error).message})`,
      );
      continue;
    }

    let hash: string | undefined;
    if (info.size <= ctx.maxFileSizeBytes) {
      hash = await maybeHashFile(absolutePath, ctx.hashFiles);
    } else {
      console.warn(
        `[fsIntake] skipping oversized file: ${relativePath} (${info.size} bytes > ${ctx.maxFileSizeBytes} limit)`,
      );
    }
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

  const ctx: WalkContext = {
    root,
    ignores: ignore,
    hashFiles: options.hash_files ?? false,
    maxFileSizeBytes: options.max_file_size_bytes ?? 1024 * 1024,
  };
  await walk(ctx, root, files);
  return buildRepoManifest(root.split(/[\\/]/).pop() ?? "repo", files);
}
