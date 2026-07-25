#!/usr/bin/env node
// Philosophy-brief reconciliation gate.
//
// `docs/project-philosophy.md` carries THE BRIEF — the canonical condensed
// statement of the project's convictions — between marker comments. Two
// consumers read it, and neither may hold its own copy:
//
//   - README.md's "Philosophy" section is GENERATED from the brief's Product
//     half (this script, --write) and verified by this gate;
//   - `.claude/hooks/question-philosophy-gate.mjs` EXTRACTS the whole brief at
//     runtime when a question is about to reach the owner.
//
// The README used to carry a hand-maintained restatement plus an instruction to
// "check whether the README summary needs the same edit" — a drift test made of
// remembering, which is the thing this project bans. Generation removes it.
//
// Usage:
//   node scripts/check-philosophy-brief.mjs            # verify (exit 1 on drift)
//   node scripts/check-philosophy-brief.mjs --write     # regenerate the README block
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const SOURCE = 'docs/project-philosophy.md';
const TARGET = 'README.md';

export const BRIEF_BEGIN = '<!-- BEGIN philosophy-brief';
export const BRIEF_END = '<!-- END philosophy-brief -->';
export const README_BEGIN =
  '<!-- BEGIN philosophy-brief — generated from docs/project-philosophy.md; do not hand-edit -->';
export const README_END = '<!-- END philosophy-brief -->';

/**
 * Pull the brief out of the philosophy doc and split it into its two halves.
 * Pure — takes the doc text, returns `{ product, working }` bullet blocks.
 * Throws with a diagnosable message rather than returning a partial result: a
 * silently-empty brief would render an empty README section and still "pass".
 */
export function extractBrief(docText) {
  const begin = docText.indexOf(BRIEF_BEGIN);
  const end = docText.indexOf(BRIEF_END);
  if (begin === -1 || end === -1 || end < begin) {
    throw new Error(`${SOURCE} is missing the philosophy-brief markers (${BRIEF_BEGIN} … ${BRIEF_END}).`);
  }
  const body = docText.slice(docText.indexOf('-->', begin) + 3, end).trim();

  // The halves are labelled by a bolded lead line; everything until the next
  // label belongs to the current half.
  const halves = { product: [], working: [] };
  let current = null;
  for (const line of body.split(/\r?\n/)) {
    if (/^\*\*Product\b/.test(line)) {
      current = 'product';
      continue;
    }
    if (/^\*\*Working\b/.test(line)) {
      current = 'working';
      continue;
    }
    if (current) halves[current].push(line);
  }
  const product = halves.product.join('\n').trim();
  const working = halves.working.join('\n').trim();
  if (!product || !working) {
    throw new Error(`${SOURCE}'s brief must contain both a **Product** and a **Working** half.`);
  }
  return { product, working };
}

/** The exact README block for a given Product half, markers included. */
export function renderReadmeSection(product) {
  return `${README_BEGIN}\n\n${product}\n\n${README_END}`;
}

/** Replace the README's marked block. Pure — returns the new file text. */
export function applyToReadme(readmeText, product) {
  const begin = readmeText.indexOf(README_BEGIN);
  const end = readmeText.indexOf(README_END);
  if (begin === -1 || end === -1 || end < begin) {
    throw new Error(
      `${TARGET} is missing the philosophy-brief markers. Add them inside the "## Philosophy" section:\n` +
        `${README_BEGIN}\n${README_END}`,
    );
  }
  return readmeText.slice(0, begin) + renderReadmeSection(product) + readmeText.slice(end + README_END.length);
}

// ── CLI ──────────────────────────────────────────────────────────────────────
// Only when run directly; importing for tests must not execute the gate.
const invokedDirectly = process.argv[1] && process.argv[1].endsWith('check-philosophy-brief.mjs');
if (invokedDirectly) {
  const write = process.argv.includes('--write');
  try {
    const doc = readFileSync(join(ROOT, SOURCE), 'utf8');
    const { product, working } = extractBrief(doc);
    const readmePath = join(ROOT, TARGET);
    const readme = readFileSync(readmePath, 'utf8');
    const next = applyToReadme(readme, product);

    if (write) {
      if (next !== readme) writeFileSync(readmePath, next);
      console.log(
        `✓ philosophy-brief: ${TARGET} regenerated from ${SOURCE} ` +
          `(${product.split('\n').filter((l) => l.startsWith('-')).length} product line(s); ` +
          `${working.split('\n').filter((l) => l.startsWith('-')).length} working line(s) for the hook).`,
      );
      process.exit(0);
    }

    if (next !== readme) {
      console.error(
        `✗ philosophy-brief check failed: ${TARGET}'s Philosophy section does not match the brief in ${SOURCE}.\n` +
          `  The README block is GENERATED — edit the brief, not the README.\n` +
          `  Regenerate: node scripts/check-philosophy-brief.mjs --write`,
      );
      process.exit(1);
    }
    console.log(`✓ philosophy-brief: ${TARGET} matches the brief in ${SOURCE}; the hook reads the same source.`);
  } catch (err) {
    console.error(`✗ philosophy-brief check failed: ${err.message}`);
    process.exit(1);
  }
}
