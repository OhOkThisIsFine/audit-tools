#!/usr/bin/env node
// Unit tests for the doc-review clear-on-apply ledger.
// Tests: ID parsing, record/read round-trip, SHA-keyed filtering, SHA-pruning
//        (stale generation auto-expires), malformed-ledger fail-open.
//
// Run: node .claude/hooks/doc-review-resolve.test.mjs
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import {
  parseItemId,
  recordResolved,
  resolvedIdsFor,
  readLedger,
} from './docReviewLedger.mjs';

let passed = 0;
let failed = 0;
function test(label, fn) {
  try {
    fn();
    console.log(`  PASS  ${label}`);
    passed++;
  } catch (e) {
    console.log(`  FAIL  ${label}\n        ${e.message}`);
    failed++;
  }
}

const dir = mkdtempSync(join(tmpdir(), 'docrev-'));
const ledger = join(dir, 'resolved.json');

test('parseItemId pulls the [ID] token', () => {
  assert.equal(parseItemId('- [AF-1] some text'), 'AF-1');
  assert.equal(parseItemId('  * [D-5] indented'), 'D-5');
  assert.equal(parseItemId('## a header'), null);
  assert.equal(parseItemId('plain continuation line'), null);
});

test('record + resolvedIdsFor round-trip, SHA-scoped', () => {
  recordResolved('sha-aaa', ['AF-1', 'D-5'], ledger);
  const got = resolvedIdsFor('sha-aaa', ledger);
  assert.ok(got.has('AF-1') && got.has('D-5'));
  // A different SHA shares nothing — recycled IDs in a new generation surface.
  assert.equal(resolvedIdsFor('sha-bbb', ledger).size, 0);
});

test('recording a new SHA prunes the old generation', () => {
  recordResolved('sha-aaa', ['AF-1'], ledger);
  recordResolved('sha-bbb', ['D-6'], ledger);
  const l = readLedger(ledger);
  assert.deepEqual(Object.keys(l), ['sha-bbb']); // old SHA dropped
  assert.equal(resolvedIdsFor('sha-aaa', ledger).size, 0);
  assert.ok(resolvedIdsFor('sha-bbb', ledger).has('D-6'));
});

test('additive within a SHA, idempotent', () => {
  recordResolved('sha-ccc', ['AF-1'], ledger);
  recordResolved('sha-ccc', ['AF-1', 'D-5'], ledger);
  const got = resolvedIdsFor('sha-ccc', ledger);
  assert.deepEqual([...got].sort(), ['AF-1', 'D-5']);
});

test('malformed/absent ledger fails open to empty', () => {
  const bad = join(dir, 'bad.json');
  writeFileSync(bad, '{not json', 'utf8');
  assert.deepEqual(readLedger(bad), {});
  assert.equal(resolvedIdsFor('whatever', join(dir, 'nope.json')).size, 0);
});

test('empty ids / empty sha are no-ops', () => {
  const before = readLedger(ledger);
  recordResolved('', ['AF-1'], ledger);
  recordResolved('sha-ddd', [], ledger);
  assert.deepEqual(readLedger(ledger), before);
});

rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
