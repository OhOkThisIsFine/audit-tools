import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { spawnSyncHidden } from '../helpers/spawn.mjs';
import { dispatchBoundedItems } from '../../scripts/shared/lane-dispatch.mjs';
import { triageRecordCallbacks, PREMISE_STAMP_CLASSES, TRIAGE_STAMP_INIT, countTriageStamp } from '../../scripts/shared/triage-backlog.mjs';
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'triage-dispatch-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/live.ts'), 'const LIVE = 1;');
  for (const args of [['init', '-q'], ['add', '.']]) {
    const r = spawnSyncHidden('git', args, { cwd: root });
    expect(r.status).toBe(0);
  }
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const probes = [
  [{ file: 'src/live.ts', contains: 'LIVE' }],
  [{ file: 'src/live.ts', contains: 'LIVE' }, { file: 'src/live.ts', contains: 'ABSENT' }],
  [{ file: 'src/live.ts', contains: 'ABSENT' }],
  [{ file: 'src/gone.ts', contains: 'LIVE' }],
  [],
];
const row = (i: number) => ({ id: String(i), file: 'open-bugs.md', title: 'Test', verdict: 'already_shipped_or_stale', why: 'Evidence', action: 'Review', effort: 'small', code_paths: [], premise_probes: probes[i] });
it('counts all five classes across real new/revival callbacks and zero-new resume exactly once', async () => {
  const outPath = join(root, 'rows.jsonl');
  writeFileSync(outPath, JSON.stringify(row(0)) + '\n' + JSON.stringify(row(1)) + '\n');
  const run = () => dispatchBoundedItems({ items: probes.map((_, i) => row(i)), outPath,
    ...triageRecordCallbacks({ root }), stampInit: { ...TRIAGE_STAMP_INIT, lanes: {} }, stampExtra: countTriageStamp,
    callLane: async (e: any) => ({ raw: JSON.stringify(e), finishReason: 'completed', lane: 'test' }),
  });
  const first = await run();
  expect(first.stamp.attempted).toBe(3);
  expect(first.stamp.classified_total).toBe(5);
  for (const cls of PREMISE_STAMP_CLASSES) expect(first.stamp[cls]).toBe(1);
  const normalized = readFileSync(outPath, 'utf8');
  const second = await run();
  expect(second.stamp.attempted).toBe(0);
  expect(second.stamp.classified).toBe(0);
  for (const cls of PREMISE_STAMP_CLASSES) expect(second.stamp[cls]).toBe(1);
  expect(readFileSync(outPath, 'utf8')).toBe(normalized);
});
it('restores unresolved guesses, clears stale classification, and stays idempotent', () => {
  const { reviveRecord } = triageRecordCallbacks({ root });
  const fixed = reviveRecord({ ...row(0), code_paths_unresolved: [{ written: 'src/live.ts', reason: 'missing' }] });
  expect(fixed.code_paths).toEqual(['src/live.ts']);
  expect(fixed.code_paths_unresolved).toBeUndefined();
  expect(reviveRecord(fixed)).toEqual(fixed);
});
it('rejected new records do not count as classified premises', async () => {
  const out = await dispatchBoundedItems({ items: [row(0)], outPath: join(root, 'rows.jsonl'),
    ...triageRecordCallbacks({ root }), stampInit: { ...TRIAGE_STAMP_INIT, lanes: {} }, stampExtra: countTriageStamp,
    callLane: async () => ({ raw: '{}', finishReason: 'completed' }),
  });
  expect(out.stamp.errored).toBe(1);
  expect(out.stamp.classified_total).toBe(0);
  expect(PREMISE_STAMP_CLASSES.reduce((n, c) => n + out.stamp[c], 0)).toBe(0);
});
it('a rejected revival preserves accepted durable records and refuses a false completion', async () => {
  const outPath = join(root, 'rows.jsonl');
  const original = JSON.stringify(row(0)) + '\n';
  writeFileSync(outPath, original);
  await expect(dispatchBoundedItems({ items: [row(0)], outPath, reviveRecord: () => undefined,
    callLane: async () => ({ raw: '' }), buildRecord: () => row(0),
  })).rejects.toThrow(/reviv/i);
  expect(readFileSync(outPath, 'utf8')).toBe(original);
});

it('counts duplicate retained identities once and never dispatches a completed identity again', async () => {
  const outPath = join(root, 'rows.jsonl');
  writeFileSync(outPath, [row(0), row(0)].map((r) => JSON.stringify(r)).join('\n') + '\n');
  const { stamp } = await dispatchBoundedItems({ items: [row(0)], outPath,
    ...triageRecordCallbacks({ root }), stampInit: { ...TRIAGE_STAMP_INIT, lanes: {} }, stampExtra: countTriageStamp,
    callLane: async () => { throw new Error('must not dispatch'); },
  });
  expect(stamp.classified_total).toBe(1);
  expect(stamp.holds).toBe(1);
  expect(stamp.attempted).toBe(0);
  expect(readFileSync(outPath, 'utf8').trim().split('\n')).toHaveLength(1);
});

it.each(['not JSON', '{}'])('retries a malformed completed answer once: %s', async (bad) => {
  let calls = 0;
  const { stamp, records } = await dispatchBoundedItems({ items: [row(0)], outPath: join(root, 'retry.jsonl'),
    ...triageRecordCallbacks({ root }),
    callLane: async () => ({ raw: ++calls === 1 ? bad : JSON.stringify(row(0)), finishReason: 'completed' }),
  });
  expect(calls).toBe(2);
  expect(stamp.retried).toBe(1);
  expect(stamp.classified).toBe(1);
  expect(records[0].retry.attempts).toBe(2);
});
it('bounds combined transport and malformed-answer failures to two calls', async () => {
  let calls = 0;
  const { stamp } = await dispatchBoundedItems({ items: [row(0)], outPath: join(root, 'retry.jsonl'),
    ...triageRecordCallbacks({ root }),
    callLane: async () => { if (++calls === 1) throw new Error('transport'); return { raw: '{}', finishReason: 'completed' }; },
  });
  expect(calls).toBe(2);
  expect(stamp.retried).toBe(1);
  expect(stamp.errored).toBe(1);
});
it('never retries a timed-out terminal lane answer', async () => {
  let calls = 0;
  const { stamp } = await dispatchBoundedItems({ items: [row(0)], outPath: join(root, 'retry.jsonl'),
    ...triageRecordCallbacks({ root }),
    callLane: async () => { calls++; return { raw: '{}', finishReason: 'timed_out' }; },
  });
  expect(calls).toBe(1);
  expect(stamp.retried).toBe(0);
  expect(stamp.errored).toBe(1);
});

it('preserves historical rows but counts only the current input population', async () => {
  const outPath = join(root, 'subset.jsonl');
  writeFileSync(outPath, [row(0), row(1)].map((r) => JSON.stringify(r)).join('\n') + '\n');
  const { stamp } = await dispatchBoundedItems({ items: [row(0)], outPath,
    ...triageRecordCallbacks({ root }), stampInit: { ...TRIAGE_STAMP_INIT, lanes: {} }, stampExtra: countTriageStamp,
    callLane: async () => { throw new Error('must not dispatch'); },
  });
  expect(stamp.total_entries).toBe(1);
  expect(stamp.prior_classified).toBe(1);
  expect(stamp.classified_total).toBe(1);
  expect(stamp.holds).toBe(1);
  expect(stamp.partial).toBe(0);
  expect(readFileSync(outPath, 'utf8').trim().split('\n')).toHaveLength(2);
});
