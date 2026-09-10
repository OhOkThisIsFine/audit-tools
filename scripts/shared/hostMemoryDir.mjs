// The host's per-project memory directory — ONE derivation, pre-build.
//
// WHY THIS EXISTS (backlog 2026-08-27, "Three governance vocabularies are copied
// per consumer"). The rule was derived THREE times with DIFFERENT spellings:
//
//   scripts/check-memory-citations.mjs     replace(/[^a-zA-Z0-9]/g, '-')
//   scripts/shared/closeoutReadiness.mjs   replace(/[:\\/]/g, '-')
//   .claude/hooks/closeout-challenge-gate  (via closeoutReadiness)
//
// They agree on this repository's path — `C:\Code\audit-tools` carries only a
// colon and backslashes — and diverge on any path carrying other punctuation
// (a `.`, a space, a `+`). The failure mode is not an error: the derived
// directory simply does not exist, so the check SKIPS, and the one guard that
// stops an unindexed memory file reads as a pass. A silently empty directory is
// the worst possible symptom for a citation gate.
//
// The rule is the HOST's, not ours: it is the path Claude Code keys its
// per-project store on. Deriving it here — once — means the three consumers
// cannot disagree, and a future path with punctuation resolves the same way in
// all of them.
//
// PRE-BUILD by necessity: the closeout renderer chain and the Stop-gate hooks run
// under plain node in checkouts that may never have been built, so this module
// must import nothing from `audit-tools/shared` (which resolves `dist/`).
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";

/**
 * The slug the host derives for a project root: every character that is not
 * ASCII alphanumeric becomes `-`. Case is PRESERVED (`C--Code-audit-tools`
 * versus `c--code-audit-tools` are different stores on a case-sensitive host).
 *
 * @param {string} projectRoot absolute path to the project root
 * @returns {string}
 */
export function projectSlug(projectRoot) {
  return resolve(projectRoot).replace(/[^a-zA-Z0-9]/g, "-");
}

/**
 * The main checkout's root — the identity EVERY worktree of a repository shares.
 *
 * WHY REPOSITORY IDENTITY, NOT cwd. One store serves a repository, but a
 * cwd-derived slug names a different one in every linked worktree, and every lap
 * runs in a worktree. A cwd-derived caller then found no store, skipped, and
 * exited 0 — so the guard was green-by-absence for exactly the sessions that
 * edit memories (2026-08-29). The common git dir is shared by every worktree of
 * a repository, which is the identity the store already keys on.
 *
 * Falls back to cwd when git cannot answer: that is "cannot tell", and a store
 * then simply goes unfound rather than being asserted against wrongly.
 *
 * @param {string} [cwd]
 * @returns {string}
 */
export function repositoryRoot(cwd = process.cwd()) {
  try {
    const commonDir = execFileSync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { encoding: "utf8", cwd, windowsHide: true },
    ).trim();
    // `<main>/.git` in an ordinary checkout and in every linked worktree alike.
    return basename(commonDir) === ".git" ? dirname(commonDir) : cwd;
  } catch {
    return cwd;
  }
}

/**
 * The user's `~/.claude/projects` directory.
 * @returns {string}
 */
export function hostProjectsDir() {
  return join(homedir(), ".claude", "projects");
}

/**
 * The memory directory for a project root.
 *
 * $AUDIT_TOOLS_MEMORY_DIR overrides outright — the citation gate's form-fixture
 * drive points it at an empty directory so every cited name is dangling by
 * construction.
 *
 * @param {{projectRoot?: string, env?: Record<string, string|undefined>}} [options]
 * @returns {string}
 */
export function hostMemoryDir({ projectRoot = repositoryRoot(), env = process.env } = {}) {
  return env["AUDIT_TOOLS_MEMORY_DIR"] ?? join(hostProjectsDir(), projectSlug(projectRoot), "memory");
}
