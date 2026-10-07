import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { execFileSyncHidden } from '../helpers/spawn.mjs';
import { prepareAuditHostHandoff, ingestAuditHostResults, type AuditHostTask } from '../../src/audit/cli/dispatch/hostHandoff.js';
let root: string;
let artifactsDir: string;
const runId = 'root-log-test';
const task: AuditHostTask = { task_id: 'task', unit_id: 'unit', pass_id: 'pass', lens: 'security', file_paths: ['a.ts'], file_line_counts: { 'a.ts': 1 }, rationale: 'Review', priority: 'low', demand: { size: 'small', complexity: 'focused', risk: 'low' }, token_estimate: 10 };
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'root-log-boundary-'));
  artifactsDir = join(root, '.audit-tools/audit');
  const git = (...args: string[]) => execFileSyncHidden('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  await writeFile(join(root, '.gitignore'), '*.log\n*.out\n*.err\n.audit-tools/\n');
  await writeFile(join(root, 'a.ts'), 'const a = 1;');
  git('add', '.'); git('commit', '-qm', 'fixture');
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
const prepare = () => prepareAuditHostHandoff({ root, artifactsDir, runId, tasks: [task] });
const ingest = () => ingestAuditHostResults({ pendingTaskIds: new Set(), root, artifactsDir, runId, auditTasks: [] });

it('observes only new ignored root logs once across reprepare, without attributing or deleting them', async () => {
  await writeFile(join(root, 'old.log'), 'before');
  const first = await prepare();
  const recordPath = join(dirname(first.workload_path), 'root-log-observations.json');
  const peer = process.platform === 'win32' ? 'peer session.log' : 'peer\nsession.log';
  await writeFile(join(root, 'fresh.log'), 'after');
  await writeFile(join(root, peer), 'another session may own this');
  await writeFile(join(root, 'old.log'), 'changed existing file');
  await writeFile(join(root, 'notes.txt'), 'not a log');
  await mkdir(join(root, '.audit-tools/logs'), { recursive: true });
  await writeFile(join(root, '.audit-tools/logs/owned.log'), 'sanctioned nested output');
  await prepare(); // A re-emission must not erase the first baseline.
  const warnings = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  await ingest();
  await ingest();
  const record = JSON.parse(await readFile(recordPath, 'utf8'));
  expect(record.observations.map((entry: { name: string }) => entry.name).sort()).toEqual(['fresh.log', peer].sort());
  expect(record.observations.every((entry: { creator: string }) => entry.creator === 'unknown')).toBe(true);
  expect(warnings.mock.calls.filter(([line]) => String(line).includes('new ignored root log'))).toHaveLength(1);
  expect(warnings.mock.calls.map(([line]) => String(line)).join('')).toContain('creator/session unknown');
  for (const name of ['old.log', 'fresh.log', peer, 'notes.txt', '.audit-tools/logs/owned.log']) {
    expect(await readFile(join(root, name), 'utf8')).not.toBe('');
  }
});

it('does not infer new files without a pre-execution baseline', async () => {
  const first = await prepare();
  const recordPath = join(dirname(first.workload_path), 'root-log-observations.json');
  await rm(recordPath, { force: true });
  await writeFile(join(root, 'unknown.log'), 'no baseline to compare');
  const warnings = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  await ingest();
  const record = JSON.parse(await readFile(recordPath, 'utf8'));
  expect(record.observations).toEqual([]);
  expect(record.baseline.status).toBe('unavailable');
  expect(warnings.mock.calls.map(([line]) => String(line)).join('')).toMatch(/baseline.*missing|missing.*baseline/i);
  expect(await readFile(join(root, 'unknown.log'), 'utf8')).toBe('no baseline to compare');
});

it('reports a bounded partial inventory rather than labeling an unscanned old file as new', async () => {
  await Promise.all(Array.from({ length: 200 }, (_, i) => writeFile(join(root, `${i}.log`), 'old')));
  const first = await prepare();
  await writeFile(join(root, 'later.log'), 'new, but comparison is incomplete');
  await ingest();
  const record = JSON.parse(await readFile(join(dirname(first.workload_path), 'root-log-observations.json'), 'utf8'));
  expect(record.baseline.status).toBe('partial');
  expect(record.observations).toEqual([]);
  expect((await readdir(root)).filter((name) => name.endsWith('.log'))).toHaveLength(201);
});

it('reports an unavailable git inventory without failing the handoff', async () => {
  await rm(join(root, '.git'), { recursive: true, force: true });
  await writeFile(join(root, 'unknown.log'), 'ignore status cannot be established');
  const first = await prepare();
  const record = JSON.parse(await readFile(join(dirname(first.workload_path), 'root-log-observations.json'), 'utf8'));
  expect(record.baseline.status).toBe('unavailable');
  expect(record.observations).toEqual([]);
});

it('does not label a preexisting unignored root log new when ignore rules change', async () => {
  await writeFile(join(root, '.gitignore'), '.audit-tools/\n');
  await writeFile(join(root, 'existing.log'), 'already present');
  const first = await prepare();
  await writeFile(join(root, '.gitignore'), '.audit-tools/\n*.log\n');
  await ingest();
  const record = JSON.parse(await readFile(join(dirname(first.workload_path), 'root-log-observations.json'), 'utf8'));
  expect(record.observations).toEqual([]);
  expect(await readFile(join(root, 'existing.log'), 'utf8')).toBe('already present');
});
