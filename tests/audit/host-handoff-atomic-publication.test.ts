import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as lockIo from '../../src/shared/io/fileLock.js';
import type { RunLogger } from '../../src/shared/observability/runLog.js';
import * as jsonIo from '../../src/shared/io/json.js';
import { expectedSubmissionsPath } from '../../src/shared/io/auditToolsPaths.js';
import { readSubmissionLedger } from '../../src/shared/submission/submissionLedger.js';
import { recordExpectedLanes, recordLaneOutcome, AUDIT_GATE_SUBMISSION_SCOPE } from '../../src/audit/cli/laneSubmissions.js';
import { prepareAuditHostHandoff, ingestAuditHostResults, type AuditHostTask } from '../../src/audit/cli/dispatch/hostHandoff.js';
let root: string;
let artifactsDir: string;
const runId = 'atomic-run';
const task: AuditHostTask = { task_id: 'task-a', unit_id: 'unit-a', pass_id: 'pass-a', lens: 'security', file_paths: ['a.ts'], file_line_counts: { 'a.ts': 1 }, rationale: 'Review a', priority: 'high', demand: { size: 'small', complexity: 'focused', risk: 'low' }, token_estimate: 10 };
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'audit-atomic-'));
  artifactsDir = join(root, '.audit-tools/audit');
  await mkdir(artifactsDir, { recursive: true });
  await writeFile(join(root, 'a.ts'), 'const x = 1;');
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

it('retries expected-set removal after accepted append persisted but removal failed', async () => {
  const lane = 'design_review_conceptual';
  await recordExpectedLanes(artifactsDir, AUDIT_GATE_SUBMISSION_SCOPE, [{ lane, promptText: 'Review' }]);
  const path = expectedSubmissionsPath(artifactsDir);
  const original = await readFile(path, 'utf8');
  await rm(path);
  await mkdir(path);
  await expect(recordLaneOutcome(artifactsDir, lane, { kind: 'accepted' })).rejects.toThrow();
  expect((await readSubmissionLedger(artifactsDir)).filter((e) => e.kind === 'accepted')).toHaveLength(1);
  await rm(path, { recursive: true });
  await writeFile(path, original);
  await recordLaneOutcome(artifactsDir, lane, { kind: 'rejected', issueCode: 'submission_contract_invalid', message: 'later rejected' });
  await recordLaneOutcome(artifactsDir, lane, { kind: 'accepted' });
  expect((await readSubmissionLedger(artifactsDir)).filter((e) => e.kind === 'accepted')).toHaveLength(1);
  expect(JSON.parse(await readFile(path, 'utf8')).entries).toEqual([]);
});

it('publishes every binding document while holding the accepted-results lock', async () => {
  const original = jsonIo.writeJsonFile;
  const writes: Array<{ path: string; locked: boolean }> = [];
  vi.spyOn(jsonIo, 'writeJsonFile').mockImplementation(async (path, value) => {
    if (/host-(?:task-bindings|workload|result-map)\.json$/.test(path)) {
      writes.push({ path, locked: existsSync(join(dirname(path), 'host-accepted-results.lock')) });
    }
    return original(path, value);
  });
  await prepareAuditHostHandoff({ root, artifactsDir, runId, tasks: [task] });
  expect(writes).toHaveLength(3);
  expect(writes.every((w) => w.locked)).toBe(true);
});

it('reads the complete binding set under the same lock during ingestion', async () => {
  await prepareAuditHostHandoff({ root, artifactsDir, runId, tasks: [task] });
  const original = jsonIo.readJsonFile;
  const reads: Array<{ path: string; locked: boolean }> = [];
  vi.spyOn(jsonIo, 'readJsonFile').mockImplementation(async <T>(path: string): Promise<T> => {
    if (/host-(?:task-bindings|workload|result-map|accepted-results-ledger)\.json$/.test(path)) {
      reads.push({ path, locked: existsSync(join(dirname(path), 'host-accepted-results.lock')) });
    }
    return original<T>(path);
  });
  await ingestAuditHostResults({ root, artifactsDir, runId, auditTasks: [] });
  expect(reads.length).toBeGreaterThanOrEqual(4);
  expect(reads.every((r) => r.locked)).toBe(true);
});

it('a held accepted lock prevents publication until the prior coherent generation is released', async () => {
  const prepared = await prepareAuditHostHandoff({ root, artifactsDir, runId, tasks: [task] });
  const runDir = dirname(prepared.workload_path);
  const path = join(runDir, 'host-task-bindings.json');
  const before = await readFile(path, 'utf8');
  const lockPath = join(runDir, 'host-accepted-results.lock');
  const originalLock = lockIo.withFileLock;
  let publication: ReturnType<typeof prepareAuditHostHandoff> | undefined;
  await originalLock(lockPath, async () => {
    let notify!: () => void;
    const attempted = new Promise<void>((resolve) => { notify = resolve; });
    vi.spyOn(lockIo, 'withFileLock').mockImplementation(async <T>(
      path: string, fn: () => Promise<T>, timeout?: number, logger?: RunLogger, options?: lockIo.LockOptions,
    ): Promise<T> => {
      if (path === lockPath) notify();
      return originalLock(path, fn, timeout, logger, options);
    });
    publication = prepareAuditHostHandoff({ root, artifactsDir, runId, tasks: [{ ...task, rationale: 'Changed scope prompt' }] });
    await attempted;
    expect(await readFile(path, 'utf8')).toBe(before);
  });
  await publication;
  expect(await readFile(path, 'utf8')).not.toBe(before);
  expect(existsSync(lockPath)).toBe(false);
});

it.each(['workload', 'map', 'bindings', 'json'])('reports repairable %s corruption without throwing or accepting stale results', async (kind) => {
  const prepared = await prepareAuditHostHandoff({ root, artifactsDir, runId, tasks: [task] });
  const runDir = dirname(prepared.workload_path);
  const path = kind === 'bindings' ? join(runDir, 'host-task-bindings.json') : kind === 'map' ? prepared.result_map_path : prepared.workload_path;
  if (kind === 'json') await writeFile(path, '{ broken');
  else {
    const body = JSON.parse(await readFile(path, 'utf8'));
    if (kind === 'workload') body.work_items[0].prompt.text += 'changed';
    if (kind === 'map') body.entries = [];
    if (kind === 'bindings') body.entries[0].prompt_sha256 = '0'.repeat(64);
    await writeFile(path, JSON.stringify(body));
  }
  const summary = await ingestAuditHostResults({ root, artifactsDir, runId, auditTasks: [] });
  expect(summary.accepted_count).toBe(0);
  expect(summary.issues).toEqual([expect.objectContaining({ code: 'workload_stale', check: 'workload_binding', message: expect.stringMatching(/re-prepare/i) })]);
  await prepareAuditHostHandoff({ root, artifactsDir, runId, tasks: [task] });
  const repaired = await ingestAuditHostResults({ root, artifactsDir, runId, auditTasks: [] });
  expect(repaired.issues.some((issue) => issue.code === 'workload_stale')).toBe(false);
});

it('concurrent preparation and ingestion preserve the accepted partial wave', async () => {
  const prepared = await prepareAuditHostHandoff({ root, artifactsDir, runId, tasks: [task] });
  const item = prepared.workload.work_items[0]!;
  await writeFile(join(root, item.result_path), JSON.stringify({
    contract_version: 'audit-host-result/v1alpha1', result_id: `${item.id}-${item.prompt.sha256.slice(0, 12)}`,
    run_id: runId, work_item_id: item.id, prompt_sha256: item.prompt.sha256,
    file_coverage: [{ path: 'a.ts', reviewed_lines: 1, total_lines: 1 }], findings: [],
  }));
  const first = await ingestAuditHostResults({ root, artifactsDir, runId, auditTasks: [] });
  expect(first.accepted_count).toBe(1);
  await Promise.all([
    prepareAuditHostHandoff({ root, artifactsDir, runId, tasks: [{ ...task, rationale: 'Changed prompt' }] }),
    ingestAuditHostResults({ root, artifactsDir, runId, auditTasks: [] }),
  ]);
  const repeated = await ingestAuditHostResults({ root, artifactsDir, runId, auditTasks: [] });
  expect(repeated.accepted_count).toBe(0);
  expect(repeated.accepted_results).toHaveLength(1);
  expect(repeated.issues.some((issue) => /identity|prompt/i.test(issue.message))).toBe(true);
});

it('keeps real IO and corrupt accepted-ledger failures strict and releases the lock', async () => {
  const prepared = await prepareAuditHostHandoff({ root, artifactsDir, runId, tasks: [task] });
  const runDir = dirname(prepared.workload_path);
  const ledgerPath = join(runDir, 'host-accepted-results-ledger.json');
  const originalLedger = await readFile(ledgerPath, 'utf8');
  await writeFile(ledgerPath, '{ broken ledger');
  await expect(ingestAuditHostResults({ root, artifactsDir, runId, auditTasks: [] })).rejects.toThrow();
  expect(existsSync(join(runDir, 'host-accepted-results.lock'))).toBe(false);
  await writeFile(ledgerPath, originalLedger);
  await rm(prepared.workload_path);
  await mkdir(prepared.workload_path);
  await expect(ingestAuditHostResults({ root, artifactsDir, runId, auditTasks: [] })).rejects.toThrow();
  expect(existsSync(join(runDir, 'host-accepted-results.lock'))).toBe(false);
  expect(await readFile(ledgerPath, 'utf8')).toBe(originalLedger);
});
