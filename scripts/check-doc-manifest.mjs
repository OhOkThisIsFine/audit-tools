#!/usr/bin/env node
//
// Doc-manifest reconciliation gate.
//
// The canonical doc set is declared as DATA in `scripts/doc-manifest-data.mjs`;
// the routing table in `docs/doc-review-guidelines.md` (the doc-review routine's
// spec) is RENDERED from it. This gate reconciles that data against the actual
// tracked markdown tree so the two can never drift: a stray doc that no row
// lists fails the build, a row that points at a deleted file fails too, and a
// hand-edited routing table fails until it is regenerated.
//
// WHAT CHANGED AND WHY (three silent holes, all now closed by construction):
//
//   • REACH. The tracked-file listing was `git ls-files 'docs/*.md'
//     'docs/**/*.md'` — it could not see the ~65 tracked markdown files outside
//     `docs/`, even though the manifest routes them. A retired proxy-setup
//     example was tracked, appeared in ZERO rows, and nothing caught it.
//     The listing is now the whole repo.
//   • GLOBS. Row matching discarded any pattern containing `*`, so the
//     `spec/**/*.md` row matched nothing and 22 spec docs were unrouted.
//     Matching is glob-aware now (grammar documented in doc-manifest-data.mjs).
//   • PROSE. The registered set was regexed out of the WHOLE guidelines file, so
//     a doc merely MENTIONED anywhere — including inside another row's rationale
//     text — counted as registered (`remediation-report.md` was "registered"
//     solely by a passing mention). Reading structured data instead of prose
//     makes that impossible: there is no prose to misread.
//
// Enforce-in-tooling, not host discretion: the canonical set is mechanically
// verified, never maintained by an agent remembering to prune.
//
//   node scripts/check-doc-manifest.mjs            # verify
//   node scripts/check-doc-manifest.mjs --write    # regenerate the rendered table
//
// The reconciliation logic below is exported as a library (the contract test in
// tests/shared/doc-manifest-gate.test.mjs drives it with synthetic manifests and
// file lists); the CLI body runs ONLY on direct invocation.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DOC_MANIFEST } from './doc-manifest-data.mjs';
import { CONSTITUTIONAL_DOC_PATHS } from './shared/constitutional-doc-paths.generated.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
export const GUIDELINES = 'docs/doc-review-guidelines.md';
const DATA_FILE = 'scripts/doc-manifest-data.mjs';
export const BEGIN_MARKER = '<!-- BEGIN doc-manifest table — generated from scripts/doc-manifest-data.mjs -->';
export const END_MARKER = '<!-- END doc-manifest table -->';

function git(args) {
  // win32: a windowless parent spawning a console child (git) pops a console window
  // unless suppressed. This script runs inside `verify:checks`, so an unguarded spawn
  // flashes a window on every gate run — INV-WH.
  return execFileSync('git', args, { encoding: 'utf8', cwd: repoRoot, windowsHide: true });
}

// ── glob grammar ─────────────────────────────────────────────────────────────
// `*` within a segment, `**/` across any number of segments (including none),
// `?` one character, `<date>` an ISO date with an optional lap suffix — the
// token that lets `docs/reviews/*-<date>.md` state the rule "a dated review
// record is excluded by construction" instead of enumerating 51 of them.
// See the header of doc-manifest-data.mjs.
const GLOB_CHARS = /[*?]|<date>/;
export const isGlob = (pattern) => GLOB_CHARS.test(pattern);

export function globToRegExp(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    if (glob.startsWith('<date>', i)) {
      out += '\\d{4}-\\d{2}-\\d{2}[a-z]?';
      i += '<date>'.length - 1;
      continue;
    }
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          out += '(?:[^/]+/)*'; // `**/` — zero or more whole segments
          i += 2;
          continue;
        }
        out += '.*';
        i += 1;
        continue;
      }
      out += '[^/]*';
      continue;
    }
    if (c === '?') {
      out += '[^/]';
      continue;
    }
    out += c.replace(/[.+^${}()[\]\\|]/g, '\\$&');
  }
  return new RegExp('^' + out + '$');
}

/** Flatten manifest rows into `{ pattern, note, row, matcher }` records. */
export function flattenManifest(manifest) {
  const patterns = [];
  for (const row of manifest) {
    for (const entry of row.files) {
      const [pattern, note] = Array.isArray(entry) ? entry : [entry, null];
      patterns.push({ pattern, note, row, matcher: isGlob(pattern) ? globToRegExp(pattern) : null });
    }
  }
  return patterns;
}

const matches = (p, file) => (p.matcher ? p.matcher.test(file) : p.pattern === file);

// ── table rendering ──────────────────────────────────────────────────────────
function renderEntry(entry) {
  const [pattern, note] = Array.isArray(entry) ? entry : [entry, null];
  return note ? `\`${pattern}\` (${note})` : `\`${pattern}\``;
}

export function renderTable(rows) {
  const cellsOf = (row) => [
    `**${row.type}**`,
    row.files.map(renderEntry).join(', '),
    row.check,
    row.autoApply,
  ];
  for (const row of rows) {
    for (const cell of cellsOf(row)) {
      if (cell.includes('|')) {
        throw new Error(
          `manifest row "${row.type}" contains a literal "|", which would break the rendered ` +
            `markdown table. Reword the cell in ${DATA_FILE}.`,
        );
      }
    }
  }
  return [
    '| Type | Files | Check | Auto-apply? |',
    '|---|---|---|---|',
    ...rows.map((row) => `| ${cellsOf(row).join(' | ')} |`),
  ].join('\n');
}

/**
 * Reconcile a manifest against a tracked-file listing. Pure — takes the file
 * list and the guidelines text, returns the error strings (empty = clean), so
 * the contract test can drive every failure mode without a git repo.
 */
export function reconcile({ manifest, onDisk, guidelinesText, constitutionalPaths = [] }) {
  const patterns = flattenManifest(manifest);
  const errors = [];

  // 1. Every tracked doc matches exactly one row.
  const unlisted = [];
  const doubleListed = [];
  for (const file of onDisk) {
    const hits = patterns.filter((p) => matches(p, file));
    if (hits.length === 0) unlisted.push(file);
    else if (new Set(hits.map((h) => h.row.type)).size > 1) {
      doubleListed.push(`${file} → rows: ${[...new Set(hits.map((h) => h.row.type))].join(', ')}`);
    }
  }
  if (unlisted.length) {
    errors.push(
      `Stray doc(s) not in the canonical manifest (${DATA_FILE}):\n` +
        unlisted.map((f) => `  - ${f}`).join('\n') +
        `\n  → register each in a row (type + reason to exist), fold into an existing canonical doc, or` +
        ` delete. Then re-render the table: node scripts/check-doc-manifest.mjs --write`,
    );
  }
  if (doubleListed.length) {
    errors.push(
      `Doc(s) claimed by more than one manifest row — every doc must route to exactly one:\n` +
        doubleListed.map((d) => `  - ${d}`).join('\n'),
    );
  }

  // 2. Every row entry still resolves — EVERY row, with no exemption. The old
  //    checker exempted the `excluded` row from the existence check (its
  //    entries were "allowed but not required to exist"), and that exemption is
  //    precisely how `meta-audit-log.md` sat in the manifest for ~8 weeks after
  //    being deleted from main. A registered path that does not exist is a dead
  //    rule wherever it lives; nothing in the current manifest needs the escape
  //    hatch, so there isn't one.
  const missing = [];
  const deadGlobs = [];
  for (const p of patterns) {
    if (p.matcher) {
      if (!onDisk.some((f) => p.matcher.test(f))) deadGlobs.push(p.pattern);
    } else if (!onDisk.includes(p.pattern)) {
      missing.push(p.pattern);
    }
  }
  if (missing.length) {
    errors.push(
      `Manifest lists doc(s) that no longer exist on disk:\n` +
        missing.map((f) => `  - ${f}`).join('\n') +
        `\n  → remove the dead entry from ${DATA_FILE}, then re-render:` +
        ` node scripts/check-doc-manifest.mjs --write`,
    );
  }
  if (deadGlobs.length) {
    errors.push(
      `Manifest pattern(s) that match no tracked doc — a dead routing rule:\n` +
        deadGlobs.map((f) => `  - ${f}`).join('\n') +
        `\n  → drop the pattern from ${DATA_FILE} or fix it.`,
    );
  }

  // 3. Constitutional docs must exist AND be routed. A renamed or deleted
  //    constitutional doc silently disables the pre-commit refusal that protects
  //    it (`src/shared/constitutionalDocPaths.ts` →
  //    `.claude/hooks/pre-commit-gate.mjs`), and nothing else would notice.
  const constitutionalGone = constitutionalPaths.filter((p) => !onDisk.includes(p));
  if (constitutionalGone.length) {
    errors.push(
      `Constitutional doc(s) named in src/shared/constitutionalDocPaths.ts are not tracked:\n` +
        constitutionalGone.map((f) => `  - ${f}`).join('\n') +
        `\n  → the commit refusal that protects them is now a no-op. Update the canonical list and re-run` +
        ` node scripts/shared/generate-constitutional-doc-paths.mjs.`,
    );
  }

  // 4. The rendered table matches the data.
  const text = guidelinesText.replace(/\r\n/g, '\n');
  const beginAt = text.indexOf(BEGIN_MARKER);
  const endAt = text.indexOf(END_MARKER);
  if (beginAt === -1 || endAt === -1 || endAt < beginAt) {
    errors.push(
      `${GUIDELINES} is missing the generated-table markers. The routing table is rendered from ` +
        `${DATA_FILE} and must sit between:\n  ${BEGIN_MARKER}\n  ${END_MARKER}`,
    );
  } else if (text.slice(beginAt + BEGIN_MARKER.length, endAt).trim() !== renderTable(manifest)) {
    errors.push(
      `The routing table in ${GUIDELINES} does not match ${DATA_FILE}. The table is GENERATED — edit the ` +
        `data, never the markdown.\n  → node scripts/check-doc-manifest.mjs --write`,
    );
  }

  return errors;
}

/** Rewrite the generated table region of the guidelines from `manifest`. */
export function writeRenderedTable(guidelinesText, manifest) {
  const text = guidelinesText.replace(/\r\n/g, '\n');
  const beginAt = text.indexOf(BEGIN_MARKER);
  const endAt = text.indexOf(END_MARKER);
  if (beginAt === -1 || endAt === -1 || endAt < beginAt) {
    throw new Error(`${GUIDELINES} is missing the generated-table markers — cannot render into it.`);
  }
  return (
    text.slice(0, beginAt + BEGIN_MARKER.length) +
    '\n\n' +
    renderTable(manifest) +
    '\n\n' +
    text.slice(endAt)
  );
}

function main() {
  // The tracked markdown tree, WHOLE REPO. git ls-files keeps us to checked-in
  // files — untracked scratch is not the manifest's concern.
  const onDisk = git(['ls-files', '*.md'])
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const guidelinesPath = join(repoRoot, GUIDELINES);
  const guidelinesText = readFileSync(guidelinesPath, 'utf8');

  if (process.argv.includes('--write')) {
    writeFileSync(guidelinesPath, writeRenderedTable(guidelinesText, DOC_MANIFEST), 'utf8');
    process.stdout.write(
      `wrote the rendered routing table into ${GUIDELINES} (${DOC_MANIFEST.length} rows)\n`,
    );
    return;
  }

  const errors = reconcile({
    manifest: DOC_MANIFEST,
    onDisk,
    guidelinesText,
    constitutionalPaths: CONSTITUTIONAL_DOC_PATHS,
  });

  if (errors.length) {
    console.error('✗ doc-manifest check failed:\n\n' + errors.join('\n\n') + '\n');
    process.exit(1);
  }
  console.log(
    `✓ doc-manifest: ${onDisk.length} tracked docs all registered across ${DOC_MANIFEST.length} rows in ` +
      `${DATA_FILE}; ${GUIDELINES} renders it verbatim`,
  );
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) main();
