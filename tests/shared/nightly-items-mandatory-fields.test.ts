// P32 (nightly sol-7, owner decision 2026-08-18): the two fields that make an
// item ANSWERABLE — `options[]` and `eli5` — are enforced at write, beside the
// four probe refusals that make it CLOSABLE. On 2026-07-29, 18 items shipped
// with no options because the contract only NAMED the field and the renderer
// degrades silently (render-inbox defaults options to [] and renders the
// plain-terms block only when eli5 is truthy). A named requirement is not a
// refusal. Lives under tests/ because vitest excludes `.claude/**` and the
// other nightly tests already sit here.
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSyncHidden } from '../helpers/spawn.mjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  readOpenItems,
  readOpenItemsIndex,
  recordDecision,
  subjectKey,
  writeOpenItems,
  OPEN_ITEMS_INDEX_RELPATH,
} from '../../scripts/nightly/items.mjs';

// Every fixture item probes this file, because writeOpenItems refuses an item
// whose premise is not verifiably true at creation. It must be git-TRACKED:
// P8 refuses a probe target git cannot speak about, so a bare temp dir (no
// repo) reads as "untrackable" and the probe refusal would fire before the
// fields under test are ever reached.
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
  subject_key: subjectKey(ITEM_PATH, SUBJECT),
  eli5: ELI5,
  options: OPTIONS,
  premise_probes: [{ file: PROBE_FILE, contains: 'ANCHOR_PRESENT' }],
  ...over,
});

describe('writeOpenItems refuses an item that cannot be ANSWERED (P32)', () => {
  it('refuses empty options[] — a bare text box costs an essay instead of a press', () => {
    expect(() => writeOpenItems(root, { items: [item({ options: [] })] })).toThrow(
      /options/,
    );
  });

  it('refuses malformed option entries, naming the malformed count', () => {
    const bad = item({
      options: [
        { label: '', answer: 'An answer with no label.' },
        { label: 'Fine', answer: 'A well-formed entry.' },
        { label: 'No answer at all' },
      ],
    });
    expect(() => writeOpenItems(root, { items: [bad] })).toThrow(/2 are malformed/);
  });

  it('refuses a missing eli5 — the plain-terms explanation is mandatory', () => {
    const bare = item();
    delete bare.eli5;
    expect(() => writeOpenItems(root, { items: [bare] })).toThrow(/eli5/);
  });

  it('refuses an id pasted in as the eli5 — the 80-char floor catches the documented substitution', () => {
    expect(() => writeOpenItems(root, { items: [item({ eli5: 'docs-4' })] })).toThrow(
      /eli5/,
    );
  });

  it('accepts a fully-formed item, and both fields round-trip through readOpenItems', () => {
    const payload = writeOpenItems(root, { items: [item()] });
    expect(payload.items).toHaveLength(1);
    const back = readOpenItems(root);
    expect(back.items[0].options).toEqual(OPTIONS);
    expect(back.items[0].eli5).toBe(ELI5);
  });
});

// The identity field everything downstream keys on (2026-08-14, re-hit
// 2026-08-19). `writeOpenItems` validated probes exhaustively and never checked
// `subject_key` — the field the durable-answer mechanism, the carry-forward and
// the HANDOFF generator all read — so a missing key was persisted here and the
// refusal landed two steps later as a BLOCKED COMMIT naming `items[N]` and
// HANDOFF rather than the malformed item.
describe('writeOpenItems DERIVES or REFUSES subject_key at write', () => {
  const noKey = (over: Record<string, unknown> = {}): Record<string, unknown> => {
    const it = item(over);
    delete it.subject_key;
    return it;
  };

  it('DERIVES the key from the item\'s own path + subject when it is absent', () => {
    const payload = writeOpenItems(root, { items: [noKey()] });
    expect(payload.items[0].subject_key).toBe(subjectKey(ITEM_PATH, SUBJECT));
    expect(readOpenItems(root).items[0].subject_key).toBe(subjectKey(ITEM_PATH, SUBJECT));
  });

  it('derives a key that the settled ledger can actually match', () => {
    // The point of deriving rather than merely accepting: the key must be the
    // SAME one a later `answer.mjs` computes, or the answer never settles it.
    writeOpenItems(root, { items: [noKey()] });
    const persisted = readOpenItems(root).items[0].subject_key;
    expect(persisted).toBe(subjectKey(ITEM_PATH, SUBJECT));
  });

  it('REFUSES an item that names neither a subject nor a path, naming the item', () => {
    expect(() => writeOpenItems(root, { items: [noKey({ subject: undefined, path: undefined })] })).toThrow(
      /subject_key/,
    );
  });

  it('refuses a missing title at write too — the HANDOFF generator would otherwise block the commit', () => {
    const bare = item();
    delete bare.title;
    expect(() => writeOpenItems(root, { items: [bare] })).toThrow(/title/);
  });

  it('refuses before ANY write — the queue is left untouched', () => {
    writeOpenItems(root, { items: [item({ id: 'GOOD-1' })] });
    const before = readFileSync(join(root, '.audit-tools/nightly/open-items.json'), 'utf8');
    expect(() =>
      writeOpenItems(root, { items: [item({ id: 'GOOD-1' }), noKey({ id: 'BAD-2', subject: undefined })] }),
    ).toThrow(/BAD-2/);
    expect(readFileSync(join(root, '.audit-tools/nightly/open-items.json'), 'utf8')).toBe(before);
  });

  it('normalizes a padded key rather than persisting whitespace the generator would refuse', () => {
    const payload = writeOpenItems(root, { items: [item({ subject_key: '  spaced-key  ' })] });
    expect(payload.items[0].subject_key).toBe('spaced-key');
  });
});

// The queue's on-disk form must be ENUMERABLE in one bounded read (2026-07-26
// friction walk): `open-items.json` is a 659-line / 26k-token document that
// exceeds the Read cap, so enumerating it needed a hand-written `node -e`. It is
// also the stale half — answering writes the ledger and never reconciled the
// queue. The index is the derived, bounded, ledger-folded projection.
describe('the queue index is enumerable in one bounded read', () => {
  it('carries every open item in the compact action shape', () => {
    writeOpenItems(root, { items: [item()] });
    const index = readOpenItemsIndex(root);
    expect(index.count).toBe(1);
    expect(index.items[0]).toMatchObject({
      id: 'DOC-1',
      path: ITEM_PATH,
      subject_key: subjectKey(ITEM_PATH, SUBJECT),
    });
  });

  it('omits the prose fields that make the store unbounded', () => {
    writeOpenItems(root, { items: [item()] });
    const raw = readFileSync(join(root, OPEN_ITEMS_INDEX_RELPATH), 'utf8');
    expect(raw).not.toContain('eli5');
    expect(raw).not.toContain('premise_probes');
    expect(raw).not.toContain('```');
  });

  it('carries the actionable TARGET, so acting on an answer needs no re-derivation', () => {
    writeOpenItems(root, { items: [item()] });
    expect(readOpenItemsIndex(root).items[0].target).toEqual({ path: ITEM_PATH });
  });

  it('folds the settled ledger: an answered item leaves the index on the next write', () => {
    writeOpenItems(root, { items: [item()] });
    expect(readOpenItemsIndex(root).count).toBe(1);
    // Settle the subject, then re-write the same item as the routine would.
    recordDecision(root, subjectKey(ITEM_PATH, SUBJECT), {
      answer: 'done',
      disposition: 'settled',
    });
    writeOpenItems(root, { items: [item()] });
    expect(readOpenItemsIndex(root).count).toBe(0);
    expect(readOpenItemsIndex(root).items).toEqual([]);
  });

  it('reports count 0 rather than throwing when the index has never been written', () => {
    expect(readOpenItemsIndex(root)).toMatchObject({ count: 0, items: [] });
  });

  it('carries no timestamp — it is a pure projection, so two writers emit identical bytes', () => {
    // `check:nightly-inbox` byte-compares the index against a re-derivation, and
    // TWO writers produce it (the queue write and the inbox render). A
    // `generated_at` would differ between them and leave the gate permanently
    // red. The store keeps the timestamp; the projection must not.
    writeOpenItems(root, { items: [item()] });
    expect(readFileSync(join(root, OPEN_ITEMS_INDEX_RELPATH), 'utf8')).not.toMatch(/generated_at/);
    expect(readOpenItemsIndex(root).run).toEqual(readOpenItems(root).run);
  });
});

// A run that writes the queue must leave `check:handoff-roadmap` green
// (2026-08-20). The generated LIVE STATUS block derives from the queue and the
// ledger, and the nightly run contract did not list regenerating it, so the
// desync was caught only afterwards by the closeout gate.
describe('writing the queue refreshes the generated HANDOFF state', () => {
  /**
   * A minimal HANDOFF: both generated marker pairs, the `## Immediate next` section the
   * write path requires, and the backlog sources.
   */
  function seedHandoff(): string {
    mkdirSync(join(root, 'docs', 'backlog'), { recursive: true });
    writeFileSync(
      join(root, 'docs', 'backlog', 'open-bugs.md'),
      '# Open bugs\n\n- **An entry that is not pinned.**\n',
      'utf8',
    );
    writeFileSync(
      join(root, 'docs', 'backlog', 'forward-tracks.md'),
      '# Forward tracks\n\n## Open tracks\n\n## Forward tracks\n',
      'utf8',
    );
    writeFileSync(join(root, 'docs', 'backlog', 'deferred.md'), '# Deferred\n', 'utf8');
    const path = join(root, 'docs', 'HANDOFF.md');
    writeFileSync(
      path,
      [
        '# Handoff',
        '',
        '<!-- BEGIN GENERATED LIVE STATUS — scripts/shared/generate-handoff-roadmap.mjs — DO NOT EDIT BY HAND -->',
        '<!-- END GENERATED LIVE STATUS -->',
        '',
        '<!-- BEGIN GENERATED ROADMAP — scripts/shared/generate-handoff-roadmap.mjs — DO NOT EDIT BY HAND -->',
        '<!-- END GENERATED ROADMAP -->',
        '',
        '## Immediate next',
        '',
        'None.',
        '',
      ].join('\n'),
      'utf8',
    );
    return path;
  }

  it('regenerates docs/HANDOFF.md live status in the same write, so the gate stays green', () => {
    const path = seedHandoff();
    writeOpenItems(root, { items: [item()] });
    const handoff = readFileSync(path, 'utf8');
    expect(handoff).toMatch(/DOC-1/);
    expect(handoff).toMatch(/1 nightly decision is waiting/);
  });

  it('a later queue write REMOVES an item the ledger has since settled', () => {
    // The desync shape from 2026-08-20: the block is generated, then the queue
    // changes. Because the write regenerates, the block follows in one step.
    const path = seedHandoff();
    writeOpenItems(root, { items: [item()] });
    expect(readFileSync(path, 'utf8')).toMatch(/DOC-1/);
    recordDecision(root, subjectKey(ITEM_PATH, SUBJECT), { answer: 'done', disposition: 'settled' });
    writeOpenItems(root, { items: [item()] });
    expect(readFileSync(path, 'utf8')).not.toMatch(/DOC-1/);
  });

  it('is silent, not fatal, when the root has no HANDOFF to regenerate', () => {
    // A test fixture with no docs/HANDOFF.md: the queue write is the durable
    // act and must still succeed; the gate is what reports a stale block.
    expect(() => writeOpenItems(root, { items: [item()] })).not.toThrow();
    expect(readOpenItems(root).items).toHaveLength(1);
  });
});
