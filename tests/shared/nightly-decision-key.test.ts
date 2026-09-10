// The nightly-ledger citation check for the two attestation producers.
//
// THE BITE (2026-09-04): `attest-constitutional-doc-change.mjs` recorded the
// owner-decision text `... cde41c31c1c6a7f3 ...` when the ledger held
// `cde41c31f1c6a7f3` — one character off. The attestation is the DURABLE audit
// record, so the typo outlived the work; the only thing that noticed was a later
// `answer.mjs --done`, i.e. after the record was written. A citation of a
// 16-lowercase-hex key is mechanically checkable, so it is checked before the
// record is written, and a key that does not resolve is refused rather than
// warned about (a warning printed to a scrollback the record outlives is not
// enforcement).
//
// Two halves are pinned here, and the second is what keeps the refusal honest:
//   • a citation that resolves is accepted, and a MISTYPED one is refused with
//     the nearest real key named — the self-healing half;
//   • an absent / unreadable / malformed ledger FAILS OPEN and says so. Refusing
//     there would let a missing ledger make a repo un-attestable, and a silent
//     skip is indistinguishable from a verified citation.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { resolveNightlyDecisionKeys } from '../../scripts/shared/nightlyDecisionKey.mjs';
import { subjectKey } from '../../scripts/nightly/items.mjs';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A throwaway root carrying `ledger` at `.claude/nightly-decisions.json`. */
function makeRoot(ledger: unknown, { raw }: { raw?: string } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'nightly-key-'));
  dirs.push(root);
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(
    join(root, '.claude', 'nightly-decisions.json'),
    raw ?? JSON.stringify(ledger),
    'utf8',
  );
  return root;
}

// A REAL subject key, produced by the same function the ledger is keyed with —
// never a hand-typed literal. That is the point: the key format is owned by
// `subjectKey`, and a hand-copied 16-hex string here would be the very defect
// this module exists to catch.
const REAL_KEY = subjectKey('spec/audit/dependency-map.md', 'two dependency-map examples hand-list artifacts');

describe('a cited 16-hex key must resolve against the nightly ledger', () => {
  it('accepts a decision text citing a real key, and reports which one', () => {
    const root = makeRoot({ [REAL_KEY]: { disposition: 'settled' } });
    const r = resolveNightlyDecisionKeys(root, `owner settled it (${REAL_KEY}) in the 2026-09-04 lap`);
    expect(r).toEqual({ ok: true, keys: [REAL_KEY] });
  });

  it('a text citing NO key passes without consulting the ledger at all', () => {
    // A root with no ledger: a text with no citation must not fail open-with-a-
    // note, because there was never a citation to verify. Conflating the two
    // would make every ordinary attestation print a spurious skip note.
    const root = makeRoot(null);
    rmSync(join(root, '.claude', 'nightly-decisions.json'));
    expect(resolveNightlyDecisionKeys(root, 'owner approved the change, decided in the 2026-07-25 hand-back')).toEqual({
      ok: true,
      keys: [],
    });
  });

  it('REFUSES a mistyped key and names the real one — the 2026-09-04 bite, pinned', () => {
    const root = makeRoot({ [REAL_KEY]: { disposition: 'settled' } });
    // One character changed, in the position the real bite changed it.
    const typo = REAL_KEY.slice(0, 8) + (REAL_KEY[8] === 'a' ? 'b' : 'a') + REAL_KEY.slice(9);
    expect(typo).not.toBe(REAL_KEY);
    const r = resolveNightlyDecisionKeys(root, `owner settled it (${typo}) in the 2026-09-04 lap`);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.key).toBe(typo);
    expect(r.reason).toMatch(/NOT a key in \.claude\/nightly-decisions\.json/);
    expect(r.suggestion).toBe(REAL_KEY);
  });

  it('refuses a well-formed key with NO near match, without inventing a suggestion', () => {
    const root = makeRoot({ [REAL_KEY]: { disposition: 'settled' } });
    const unrelated = '0123456789abcdef';
    const r = resolveNightlyDecisionKeys(root, `citing ${unrelated}`);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    // Two substitutions away is not "did you mean" — guessing there would send
    // the caller to a WRONG key, which is worse than saying nothing.
    expect(r.suggestion).toBeNull();
  });

  it('refuses when the ledger holds an AMBIGUOUS near match (two keys one edit away)', () => {
    // Built from a base that is ONE edit from the cited key at a fixed
    // position, so both candidates are genuine distance-1 neighbours of it and
    // neither IS it (the earlier version derived them from REAL_KEY's own byte
    // there, which made one of them resolve).
    const base = 'a'.repeat(16);
    const cited = 'a'.repeat(8) + 'f' + 'a'.repeat(7);
    expect(base).not.toBe(cited);
    const first = 'a'.repeat(8) + 'c' + 'a'.repeat(7);
    const second = 'a'.repeat(8) + 'd' + 'a'.repeat(7);
    const root = makeRoot({ [first]: {}, [second]: {} });
    const r = resolveNightlyDecisionKeys(root, `citing ${cited}`);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.suggestion).toBeNull();
  });

  it('accepts every citation when a text cites several real keys', () => {
    const other = subjectKey('docs/HANDOFF.md', 'a second settled question');
    const root = makeRoot({ [REAL_KEY]: {}, [other]: {} });
    const r = resolveNightlyDecisionKeys(root, `settles ${REAL_KEY} and also ${other}`);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect([...r.keys].sort()).toEqual([REAL_KEY, other].sort());
  });

  it('refuses on the FIRST bad key, so the caller learns one typo per lap', () => {
    const good = subjectKey('docs/HANDOFF.md', 'a second settled question');
    const bad = 'fedcba9876543210';
    const root = makeRoot({ [REAL_KEY]: {}, [good]: {} });
    const r = resolveNightlyDecisionKeys(root, `settles ${REAL_KEY} and ${good} and ${bad}`);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.key).toBe(bad);
  });

  it('does not treat a 16-hex run inside a longer token as a citation', () => {
    const root = makeRoot({ [REAL_KEY]: {} });
    // A 32-hex commit sha, or a key embedded in a longer word, is not a ledger
    // citation. `\b` boundaries make the match exact-width: a substring of a
    // longer hex run must not be pulled out and refused.
    const r = resolveNightlyDecisionKeys(root, `see commit ${REAL_KEY}deadbeef`);
    expect(r).toEqual({ ok: true, keys: [] });
  });
});

describe('an absent / unreadable ledger fails OPEN, announced', () => {
  it('passes the citation through when no ledger exists, recording why', () => {
    const root = makeRoot(null);
    rmSync(join(root, '.claude', 'nightly-decisions.json'));
    const r = resolveNightlyDecisionKeys(root, `citing ${REAL_KEY}`);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    // The skip is DATA, not silence: the caller must be able to announce it, or
    // an unverified citation reads exactly like a verified one.
    expect(r.skipped).toMatch(/no \.claude\/nightly-decisions\.json in this repository/);
  });

  it('passes through when the ledger is malformed JSON, recording why', () => {
    // Malformed state must not make a repo un-attestable (the same rule the
    // derived-file preflight's unwired leg follows). Note the asymmetry with
    // `readDecisions`, which fails CLOSED on its WRITE paths: nothing here
    // writes, so the risk that rule guards against is absent.
    const root = makeRoot(null, { raw: '{"truncated": ' });
    const r = resolveNightlyDecisionKeys(root, `citing ${REAL_KEY}`);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.skipped).toMatch(/could not read|not valid JSON/i);
  });

  it('passes through when the ledger is a JSON array rather than a key map', () => {
    const root = makeRoot([]);
    const r = resolveNightlyDecisionKeys(root, `citing ${REAL_KEY}`);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.skipped).toBe('.claude/nightly-decisions.json is not a key map');
  });
});
