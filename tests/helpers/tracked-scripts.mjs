/**
 * The tracked `scripts/**` set, for tests that assert a property over the whole
 * script tree rather than over one script.
 *
 * WHY A HELPER. Two tests already need it (the argv-refusal ratchet and the
 * gate-reach reconciliation) and a third would otherwise re-derive it, each
 * with its own idea of what counts as "the script tree". Deriving from
 * `git ls-files` — the same source `check:guard-reach` reconciles against —
 * means an untracked scratch script cannot satisfy or dodge a contract, and a
 * new tracked script is in scope the moment it is added.
 *
 * Deterministic order (sorted by code units) so a test's diff is readable and a
 * failure names the same file every run. Node built-ins only.
 */
import { execFileSyncHidden } from './spawn.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every tracked `.mjs` under `scripts/`, repo-relative and POSIX-separated,
 * sorted. Cached per root, because the tests that use it call it repeatedly.
 *
 * @param {string} root
 * @returns {string[]}
 */
const cache = new Map();

export function listTrackedScripts(root) {
  const hit = cache.get(root);
  if (hit) return hit;
  const out = execFileSyncHidden('git', ['ls-files', '-z', '--', 'scripts'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
  const files = out
    .split('\0')
    .filter(Boolean)
    .map((p) => p.replace(/\\/g, '/'))
    .filter((p) => p.endsWith('.mjs'))
    .sort();
  cache.set(root, files);
  return files;
}

/**
 * The source text of one tracked script. Throws when the path is not tracked or
 * not readable — a caller asserting over the tree wants that to be loud, not an
 * empty string it silently treats as "guarded".
 *
 * @param {string} root
 * @param {string} relPath
 * @returns {string}
 */
export function readScriptSource(root, relPath) {
  return readFileSync(join(root, relPath), 'utf8');
}
