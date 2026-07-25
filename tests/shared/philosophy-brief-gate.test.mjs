// Contract tests for the philosophy-brief gate (scripts/check-philosophy-brief.mjs).
//
// The brief in docs/project-philosophy.md is the single source for every condensed
// restatement: README.md's Philosophy section is generated from its Product half,
// and the question-philosophy-gate hook extracts the whole brief at runtime. The
// gate is what makes "single source" true rather than aspirational — before it,
// the README carried a hand-maintained copy plus an instruction to remember to
// update it.
//
// Driven with SYNTHETIC documents (not the repo's own) so a legitimate edit to the
// real philosophy never turns these red; one live case pins that the real pair is
// actually in sync.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import {
  extractBrief,
  applyToReadme,
  renderReadmeSection,
  README_BEGIN,
  README_END,
} from '../../scripts/check-philosophy-brief.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

const DOC = [
  '# Project philosophy',
  '',
  '<!-- BEGIN philosophy-brief — generated -->',
  '',
  '**Product — what it is.**',
  '',
  '- Trustworthy even when the host is weak.',
  '- Mechanical where mechanical works.',
  '',
  '**Working — how the work gets done.**',
  '',
  '- Effort is not a cost.',
  '',
  '<!-- END philosophy-brief -->',
  '',
  '# PART A',
].join('\n');

const README = ['# t', '', '## Philosophy', '', README_BEGIN, README_END, '', '## Install'].join('\n');

describe('philosophy-brief: the brief splits into the two halves its consumers need', () => {
  it('extracts Product and Working separately', () => {
    const { product, working } = extractBrief(DOC);
    expect(product).toContain('Trustworthy even when the host is weak.');
    expect(product).toContain('Mechanical where mechanical works.');
    expect(working).toContain('Effort is not a cost.');
    // The halves must not bleed: the README renders Product ONLY.
    expect(product).not.toContain('Effort is not a cost.');
    expect(working).not.toContain('Trustworthy even when the host is weak.');
  });

  it('refuses a doc with no brief markers rather than rendering an empty section', () => {
    assert.throws(() => extractBrief('# Something else entirely\n'), /missing the philosophy-brief markers/);
  });

  it('refuses a brief that is missing one of its halves', () => {
    const halfOnly = DOC.replace('**Working — how the work gets done.**', '').replace('- Effort is not a cost.', '');
    assert.throws(() => extractBrief(halfOnly), /must contain both/);
  });
});

describe('philosophy-brief: the README block is generated, never hand-held', () => {
  it('renders the Product half between the markers', () => {
    const { product } = extractBrief(DOC);
    const next = applyToReadme(README, product);
    expect(next).toContain('Trustworthy even when the host is weak.');
    expect(next).toContain(README_BEGIN);
    expect(next).toContain(README_END);
    // Surrounding prose is preserved — this replaces a block, not the file.
    expect(next).toContain('## Install');
  });

  it('is idempotent — regenerating an up-to-date README is a no-op', () => {
    const { product } = extractBrief(DOC);
    const once = applyToReadme(README, product);
    expect(applyToReadme(once, product)).toBe(once);
  });

  it('detects drift: a hand-edited README no longer matches the brief', () => {
    const { product } = extractBrief(DOC);
    const tampered = applyToReadme(README, product).replace('Mechanical where mechanical works.', 'Something else.');
    expect(applyToReadme(tampered, product)).not.toBe(tampered);
  });

  it('refuses a README with no markers, and says how to add them', () => {
    const { product } = extractBrief(DOC);
    assert.throws(() => applyToReadme('# t\n\n## Philosophy\n\nprose\n', product), /missing the philosophy-brief markers/);
  });

  it('renderReadmeSection wraps exactly the two markers around the content', () => {
    const block = renderReadmeSection('- one');
    expect(block.startsWith(README_BEGIN)).toBe(true);
    expect(block.endsWith(README_END)).toBe(true);
  });
});

describe('philosophy-brief: the real pair is in sync', () => {
  it('README.md matches the brief in docs/project-philosophy.md', () => {
    const doc = readFileSync(join(REPO_ROOT, 'docs', 'project-philosophy.md'), 'utf8');
    const readme = readFileSync(join(REPO_ROOT, 'README.md'), 'utf8');
    const { product } = extractBrief(doc);
    expect(applyToReadme(readme, product)).toBe(readme);
  });

  it('the brief carries the line that dissolves most scope questions', () => {
    const doc = readFileSync(join(REPO_ROOT, 'docs', 'project-philosophy.md'), 'utf8');
    const { working } = extractBrief(doc);
    expect(working).toContain('are NOT costs');
  });
});
