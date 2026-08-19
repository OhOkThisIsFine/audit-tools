// P32 (nightly sol-7, owner decision 2026-08-18): the two fields that make an
// item ANSWERABLE — `options[]` and `eli5` — are enforced at write, beside the
// four probe refusals that make it CLOSABLE. On 2026-07-29, 18 items shipped
// with no options because the contract only NAMED the field and the renderer
// degrades silently (render-inbox defaults options to [] and renders the
// plain-terms block only when eli5 is truthy). A named requirement is not a
// refusal. Lives under tests/ because vitest excludes `.claude/**` and the
// other nightly tests already sit here.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSyncHidden } from '../helpers/spawn.mjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readOpenItems, writeOpenItems } from '../../scripts/nightly/items.mjs';

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

const item = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'DOC-1',
  subject_key: 'k-doc-1',
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
