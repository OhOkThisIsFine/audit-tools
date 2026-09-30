import { reconcile } from '../../scripts/check-guard-reach.mjs';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { catalogCommands, catalogGates, verifyChecksSteps } from '../../scripts/shared/verify-steps.mjs';
import { buildPreCommitLegs } from '../../scripts/shared/derived-file-preflight.mjs';
import { deriveTriggerPaths } from '../../scripts/shared/generate-ci-trigger-paths.mjs';

describe('executable gate catalog', () => {
  it('one fixture declaration reaches release, pre-commit and CI', () => {
    const guards = [{ id: 'fixture', kind: 'gate' as const, impl: 'check:fixture',
      releaseOrder: 1, releaseStage: 'checks' as const, preCommit: 'reach' as const,
      paths: ['fixture/**'], fix: 'repair the fixture' }];
    expect(catalogCommands('release', guards, 'npm')).toEqual([
      { label: 'fixture', command: 'npm', args: ['run', '--silent', 'check:fixture'] },
    ]);
    expect(buildPreCommitLegs({ guards, reach: [] })[0].triggered({ root: '.', staged: ['fixture/a.ts'] })).toBe(true);
    expect(deriveTriggerPaths([], guards)).toContain('fixture/**');
    expect(reconcile({ guards, reach: [], onDisk: ['fixture/a.ts'], settingsHookCommands: [],
      packageScripts: { 'verify:release': 'node scripts/shared/profile-run.mjs verify-release --catalog=release',
        'verify:checks': 'node scripts/shared/profile-run.mjs verify-checks --catalog=checks',
        'check:fixture': 'node fixture/a.ts' } })).toEqual([]);
  });

  it('preserves the load-bearing build, host, package, suite and linked-smoke sequence', () => {
    const ids = catalogGates('release').map((g) => g.id);
    const sequence = ['check:tests', 'build', 'check:scripts', 'verify:hosts', 'verify:remediate-hosts',
      'pack:smoke', 'smoke:packaged-audit-code', 'smoke:packaged-remediate-code',
      'smoke:remediate-gate', 'vitest-gate', 'smoke:linked-audit-code', 'smoke:linked-remediate-code'];
    expect(ids.filter((id) => sequence.includes(id))).toEqual(sequence);
    const scripts = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).scripts;
    expect(verifyChecksSteps(scripts)).toEqual(catalogGates('checks').map((g) => g.impl));
  });
});
