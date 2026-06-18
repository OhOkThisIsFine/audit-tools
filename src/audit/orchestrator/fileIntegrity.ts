import { hashContent } from "audit-tools/shared";
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
  const changed: string[] = [];
  const missing: string[] = [];
  const ioErrors: string[] = [];

  const scopeSet = scope ? new Set(scope) : null;
  const files = scopeSet
    ? manifest.files.filter((f) => scopeSet.has(f.path))
    : manifest.files;

  for (const record of files) {
    if (!record.hash) continue;
    const absolute = isAbsolute(record.path)
      ? record.path
      : join(root, record.path);
    if (!existsSync(absolute)) {
      missing.push(record.path);
      continue;
    }
    try {
      const currentHash = await hashFile(absolute);
      if (currentHash !== record.hash) {
        changed.push(record.path);
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        missing.push(record.path);
      } else {
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
        ioErrors.push(record.path);
      }
    }
  }

  return {
    changed_files: changed,
    missing_files: missing,
    io_errors: ioErrors,
    is_clean:
      changed.length === 0 && missing.length === 0 && ioErrors.length === 0,
  };
}
