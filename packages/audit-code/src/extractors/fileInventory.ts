import type { RepoManifest } from "../types.js";
import { normalizeExtractorPath } from "./pathPatterns.js";
import { LANGUAGE_BY_EXTENSION } from "./languageMap.generated.js";

export interface InventoryInputFile {
  path: string;
  size_bytes: number;
  hash?: string;
}

function inferLanguage(path: string): string {
  const normalized = normalizeExtractorPath(path);
  const base = normalized.split("/").pop() ?? normalized;
  const extension = base.includes(".") ? base.split(".").pop() ?? "" : "";
  return LANGUAGE_BY_EXTENSION[extension] ?? "unknown";
}

export function buildRepoManifest(
  repositoryName: string,
  files: InventoryInputFile[],
): RepoManifest {
  return {
    repository: {
      name: repositoryName,
    },
    generated_at: new Date().toISOString(),
    files: files.map((file) => ({
      path: file.path,
      language: inferLanguage(file.path),
      size_bytes: file.size_bytes,
      hash: file.hash,
    })),
  };
}
