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

/** Is `id` a git tree-object id in either supported object format? */
const isTreeId = (id) => /^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(id);

/**
 * The files a `npm version` bump rewrites, and nothing else does.
 *
 * Taken from the measured release commits rather than from the docs: every
 * `release: vX.Y.Z` in this repository's history touches exactly these two files
 * and exactly the `"version"` values in them (e.g. a5ced6e3 — 3 lines across 2
 * files). A file added here without that evidence would widen what the stamp is
 * willing to certify green.
 */
const RELEASE_BUMP_FILES = ['package.json', 'package-lock.json'];

/**
 * Replace the release-version VALUES in a bump file's text with a fixed token,
 * leaving everything else byte-identical. Pure, so the same masking can be
 * applied to the stamped content and to the current one and the two compared.
 *
 * The masks are anchored, not global:
 *   • `package.json` — the TOP-LEVEL `"version"` (2-space indent is this file's
 *     top level; nested keys are deeper).
 *   • `package-lock.json` — the top-level `"version"` plus the root package
 *     entry's `packages[""].version`. A global `"version"` mask would swallow
 *     every DEPENDENCY's pinned version, and a dependency bump is a real change
 *     to what ships — certifying it green would be the false green this whole
 *     mechanism exists to prevent.
 * A shape this cannot locate is returned UNCHANGED, so it masks nothing and two
 * different contents stay different (the safe direction).
 *
 * @param {string} relPath
 * @param {string} text
 * @returns {string} the masked text (identical to the input when nothing matched)
 */
export function maskReleaseVersionValues(relPath, text) {
  const source = String(text ?? '');
  const MASK = '"<release-bump>"';
  // The trailing comma is part of the shape, not decoration: `name` and
  // `version` are followed by more keys in both files, so a `"$`-anchored match
  // silently masks nothing on the real content while passing a hand-written
  // fixture that happens to end the line.
  const topLevel = (/** @type {string} */ value) =>
    value.replace(/^( {2}"version": )"[^"]*"(,?)$/mu, `$1${MASK}$2`);

  if (relPath === 'package.json') return topLevel(source);
  if (relPath !== 'package-lock.json') return source;

  const masked = topLevel(source);
  // Anchor on the KEY (not the opening quote of the value) so the slice below
  // replaces the value rather than doubling its opening quote.
  const anchor = '\n      "version": ';
  const packagesAt = masked.indexOf('\n  "packages": {');
  if (packagesAt === -1) return masked;
  const rootEntryAt = masked.indexOf('\n    "": {', packagesAt);
  if (rootEntryAt === -1) return masked;
  const keyAt = masked.indexOf(anchor, rootEntryAt);
  if (keyAt === -1) return masked;
  const valueStart = keyAt + anchor.length;
  if (masked[valueStart] !== '"') return masked;
  const valueEnd = masked.indexOf('"', valueStart + 1);
  if (valueEnd === -1) return masked;
  return masked.slice(0, valueStart) + MASK + masked.slice(valueEnd + 1);
}

/**
 * Tree-object ids of the worktree as it would be committed, in ONE index pass:
 * the exact `tree`, and `bumpAgnosticTree` — the same tree with the release
 * version values masked out of the two bump files.
 *
 * Why a SECOND identity at all. A `npm version` bump rewrites two `"version"`
 * values, so it moves the worktree tree id and invalidates every full-suite
 * green that was taken before it — by construction, on every release, for a
 * two-line change whose code is byte-identical. The masked tree is EQUAL across
 * that delta and different across every other change (a dependency bump moves
 * `dependencies`/`packages`, a script edit moves `scripts`), so it is exactly
 * the predicate "these two contents differ only by the release bump".
 *
 * Nulls are per-field and mean "cannot tell", never "unchanged" — the same
 * contract {@link worktreeTree} states; a caller that reads a null as a match
 * would certify a tree nothing looked at.
 *
 * @param {string} root
 * @returns {{tree: string|null, bumpAgnosticTree: string|null} | null}
 */
export function worktreeTrees(root) {
  const indexFile = join(tmpdir(), `closeout-index-${process.pid}-${Date.now()}.idx`);
  // `input` requires stdin to be a PIPE: with `stdio[0] === 'ignore'` Node
  // silently discards the `input` option, and `hash-object --stdin` then hashes
  // an EMPTY blob — which makes every masked tree the same constant regardless of
  // content, i.e. a mechanism that certifies any bump-shaped tree. That shipped
  // here first and only a fixture whose masked ids had to DIFFER caught it.
  /** @param {string[]} args @param {{input?: string}} [options] */
  const git = (args, options = {}) =>
    spawnSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: options.input === undefined ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
      timeout: 30_000,
      windowsHide: true,
      ...(options.input === undefined ? {} : { input: options.input }),
      env: { ...process.env, GIT_INDEX_FILE: indexFile },
    });
  try {
    if (git(['read-tree', 'HEAD']).status !== 0) return null;
    if (git(['add', '-A']).status !== 0) return null;
    const written = git(['write-tree']);
    if (written.status !== 0) return null;
    const tree = (written.stdout ?? '').trim();
    if (!isTreeId(tree)) return null;

    // Mask the bump files IN the index, then write the tree again. Read the
    // blob back from the INDEX (not the worktree) so the masking sees the same
    // byte stream git just hashed, whatever line-ending normalisation applied.
    for (const relPath of RELEASE_BUMP_FILES) {
      const blob = git(['cat-file', '-p', `:${relPath}`]);
      if (blob.status !== 0) continue;
      const original = blob.stdout ?? '';
      const masked = maskReleaseVersionValues(relPath, original);
      if (masked === original) continue;
      const hashed = git(['hash-object', '-w', '--stdin'], { input: masked });
      const objectId = (hashed.stdout ?? '').trim();
      if (hashed.status !== 0 || !isTreeId(objectId)) continue;
      git(['update-index', '--cacheinfo', `100644,${objectId},${relPath}`]);
    }
    const maskedWritten = git(['write-tree']);
    const bumpAgnosticTree = (maskedWritten.stdout ?? '').trim();

    return { tree, bumpAgnosticTree: isTreeId(bumpAgnosticTree) ? bumpAgnosticTree : null };
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

/**
 * Tree-object id of the worktree as it would be committed, or null when the id
 * cannot be taken — no commits yet, not a repository, git absent, spawn fault.
 * Null is always "cannot tell", never "unchanged": every caller must treat it as
 * missing evidence rather than as a match.
 * @param {string} root
 * @returns {string | null}
 */
export function worktreeTree(root) {
  return worktreeTrees(root)?.tree ?? null;
}
