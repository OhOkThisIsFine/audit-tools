// Pre-render readiness checks for the end-of-sprint hand-back — ONE definition,
// two consumers: `scripts/render-closeout.mjs` refuses to render while any is
// outstanding, and `.claude/hooks/closeout-challenge-gate.mjs` keeps them as its
// Stop-time backstop.
//
// WHY THE RENDERER GOT THEM TOO. The challenge is a Stop hook, so it can only
// speak AFTER a report exists. The observed loop was therefore: render → gate
// challenges on mechanical evidence → agent fixes it → RE-render. The second
// render is pure waste, and the first report is a document that was wrong when
// it was written. Moving the deterministic half of the evidence in front of the
// render collapses that loop: the agent fixes first and renders once.
//
// WHAT LIVES HERE, AND WHAT DELIBERATELY DOES NOT. Only checks that are pure
// functions of the tree, so the renderer — which has no session registry and no
// dirt baseline — can evaluate them identically to the gate. Uncommitted work
// and unpushed commits stay gate-only ON PURPOSE: distinguishing this session's
// dirt from a concurrent session's needs the baseline captured at SessionStart,
// and refusing to render over a sibling's untracked file would be a false red —
// the corrosive kind, because the fix is to touch work that is not yours.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readSuiteGreenStamp } from './suiteGreenStamp.mjs';
import { worktreeTree } from './worktree-tree.mjs';

/**
 * Deterministic, session-independent reasons a hand-back is not ready.
 *
 * Every check FAILS OPEN: a missing generator, an absent memory store, or a
 * spawn fault yields no finding. A readiness check that cannot see its evidence
 * must not assert a problem — a false red here blocks a correct hand-back.
 *
 * @param {string} root repository root
 * @returns {string[]} human-readable findings; empty means ready
 */
export function closeoutReadinessFindings(root) {
  const findings = [];

  // HANDOFF carries generated views of the nightly queue, the decision ledger
  // and the backlog. A mismatch means the state the next agent reads is stale —
  // and it is deterministic, so there is no reason to discover it after the
  // report has already described that state.
  try {
    const script = join(root, 'scripts', 'shared', 'generate-handoff-roadmap.mjs');
    if (existsSync(script)) {
      const r = spawnSync(process.execPath, [script, '--check'], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 15_000,
        windowsHide: true,
      });
      if (r.status !== 0) {
        findings.push(
          'docs/HANDOFF.md no longer matches its generated sources (nightly queue/decisions and ' +
            'backlog; generate-handoff-roadmap --check failed). Fix: node ' +
            'scripts/shared/generate-handoff-roadmap.mjs',
        );
      }
    }
  } catch {
    /* spawn fault → fail open */
  }

  // The full-suite green must bind to the tree being handed off. This check
  // used to live only in the Stop gate (P48, `15e45d76`), which could speak
  // only AFTER a render existed — the double-generation loop this module's
  // header describes. It is a pure function of the tree, so it belongs here:
  // a stale stamp refuses the FIRST render, and the gate keeps it as backstop.
  try {
    // Evidence-bound: with no worktree tree identity (not a repository, no
    // commits, git fault) neither half can assert anything — fail open, per
    // this module's rule. With an identity, a MISSING stamp is itself the
    // meaningful absence.
    const currentTree = worktreeTree(root);
    if (currentTree) {
      const green = readSuiteGreenStamp(root);
      if (!green?.tree) {
        findings.push(
          'no full-suite green on record for this repo — `npm test` has not passed since the stamp ' +
            'was last cleared. The closeout requires green on the FINAL tree, so run it after your ' +
            'last edit, not before.',
        );
      } else if (green.tree !== currentTree) {
        findings.push(
          `the last full-suite green ran on different content than the tree being handed off ` +
            `(green at ${String(green.tree).slice(0, 8)}, tree ${currentTree.slice(0, 8)}, ` +
            `${green.ran_at ?? 'unknown time'}). An edit after a green run is not evidence for the ` +
            'tree you are pushing — re-run `npm test`.',
        );
      }
    }
  } catch {
    /* stamp or tree unreadable → fail open */
  }

  // A memory file that never reached MEMORY.md is invisible to the next
  // session: the index is what loads, not the directory.
  try {
    const slug = root.replace(/[:\\/]/g, '-');
    const memDir = join(homedir(), '.claude', 'projects', slug, 'memory');
    const index = readFileSync(join(memDir, 'MEMORY.md'), 'utf8');
    const orphans = readdirSync(memDir)
      .filter((n) => n.endsWith('.md') && n !== 'MEMORY.md')
      .filter((n) => !index.includes(n));
    if (orphans.length > 0) {
      findings.push(
        `${orphans.length} memory file(s) are NOT linked from MEMORY.md — the index is what loads ` +
          `next session, so these are invisible:\n` +
          orphans.slice(0, 8).map((n) => `      ${n}`).join('\n'),
      );
    }
  } catch {
    /* memory store absent on this box → fail open */
  }

  return findings;
}
