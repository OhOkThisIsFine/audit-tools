// Evidence that the FULL suite went green on a specific worktree CONTENT.
//
// The trap this closes: a suite run BEFORE the last edit is not evidence for
// the tree you push — an edit of ANY kind after a green run invalidates that
// run, and no local gate re-runs the full suite, so a late edit reached CI
// unseen (two commits shipped red on 2026-08-27 this exact way). The HANDOFF
// half is enforced by the pre-commit doc leg (053c4a28's test move); this stamp
// enforces the general half as closeout-challenge evidence. Discipline is what
// this repo bans wherever a property can be guaranteed mechanically.
//
// The identity is the same tree object the closeout record already binds to
// (scripts/shared/worktree-tree.mjs), for the same reason: committing exactly
// what the green run covered keeps the stamp valid, while any further edit
// correctly invalidates it. The stamp lands under .claude/hooks/.state/, which is
// gitignored, so writing it cannot change the tree it just described.
//
// A FILTERED run is not full-suite evidence. `npm test` and `verify:release`
// invoke the gate with no argv; every narrower caller (test:doc-contract passes
// file paths, verify:guards passes --retry/--exclude) passes at least one. So an
// empty argv IS the predicate — no allowlist to maintain, and a new filtered
// caller cannot accidentally mint full-suite evidence. The CI shard runs
// (`--shard=N/4`) are whole-suite runs that carry an argument, so they do NOT
// mint a stamp — by design: CI pipelines never reach the Stop-gate closeout
// this evidence feeds, and a shard alone is not whole-tree evidence anyway.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Is this gate invocation a full-suite run, i.e. one whose green result is
 * evidence about the whole tree rather than about a subset?
 * @param {string[]} vitestArgs argv handed to scripts/shared/run-vitest-gate.mjs
 * @returns {boolean}
 */
export function isFullSuiteRun(vitestArgs) {
  return Array.isArray(vitestArgs) && vitestArgs.length === 0;
}

/**
 * ⚠ This stays keyed on the CHECKOUT, and that is deliberate — do not "fix" it to
 * match the session registry beside it. The registry keys on the REPOSITORY (its
 * common git dir) because a session is a fact about the repository, and keying it
 * on the checkout made its arming a property of how a worktree was created. This
 * stamp is the opposite case: it binds a TREE, and two worktrees of one repository
 * have different trees, so a repository-wide stamp would certify one worktree's
 * green as evidence for another's content. Two identities, two reasons.
 * @param {string} root
 * @returns {string}
 */
export function suiteGreenStampPath(root) {
  return join(root, '.claude', 'hooks', '.state', 'suite-green', 'latest.json');
}

/**
 * Record a full-suite green against the tree it ran on. Best-effort: a stamp that
 * cannot be written must never fail a green suite, and a MISSING stamp already
 * reads as "no evidence" downstream, which is the safe direction.
 * @param {string} root
 * @param {string | null} tree tree id, or null when it could not be taken
 * @returns {boolean} whether a stamp was written
 */
export function writeSuiteGreenStamp(root, tree) {
  if (!tree) return false;
  const path = suiteGreenStampPath(root);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      `${JSON.stringify(
        {
          tree,
          ran_at: new Date().toISOString(),
          session_id: process.env.CLAUDE_SESSION_ID ?? null,
        },
        null,
        2,
      )}\n`,
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} root
 * @returns {{ tree?: string, ran_at?: string } | null} null when absent/unreadable
 */
export function readSuiteGreenStamp(root) {
  try {
    return JSON.parse(readFileSync(suiteGreenStampPath(root), 'utf8'));
  } catch {
    return null;
  }
}
