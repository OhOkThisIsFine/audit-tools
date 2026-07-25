import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Root-containment guard — the single source for "does this path stay inside
 * that root".
 *
 * This check was reimplemented five times (audit dispatch paths, the TypeScript
 * analyzer's include mapping, graph extraction, the openai-compatible provider's
 * apply step, remediate's worktree seeding). Four spelled the same
 * `rel.startsWith("..") || isAbsolute(rel)` pair by hand and the fifth omitted
 * the `isAbsolute` half — which is the case that matters on win32, where
 * `relative()` returns an ABSOLUTE path when the two sides sit on different
 * drives and a `startsWith("..")` test therefore reads "contained". Five copies
 * of a containment check is five chances for one to be subtly wrong, and this is
 * the class where that is a security property, not a style preference.
 *
 * Callers differ only in how they REACT (throw / null / skip) and whether the
 * root itself counts as contained — both are parameters here, not reasons to
 * fork the predicate.
 */

/** Options for {@link resolveWithinRoot}. */
export interface WithinRootOptions {
  /**
   * Whether the root itself (`rel === ""`) counts as contained. Default `true`
   * — a root-relative "" resolves to the root, which is inside it. Pass `false`
   * where the caller wants a FILE strictly under the root (the provider's
   * apply step: writing "the repo" is never a legal model-supplied target).
   */
  allowRoot?: boolean;
}

/**
 * Resolve `candidate` against `root` and return the absolute path only when it
 * stays inside that root; otherwise `null`.
 *
 * The escape test is SEGMENT-accurate (`".."` or a `"../"`-prefixed relative
 * path), not a bare `startsWith("..")`: a real entry named `..cache` sits inside
 * the root and the prefix test wrongly rejected it. Both separators are checked
 * so a win32 `relative()` result (`..\x`) and a posix one (`../x`) are treated
 * identically.
 */
export function resolveWithinRoot(
  root: string,
  candidate: string,
  options: WithinRootOptions = {},
): string | null {
  if (typeof candidate !== "string" || candidate.length === 0) return null;
  const rootPath = resolve(root);
  const absolutePath = resolve(rootPath, candidate);
  const rel = relative(rootPath, absolutePath);
  // An ABSOLUTE `relative()` result means the two paths share no common base at
  // all (different win32 drives / UNC roots) — outside by definition.
  if (isAbsolute(rel)) return null;
  if (rel === "") return options.allowRoot === false ? null : absolutePath;
  if (rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith("../")) return null;
  return absolutePath;
}

/**
 * {@link resolveWithinRoot}, but throws instead of returning `null` — for the
 * call sites where an escaping path is a contract violation rather than an
 * input to filter out.
 */
export function assertWithinRoot(
  root: string,
  candidate: string,
  options: WithinRootOptions = {},
): string {
  const resolved = resolveWithinRoot(root, candidate, options);
  if (resolved === null) {
    throw new Error(`Path '${candidate}' escapes repository root '${resolve(root)}'.`);
  }
  return resolved;
}
