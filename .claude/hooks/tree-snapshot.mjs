// The git/tree-snapshot substrate the two commit hooks share (P53).
//
// The staged-snapshot round-trip REWRITES the working tree and, at restore, the
// real index, so it needs a crash journal and a lock — and the journal must be
// HEALED promptly by whichever hook runs next. The git-boundary commit gate
// (commit-gate.mjs) owns the round-trip; the tool-boundary hook
// (pre-commit-gate.mjs) fires on every Bash/PowerShell call and is therefore
// the prompt healer. One implementation, bound to a `root`, serves both:
// two copies of tree surgery is two chances to restore the wrong tree.
import { spawnSync } from 'node:child_process';
import { rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, statSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

/**
 * @param {string} root the repository worktree the tools operate on
 * @param {{ label: string }} opts `label` prefixes the recovery announcements
 */
export function treeSnapshotTools(root, { label }) {
  // ── git helper: run a git subcommand, capturing status/stdout/stderr. ────────
  // Never throws — callers branch on `.ok`. Used for the snapshot orchestration so
  // a git fault degrades to a decision, not an unhandled exception.
  function git(args) {
    const r = spawnSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    return {
      ok: r.status === 0,
      status: r.status,
      stdout: r.stdout ?? '', // raw — callers that need porcelain columns must not lose leading spaces
      stderr: (r.stderr ?? '').trim(),
      spawnError: r.error,
    };
  }
  // Run a git subcommand with a SCRATCH index (GIT_INDEX_FILE) so it never touches
  // the real staged state. Same shape as git(); used to build/apply worktree trees.
  function gitWithIndex(indexFile, args) {
    const r = spawnSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_INDEX_FILE: indexFile },
      windowsHide: true,
    });
    return { ok: r.status === 0, status: r.status, stdout: r.stdout ?? '', stderr: (r.stderr ?? '').trim() };
  }

  // Snapshot the ENTIRE working tree (all tracked + untracked files, honoring
  // .gitignore) as a git tree object, without disturbing the real index. Returns
  // the tree SHA or null on any git fault.
  function captureWorktreeTree(scratchIndex) {
    if (!gitWithIndex(scratchIndex, ['read-tree', 'HEAD']).ok) return null;
    if (!gitWithIndex(scratchIndex, ['add', '-A']).ok) return null;
    const wt = gitWithIndex(scratchIndex, ['write-tree']);
    if (!wt.ok) return null;
    return wt.stdout.trim();
  }

  // List the paths contained in a tree object (recursive). Null on fault.
  function listTreePaths(tree) {
    const r = git(['ls-tree', '-r', '-z', '--name-only', tree]);
    if (!r.ok) return null;
    return r.stdout.split('\0').filter(Boolean);
  }

  // Check out `tree` into the working tree EXACTLY: write every file the tree
  // contains, then delete any currently-present file that the tree does NOT
  // contain (so a staged deletion / untracked file is honored). `presentPaths` is
  // the union of the two trees involved in the round-trip — the candidate set to
  // prune. Uses a scratch index so the real index is untouched. True on success.
  function checkoutTreeExact(scratchIndex, tree, presentPaths) {
    if (!gitWithIndex(scratchIndex, ['read-tree', tree]).ok) return false;
    if (!gitWithIndex(scratchIndex, ['checkout-index', '-f', '-a']).ok) return false;
    const wanted = new Set(listTreePaths(tree) ?? []);
    for (const p of presentPaths) {
      if (!wanted.has(p)) {
        // Delete files the target tree does not include (best-effort; a leftover
        // file is a soft fault, never a wedge).
        try {
          rmSync(join(root, p), { force: true });
        } catch {
          /* ignore */
        }
      }
    }
    return true;
  }
  // ── Round-trip crash safety ──────────────────────────────────────────────────
  // The staged-snapshot round-trip REWRITES the working tree and, at restore, the
  // real index. A hook process killed mid-round-trip (harness timeout, parallel
  // tool-call interleave) used to leave that clobbered state behind with nothing
  // to heal it — observed live 2026-07-23 (the real index silently absorbed the
  // whole worktree). Mechanism: the two tree SHAs are JOURNALED before any
  // worktree mutation; every gate invocation (any Bash/PowerShell call) heals a
  // journal left behind by a crashed instance, and a mkdir-based LOCK serializes
  // concurrent round-trips (a second instance fails open rather than interleaving
  // tree surgery).
  const STATE_DIR = join(root, '.claude', 'hooks', '.state');
  const RT_JOURNAL = join(STATE_DIR, 'gate-roundtrip-journal.json');
  const RT_LOCK = join(STATE_DIR, 'gate-roundtrip.lock');
  const RT_LOCK_STALE_MS = 10 * 60_000;

  function roundTripLockIsLive() {
    try {
      return Date.now() - statSync(RT_LOCK).mtimeMs < RT_LOCK_STALE_MS;
    } catch {
      return false;
    }
  }

  function acquireRoundTripLock() {
    try {
      mkdirSync(STATE_DIR, { recursive: true });
    } catch {
      /* fall through — the lock mkdir below will fail and we fail open */
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        mkdirSync(RT_LOCK); // atomic: EEXIST when another instance holds it
        return true;
      } catch {
        if (roundTripLockIsLive()) return false;
        try {
          rmSync(RT_LOCK, { recursive: true, force: true }); // stale — steal once
        } catch {
          return false;
        }
      }
    }
    return false;
  }

  function releaseRoundTripLock() {
    try {
      rmSync(RT_LOCK, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  // Heal the tree/index left by a CRASHED round-trip. Runs before anything else
  // on every invocation; a live lock means an instance is legitimately mid-flight.
  function recoverInterruptedRoundTrip() {
    if (!existsSync(RT_JOURNAL) || roundTripLockIsLive()) return;
    let j = null;
    try {
      j = JSON.parse(readFileSync(RT_JOURNAL, 'utf8'));
    } catch {
      /* corrupt journal — fall through to removal */
    }
    if (j?.worktreeTree && j?.stagedTree) {
      // The journal binds to the HEAD it was captured under. A killed hook does
      // NOT stop the tool call — the git command can still run and MOVE HEAD —
      // and restoring the journaled trees over a moved HEAD time-travels the
      // checkout backward (observed live: a pre-rebase snapshot restored over
      // the rebased tree; open-bugs.md:291). On a HEAD mismatch: REFUSE,
      // quarantine the journal (its SHAs are the only pointers to the pre-crash
      // trees), and hand the operator the manual restore path. A journal with no
      // `head` field (an older gate version's shape) cannot prove it is safe to
      // apply — same refusal.
      const headNow = git(['rev-parse', 'HEAD']);
      const currentHead = headNow.ok ? headNow.stdout.trim() : null;
      if (!j.head || !currentHead || j.head !== currentHead) {
        const quarantine = join(
          STATE_DIR,
          `gate-roundtrip-journal.quarantine-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
        );
        try {
          renameSync(RT_JOURNAL, quarantine);
        } catch {
          try { rmSync(RT_JOURNAL, { force: true }); } catch { /* ignore */ }
        }
        console.error(
          `[${label}] REFUSED to auto-recover an interrupted staged-snapshot round-trip: the ` +
            `journal was captured under HEAD ${j.head ?? '(unrecorded — an older gate version wrote it)'} ` +
            `but HEAD is now ${currentHead ?? '(unreadable)'}. Applying it would move the checkout ` +
            `backward. Journal quarantined at ${quarantine}. If you need the pre-crash state: worktree ` +
            `tree ${j.worktreeTree}, staged tree ${j.stagedTree} — inspect with \`git ls-tree -r <sha>\`, ` +
            `restore single files with \`git checkout <tree-sha> -- <path>\` after checking \`git status\`.`,
        );
        return;
      }
      const scratch = join(tmpdir(), `audit-tools-gate-recover-${randomBytes(6).toString('hex')}`);
      const union = new Set([...(listTreePaths(j.worktreeTree) ?? []), ...(listTreePaths(j.stagedTree) ?? [])]);
      const restoredWt = checkoutTreeExact(scratch, j.worktreeTree, union);
      const restoredIdx = git(['read-tree', j.stagedTree]).ok;
      try {
        rmSync(scratch, { force: true });
      } catch {
        /* ignore */
      }
      console.error(
        `[${label}] recovered an INTERRUPTED staged-snapshot round-trip (a previous gate instance was ` +
          `killed mid-flight): worktree ${restoredWt ? 'restored' : 'RESTORE FAILED'}, index ` +
          `${restoredIdx ? 'restored' : 'RESTORE FAILED'}. Verify with \`git status\`.`,
      );
    }
    try {
      rmSync(RT_JOURNAL, { force: true });
    } catch {
      /* ignore */
    }
  }
  return {
    git,
    gitWithIndex,
    captureWorktreeTree,
    listTreePaths,
    checkoutTreeExact,
    STATE_DIR,
    RT_JOURNAL,
    acquireRoundTripLock,
    releaseRoundTripLock,
    recoverInterruptedRoundTrip,
  };
}
