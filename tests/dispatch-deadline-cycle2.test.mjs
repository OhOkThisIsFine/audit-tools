import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import test from 'node:test';
import {
  laneWorktreeContainer, openDispatchLane, sweepStaleLaneWorktrees,
} from '../scripts/shared/mcp-dispatch-lane.mjs';
import { main as triage } from '../scripts/shared/triage-backlog.mjs';

const stub = `
  const { appendFileSync } = require('node:fs');
  const { createInterface } = require('node:readline');
  const [mode, log] = process.argv.slice(1);
  setTimeout(() => process.exit(0), 9000).unref();
  const reply = (id, result) => process.stdout.write(JSON.stringify({jsonrpc: '2.0', id, result}) + '\\n');
  const status = (id, status, extra = {}) => reply(id, {structuredContent: {status, jobId: 'job-1', ...extra}});
  createInterface({input: process.stdin}).on('line', (line) => {
    const {id, method, params} = JSON.parse(line);
    if (method === 'initialize') {
      if (mode !== 'silent-init') reply(id, {protocolVersion: params.protocolVersion});
      return;
    }
    if (method !== 'tools/call') return;
    const {name, arguments: args} = params;
    appendFileSync(log, JSON.stringify({name, args}) + '\\n');
    if (name === 'opencode_fire') {
      if (mode === 'silent-fire' || args.prompt.includes('ACCEPTED_NO_REPLY')) return;
      status(id, 'running');
    } else if (name === 'opencode_wait') {
      if (mode.startsWith('silent-wait')) return;
      const answer = JSON.stringify({verdict: 'actionable_now', why: 'fixture', action: 'fix'});
      status(id, 'completed', {result: {parts: [{type: 'text', text: answer}]}});
    } else if (mode === 'silent-wait-confirmed-cancel') {
      status(id, 'cancelled');
    }
  });
`;

function fixture(t) {
  const parent = resolve(tmpdir());
  const dir = mkdtempSync(join(parent, 'audit-dispatch-deadline-'));
  t.after(() => {
    const location = relative(parent, dir);
    assert.ok(location.startsWith('audit-dispatch-deadline-') && !location.includes(sep) && !isAbsolute(location));
    rmSync(dir, { recursive: true, force: true });
  });
  const log = join(dir, 'rpc.jsonl');
  const lane = (mode = 'normal') => openDispatchLane({
    command: process.execPath, args: ['-e', stub, mode, log], cwd: dir,
  });
  const rows = (path = log) => existsSync(path)
    ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
    : [];
  return { dir, log, lane, rows };
}

test('a silent initialization is bounded and a readable bridge still completes a job', { timeout: 6000 }, async (t) => {
  const f = fixture(t);
  const silent = f.lane('silent-init');
  try {
    const started = performance.now();
    await assert.rejects(silent.dispatch('will not fire', { timeoutMs: 200 }), /deadline .*initialize/);
    assert.ok(performance.now() - started < 2500, 'initialization must not wait for process exit');
    assert.deepEqual(f.rows(), []);
  } finally {
    await silent.close();
  }
  const normal = f.lane();
  try {
    const result = await normal.dispatch('ordinary job', { timeoutMs: 3000 });
    assert.equal(result.status, 'completed');
    assert.equal(result.jobId, 'job-1');
    assert.equal(JSON.parse(result.raw).verdict, 'actionable_now');
    assert.deepEqual(f.rows().map((r) => r.name), ['opencode_fire', 'opencode_wait']);
  } finally {
    await normal.close();
  }
});

test('a silent wait plus silent cancel has a bounded unknown result with job ID', { timeout: 7000 }, async (t) => {
  const f = fixture(t);
  const lane = f.lane('silent-wait-silent-cancel');
  try {
    const started = performance.now();
    const result = await lane.dispatch('has job ID', { timeoutMs: 700 });
    assert.ok(performance.now() - started < 4500, 'wait and cancel must not wait for process exit');
    assert.equal(result.status, 'unknown');
    assert.equal(result.jobId, 'job-1');
    assert.match(result.error, /outcome unknown.*opencode_job_cancel.*deadline/);
    assert.deepEqual(f.rows().map((r) => r.name), ['opencode_fire', 'opencode_wait', 'opencode_job_cancel']);
  } finally {
    await lane.close();
  }
});

test('a confirmed cancel after a silent wait is distinguished from unknown', { timeout: 6000 }, async (t) => {
  const f = fixture(t);
  const lane = f.lane('silent-wait-confirmed-cancel');
  try {
    const result = await lane.dispatch('confirm cancel', { timeoutMs: 700 });
    assert.equal(result.status, 'timed_out', result.error);
    assert.match(result.error, /cancel reported cancelled/);
    assert.equal(result.jobId, 'job-1');
  } finally {
    await lane.close();
  }
});

test('agent-mode stalled fire preserves its actual locked checkout across owner exit and stale sweep', { timeout: 14_000 }, async (t) => {
  const f = fixture(t);
  const repo = join(f.dir, 'fixture-repo');
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 3000 });
  const init = spawnSync('git', ['init', '-q', repo], { encoding: 'utf8', timeout: 3000 });
  assert.equal(init.status, 0, init.stderr);
  writeFileSync(join(repo, 'committed.txt'), 'fixture');
  git('add', 'committed.txt');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
  const moduleUrl = new URL('../scripts/shared/mcp-dispatch-lane.mjs', import.meta.url).href;
  const runner = `
    const [moduleUrl, cwd, stub, log] = process.argv.slice(1);
    const {openDispatchLane} = await import(moduleUrl);
    const lane = openDispatchLane({command: process.execPath, args: ['-e', stub, 'silent-fire', log], cwd});
    try {
      const result = await lane.dispatch('agent fixture', {timeoutMs: 2000, mode: 'agent'});
      process.stdout.write(JSON.stringify(result));
    } finally {
      await lane.close();
    }
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', runner, moduleUrl, repo, stub, f.log],
    { encoding: 'utf8', cwd: repo, timeout: 8000 });
  assert.equal(child.status, 0, child.stderr || child.error?.message);
  const result = JSON.parse(child.stdout);
  assert.equal(result.status, 'unknown');
  assert.equal(result.jobId, undefined);
  assert.match(result.error, /opencode_fire/);
  const [fire] = f.rows();
  assert.equal(f.rows().length, 1);
  assert.equal(fire.name, 'opencode_fire');
  assert.equal(fire.args.agent, 'dispatch');
  assert.equal(fire.args.directory, result.checkout);
  assert.equal(readFileSync(join(result.checkout, 'committed.txt'), 'utf8'), 'fixture');
  const container = laneWorktreeContainer(repo);
  const unprotected = join(container, 'dispatch-lane-0-feed');
  git('worktree', 'add', '--detach', unprotected);
  sweepStaleLaneWorktrees(repo, container);
  assert.equal(existsSync(unprotected), false);
  assert.equal(existsSync(result.checkout), true);
  assert.match(git('worktree', 'list', '--porcelain'), /locked agent-dispatch execution may still use this checkout/);

  const normal = f.lane();
  try {
    const success = await normal.dispatch('agent finished', { timeoutMs: 3500, mode: 'agent', cwd: repo });
    assert.equal(success.status, 'completed');
    const completed = f.rows().find((r) => r.args.prompt === 'agent finished');
    assert.ok(completed);
    assert.notEqual(completed.args.directory, result.checkout);
    assert.equal(existsSync(completed.args.directory), false, 'a confirmed terminal job releases its checkout');
    assert.equal(existsSync(result.checkout), true);
  } finally {
    await normal.close();
  }
});

test('production triage never retries unknown fire in-run or on resume, but retries proven pre-fire failures', { timeout: 14_000 }, async (t) => {
  const f = fixture(t);
  const outPath = join(f.dir, 'out.jsonl');
  const entries = [
    { id: 'unknown', file: 'open-bugs.md', text: 'ACCEPTED_NO_REPLY' },
    { id: 'unknown', file: 'open-bugs.md', text: 'ACCEPTED_NO_REPLY' },
    { id: 'retry', file: 'open-bugs.md', text: 'PROVEN_PREFIRE_FAILURE' },
  ];
  let failPreFire = true;
  let preFireFailures = 0;
  const openLane = () => {
    const normal = f.lane();
    const silent = failPreFire ? f.lane('silent-init') : undefined;
    return {
      close: () => Promise.all([normal.close(), silent?.close()]),
      dispatch: async (prompt) => {
        if (silent && prompt.includes('PROVEN_PREFIRE_FAILURE')) {
          preFireFailures++;
          return silent.dispatch(prompt, { timeoutMs: 150 });
        }
        return normal.dispatch(prompt, { timeoutMs: prompt.includes('ACCEPTED_NO_REPLY') ? 600 : 3000 });
      },
    };
  };
  const options = { root: f.dir, outPath, entries, concurrency: 1, openLane };
  await triage(options);
  const first = f.rows(outPath);
  const unknown = first.find((r) => r.id === 'unknown');
  assert.equal(unknown.execution_unknown, true);
  assert.match(unknown.error, /outcome unknown.*opencode_fire/);
  assert.equal(unknown.verdict, undefined);
  assert.equal(first.find((r) => r.id === 'retry').execution_unknown, undefined);
  assert.equal(preFireFailures, 2);
  const fires = (marker) => f.rows().filter((r) => r.name === 'opencode_fire' && r.args.prompt.includes(marker));
  assert.equal(fires('ACCEPTED_NO_REPLY').length, 1);
  assert.equal(fires('PROVEN_PREFIRE_FAILURE').length, 0);

  failPreFire = false;
  await triage(options);
  const resumed = f.rows(outPath);
  assert.deepEqual(resumed.find((r) => r.id === 'unknown'), unknown);
  assert.equal(resumed.find((r) => r.id === 'retry').verdict, 'actionable_now');
  assert.equal(fires('ACCEPTED_NO_REPLY').length, 1);
  assert.equal(fires('PROVEN_PREFIRE_FAILURE').length, 1);
  const stamp = JSON.parse(readFileSync(join(f.dir, 'out-coverage.json'), 'utf8'));
  assert.equal(stamp.prior_classified, 0);
  assert.equal(stamp.classified_total, 1);
  assert.equal(stamp.unresolved_execution, 1);
  assert.equal(stamp.attempted, 1);
});
