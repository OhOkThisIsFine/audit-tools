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

  it('reaches the stamp from EVERY path it exits as a PASS', () => {
    // The assertion above only proves the gate MENTIONS the stamp, and that is
    // how this shipped: the reporter-transport tolerance path printed "Treating
    // as PASS" and exited 0 BEFORE the stamp write, so the one run class the
    // gate goes out of its way to call green was the one class leaving no
    // evidence it was. A tolerated run is full evidence by construction —
    // isReporterTransportFault demands this run's own token, zero failed AND
    // zero unfinished leaves — so withholding the stamp there is the same false
    // signal the tolerance exists to prevent, relocated to the closeout.
    //
    // ONE success exit is the property, not a style preference: a second one is
    // a second place to forget the evidence, which is exactly what happened.
    const gate = readFileSync(resolve(ROOT, 'scripts/shared/run-vitest-gate.mjs'), 'utf8');
    const successExits = [...gate.matchAll(/process\.exit\(0\)/g)].map((m) => m.index ?? -1);
    expect(successExits).toHaveLength(1);
    expect(gate.indexOf('writeSuiteGreenStamp(')).toBeLessThan(successExits[0]);
  });

  it('is read by the PRE-RENDER readiness seam, so a stale green refuses the FIRST render', () => {
    // The seam owns the read; both consumers reach it through
    // closeoutReadinessFindings — the renderer before writing a record, the
    // Stop gate as its backstop. The gate holding its OWN copy is exactly the
    // double-generation defect (the challenge could only speak post-render).
    const readiness = readFileSync(resolve(ROOT, 'scripts/shared/closeoutReadiness.mjs'), 'utf8');
    expect(readiness).toContain('readSuiteGreenStamp');
    const renderer = readFileSync(resolve(ROOT, 'scripts/render-closeout.mjs'), 'utf8');
    expect(renderer).toContain('closeoutReadinessFindings');
    const hook = readFileSync(resolve(ROOT, '.claude/hooks/closeout-challenge-gate.mjs'), 'utf8');
    expect(hook).toContain('closeoutReadinessFindings');
    expect(hook).not.toContain('readSuiteGreenStamp');
  });

  it('readiness reports a missing or tree-mismatched stamp, and accepts a matching one', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { execFileSync } = await import('node:child_process');
    const readinessModule = await import(
      /* @vite-ignore */ pathToFileURL(resolve(ROOT, 'scripts/shared/closeoutReadiness.mjs')).href
    );
    const treeModule = await import(
      /* @vite-ignore */ pathToFileURL(resolve(ROOT, 'scripts/shared/worktree-tree.mjs')).href
    );
    const stampModule = await import(/* @vite-ignore */ MODULE);
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'suite-green-readiness-'));
    try {
      const git = (args: string[]) =>
        execFileSync('git', args, { cwd: fixtureRoot, encoding: 'utf8', windowsHide: true });
      mkdirSync(join(fixtureRoot, 'src'), { recursive: true });
      writeFileSync(join(fixtureRoot, 'src', 'a.txt'), 'content\n');
      // Mirror the real repo: the stamp lives under .claude/, which is ignored,
      // so writing it never changes the tree identity it is compared against.
      writeFileSync(join(fixtureRoot, '.gitignore'), '.claude/\n');
      git(['init']);
      git(['config', 'user.email', 'test@example.com']);
      git(['config', 'user.name', 'Test']);
      git(['add', 'src/a.txt', '.gitignore']);
      git(['commit', '-m', 'baseline']);

      const suiteFindings = () =>
        readinessModule
          .closeoutReadinessFindings(fixtureRoot)
          .filter((f: string) => /full-suite green|different content/u.test(f));

      // No stamp at all → the missing-green finding.
      expect(suiteFindings().some((f: string) => f.includes('no full-suite green'))).toBe(true);

      // A stamp bound to a DIFFERENT tree → the stale finding.
      stampModule.writeSuiteGreenStamp(fixtureRoot, 'f'.repeat(40));
      expect(suiteFindings().some((f: string) => f.includes('different content'))).toBe(true);

      // A stamp bound to the CURRENT tree → no suite finding.
      const currentTree = treeModule.worktreeTree(fixtureRoot);
      expect(currentTree).toBeTruthy();
      stampModule.writeSuiteGreenStamp(fixtureRoot, currentTree);
      expect(suiteFindings()).toEqual([]);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});
