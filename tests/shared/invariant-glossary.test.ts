import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  glossaryInvariantNamespaces,
  sourceInvariantNamespaces,
  uncoveredInvariantNamespaces,
} from '../../scripts/check-invariant-glossary.mjs';

const ROOT = resolve(import.meta.dirname, '..', '..');

describe('invariant glossary completeness', () => {
  it('every uppercase, nonnumeric INV-* namespace used by src/**/*.ts has a glossary row', () => {
    const missing = uncoveredInvariantNamespaces(ROOT);
    expect(missing, `missing glossary namespace(s): ${missing.join(', ')}`).toEqual([]);
  });

  it('normalizes numbered invariant instances without collapsing named namespaces', () => {
    const source = sourceInvariantNamespaces([
      'INV-CK-7 INV-COVERAGE INV-SSF INV-RSM-RESOLUTION-CORRELATE INV-42',
      'INV-remediate-state-01',
    ]);
    expect([...source].sort()).toEqual([
      'INV-CK',
      'INV-COVERAGE',
      'INV-RSM-RESOLUTION-CORRELATE',
      'INV-SSF',
    ]);
  });

  it('reads namespace ids only from the glossary table first column', () => {
    const glossary = readFileSync(join(ROOT, 'docs', 'glossary-ids.md'), 'utf8');
    const rows = glossaryInvariantNamespaces(glossary);
    expect(rows).toContain('INV-COVERAGE');
    expect(rows).toContain('INV-SSF');
    expect(rows).not.toContain('INV-AREA-N');
  });
});
