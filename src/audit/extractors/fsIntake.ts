// sites-pinned: tests/audit/frozen-snapshot.test.ts, tests/audit/run-snapshot.test.ts
import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { hashContent, hashContentStream, toPosixPath } from "audit-tools/shared";
import { join, relative, resolve } from "node:path";
import type { RepoManifest } from "../types.js";
import { buildRepoManifest, type InventoryInputFile } from "./fileInventory.js";
import { hashTextIdentity } from "../../shared/hash.js";
import { isBinaryArtifact, normalizeExtractorPath } from "./pathPatterns.js";

export interface IntakeOptions {
  root: string;
  /**
   * The manifest's name. A run reads a frozen snapshot whose directory name is
   * not the repository's, so the caller names the manifest after the LIVE root;
   * defaults to the basename of `root`.
   */
  name?: string;
  ignore?: string[];
  hash_files?: boolean;
  /** Maximum buffered hashing size; larger files are stream-hashed. */
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
  ".audit-tools",
  ".audit-code/install",
  ".agent",
  ".claude",
  "coverage",
];

/**
 * True when intake skips `relativePath` — its default set plus `extra` (the
 * repository's `.auditorignore` rules). The one rule a frozen copy of a non-git
 * root (`runSnapshot.ts`) uses to decide what it links instead of copying, so
 * the copy and the walk can never disagree about what intake reads.
 */
export function isIntakeIgnored(relativePath: string, extra: readonly string[] = []): boolean {
  return shouldIgnore(relativePath, posixIgnores(extra));
}

/** The default ignores plus `extra`, each in posix form (the form `shouldIgnore` reads). */
function posixIgnores(extra: readonly string[]): string[] {
  return [...DEFAULT_IGNORES, ...extra].map(toPosixPath);
}

/** `ignores` must be in posix form already (see {@link posixIgnores}). */
function shouldIgnore(relativePath: string, ignores: string[]): boolean {
  const normalized = toPosixPath(relativePath);
  return ignores.some((value) => {
    return (
      normalized === value ||
      normalized.startsWith(`${value}/`) ||
      normalized.includes(`/${value}/`) ||
      normalized.endsWith(`/${value}`)
    );
  });
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
  results: InventoryInputFile[],
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
    const relativePath = toPosixPath(relative(ctx.root, absolutePath));
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

    // sites-pinned: tests/audit/fs-intake.test.ts
    let fingerprints: Pick<InventoryInputFile, "hash" | "normalized_hash"> = {};
    if (ctx.hashFiles) {
      const source = info.size <= ctx.maxFileSizeBytes
        ? await readFile(absolutePath) : createReadStream(absolutePath);
      const binary = isBinaryArtifact(normalizeExtractorPath(relativePath));
      fingerprints = binary
        ? { hash: Buffer.isBuffer(source) ? hashContent(source) : await hashContentStream(source) }
        : await hashTextIdentity(source);
    }
    results.push({ path: relativePath, size_bytes: info.size, ...fingerprints });
  }
}

export async function buildRepoManifestFromFs(
  options: IntakeOptions,
): Promise<RepoManifest> {
  const root = resolve(options.root);
  const files: InventoryInputFile[] = [];

  const ctx: WalkContext = {
    root,
    ignores: posixIgnores(options.ignore ?? []),
    hashFiles: options.hash_files ?? false,
    maxFileSizeBytes: options.max_file_size_bytes ?? 1024 * 1024,
  };
  await walk(ctx, root, files);
  return buildRepoManifest(options.name ?? root.split(/[\\/]/).pop() ?? "repo", files);
}
