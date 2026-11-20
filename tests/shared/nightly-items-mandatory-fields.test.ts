// The compact index is a projection of an existing stored queue.
import { seedStoredQueue } from "../helpers/storedNightlyQueue.js";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSyncHidden } from '../helpers/spawn.mjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  readOpenItems,
  readOpenItemsIndex,
  recordDecision,
  OPEN_ITEMS_INDEX_RELPATH,
} from '../../scripts/nightly/items.mjs';

const PROBE_FILE = 'src-probe.txt';

let root: string;

function git(...args: string[]): void {
  const out = spawnSyncHidden('git', args, { cwd: root, encoding: 'utf8' });
  if (out.status !== 0) throw new Error(`git ${args.join(' ')}: ${out.stderr}`);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nightly-fields-'));
  writeFileSync(join(root, PROBE_FILE), 'const ANCHOR_PRESENT = 1;\n');
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 't');
  git('add', PROBE_FILE);
  git('commit', '-qm', 'probe anchor');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const ELI5 =
  'The routine wrote items with no answer buttons and no plain-terms summary, so every ' +
  'question cost the owner an essay instead of a single press on a named choice.';

const OPTIONS = [
  { label: 'Keep it', answer: 'Keep the pin, it is a deliberate anchor.' },
  { label: 'Drop it', answer: 'Remove the claim; it no longer holds.' },
];

const SUBJECT = 'the prose in question';
const ITEM_PATH = 'spec/foo.md';

const item = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'DOC-1',
  path: ITEM_PATH,
  title: 'The claim the code contradicts is still in the doc',
  subject: SUBJECT,
  subject_key: '1234567890abcdef',
  eli5: ELI5,
  options: OPTIONS,
  premise_probes: [{ file: PROBE_FILE, contains: 'ANCHOR_PRESENT' }],
  ...over,
});

describe('the queue index is enumerable in one bounded read', () => {
  it('carries every open item in the compact action shape', () => {
    seedStoredQueue(root, { items: [item()] });
    const index = readOpenItemsIndex(root);
    expect(index.count).toBe(1);
    expect(index.items[0]).toMatchObject({
      id: 'DOC-1',
      path: ITEM_PATH,
      subject_key: '1234567890abcdef',
    });
  });

  it('omits the prose fields that make the store unbounded', () => {
    seedStoredQueue(root, { items: [item()] });
    const raw = readFileSync(join(root, OPEN_ITEMS_INDEX_RELPATH), 'utf8');
    expect(raw).not.toContain('eli5');
    expect(raw).not.toContain('premise_probes');
    expect(raw).not.toContain('```');
  });

  it('carries the actionable TARGET, so acting on an answer needs no re-derivation', () => {
    seedStoredQueue(root, { items: [item()] });
    expect(readOpenItemsIndex(root).items[0].target).toEqual({ path: ITEM_PATH });
  });

  it('folds the settled ledger: an answered item leaves the index on the next write', () => {
    seedStoredQueue(root, { items: [item()] });
    expect(readOpenItemsIndex(root).count).toBe(1);
    // Settle the subject, then re-write the same item as the routine would.
    recordDecision(root, '1234567890abcdef', {
      answer: 'done',
      disposition: 'settled',
    });
    seedStoredQueue(root, { items: [item()] });
    expect(readOpenItemsIndex(root).count).toBe(0);
    expect(readOpenItemsIndex(root).items).toEqual([]);
  });

  it('reports count 0 rather than throwing when the index has never been written', () => {
    expect(readOpenItemsIndex(root)).toMatchObject({ count: 0, items: [] });
  });

  it('carries no timestamp — it is a pure projection, so regeneration emits identical bytes', () => {
    // The freshness check byte-compares the index to its projection.
    seedStoredQueue(root, { items: [item()] });
    expect(readFileSync(join(root, OPEN_ITEMS_INDEX_RELPATH), 'utf8')).not.toMatch(/generated_at/);
    expect(readOpenItemsIndex(root).run).toEqual(readOpenItems(root).run);
  });
});
