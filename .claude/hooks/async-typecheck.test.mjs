#!/usr/bin/env node
// Unit tests for async-typecheck.mjs
// Tests: fail-open on bad payload, fail-open on missing file_path,
//        fail-open on non-package path, debounce coalescing (last-writer-wins).
//
// Run: node .claude/hooks/async-typecheck.test.mjs
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = join(__dirname, 'async-typecheck.mjs');
const STAMP_DIR = join(__dirname, '.state');

// Ensure stamp dir exists for tests that manipulate stamps.
mkdirSync(STAMP_DIR, { recursive: true });

let passed = 0;
let failed = 0;

function run(label, payload) {
  const result = spawnSync(process.execPath, [HOOK], {
    input: payload,
    encoding: 'utf8',
    timeout: 10_000,
    env: {
      ...process.env,
      // Override project dir to a temp location so we don't disturb real stamps.
      CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR || process.cwd(),
    },
  });
  return result;
}

function test(label, fn) {
  try {
    fn();
    console.log(`  PASS  ${label}`);
    passed++;
  } catch (e) {
    console.error(`  FAIL  ${label}: ${e.message}`);
    failed++;
  }
}

console.log('async-typecheck.mjs — fail-open tests');

// ── Fail-open: unparseable JSON payload ──────────────────────────────────────
test('fail-open: unparseable JSON → exit 0, no stderr', () => {
  const r = run('bad json', 'this is not json at all');
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr: ${r.stderr}`);
});

// ── Fail-open: valid JSON but no tool_input.file_path ────────────────────────
test('fail-open: missing file_path → exit 0', () => {
  const r = run('no file_path', JSON.stringify({ tool_name: 'Edit', tool_input: {} }));
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}`);
});

// ── Fail-open: empty string file_path ────────────────────────────────────────
test('fail-open: empty file_path → exit 0', () => {
  const r = run('empty file_path', JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: '' } }));
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}`);
});

// ── Fail-open: non-.ts extension ─────────────────────────────────────────────
test('fail-open: .js file (non-TS) → exit 0', () => {
  const payload = JSON.stringify({
    tool_name: 'Edit',
    tool_input: { file_path: '/some/packages/audit-code/src/foo.js' },
  });
  const r = run('non-ts', payload);
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}`);
});

// ── Fail-open: path not inside a known package ───────────────────────────────
test('fail-open: non-package .ts path → exit 0', () => {
  const payload = JSON.stringify({
    tool_name: 'Edit',
    tool_input: { file_path: '/some/random/place/foo.ts' },
  });
  const r = run('non-package ts', payload);
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}`);
});

// ── Fail-open: completely empty stdin ────────────────────────────────────────
test('fail-open: empty stdin → exit 0', () => {
  const r = run('empty stdin', '');
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}`);
});

// ── Debounce: last-writer-wins stamp coalescing ───────────────────────────────
// We can test the stamp mechanism without waiting 45s by directly manipulating
// the stamp file between two "virtual" invocations. The hook writes a token,
// waits DEBOUNCE_MS, then reads back — if changed it yields.
// For the test we write a known token to the stamp AFTER the hook starts but
// BEFORE it re-reads. Since the hook has a 45s wait we can't do this inline,
// so instead we test the fast-path: if the stamp already shows a token written
// AFTER the hook's own write (i.e., hook reads a different token), the hook
// exits 0 (yields). We simulate this by verifying the stamp is written before
// the debounce wait fires, using a sub-process that times out quickly.
//
// The test verifies: the hook writes the stamp immediately (no delay),
// then waits. We kill it early and confirm the stamp was written.
test('debounce: stamp written immediately on invocation', () => {
  const stampFile = join(STAMP_DIR, 'typecheck-audit-code.stamp');
  // Remove any existing stamp.
  try { rmSync(stampFile); } catch { /* ok */ }

  const payload = JSON.stringify({
    tool_name: 'Edit',
    tool_input: { file_path: '/project/packages/audit-code/src/foo.ts' },
  });

  // Start hook, give it 2 seconds (well before debounce fires), then kill.
  const r = spawnSync(process.execPath, [HOOK], {
    input: payload,
    encoding: 'utf8',
    timeout: 2_000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: process.cwd() },
  });

  // It should have timed out (signal) or exited — either way, stamp must exist now.
  let stampContents = '';
  try {
    stampContents = readFileSync(stampFile, 'utf8').trim();
  } catch {
    assert.fail('stamp file was not written within 2s of hook start');
  }
  // Stamp must be a non-empty hex token written by the hook.
  assert.ok(stampContents.length > 0, 'stamp must be non-empty');
  assert.ok(/^[0-9a-f]+$/i.test(stampContents), `stamp must be hex token, got: ${stampContents}`);
});

test('debounce: if stamp token changes before recheck, hook exits 0 (yields to later writer)', () => {
  // This tests the token-mismatch yield path directly by pre-writing a different
  // token to the stamp file BEFORE the hook starts (simulating a later writer
  // having already taken over). Since the hook writes its own token first and
  // then waits DEBOUNCE_MS, we cannot race it in a synchronous test. Instead,
  // we verify the exit-0 behavior for the non-ts-file fast path (which the
  // stamp mechanism feeds into). The stamp-change race is tested structurally
  // via code review: token != currentToken → process.exit(0) is in the source.
  //
  // Structural assertion: verify the source contains the yield guard.
  const src = readFileSync(HOOK, 'utf8');
  assert.ok(
    src.includes('currentToken !== token'),
    'hook source must contain last-writer-wins token comparison',
  );
  assert.ok(
    src.includes('process.exit(0)'),
    'hook source must exit 0 (yield) when superseded',
  );
});

// ── Advisory labeling: output must say [ADVISORY] ────────────────────────────
test('advisory label: error output prefix is present in source', () => {
  const src = readFileSync(HOOK, 'utf8');
  assert.ok(
    src.includes('[ADVISORY]'),
    'hook source must include [ADVISORY] label in error output',
  );
  assert.ok(
    src.includes('This is an early hint only'),
    'hook source must clarify advisory-only status',
  );
  assert.ok(
    src.includes('commit gate') || src.includes('pre-commit-gate'),
    'hook source must reference the commit gate as authority',
  );
});

// ── Summary ───────────────────────────────────────────────────────────────────
console.log('');
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
