// The identity a closeout render is bound to: the CONTENT of the worktree, not HEAD.
//
// WHY NOT HEAD. The closeout itself requires a commit — the HANDOFF trim, the
// backlog status, the memory sync. A record bound to HEAD is invalidated by the
// very commit it describes, and the Stop gate then demands a re-render of a
// report whose content did not change. That fired 16 times in the transcripts
// before this module existed (docs/reviews/closeout-generation-failure-2026-08-26.md),
// and the second render is a second, contradicting hand-back in the same chat.
//
// A tree object is the SAME identity on both sides of that commit: before it the
// content is HEAD + dirt, after it the same content is HEAD' + clean, and both
// hash to the same tree. So committing exactly what the closeout described keeps
// the record valid, while any further edit correctly invalidates it.
//
// The hash is taken through a TEMPORARY index file, so the caller's real index is
// never touched. `git add -A` writes the worktree blobs into the object database
// as unreferenced objects; git prunes those on its normal gc schedule, exactly as
// it does for the objects `git stash create` writes.
//
// `git add -A` honors .gitignore, which is what keeps the identity stable across
// the caller's own bookkeeping: the closeout record lands under .claude/hooks/,
// ignored in this repo, so writing it cannot change the tree it just described.
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Tree-object id of the worktree as it would be committed, or null when the id
 * cannot be taken — no commits yet, not a repository, git absent, spawn fault.
 * Null is always "cannot tell", never "unchanged": every caller must treat it as
 * missing evidence rather than as a match.
 * @param {string} root
 * @returns {string | null}
 */
export function worktreeTree(root) {
  const indexFile = join(tmpdir(), `closeout-index-${process.pid}-${Date.now()}.idx`);
  /** @param {string[]} args */
  const git = (args) =>
    spawnSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
      windowsHide: true,
      env: { ...process.env, GIT_INDEX_FILE: indexFile },
    });
  try {
    if (git(['read-tree', 'HEAD']).status !== 0) return null;
    if (git(['add', '-A']).status !== 0) return null;
    const written = git(['write-tree']);
    if (written.status !== 0) return null;
    const id = (written.stdout ?? '').trim();
    // sha1 (40) or sha256 (64) object format.
    return /^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(id) ? id : null;
  } catch {
    return null;
  } finally {
    try {
      rmSync(indexFile, { force: true });
    } catch {
      /* temp index already gone — nothing to reclaim */
    }
  }
}
