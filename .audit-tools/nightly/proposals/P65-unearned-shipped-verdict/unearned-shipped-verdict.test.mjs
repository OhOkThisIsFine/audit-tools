// P65 (nightly leg 3, 2026-09-11) — red-green test for the candidate patch.
//
// RED at HEAD: the imports below are taken from
// `scripts/shared/triage-backlog.mjs`, which exports neither symbol, so all six
// cases fail with "is not a function" (RED-AT.txt holds the verbatim run).
// GREEN with the patch applied: re-point the import at
// `./candidate-triage-downgrade.mjs` (green-run.txt holds that run).
//
// On acceptance this file moves to `tests/shared/` and imports the real module
// — vitest excludes `.claude/**` and this tree, so it runs nowhere until then.
import { describe, expect, it } from 'vitest';

import {
  downgradeUnearnedShippedVerdict,
  UNVERIFIED_SHIPPED_VERDICT,
} from './candidate-triage-downgrade.mjs';

const base = {
  id: 'forward-tracks#55883634',
  file: 'forward-tracks.md',
  title: 'CI wall-clock: shard balance and single-file floor (pointer to review doc)',
  why: 'The entry says implementation was assigned outside this repo.',
  action: 'delete',
  effort: 'S',
  code_paths: ['docs/reviews/ci-wallclock-plan-critique-2026-08-07.md'],
  premise_probes: [],
};

describe('an unearned shipped verdict is downgraded at revive', () => {
  for (const premise of ['unprobed', 'probes_unusable', 'premise_unconfirmed']) {
    it(`downgrades already_shipped_or_stale when the premise is ${premise}`, () => {
      const out = downgradeUnearnedShippedVerdict({
        ...base,
        premise,
        verdict: 'already_shipped_or_stale',
      });
      expect(out.verdict).toBe(UNVERIFIED_SHIPPED_VERDICT);
      expect(out.verdict).not.toBe('already_shipped_or_stale');
    });
  }

  for (const premise of ['holds', 'partial']) {
    it(`keeps already_shipped_or_stale when the premise is ${premise}`, () => {
      const out = downgradeUnearnedShippedVerdict({
        ...base,
        premise,
        verdict: 'already_shipped_or_stale',
      });
      expect(out.verdict).toBe('already_shipped_or_stale');
    });
  }

  it('never rewrites a verdict that does not authorize deletion', () => {
    const out = downgradeUnearnedShippedVerdict({
      ...base,
      premise: 'unprobed',
      verdict: 'owner_decision_needed',
    });
    expect(out.verdict).toBe('owner_decision_needed');
  });
});
