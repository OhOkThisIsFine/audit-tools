import { hashContent, checkFileIntegrityRecords } from "audit-tools/shared";
import { readFile } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { existsSync } from "node:fs";
import type { RepoManifest } from "../types.js";

export interface FileIntegrityResult {
  changed_files: string[];
  missing_files: string[];
  io_errors: string[];
  is_clean: boolean;
}

async function hashFile(absolutePath: string): Promise<string> {
  const content = await readFile(absolutePath);
  return hashContent(content);
}

export async function checkFileIntegrity(
  root: string,
  manifest: RepoManifest,
  scope?: string[],
): Promise<FileIntegrityResult> {
  const scopeSet = scope ? new Set(scope) : null;
  const files = scopeSet
    ? manifest.files.filter((f) => scopeSet.has(f.path))
    : manifest.files;

  const buckets = await checkFileIntegrityRecords({
    records: files,
    getPath: (record) => record.path,
    getExpectedHash: (record) => record.hash,
    resolveAbsolute: (path) => (isAbsolute(path) ? path : join(root, path)),
    exists: existsSync,
    hash: async (absolute, record) => {
      try {
        return { kind: "ok", hash: await hashFile(absolute) };
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return { kind: "missing" };
        process.stderr.write(
          JSON.stringify({
            kind: "file_integrity_io_error",
            root,
            scope_size: files.length,
            file: record.path,
            code: code ?? String(err),
            ts: new Date().toISOString(),
          }) + "\n",
        );
        return { kind: "io_error" };
      }
    },
  });

  return {
    changed_files: buckets.changed,
    missing_files: buckets.missing,
    io_errors: buckets.ioErrors,
    is_clean: buckets.isClean,
  };
}
