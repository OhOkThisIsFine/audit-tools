import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { execFileSyncHidden } from '../helpers/spawn.mjs';
import {
  discoverGeneratorCapabilities,
  validateGeneratedRegistry,
} from '../../scripts/check-generated-artifacts.mjs';
import { GENERATED } from '../../scripts/guard-reach-data.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function trackedGenerators(): string[] {
  const scriptFiles = String(
    execFileSyncHidden('git', ['ls-files', '-z', 'scripts'], { cwd: ROOT, encoding: 'utf8' }),
  )
    .split('\0')
    .filter(Boolean);
  return discoverGeneratorCapabilities({
    scriptFiles,
    readScript: (path) => readFileSync(join(ROOT, path), 'utf8'),
  });
}

describe('generated-artifact freshness registry', () => {
  it('claims every tracked generator exactly once', () => {
    const counts = new Map<string, number>();
    for (const row of GENERATED) counts.set(row.generator, (counts.get(row.generator) ?? 0) + 1);
    expect(trackedGenerators().filter((path) => counts.get(path) !== 1)).toEqual([]);
  });

  it('every declared contract-test authority exists', () => {
    for (const row of GENERATED) {
      if (row.authority !== 'contractTest') continue;
      expect(row.contractTest?.startsWith('tests/'), `${row.generator}: contract test location`).toBe(true);
      expect(existsSync(join(ROOT, row.contractTest ?? '')), `${row.generator}: contract test exists`).toBe(true);
    }
  });

  it('rejects an unexplained on-demand exception and an unwired check authority', () => {
    const common = {
      generators: ['scripts/shared/generate-one.mjs'],
      trackedFiles: new Set(['scripts/shared/generate-one.mjs']),
      packageScripts: { 'verify:checks': 'node runner.mjs' },
    };
    expect(
      validateGeneratedRegistry({
        ...common,
        rows: [{ generator: common.generators[0]!, onDemand: true, reason: '' }],
      }).join('\n'),
    ).toMatch(/no stated reason/);
    expect(
      validateGeneratedRegistry({
        ...common,
        rows: [
          { generator: common.generators[0]!, authority: 'check', npmScript: 'check:one' },
        ],
        packageScripts: {
          'verify:checks': 'node runner.mjs',
          'check:one': 'node scripts/shared/generate-one.mjs --check',
        },
      }).join('\n'),
    ).toMatch(/not inside verify:checks/);
  });

  it('rejects a capability-declared generator omitted from the registry', () => {
    const generator = 'scripts/render-synthetic.mjs';
    const generators = discoverGeneratorCapabilities({
      scriptFiles: [generator],
      readScript: () => '// @generated-artifact tracked-output\n',
    });
    expect(generators).toEqual([generator]);
    expect(
      validateGeneratedRegistry({
        rows: [],
        generators,
        trackedFiles: new Set([generator]),
        packageScripts: {},
      }),
    ).toEqual([`${generator}: tracked generator claimed by no GENERATED row`]);
  });

  it('discovers runtime renderers and default-check write arms', () => {
    expect(trackedGenerators()).toEqual(
      expect.arrayContaining([
        'scripts/render-closeout.mjs',
        'scripts/nightly/render-inbox.mjs',
        'scripts/check-doc-manifest.mjs',
        'scripts/check-gate-enumeration.mjs',
        'scripts/check-philosophy-brief.mjs',
        'scripts/check-readme-sample-report.mjs',
      ]),
    );
  });

  it('the live registry validates against the live package and tracked tree', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const tracked = new Set(
      String(execFileSyncHidden('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }))
        .split('\0')
        .filter(Boolean),
    );
    expect(
      validateGeneratedRegistry({
        rows: GENERATED,
        generators: trackedGenerators(),
        trackedFiles: tracked,
        packageScripts: pkg.scripts ?? {},
      }),
    ).toEqual([]);
  });
});
