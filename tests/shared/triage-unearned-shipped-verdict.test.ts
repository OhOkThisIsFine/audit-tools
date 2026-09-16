// P65 (owner decision 2026-09-05) — a deletion-authorizing triage verdict must
// be earned by a premise probe.
//
// Lives under `tests/shared/` because vitest EXCLUDES the `.audit-tools/`
// proposal tree, so the candidate's own copy ran nowhere. The proposal's
// measured red-green record is at
// `.audit-tools/nightly/proposals/P65-unearned-shipped-verdict/` (RED-AT.txt,
// red-run.txt, green-run.txt); the red proof below was re-derived at
// implementation time rather than taken on the proposal's word.
//
// WHAT THIS PINS. `already_shipped_or_stale` is the ONE verdict that authorizes
// DELETING a backlog entry. It is paired with a separate `premise` stamp saying
// whether the entry's own quoted fragments could be checked against the tree.
// Nothing coupled the two, so a row could claim "shipped" while establishing
// nothing — which happened to one entry on five distinct dates, each run
// re-refuting it by hand. The assertions below are the coupling.
//
// The rule is stated in prose in the module header already. These cases are why
// it is stated in code instead: a rule addressed to a reader is not a refusal,
// and the reader it must reach is a relay lane plus whoever opens the JSONL at
// 3am.
import { describe, expect, it } from 'vitest';

import {
  TRIAGE_VERDICTS,
  UNVERIFIED_SHIPPED_VERDICT,
  downgradeUnearnedShippedVerdict,
} from '../../scripts/shared/triage-backlog.mjs';

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

  it('the downgrade target is a verdict the record validator accepts', () => {
    // The coupling is only real if the rewritten record SURVIVES the load path.
    // `buildTriageRecord` refuses a verdict outside the schema enum, and a
    // downgrade to an unlisted verdict would drop the row as malformed —
    // hiding the unearned claim instead of surfacing it.
    expect(TRIAGE_VERDICTS.has(UNVERIFIED_SHIPPED_VERDICT)).toBe(true);
  });

  it('preserves every other field of the row it rewrites', () => {
    const out = downgradeUnearnedShippedVerdict({
      ...base,
      premise: 'unprobed',
      verdict: 'already_shipped_or_stale',
    });
    expect(out).toEqual({ ...base, premise: 'unprobed', verdict: UNVERIFIED_SHIPPED_VERDICT });
    expect(out.action).toBe('delete');
    expect(out.code_paths).toEqual(base.code_paths);
  });
});
