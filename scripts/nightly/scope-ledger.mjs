// Leg 1's scope ledger — the coverage stamp and the diff window.
//
// WHY THIS MODULE EXISTS (owner determination 285b804c0aef617d, 2026-08-12).
// `docs/doc-review-guidelines.md` has specified this ledger since the routine
// was written — content-hash item keys mapped to `{ lastCheckedCommit,
// lastCheckedAt }`, held in a sidecar under `.audit-tools/nightly/` — and
// nothing implemented it. Leg 1 therefore reported its own coverage from prose:
// the run said how much it had reviewed, and the number was whatever the agent
// believed. Leg 2 had already learned that lesson the expensive way and now
// reads coverage from `<out>-coverage.json`, written by the sweep as it runs
// (P11, sol-4 2026-08-06); three partial nights had to be reconstructed by hand
// before that stamp existed. This is the same stamp for leg 1.
//
// The ledger does NOT let a run skip items. On an active repo the code has
// moved since almost every item's last check, so every item is re-examined
// regardless. Its value is the EVIDENCE WINDOW: for an item last examined at
// commit C, `git diff C..HEAD` names what could have invalidated it, which is a
// far smaller thing to reason over than the whole tree — with the full codebase
// still available on demand. An item with no ledger entry has no window and is
// reviewed cold; that is the honest answer, not a defect.
//
// Two properties this file is careful about, both learned elsewhere in the
// routine:
//
//   - A STAMP IS A CLAIM. `stampExamined` is called only for items an agent
//     actually examined this run. Stamping the in-scope set up front would make
//     the ledger say "checked" about work nobody did, and every later run would
//     narrow its diff window on that lie.
//   - COVERAGE IS WRITTEN, NEVER EYEBALLED. `writeCoverage` persists the real
//     counts beside the ledger. A missing or `aborted` stamp means leg 1 did
//     not cover the corpus, and saying so is the point.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { flattenManifest } from '../check-doc-manifest.mjs';
import { DOC_MANIFEST } from '../doc-manifest-data.mjs';

export const SCOPE_LEDGER_RELPATH = '.audit-tools/nightly/scope-ledger.json';
export const SCOPE_LEDGER_VERSION = 1;

/** The manifest row whose members are deliberately NOT reviewed. */
const EXCLUDED_ROW_TYPE = 'excluded';

function readJson(file, fallback) {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    return data && typeof data === 'object' ? data : fallback;
  } catch {
    return fallback; // absent / malformed → default, never throw
  }
}

function writeJson(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function git(root, args) {
  // win32: a windowless parent spawning a console child pops a console window
  // unless suppressed — the routine runs from a scheduled task, so an unguarded
  // spawn flashes one per call (INV-WH).
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
}

// ── item identity ────────────────────────────────────────────────────────────

// Collapse whitespace before hashing, so a reflow is not a new item but a
// reword is. Deliberately NOT lowercased and NOT punctuation-stripped: unlike a
// subject key (which must survive the routine rephrasing its own question), an
// item hash exists to detect that the TEXT changed, and a claim that gains a
// "not" is a different claim.
export function normalizeItemText(text) {
  return String(text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\s+/g, ' ')
    .trim();
}

export function itemHash(text) {
  return createHash('sha1').update(normalizeItemText(text), 'utf8').digest('hex').slice(0, 16);
}

// Split a markdown document into reviewable items at blank lines, holding a
// fenced code block together as one item. Block granularity, not sentence:
// a claim and the code fence that proves it are one thing to verify, and a
// finer split would churn hashes on every reflow.
export function splitDocItems(text) {
  const lines = String(text ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n');
  const items = [];
  let buffer = [];
  let fence = null;

  const flush = () => {
    const block = buffer.join('\n').trim();
    if (block) items.push(block);
    buffer = [];
  };

  for (const line of lines) {
    const fenceMatch = /^\s*(```+|~~~+)/.exec(line);
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1][0];
      else if (line.trimStart().startsWith(fence)) fence = null;
      buffer.push(line);
      continue;
    }
    if (!fence && line.trim() === '') {
      flush();
      continue;
    }
    buffer.push(line);
  }
  flush();
  return items;
}

/** Every reviewable item in a doc: `{ path, hash, text }`, in file order. */
export function docItems(root, relPath) {
  const file = join(root, relPath);
  if (!existsSync(file)) return [];
  return splitDocItems(readFileSync(file, 'utf8')).map((text) => ({
    path: relPath,
    hash: itemHash(text),
    text,
  }));
}

// ── in-scope corpus ──────────────────────────────────────────────────────────

/**
 * Every tracked `*.md` leg 1 is responsible for, resolved through the SAME
 * manifest the doc gate reconciles against — so the corpus can never be a
 * second, drifting list. Members of the `excluded` row are dropped: they are
 * excluded by construction, not un-reviewed.
 */
export function inScopeDocs(root, { manifest = DOC_MANIFEST } = {}) {
  const tracked = git(root, ['ls-files', '*.md'])
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const patterns = flattenManifest(manifest);
  const matches = (p, file) => (p.matcher ? p.matcher.test(file) : p.pattern === file);

  const scoped = [];
  for (const file of tracked) {
    const hit = patterns.find((p) => matches(p, file));
    if (!hit) continue; // unmatched is the doc gate's failure to report, not ours
    if (hit.row.type === EXCLUDED_ROW_TYPE) continue;
    scoped.push({ path: file, type: hit.row.type, autoApply: hit.row.autoApply });
  }
  return scoped.sort((a, b) => a.path.localeCompare(b.path));
}

// ── the ledger ───────────────────────────────────────────────────────────────

export function scopeLedgerPath(root) {
  return join(root, SCOPE_LEDGER_RELPATH);
}

export function readScopeLedger(root) {
  const raw = readJson(scopeLedgerPath(root), {});
  const items = raw.items && typeof raw.items === 'object' ? raw.items : {};
  return { version: SCOPE_LEDGER_VERSION, items };
}

export function writeScopeLedger(root, ledger) {
  writeJson(scopeLedgerPath(root), {
    version: SCOPE_LEDGER_VERSION,
    items: ledger?.items ?? {},
  });
}

/**
 * Record that an agent actually examined these items at `commit`. Called after
 * the examination, never before — see the header.
 */
export function stampExamined(ledger, hashes, { commit, at, path } = {}) {
  if (!commit) throw new Error('stampExamined: a commit is required — an unanchored stamp has no window');
  const items = ledger?.items ?? {};
  for (const hash of Array.isArray(hashes) ? hashes : [hashes]) {
    if (!hash) continue;
    items[hash] = {
      lastCheckedCommit: commit,
      lastCheckedAt: at ?? new Date().toISOString(),
      ...(path ? { path } : {}),
    };
  }
  return { version: SCOPE_LEDGER_VERSION, items };
}

/**
 * The evidence window for one item: the files that changed between its last
 * examination and HEAD. `since: null` means the item has never been examined —
 * review it cold rather than pretending a window exists.
 */
export function diffWindow(root, hash, ledger, { head = 'HEAD' } = {}) {
  const entry = ledger?.items?.[hash];
  const since = entry?.lastCheckedCommit ?? null;
  if (!since) return { since: null, files: null, reason: 'never-examined' };
  try {
    const files = git(root, ['diff', '--name-only', `${since}..${head}`])
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    return { since, files, reason: 'window' };
  } catch {
    // A rewritten/absent commit is not a reason to trust a stale window.
    return { since, files: null, reason: 'unresolvable-commit' };
  }
}

export function headCommit(root) {
  return git(root, ['rev-parse', 'HEAD']).trim();
}

// ── coverage stamp ───────────────────────────────────────────────────────────

export function coveragePath(root, date) {
  return join(root, '.audit-tools', 'nightly', `leg1-${date}-coverage.json`);
}

/**
 * Leg 1's counterpart to leg 2's `<out>-coverage.json`. `aborted` is the field
 * that matters: a run that could not cover the corpus says so here, and the
 * report reads this file rather than the agent's recollection.
 */
export function writeCoverage(root, date, stats = {}) {
  const record = {
    run: date,
    head: stats.head ?? null,
    lanes: stats.lanes ?? [],
    docs_in_scope: stats.docs_in_scope ?? 0,
    docs_examined: stats.docs_examined ?? 0,
    items_in_scope: stats.items_in_scope ?? 0,
    items_examined: stats.items_examined ?? 0,
    items_with_window: stats.items_with_window ?? 0,
    items_reviewed_cold: stats.items_reviewed_cold ?? 0,
    aborted: stats.aborted ?? null,
    notes: stats.notes ?? [],
  };
  writeJson(coveragePath(root, date), record);
  return record;
}

export function readCoverage(root, date) {
  return readJson(coveragePath(root, date), null);
}

// ── CLI ──────────────────────────────────────────────────────────────────────
//
//   node scripts/nightly/scope-ledger.mjs plan        # in-scope docs + windows
//   node scripts/nightly/scope-ledger.mjs stamp <doc> # stamp one examined doc
//
// `plan` is what a run reads at leg-1 entry: every in-scope doc, its item
// count, and how many of those items carry an evidence window. `stamp` is
// called per doc AFTER it was examined.
function main(argv) {
  const root = process.cwd();
  const verb = argv[0] ?? 'plan';

  if (verb === 'plan') {
    const ledger = readScopeLedger(root);
    const docs = inScopeDocs(root);
    const plan = docs.map((doc) => {
      const items = docItems(root, doc.path);
      const withWindow = items.filter((i) => ledger.items[i.hash]?.lastCheckedCommit).length;
      return { ...doc, items: items.length, with_window: withWindow, cold: items.length - withWindow };
    });
    process.stdout.write(
      JSON.stringify(
        {
          head: headCommit(root),
          docs_in_scope: plan.length,
          items_in_scope: plan.reduce((n, d) => n + d.items, 0),
          items_with_window: plan.reduce((n, d) => n + d.with_window, 0),
          docs: plan,
        },
        null,
        2,
      ) + '\n',
    );
    return 0;
  }

  if (verb === 'stamp') {
    const relPath = argv[1];
    if (!relPath) {
      process.stderr.write('stamp: a doc path is required\n');
      return 1;
    }
    const head = headCommit(root);
    const items = docItems(root, relPath);
    if (items.length === 0) {
      process.stderr.write(`stamp: no reviewable items at ${relPath}\n`);
      return 1;
    }
    let ledger = readScopeLedger(root);
    ledger = stampExamined(ledger, items.map((i) => i.hash), { commit: head, path: relPath });
    writeScopeLedger(root, ledger);
    process.stdout.write(`stamped ${items.length} items from ${relPath} at ${head.slice(0, 8)}\n`);
    return 0;
  }

  process.stderr.write(`unknown verb: ${verb} (expected plan|stamp)\n`);
  return 1;
}

if (process.argv[1] && process.argv[1].endsWith('scope-ledger.mjs')) {
  process.exitCode = main(process.argv.slice(2));
}
