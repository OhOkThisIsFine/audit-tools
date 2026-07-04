import type { RepoManifest } from "../types.js";
import { normalizeExtractorPath } from "./pathPatterns.js";
import { LANGUAGE_BY_EXTENSION } from "./languageMap.generated.js";

export interface InventoryInputFile {
  path: string;
  size_bytes: number;
  hash?: string;
}

// The generated linguist map resolves a few common extensions to obscure
// languages that outrank the everyday one (".md" -> GCC machine description,
// ".yml"/".yaml" -> MiniYAML). These overrides win over the generated map so the
// file inventory does not mislabel ordinary docs/config. Keep this list small
// and limited to extensions whose generated mapping is demonstrably wrong.
const EXTENSION_LANGUAGE_OVERRIDES: Record<string, string> = {
  md: "markdown",
  markdown: "markdown",
  yaml: "yaml",
  yml: "yaml",
};

function inferLanguage(path: string): string {
  const normalized = normalizeExtractorPath(path);
  const base = normalized.split("/").pop() ?? normalized;
  const extension = (
    base.includes(".") ? base.split(".").pop() ?? "" : ""
  ).toLowerCase();
  return (
    EXTENSION_LANGUAGE_OVERRIDES[extension] ??
    LANGUAGE_BY_EXTENSION[extension] ??
    "unknown"
  );
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
    // Emit files in a deterministic path-sorted order. The intake walk pushes in
    // raw readdir (filesystem) order, which varies across OS and on unrelated
    // file adds/renames; preserving it churns repo_manifest's content_hash on
    // every re-extraction and cascades phantom staleness down the whole DAG
    // (repo_manifest → unit_manifest → risk_register → design_assessment →
    // design review), forcing redundant LLM re-review. Path is the unique key,
    // so sorting is semantically neutral and makes re-extraction byte-identical
    // when nothing changed.
    files: files
      .map((file) => ({
        path: file.path,
        language: inferLanguage(file.path),
        size_bytes: file.size_bytes,
        hash: file.hash,
      }))
      .sort((a, b) => a.path.localeCompare(b.path)),
  };
}
