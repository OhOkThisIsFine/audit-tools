#!/usr/bin/env node
//
// Doc-manifest reconciliation gate.
//
// The canonical doc set is declared by the routing table in
// `docs/doc-review-guidelines.md` (the doc-review routine's spec). This gate
// reconciles that table against the actual tracked `docs/**/*.md` tree so the
// two can never drift: a stray doc that no row lists fails the build, and a row
// that points at a deleted file fails too. This is the hard backstop behind the
// reviewer's existence-review (a stray doc can't merge silently and accumulate).
//
// Enforce-in-tooling, not host discretion: the canonical set is mechanically
// verified, never maintained by an agent remembering to prune.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const GUIDELINES = 'docs/doc-review-guidelines.md';

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' });
}

// Tracked docs/*.md on disk (recursive). git ls-files keeps us to checked-in
// files — untracked scratch under docs/ is not the manifest's concern.
const onDisk = git(['ls-files', 'docs/*.md', 'docs/**/*.md'])
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter(Boolean);

// Every concrete `docs/...md` path mentioned in the guidelines table
// (backtick-wrapped). Drop glob patterns (`docs/**/*.md` appears in prose, not
// as a real file) — a path with a `*` is never a manifest entry.
const guidelines = readFileSync(GUIDELINES, 'utf8');
const listed = new Set(
  [...guidelines.matchAll(/`(docs\/[^`]+\.md)`/g)]
    .map((m) => m[1])
    .filter((p) => !p.includes('*')),
);
// The spec file routes itself via the `excluded` row; ensure it's always allowed.
listed.add(GUIDELINES);

// The `excluded` row documents files that may live only on the doc-review branch
// (the findings output) — allowed on disk but NOT required to exist on main, so
// exempt them from the missing-row check.
const excludedRow = guidelines.split(/\r?\n/).find((l) => /\*\*excluded\*\*/.test(l)) ?? '';
const excluded = new Set(
  [...excludedRow.matchAll(/`(docs\/[^`]+\.md)`/g)].map((m) => m[1]),
);

const unlisted = onDisk.filter((f) => !listed.has(f));
const missing = [...listed].filter((f) => !excluded.has(f) && !onDisk.includes(f));

const errors = [];
if (unlisted.length) {
  errors.push(
    `Stray doc(s) not in the canonical manifest (${GUIDELINES} routing table):\n` +
      unlisted.map((f) => `  - ${f}`).join('\n') +
      `\n  → register each in a row (type + reason to exist), fold into an existing` +
      ` canonical doc, or delete.`,
  );
}
if (missing.length) {
  errors.push(
    `Manifest lists doc(s) that no longer exist on disk:\n` +
      missing.map((f) => `  - ${f}`).join('\n') +
      `\n  → remove the dead row from ${GUIDELINES}.`,
  );
}

if (errors.length) {
  console.error('✗ doc-manifest check failed:\n\n' + errors.join('\n\n') + '\n');
  process.exit(1);
}
console.log(`✓ doc-manifest: ${onDisk.length} tracked docs all registered in ${GUIDELINES}`);
