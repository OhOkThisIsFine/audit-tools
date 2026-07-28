// Re-base relative markdown links when text is LIFTED from one directory to another.
//
// WHY THIS EXISTS. Both generators (`generate-handoff-roadmap.mjs`,
// `generate-backlog-index.mjs`) copy a backlog entry's bold title VERBATIM out of
// `docs/backlog/*.md` and into `docs/HANDOFF.md` / `docs/backlog.md` — one
// directory up. A link written correctly at the source (`../../spec/x.md`) is
// dead at the destination, where `../spec/x.md` was meant.
//
// This is not a typo class a reviewer can be asked to catch: the source is right,
// the destination is generated, and "fixing" the generated file is overwritten by
// the next regeneration. The lift itself has to carry the rewrite.
//
// Verbatim-title copying is the whole point of both generators (one home for the
// text), so the fix belongs here — in the lift — and is shared so the two cannot
// drift apart.

import { dirname, resolve, relative, posix } from "node:path";

/** Targets that are not repo-relative paths and must be passed through untouched. */
function isNotRelativePath(target) {
  return (
    /^[a-z][a-z0-9+.-]*:/i.test(target) || // http:, https:, mailto:, …
    target.startsWith("//") ||
    target.startsWith("#") ||
    target.startsWith("/")
  );
}

function rebaseTarget(target, fromDirAbs, toDirAbs) {
  if (isNotRelativePath(target)) return target;

  const hash = target.indexOf("#");
  const pathPart = hash >= 0 ? target.slice(0, hash) : target;
  const fragment = hash >= 0 ? target.slice(hash) : "";
  if (!pathPart) return target;

  const absolute = resolve(fromDirAbs, pathPart);
  let rebased = relative(toDirAbs, absolute).split(/[\\/]/).join(posix.sep);
  if (!rebased) return target;
  // Keep it explicitly relative — a bare `spec/x.md` is ambiguous to some readers
  // and a leading `./` is how the rest of the docs write a sibling path.
  if (!rebased.startsWith(".")) rebased = `./${rebased}`;
  // Preserve a trailing slash (directory links) that `relative` drops.
  if (pathPart.endsWith("/") && !rebased.endsWith("/")) rebased += "/";
  return rebased + fragment;
}

/**
 * Rewrite every relative link target in `markdown` so that text authored in
 * `fromFile`'s directory resolves identically from `toFile`'s directory.
 *
 * Handles inline `[text](target)` and reference definitions `[label]: target`.
 * Anything non-relative (http/mailto/anchor/root-absolute) is left alone.
 */
export function rebaseRelativeLinks(markdown, fromFile, toFile) {
  const fromDirAbs = dirname(resolve(fromFile));
  const toDirAbs = dirname(resolve(toFile));
  if (fromDirAbs === toDirAbs) return markdown;

  return markdown
    .replace(
      /(\[[^\]]*\]\(\s*<?)([^)<>\s]+)(>?(?:\s+"[^"]*")?\s*\))/g,
      (_all, open, target, close) => `${open}${rebaseTarget(target, fromDirAbs, toDirAbs)}${close}`,
    )
    .replace(
      /^([ \t]{0,3}\[[^\]]+\]:[ \t]+<?)([^\s<>]+)/gm,
      (_all, open, target) => `${open}${rebaseTarget(target, fromDirAbs, toDirAbs)}`,
    );
}
