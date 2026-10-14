// sites-pinned: tests/shared/source-path-containment.test.ts, tests/shared/citation-grounding.test.ts, tests/shared/finding-grounding.test.ts
import { realpathSync, statSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { resolveWithinRoot } from "./pathContainment.js";

function isWithin(root: string, path: string): boolean {
  return resolveWithinRoot(root, path) !== null;
}

/**
 * Admit a source file before opening evidence. Preserve native filename spelling
 * and in-root aliases; neither case folding nor POSIX backslash rewriting is safe.
 * Checks the existing topology, including the parent of a final symlink. This is
 * not a defense against a same-user concurrent symlink swap between check/read.
 */
export function resolveContainedSourcePath(
  root: string,
  candidate: string,
): string | undefined {
  // Windows drive/UNC spellings are not relative POSIX source filenames. Other
  // POSIX backslashes remain literal filename characters, never separators.
  if (sep === "/" && (/^[A-Za-z]:/.test(candidate) || candidate.startsWith("\\\\"))) {
    return undefined;
  }
  const lexicalRoot = resolve(root);
  const path = resolve(lexicalRoot, candidate);
  if (!isWithin(lexicalRoot, path)) return undefined;
  try {
    const realRoot = realpathSync(lexicalRoot);
    const realParent = realpathSync(dirname(path));
    if (!isWithin(realRoot, realParent)) return undefined;
    const realPath = realpathSync(path);
    if (!isWithin(realRoot, realPath) || !statSync(realPath).isFile()) return undefined;
    return path;
  } catch {
    return undefined;
  }
}
