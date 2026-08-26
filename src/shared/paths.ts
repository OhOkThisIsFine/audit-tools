/**
 * Repo-path normalization — the two behaviours every extractor, planner, and
 * gate had re-rolled (12 copies at consolidation time, two of them under names
 * that disagreed with their bodies).
 *
 * `toPosixPath` is the render half: backslashes to forward slashes, nothing
 * else. `normalizeRepoRelPath` is the token half: posix plus one stripped
 * leading "./" — the form repo-relative path TOKENS are compared in
 * (loop-core patterns, constitutional doc paths, risk-scope matching).
 *
 * Deliberately NOT here: `normalizeRepoPath` (findingGrounding.ts) — it
 * case-FOLDS for membership matching (INV-B3-1) and is wrong for any path that
 * is persisted and later re-read on a case-sensitive filesystem.
 */

/** Backslashes to forward slashes — the posix render of a path. */
export function toPosixPath(path: string): string {
  return path.replace(/\\/g, "/");
}

/** Posix form with one leading "./" stripped — the repo-relative token form. */
export function normalizeRepoRelPath(path: string): string {
  return toPosixPath(path).replace(/^\.\//, "");
}
