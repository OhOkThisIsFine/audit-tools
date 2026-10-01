import { writeApprovedPlanFixture } from "./helpers/canonicalPlanFixture.js";
import { executionPlanPaths } from "../../src/remediate/contractPipeline/executionPlan.js";
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { changeOperatorLifecycle } from "../../src/remediate/steps/nextStep.js";
import { spawnSyncHidden } from '../helpers/spawn.mjs';
import { createNextStepHarness, makePlanningState } from './helpers/nextStepHarness.js';

const harness = createNextStepHarness('.test-operator-lifecycle');
const { REPO_DIR, ARTIFACTS_DIR } = harness;
const CLI = fileURLToPath(new URL('../../src/remediate/index.ts', import.meta.url));
const LOADER = pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm')).href;
const controlPath = () => join(ARTIFACTS_DIR, 'operator-lifecycle.json');
const statePath = () => join(ARTIFACTS_DIR, 'state.json');
function cli(...args: string[]) {
  return spawnSyncHidden(process.execPath, ['--import', LOADER, CLI, ...args, '--root', REPO_DIR], {
    cwd: REPO_DIR, encoding: 'utf8', timeout: 30_000,
    env: { ...process.env,
      TSX_TSCONFIG_PATH: fileURLToPath(new URL('../../tsconfig.test.json', import.meta.url)) },
  });
}
function ok(...args: string[]) {
  const result = cli(...args);
  expect(result.status, result.stderr || result.stdout).toBe(0);
  return JSON.parse(result.stdout);
}
beforeEach(async () => {
  await harness.resetTestRepo();
  // Fresh CLI processes cannot inherit the in-process harness runner. Give the
  // fixture a real, bounded repository test command instead of disabling gates.
  await writeFile(join(REPO_DIR, 'package.json'), JSON.stringify({
    name: 'operator-lifecycle-fixture', private: true,
    scripts: { test: 'node --test verification.test.cjs' },
  }));
  await writeFile(join(REPO_DIR, 'verification.test.cjs'), [
    "const { test } = require('node:test');",
    "const assert = require('node:assert/strict');",
    "const { readFileSync } = require('node:fs');",
    "test('fixture verification input stays intact', () => {",
    "  assert.equal(readFileSync('verification-input.txt', 'utf8'), 'expected fixture value');",
    "});",
  ].join('\n'));
  await writeFile(join(REPO_DIR, 'verification-input.txt'), 'expected fixture value');
});
afterEach(async () => { await harness.cleanupTestRepo(); });

describe('persisted operator lifecycle through fresh CLI processes', () => {
  it('pauses before intake, is idempotent, and cancellation is terminal without deleting artifacts', async () => {
    await writeFile(join(ARTIFACTS_DIR, 'keep.txt'), 'retained');
    expect(ok('pause', '--worktree', '/host/reported/worktree', '--outcome', 'waiting for review').step_kind).toBe('operator_paused');
    const paused = await readFile(controlPath(), 'utf8');
    ok('pause');
    expect(await readFile(controlPath(), 'utf8')).toBe(paused);
    expect(ok('next-step').step_kind).toBe('operator_paused');
    const guidance = join(REPO_DIR, 'guidance.md');
    await writeFile(guidance, 'do not consume while paused');
    expect(ok('next-step', '--guidance-file', guidance).step_kind).toBe('operator_paused');
    await expect(readFile(join(ARTIFACTS_DIR, 'intake/conversation-start.md'))).rejects.toThrow();
    ok('cancel');
    const cancelled = await readFile(controlPath(), 'utf8');
    ok('cancel');
    expect(await readFile(controlPath(), 'utf8')).toBe(cancelled);
    expect(ok('next-step', '--force-replan', '--finalize-closing').step_kind).toBe('operator_cancelled');
    expect(cli('resume').status).not.toBe(0);
    expect(await readFile(join(ARTIFACTS_DIR, 'keep.txt'), 'utf8')).toBe('retained');
    expect(JSON.parse(cancelled).host_report.worktree).toBe('/host/reported/worktree');
  });

  it('keeps accepted items and the active workload binding intact across pause/resume', async () => {
    await mkdir(join(REPO_DIR, 'src'), { recursive: true });
    await writeFile(join(REPO_DIR, 'src/a.ts'), 'export const a = 1;\n');
    await writeFile(join(REPO_DIR, 'src/b.ts'), 'export const b = 2;\n');
    const state = makePlanningState({ status: 'implementing' });
    state.items!['B-001']!.status = 'resolved';
    await harness.acknowledgeResume(); await harness.writeIntentCheckpoint();
    await writeApprovedPlanFixture(ARTIFACTS_DIR, state, REPO_DIR);
    await harness.saveState(state);
    expect(ok('next-step').step_kind).toBe('dispatch_implement');
    const before = await readFile(statePath(), 'utf8');
    const bound = JSON.parse(before).host_handoff;
    expect(bound.work_item_ids).toEqual(['B-002']);
    ok('pause');
    expect(ok('next-step', '--force-replan').step_kind).toBe('operator_paused');
    expect(await readFile(statePath(), 'utf8')).toBe(before);
    expect(cli('recover-ingest', '--run-id', bound.run_id).status).not.toBe(0);
    expect(await readFile(statePath(), 'utf8')).toBe(before);
    expect(ok('resume').step_kind).toBe('operator_resumed'); ok('resume');
    expect(ok('next-step').step_kind).toBe('dispatch_implement');
    const resumed = JSON.parse(await readFile(statePath(), 'utf8'));
    expect(resumed.items['B-001'].status).toBe('resolved');
    expect(resumed.host_handoff).toEqual(bound);
  });

  it('persists plan-only before intake and closes the interrupted planning boundary before dispatch', async () => {
    ok('next-step', '--plan-only');
    expect(JSON.parse(await readFile(controlPath(), 'utf8')).plan_only).toBe(true);
    // Simulate a restart after planning saved its successful implementing state
    // but before the same invocation wrote its pause. No implementation may run.
    await harness.saveState(makePlanningState({ status: 'implementing' }));
    const before = await readFile(statePath(), 'utf8');
    expect(ok('next-step').step_kind).toBe('operator_paused');
    expect(await readFile(statePath(), 'utf8')).toBe(before);
    expect(JSON.parse(await readFile(statePath(), 'utf8')).host_handoff).toBeUndefined();
  });

  it('finishes approved planning before its automatic pause, but never calls a failed plan finished', async () => {
    await harness.acknowledgeResume(); await harness.writeIntentCheckpoint();
    const initial = makePlanningState();
    await writeApprovedPlanFixture(ARTIFACTS_DIR, initial, REPO_DIR);
    await harness.saveState(initial);
    expect(ok('next-step', '--plan-only').step_kind).toBe('operator_paused');
    const planned = JSON.parse(await readFile(statePath(), 'utf8'));
    expect(planned.status).toBe('implementing');
    expect(planned.host_handoff).toBeUndefined();
    ok('resume');
    // A genuine planning-integrity refusal must still surface as a refusal,
    // rather than being relabelled a successful plan-only stop.
    const broken = makePlanningState();
    await harness.saveState(broken);
    await writeFile(executionPlanPaths(ARTIFACTS_DIR).approval, '{}');
    expect(ok('next-step', '--plan-only').step_kind).toBe('contract_pipeline');
    expect(JSON.parse(await readFile(controlPath(), 'utf8')).mode).toBe('active');
  });

  it('concurrent resume and cancel cannot reopen the cancelled run', async () => {
    ok('pause');
    await Promise.allSettled([
      changeOperatorLifecycle({ root: REPO_DIR, action: 'resume' }),
      changeOperatorLifecycle({ root: REPO_DIR, action: 'cancel' }),
    ]);
    expect(JSON.parse(await readFile(controlPath(), 'utf8')).mode).toBe('cancelled');
    expect(ok('next-step').step_kind).toBe('operator_cancelled');
  });

  it('refuses malformed persisted control instead of silently advancing', async () => {
    await writeFile(controlPath(), JSON.stringify({ mode: 'paused' }));
    expect(cli('next-step').status).not.toBe(0);
  });
});
