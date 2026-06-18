import { WorkspacePattern, addWorkspacePattern } from "./workspace.js";
import { yamlRootObject, yamlStringArray } from "./yaml.js";

/**
 * pnpm workspace globs from `pnpm-workspace.yaml`'s top-level `packages:` list.
 * Parsed with a vetted YAML parser (`yaml`) so both the block-sequence and
 * inline-flow (`packages: [a, b]`) forms — and any quoting/anchoring — resolve
 * to the same `packages` string array, instead of the prior line scanner that
 * handled only the two it special-cased. Malformed YAML degrades to `[]`.
 */
export function pnpmWorkspacePatterns(content: string): WorkspacePattern[] {
  const root = yamlRootObject(content);
  const patterns: WorkspacePattern[] = [];
  for (const pattern of yamlStringArray(root?.packages)) {
    addWorkspacePattern(patterns, pattern);
  }
  return patterns;
}
