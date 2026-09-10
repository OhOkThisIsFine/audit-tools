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

  it('answers the owned green check from the stamp and current tree without rerunning the suite', async () => {
    const mod = await import(/* @vite-ignore */ MODULE);
    expect(mod.suiteGreenVerdict(null, 'a'.repeat(40))).toEqual({
      ok: false,
      reason: 'no full-suite green stamp exists for this checkout',
    });
    expect(mod.suiteGreenVerdict({ tree: 'a'.repeat(40) }, 'b'.repeat(40))).toMatchObject({
      ok: false,
    });
    expect(
      mod.suiteGreenVerdict(
        { tree: 'a'.repeat(40), ran_at: '2026-09-07T00:00:00.000Z' },
        'a'.repeat(40),
      ),
    ).toEqual({
      ok: true,
      tree: 'a'.repeat(40),
      ranAt: '2026-09-07T00:00:00.000Z',
      viaBumpDelta: false,
    });
  });

  it('does NOT read a missing masked id as a bump match — a stamp from before the mechanism cannot certify a bump', () => {
    // Both sides of the bump comparison must be present. An old stamp (or a tree
    // whose id could not be taken) has no masked half, and "cannot tell" must
    // never become "unchanged" — that is the whole contract of a null tree id.
    const stampModulePromise = import(/* @vite-ignore */ MODULE);
    return stampModulePromise.then((mod) => {
      const oldStamp = { tree: 'a'.repeat(40), ran_at: '2026-09-07T00:00:00.000Z' };
      const current = { tree: 'b'.repeat(40), bumpAgnosticTree: 'c'.repeat(40) };
      expect(mod.suiteGreenVerdict(oldStamp, current).ok).toBe(false);
      // A current tree whose masked id could not be taken is the same "cannot tell".
      expect(
        mod.suiteGreenVerdict(
          { tree: 'a'.repeat(40), bump_agnostic_tree: 'c'.repeat(40) },
          { tree: 'b'.repeat(40), bumpAgnosticTree: null },
        ).ok,
      ).toBe(false);
      // Two DIFFERENT masked ids are a real content difference, not a bump.
      expect(
        mod.suiteGreenVerdict(
          { tree: 'a'.repeat(40), bump_agnostic_tree: 'c'.repeat(40) },
          { tree: 'b'.repeat(40), bumpAgnosticTree: 'd'.repeat(40) },
        ).ok,
      ).toBe(false);
    });
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
    //
    // UNCOVERED HALF, stated rather than implied: this is STRUCTURAL. It pins
    // that the gate has one success boundary and that the stamp call precedes
    // it — not that the call RUNS on a given path. The stamp is deliberately
    // conditional (isFullSuiteRun), so a future guard added around it would
    // still pass here. A functional proof needs a real worker-RPC timeout,
    // which vitestGateVerdict.mjs records as not reproducible on demand.
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

  it('masks ONLY the release version values, never a dependency version', async () => {
    const { maskReleaseVersionValues } = await import(
      /* @vite-ignore */ pathToFileURL(resolve(ROOT, 'scripts/shared/worktree-tree.mjs')).href
    );

    // A `package.json` whose version moved. The nested `"version"` under a
    // dependency must survive: masking it would let a dependency bump read as
    // "the release bump", which is the false green this mask could introduce.
    const pkg = [
      '{',
      '  "name": "audit-tools",',
      '  "version": "0.51.7",',
      '  "dependencies": {',
      '    "yaml": {',
      '      "version": "2.5.1"',
      '    }',
      '  }',
      '}',
      '',
    ].join('\n');
    const maskedPkg = maskReleaseVersionValues('package.json', pkg);
    expect(maskedPkg).toContain('"version": "<release-bump>"');
    expect(maskedPkg, 'a dependency version must survive the mask').toContain(
      '"version": "2.5.1"',
    );
    // Idempotent: masking the masked text changes nothing more.
    expect(maskReleaseVersionValues('package.json', maskedPkg)).toBe(maskedPkg);

    // A lockfile: the top-level version and the root package entry's version are
    // bumped by `npm version`; a transitive dependency's is not.
    const lock = [
      '{',
      '  "name": "audit-tools",',
      '  "version": "0.51.7",',
      '  "lockfileVersion": 3,',
      '  "packages": {',
      '    "": {',
      '      "name": "audit-tools",',
      '      "version": "0.51.7",',
      '    },',
      '    "node_modules/yaml": {',
      '      "version": "2.5.1"',
      '    }',
      '  }',
      '}',
      '',
    ].join('\n');
    const maskedLock = maskReleaseVersionValues('package-lock.json', lock);
    expect(maskedLock.match(/"version": "<release-bump>"/g)).toHaveLength(2);
    expect(maskedLock, 'a transitive dependency version must survive the mask').toContain(
      '"version": "2.5.1"',
    );

    // An unrecognized shape is returned UNCHANGED, so it masks nothing and two
    // different contents stay different (the safe direction).
    expect(maskReleaseVersionValues('package-lock.json', '{"version":"1.0.0"}')).toBe(
      '{"version":"1.0.0"}',
    );
  });

  it('admits a RELEASE-BUMP-ONLY delta as content it already certified', async () => {
    // The measured friction (commitFold-unlink friction walk, 2026-08-30): the
    // release script bumps package.json/package-lock.json AFTER its pre-tag gate,
    // so every release ends with a stamp pointing at the pre-bump tree and pays
    // one extra full local suite (~3.2 min) to re-certify a two-line version
    // change the publish run's own sharded suite already runs.
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { execFileSync } = await import('node:child_process');
    const treeModule = await import(
      /* @vite-ignore */ pathToFileURL(resolve(ROOT, 'scripts/shared/worktree-tree.mjs')).href
    );
    const stampModule = await import(/* @vite-ignore */ MODULE);

    const root = mkdtempSync(join(tmpdir(), 'suite-green-bump-'));
    try {
      const git = (args: string[]) =>
        execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, '.gitignore'), '.claude/\n');
      writeFileSync(
        join(root, 'package.json'),
        '{\n  "name": "audit-tools",\n  "version": "0.51.7"\n}\n',
      );
      writeFileSync(
        join(root, 'package-lock.json'),
        [
          '{',
          '  "name": "audit-tools",',
          '  "version": "0.51.7",',
          '  "lockfileVersion": 3,',
          '  "packages": {',
          '    "": {',
          '      "name": "audit-tools",',
          '      "version": "0.51.7"',
          '    },',
          '    "node_modules/yaml": {',
          '      "version": "2.5.1"',
          '    }',
          '  }',
          '}',
          '',
        ].join('\n'),
      );
      writeFileSync(join(root, 'src', 'a.txt'), 'content\n');
      git(['init']);
      git(['config', 'user.email', 'test@example.com']);
      git(['config', 'user.name', 'Test']);
      git(['add', '-A']);
      git(['commit', '-m', 'baseline']);

      const greenTrees = treeModule.worktreeTrees(root);
      expect(greenTrees?.tree).toBeTruthy();
      expect(greenTrees?.bumpAgnosticTree).toBeTruthy();
      stampModule.writeSuiteGreenStamp(root, greenTrees.tree);
      expect(stampModule.readSuiteGreenStamp(root).bump_agnostic_tree).toBe(
        greenTrees.bumpAgnosticTree,
      );

      // THE RELEASE BUMP: exactly what `npm version --no-git-tag-version` writes.
      const bump = (text: string, from: string, to: string) => text.split(from).join(to);
      writeFileSync(
        join(root, 'package.json'),
        bump(
          '{\n  "name": "audit-tools",\n  "version": "0.51.7"\n}\n',
          '"version": "0.51.7"',
          '"version": "0.51.8"',
        ),
      );
      writeFileSync(
        join(root, 'package-lock.json'),
        bump(
          await (await import('node:fs/promises')).readFile(join(root, 'package-lock.json'), 'utf8'),
          '"version": "0.51.7"',
          '"version": "0.51.8"',
        ),
      );

      const bumpedTrees = treeModule.worktreeTrees(root);
      expect(bumpedTrees.tree, 'the bump moves the tree id — that is its cost').not.toBe(
        greenTrees.tree,
      );
      expect(
        bumpedTrees.bumpAgnosticTree,
        'the masked identity must be EQUAL across the release bump',
      ).toBe(greenTrees.bumpAgnosticTree);

      expect(stampModule.suiteGreenVerdict(stampModule.readSuiteGreenStamp(root), bumpedTrees)).toEqual(
        { ok: true, tree: bumpedTrees.tree, ranAt: expect.any(String), viaBumpDelta: true },
      );
      // The same verdict through the closeout readiness seam, so a bumped tree
      // does not refuse the FIRST render of the release's own hand-back.
      const readiness = await import(
        /* @vite-ignore */ pathToFileURL(resolve(ROOT, 'scripts/shared/closeoutReadiness.mjs')).href
      );
      expect(
        readiness
          .closeoutReadinessFindings(root)
          .filter((f: string) => /full-suite green|different content/u.test(f)),
      ).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does NOT admit a dependency-version change — masking must not swallow it', async () => {
    // The false green this mechanism could introduce: if the mask swallowed any
    // `"version"`, a dependency bump (a real change to what ships) would read as
    // "just the release bump". A dep bump moves the masked tree, so the verdict
    // stays a refusal.
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { execFileSync } = await import('node:child_process');
    const treeModule = await import(
      /* @vite-ignore */ pathToFileURL(resolve(ROOT, 'scripts/shared/worktree-tree.mjs')).href
    );
    const stampModule = await import(/* @vite-ignore */ MODULE);

    const root = mkdtempSync(join(tmpdir(), 'suite-green-depbump-'));
    try {
      const git = (args: string[]) =>
        execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
      writeFileSync(join(root, '.gitignore'), '.claude/\n');
      writeFileSync(
        join(root, 'package.json'),
        '{\n  "name": "audit-tools",\n  "version": "0.51.7"\n}\n',
      );
      const lockfile = (dep: string) =>
        [
          '{',
          '  "name": "audit-tools",',
          '  "version": "0.51.7",',
          '  "packages": {',
          '    "": {',
          '      "name": "audit-tools",',
          '      "version": "0.51.7"',
          '    },',
          '    "node_modules/yaml": {',
          `      "version": "${dep}"`,
          '    }',
          '  }',
          '}',
          '',
        ].join('\n');
      writeFileSync(join(root, 'package-lock.json'), lockfile('2.5.1'));
      git(['init']);
      git(['config', 'user.email', 'test@example.com']);
      git(['config', 'user.name', 'Test']);
      git(['add', '-A']);
      git(['commit', '-m', 'baseline']);

      const greenTrees = treeModule.worktreeTrees(root);
      stampModule.writeSuiteGreenStamp(root, greenTrees.tree);

      // A dependency bump ONLY — no release version change at all.
      writeFileSync(join(root, 'package-lock.json'), lockfile('2.6.0'));
      const after = treeModule.worktreeTrees(root);
      expect(after.bumpAgnosticTree).not.toBe(greenTrees.bumpAgnosticTree);
      expect(stampModule.suiteGreenVerdict(stampModule.readSuiteGreenStamp(root), after).ok).toBe(
        false,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
