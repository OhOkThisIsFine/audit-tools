import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
// Imported by absolute file URL so this file asserts the same property from the
// proposal directory and from tests/shared/ after adoption. Windows needs the
// file:// form; a bare absolute path is not a valid ESM specifier there.
const MODULE = pathToFileURL(resolve(ROOT, 'scripts/shared/suiteGreenStamp.mjs')).href;

// The property: a full-suite green run leaves tree-bound evidence, and the
// closeout challenge reads it. Both halves are wiring assertions, because the
// defect this closes is precisely that NOTHING carries the evidence — not that
// an existing carrier computes it wrongly.
describe('full-suite green is recorded as tree-bound evidence', () => {
  it('exposes a full-suite predicate that a filtered run cannot satisfy', async () => {
    const mod = await import(/* @vite-ignore */ MODULE);
    expect(mod.isFullSuiteRun([])).toBe(true);
    expect(mod.isFullSuiteRun(['tests/shared/x.test.ts'])).toBe(false);
    expect(mod.isFullSuiteRun(['--exclude', '**/y.test.ts'])).toBe(false);
    expect(mod.isFullSuiteRun(['--retry=2'])).toBe(false);
  });

  it('binds the stamp to the worktree CONTENT, not to HEAD', async () => {
    const mod = await import(/* @vite-ignore */ MODULE);
    const stamp = mod.suiteGreenStampPath(ROOT).split('\\').join('/');
    expect(stamp.endsWith('.claude/hooks/.state/suite-green/latest.json')).toBe(true);
    // A null tree is "cannot tell", never "unchanged": it must not mint evidence.
    expect(mod.writeSuiteGreenStamp(ROOT, null)).toBe(false);
  });

  it('is written by the one vitest gate every suite run goes through', () => {
    const gate = readFileSync(resolve(ROOT, 'scripts/shared/run-vitest-gate.mjs'), 'utf8');
    expect(gate).toContain('suiteGreenStamp.mjs');
    expect(gate).toContain('writeSuiteGreenStamp');
  });

  it('is read by the closeout challenge, so a stale green cannot pass in silence', () => {
    const hook = readFileSync(resolve(ROOT, '.claude/hooks/closeout-challenge-gate.mjs'), 'utf8');
    expect(hook).toContain('readSuiteGreenStamp');
  });
});
