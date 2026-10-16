import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { main } from '../../scripts/shared/triage-backlog.mjs';
import { coverageStampPath } from '../../scripts/shared/lane-dispatch.mjs';

const dirs: string[] = [];
const exitCode = process.exitCode;
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = exitCode;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'triage-lifecycle-'));
  dirs.push(root);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const outPath = join(root, 'triage.jsonl');
  const stamp = () => JSON.parse(readFileSync(coverageStampPath(outPath), 'utf8'));
  const row = { id: 'a', file: 'open-bugs.md', verdict: 'actionable_now', why: 'fixture',
    action: 'fix', code_paths: [], premise_probes: [], premise: 'holds', lane: 'offline' };
  const dispatch = vi.fn(async (_task: string, _options?: object) => ({ error: undefined, status: 'completed', lane: 'offline', raw: JSON.stringify(row) }));
  const close = vi.fn(async () => {});
  const openLane = vi.fn(() => ({ dispatch, close }));
  return { root, outPath, stamp, row, dispatch, close, openLane };
}

for (const retained of [false, true]) {
  test(`no pending input opens and closes no bridge (retained=${retained})`, async () => {
    const f = setup();
    if (retained) writeFileSync(f.outPath, JSON.stringify(f.row) + '\n');
    await main({ ...f, entries: retained ? [{ id: 'a', file: 'open-bugs.md', text: 'fixture' }] : [] });
    expect(f.openLane).not.toHaveBeenCalled();
    expect(f.close).not.toHaveBeenCalled();
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(f.stamp()).toMatchObject({ aborted: null, finished_at: expect.any(String), attempted: 0,
      prior_classified: Number(retained), classified_total: Number(retained), unprobed: Number(retained) });
    if (retained) expect(JSON.parse(readFileSync(f.outPath, 'utf8')).premise).toBe('unprobed');
  });
}

test('default entry loading happens on main invocation using its root', async () => {
  const f = setup();
  mkdirSync(join(f.root, 'docs', 'backlog'), { recursive: true });
  for (const file of ['open-bugs.md', 'forward-tracks.md', 'deferred.md'])
    writeFileSync(join(f.root, 'docs', 'backlog', file), '# Empty fixture\n');
  await main(f);
  expect(f.stamp().total_entries).toBe(0);
  expect(f.openLane).not.toHaveBeenCalled();
});

test('partial resume opens once, preflights once, dispatches pending entry and closes once', async () => {
  const f = setup();
  writeFileSync(f.outPath, JSON.stringify(f.row) + '\n');
  await main({ ...f, concurrency: 1, entries: [
    { id: 'a', file: 'open-bugs.md', text: 'retained' },
    { id: 'b', file: 'open-bugs.md', text: 'pending fixture' },
  ] });
  expect(f.openLane).toHaveBeenCalledExactlyOnceWith({ size: 1, cwd: f.root });
  expect(f.dispatch).toHaveBeenCalledTimes(2);
  expect(f.dispatch.mock.calls[0][0]).toBe('Reply with the single word: ok');
  expect(f.dispatch.mock.calls[1][0]).toContain('pending fixture');
  expect(f.close).toHaveBeenCalledTimes(1);
  expect(f.stamp()).toMatchObject({ aborted: null, prior_classified: 1, attempted: 1,
    classified_total: 2, unprobed: 2, lanes: { offline: 2 } });
});

test('synchronous open failure uses abort/remedy path without resetting revived counters', async () => {
  const f = setup();
  writeFileSync(f.outPath, JSON.stringify(f.row) + '\n');
  f.openLane.mockImplementation(() => { throw new Error('offline open failure'); });
  await main({ ...f, entries: [{ id: 'a', file: 'open-bugs.md', text: 'a' }, { id: 'b', file: 'open-bugs.md', text: 'b' }] });
  expect(f.openLane).toHaveBeenCalledTimes(1);
  expect(f.close).not.toHaveBeenCalled();
  expect(f.dispatch).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(1);
  expect(f.stamp()).toMatchObject({ aborted: 'preflight failed: offline open failure', finished_at: null,
    attempted: 0, prior_classified: 1, classified_total: 1, unprobed: 1, lanes: { offline: 1 } });
  expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining('Check the agent-dispatch worker'));
  expect(JSON.parse(readFileSync(f.outPath, 'utf8')).premise).toBe('unprobed');
});

for (const failure of ['throw', 'failed-status']) {
  test(`pending preflight ${failure} closes the opened lane and never dispatches an item`, async () => {
    const f = setup();
    f.dispatch.mockImplementation(async () => {
      if (failure === 'throw') throw new Error('offline dispatch failure');
      return { error: undefined, status: 'failed', lane: 'offline', raw: 'offline failure' };
    });
    await main({ ...f, entries: [{ id: 'a', file: 'open-bugs.md', text: 'a' }] });
    expect(f.openLane).toHaveBeenCalledTimes(1);
    expect(f.dispatch).toHaveBeenCalledTimes(1);
    expect(f.close).toHaveBeenCalledTimes(1);
    expect(f.stamp()).toMatchObject({ attempted: 0, finished_at: null, aborted: expect.stringContaining('preflight failed:') });
    expect(process.exitCode).toBe(1);
  });
}
