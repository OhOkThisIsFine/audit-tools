import { WorkspacePattern, addWorkspacePattern } from "./workspace.js";
import { stripYamlComment, unquoteYamlScalar, splitYamlInlineList } from "./yaml.js";

export function pnpmWorkspacePatterns(content: string): WorkspacePattern[] {
  const patterns: WorkspacePattern[] = [];
  const lines = content.split(/\r?\n/);
  let inPackagesList = false;
  let packagesIndent = 0;

  for (const line of lines) {
    const withoutComment = stripYamlComment(line);
    if (withoutComment.trim().length === 0) {
      continue;
    }

    const indent = withoutComment.match(/^\s*/)?.[0].length ?? 0;
    const trimmed = withoutComment.trim();
    if (inPackagesList) {
      if (indent <= packagesIndent) {
        inPackagesList = false;
      } else {
        const itemMatch = /^-\s+(.+)$/.exec(trimmed);
        if (itemMatch?.[1]) {
          addWorkspacePattern(patterns, unquoteYamlScalar(itemMatch[1]));
        }
        continue;
      }
    }

    const packagesMatch = /^packages\s*:\s*(.*)$/.exec(trimmed);
    if (!packagesMatch || indent !== 0) {
      continue;
    }

    const inlineValue = packagesMatch[1]?.trim() ?? "";
    if (inlineValue.length === 0) {
      inPackagesList = true;
      packagesIndent = indent;
      continue;
    }

    for (const pattern of splitYamlInlineList(inlineValue)) {
      addWorkspacePattern(patterns, pattern);
    }
  }

  return patterns;
}
