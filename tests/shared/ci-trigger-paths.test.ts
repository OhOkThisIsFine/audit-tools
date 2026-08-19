// P26 (owner decision 2026-08-18): ci.yml's two `paths:` trigger blocks are
// GENERATED from the guard-reach registry — the union of every
// non-declared-gap REACH row's file globs plus the always-trigger base — by
// scripts/shared/generate-ci-trigger-paths.mjs, reconciled by
// `npm run check:ci-trigger-paths`. This is the contract test over the
// derivation, the marker replacement, and the tracked ci.yml's live parity.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  ALWAYS_TRIGGER,
  BEGIN_MARKER,
  END_MARKER,
  deriveTriggerPaths,
  renderPathsBlock,
  replaceTriggerBlocks,
} from '../../scripts/shared/generate-ci-trigger-paths.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const CI_YML = join(REPO_ROOT, '.github', 'workflows', 'ci.yml');

interface ReachRow {
  area: string;
  files: string[];
  guardedBy: string[] | 'declared-gap';
}
const derive = deriveTriggerPaths as (reach?: ReachRow[]) => string[];
const replace = replaceTriggerBlocks as (source: string, paths: string[]) => { output: string; blocks: number };
const render = renderPathsBlock as (paths: string[], indent: string) => string;

const SYNTHETIC: ReachRow[] = [
  { area: 'source', files: ['src/**'], guardedBy: ['build'] },
  { area: 'docs', files: ['**/*.md'], guardedBy: ['check:doc-manifest'] },
  { area: 'unguarded', files: ['examples/**', 'LICENSE'], guardedBy: 'declared-gap' },
];

describe('derivation', () => {
  it('unions non-declared-gap row globs, excludes declared-gap rows, keeps the base, sorts stably', () => {
    const paths = derive(SYNTHETIC);
    expect(paths).toEqual([...['src/**', '**/*.md', ...ALWAYS_TRIGGER]].sort());
    expect(paths).not.toContain('examples/**');
    expect(paths).not.toContain('LICENSE');
  });

  it('the always-trigger base survives even an all-declared-gap registry — a pure union would regress it', () => {
    const paths = derive([{ area: 'x', files: ['x/**'], guardedBy: 'declared-gap' }]);
    expect(paths).toEqual([...ALWAYS_TRIGGER].sort());
  });

  it('duplicate globs across rows collapse', () => {
    const paths = derive([
      { area: 'a', files: ['src/**'], guardedBy: ['build'] },
      { area: 'b', files: ['src/**'], guardedBy: ['check:tests'] },
    ]);
    expect(paths.filter((p) => p === 'src/**')).toHaveLength(1);
  });
});

describe('marker replacement', () => {
  const doc = (body: string) =>
    ['on:', '  push:', `    ${BEGIN_MARKER}`, body, `    ${END_MARKER}`, '  pull_request:', `    ${BEGIN_MARKER}`, body, `    ${END_MARKER}`, ''].join(
      '\n',
    );

  it('rewrites every block, byte-identically, and reports the count', () => {
    const { output, blocks } = replace(doc('    paths: []'), ['a/**', 'b.md']);
    expect(blocks).toBe(2);
    const rendered = render(['a/**', 'b.md'], '    ');
    expect(output.split(rendered)).toHaveLength(3); // both bodies are the same bytes
    expect(output).toContain('- "a/**"');
  });

  it('is idempotent — regenerating regenerated output changes nothing', () => {
    const once = replace(doc('    paths: []'), ['a/**']).output;
    expect(replace(once, ['a/**']).output).toBe(once);
  });

  it('a changed registry changes the output — drift is detectable', () => {
    const once = replace(doc('    paths: []'), derive(SYNTHETIC)).output;
    const perturbed = derive([...SYNTHETIC, { area: 'new', files: ['newtree/**'], guardedBy: ['build'] }]);
    expect(replace(once, perturbed).output).not.toBe(once);
  });

  it('an unterminated block throws instead of eating the file', () => {
    expect(() => replace(`x\n  ${BEGIN_MARKER}\n  paths: []\n`, ['a'])).toThrow(/unterminated/);
  });
});

describe('live parity — the tracked ci.yml matches the registry', () => {
  it('both tracked blocks are exactly what the generator renders today', () => {
    const source = readFileSync(CI_YML, 'utf8');
    const { output, blocks } = replace(source, derive());
    expect(blocks).toBe(2);
    expect(output).toBe(source);
  });

  it('the tracked trigger list still carries the load-bearing members', () => {
    const paths = derive();
    for (const p of ['**/*.md', 'src/**', 'tests/**', '.claude/hooks/**', ...ALWAYS_TRIGGER]) {
      expect(paths).toContain(p);
    }
  });
});
