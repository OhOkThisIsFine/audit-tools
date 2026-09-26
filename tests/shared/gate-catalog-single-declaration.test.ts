// Packet 22 gate catalog (docs/backlog implementation, 2026-09-19): release
// sequence and pre-commit policy derive from ordered GUARDS; staged and CI
// triggers still use separate REACH rows, and executable npm commands still
// need package.json scripts. The old hand-written verify:checks list is gone.
//
// This fixture injects a gate row, a REACH row, and a package script separately.
// It checks each current projection without claiming the unmet one-declaration
// acceptance criterion or executing the release runner. The fixture never
// changes the live registry or release sequence.
import { describe, expect, it } from 'vitest';

import { releaseGatePhases } from '../../scripts/shared/run-release-gates.mjs';
import { buildPreCommitLegs } from '../../scripts/shared/derived-file-preflight.mjs';
import { deriveTriggerPaths } from '../../scripts/shared/generate-ci-trigger-paths.mjs';
import { GUARDS, REACH } from '../../scripts/guard-reach-data.mjs';

const FIXTURE_GATE = {
  id: 'check:fixture-gate',
  kind: 'gate' as const,
  impl: 'check:fixture-gate',
  preCommit: 'reach' as const,
  fix: 'fixture remedy',
};
const FIXTURE_REACH = {
  area: 'fixture tree',
  files: ['fixture/**'],
  guardedBy: ['check:fixture-gate'] as string[],
};
const SCRIPT = { 'check:fixture-gate': 'node scripts/check-fixture-gate.mjs' };

describe('gate catalog projections with their separate reach and command declarations', () => {
  it('a fixture GUARDS gate reaches the release default sequence', () => {
    const { default: sequence } = releaseGatePhases([...GUARDS, FIXTURE_GATE]);
    expect(sequence).toContain('check:fixture-gate');
  });

  it('a fixture GUARDS gate creates a pre-commit leg, and a separate REACH row makes it trigger', () => {
    const legs = buildPreCommitLegs({
      guards: [...GUARDS, FIXTURE_GATE],
      reach: [...REACH, FIXTURE_REACH],
      packageScripts: SCRIPT,
    });
    const leg = legs.find((l) => l.id === 'check:fixture-gate');
    expect(leg).toBeDefined();
    expect(leg!.triggered({ root: '.', staged: ['fixture/any-file.mjs'] })).toBe(true);
    // …and not for an unrelated staged file (reach, not always).
    expect(leg!.triggered({ root: '.', staged: ['src/other.ts'] })).toBe(false);
  });

  it('the separately declared REACH row reaches CI trigger-path derivation', () => {
    expect(deriveTriggerPaths([...REACH, FIXTURE_REACH])).toContain('fixture/**');
  });

  it('a fixture gate uses the npm-script name convention, with a separately supplied script', () => {
    // GUARDS names the command, while package.json supplies its implementation.
    expect(FIXTURE_GATE.impl).toBe(FIXTURE_GATE.id);
    expect(Object.hasOwn(SCRIPT, FIXTURE_GATE.impl)).toBe(true);
  });

  it('the live release projection contains exactly the GUARDS gate implementations in order', () => {
    // This checks the release projection's ordering. Actual runner execution,
    // REACH completeness, and npm-script availability have other gates.
    const gates = GUARDS.filter((g) => g.kind === 'gate');
    const { default: sequence, tail } = releaseGatePhases();
    expect(sequence.length + tail.length).toBe(gates.length);
    // Release order is GUARDS order: default then tail.
    expect([...sequence, ...tail]).toEqual(gates.filter((g) => g.kind === 'gate').map((g) => g.impl));
  });
});
