import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';

// Canonical repo-root discovery for the WRAPPER side of BOTH bins.
//
// Bin-neutral by name and by ownership, like `installer-verb-help.mjs`: audit-code
// and remediate-code answer their installer verbs from this one module, so the two
// wrappers cannot resolve "no --root" differently (one core, two draws — never a
// per-bin fork of the same algorithm).
//
// This is a deliberate, pinned MIRROR of `discoverRepoRoot` / `climbOutOfAuditTools`
// in src/shared/io/repoRoot.ts, kept for the same bootstrap constraint that
// forces `quoteForCmd` to be mirrored here: the wrapper runs BEFORE dist exists
// (the installer verbs `ensure` / `install` / `verify-install` are answered
// entirely in the wrapper and must never trigger a build just to learn where
// they are), so it cannot import the TypeScript source or the built module.
// `tests/shared/wrapper-repo-root-parity.test.ts` runs BOTH implementations over
// the same fixture trees and fails if they ever disagree — the two copies cannot
// drift silently.
//
// Behaviour, stated once here and pinned by that parity test: climb out of any
// `.audit-tools/` the start dir sits inside, then walk up to the nearest
// ancestor carrying `.audit-tools` or `.git` (either may be a file — a linked
// worktree's `.git` is one), stopping BELOW the home directory because
// `~/.audit-tools/` is the tool's machine-wide cache home and would otherwise
// match on every box. No marker → the start dir unchanged.

export const AUDIT_TOOLS_DIRNAME = '.audit-tools';

export const REPO_ROOT_MARKERS = [AUDIT_TOOLS_DIRNAME, '.git'];

/** @param {string} p */
export function climbOutOfAuditTools(p) {
  const resolved = resolve(p);
  const segments = resolved.split(sep);
  const idx = segments.indexOf(AUDIT_TOOLS_DIRNAME);
  if (idx <= 0) return resolved;
  return segments.slice(0, idx).join(sep) || resolved;
}

/** @returns {string | null} */
function repoRootCeiling() {
  try {
    const home = homedir();
    return home ? resolve(home) : null;
  } catch {
    return null;
  }
}

/** @param {string} [startDir] @returns {string} */
export function discoverRepoRoot(startDir = process.cwd()) {
  const start = climbOutOfAuditTools(resolve(startDir));
  const ceiling = repoRootCeiling();
  let current = start;
  for (;;) {
    if (ceiling !== null && current === ceiling) return start;
    if (REPO_ROOT_MARKERS.some((marker) => existsSync(join(current, marker)))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) return start;
    current = parent;
  }
}

/**
 * The root a wrapper-side command acts on: an explicitly supplied `--root` is
 * honored verbatim (resolved against the caller's cwd), an absent one is
 * discovered. The ONE place either wrapper turns "no --root" into a directory,
 * so `next-step`, `ensure`, `install` and `verify-install` cannot answer it
 * differently — across both bins.
 *
 * @param {string | undefined} rawRoot
 * @returns {string}
 */
export function resolveWrapperRoot(rawRoot) {
  return rawRoot === undefined ? discoverRepoRoot() : resolve(rawRoot);
}
