// Contract tests for the nightly maintenance routine's state + surfacing.
//
// The property under test throughout is the one the previous channel got wrong:
// AN ANSWERED QUESTION STAYS ANSWERED. The old clear-on-apply ledger was keyed
// by the findings file's commit SHA and expired whenever the routine regenerated
// that file, so a settled question returned every night and the whole channel
// became noise. These tests pin the durable half.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSyncHidden } from '../helpers/spawn.mjs';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  subjectKey,
  normalizeSubject,
  recordDecision,
  readDecisions as readDecisionsRaw,
  partitionBySettled,
  writeOpenItems,
  readOpenItems,
  nightsBetween,
  recordViewed,
} from '../../scripts/nightly/items.mjs';
import { renderDigest } from '../../scripts/nightly/render-digest.mjs';
import { createNightlyReviewServer } from '../../scripts/nightly/serve.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const SURFACE_HOOK = join(REPO_ROOT, '.claude', 'hooks', 'nightly-surface.mjs');
const ANSWER_CLI = join(REPO_ROOT, 'scripts', 'nightly', 'answer.mjs');

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nightly-'));
  mkdirSync(join(root, '.claude'), { recursive: true });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

interface NightlyItemOption {
  label: string;
  answer: string;
}

interface NightlyItemFixture {
  id: string;
  leg: string;
  path: string;
  title: string;
  question?: string;
  evidence?: string[];
  subject_key: string;
  first_seen?: string;
  nights_open?: number;
  eli5?: string;
  options?: NightlyItemOption[];
}

const item = (over: Partial<NightlyItemFixture> = {}): NightlyItemFixture => ({
  id: 'DOC-1',
  leg: 'docs',
  path: 'spec/foo.md',
  title: 'A claim the code contradicts',
  question: 'Should this stay?',
  evidence: ['grep found zero hits'],
  subject_key: subjectKey('spec/foo.md', 'the claim prose'),
  ...over,
});

interface NightlyDecisionEntry {
  disposition: string;
  answer: string;
  subject?: string;
  path?: string;
  note?: string;
  decided_at?: string;
  completed_at?: string;
  completed_ref?: string;
}

// `readDecisions` comes back from an untyped .mjs module (`readJson`'s fallback
// is a plain `{}`), so a thin typed wrapper is the difference between every
// downstream `.answer`/`.disposition` read type-checking and every call site
// needing its own cast.
function readDecisions(rootDir: string): Record<string, NightlyDecisionEntry> {
  return readDecisionsRaw(rootDir);
}

// The interactive review server's own return type as this file uses it — the
// three methods actually called, with `address()` narrowed to the post-listen
// TCP shape (never the pre-listen `null` or the unix-socket `string`).
interface ReviewServer {
  listen(port: number, host: string, callback: () => void): void;
  address(): { address: string; port: number };
  close(callback: () => void): void;
}

describe('subject key — identity is the SUBJECT, not the question wording', () => {
  it('is stable when the question is rephrased around the same prose', () => {
    const a = subjectKey('spec/foo.md', 'The gate emits the service axis');
    const b = subjectKey('spec/foo.md', 'the   gate emits the SERVICE axis  ');
    expect(a).toBe(b);
  });

  it('changes when the underlying prose changes — a reword re-opens the question', () => {
    const before = subjectKey('spec/foo.md', 'The gate emits the service axis');
    const after = subjectKey('spec/foo.md', 'The gate does not emit the service axis');
    expect(after).not.toBe(before);
  });

  it('changes when the same prose moves to a different doc', () => {
    expect(subjectKey('a.md', 'same prose')).not.toBe(subjectKey('b.md', 'same prose'));
  });

  it('normalizes whitespace and case but never punctuation that flips meaning', () => {
    expect(normalizeSubject('  A  B  ')).toBe('a b');
    expect(normalizeSubject('is shipped')).not.toBe(normalizeSubject('is not shipped'));
  });
});

describe('decisions ledger — a settled subject is never re-asked', () => {
  it('suppresses an item whose subject was settled', () => {
    const it1 = item();
    recordDecision(root, it1.subject_key, { answer: 'keep as is', disposition: 'settled' });
    const { open, settled } = partitionBySettled([it1], readDecisions(root));
    expect(open).toHaveLength(0);
    expect(settled).toHaveLength(1);
  });

  it('does NOT suppress after the underlying prose changes (new key)', () => {
    const original = item();
    recordDecision(root, original.subject_key, { answer: 'keep as is' });
    const reworded = item({ subject_key: subjectKey('spec/foo.md', 'the claim prose, now different') });
    const { open } = partitionBySettled([reworded], readDecisions(root));
    expect(open).toHaveLength(1);
  });

  it('survives a regenerated items file — the old ledger expired here, this one must not', () => {
    const it1 = item();
    recordDecision(root, it1.subject_key, { answer: 'settled once' });
    // Simulate several nights: the routine rewrites open-items.json each run.
    for (let night = 0; night < 3; night++) {
      writeOpenItems(root, { items: [item({ id: `DOC-${night}` })] });
      const { open } = partitionBySettled(readOpenItems(root).items, readDecisions(root));
      expect(open, `re-asked on night ${night + 1}`).toHaveLength(0);
    }
  });

  it('records the answer text, not just the fact of an answer', () => {
    const it1 = item();
    recordDecision(root, it1.subject_key, { answer: 'the version pin is a deliberate anchor', path: 'spec/foo.md' });
    const stored = readDecisions(root)[it1.subject_key];
    expect(stored.answer).toMatch(/deliberate anchor/);
    expect(stored.decided_at).toBeTruthy();
  });
});

describe('open items — nights_open carries across runs', () => {
  it('counts an item as new on its first night', () => {
    const written = writeOpenItems(root, { items: [item()] });
    expect(written.items[0].nights_open).toBe(1);
  });

  it('preserves first_seen across a regenerated run', () => {
    writeOpenItems(root, { items: [item({ first_seen: '2026-07-01' })] });
    const second = writeOpenItems(root, { items: [item()] });
    expect(second.items[0].first_seen).toBe('2026-07-01');
    expect(second.items[0].nights_open).toBeGreaterThan(1);
  });

  it('nightsBetween is inclusive of both ends', () => {
    expect(nightsBetween('2026-07-01', '2026-07-01')).toBe(1);
    expect(nightsBetween('2026-07-01', '2026-07-03')).toBe(3);
  });
});

describe('digest render', () => {
  it('is self-contained: no external fetches of any kind', () => {
    const html = renderDigest({ items: [item()], applied: [], skipped: [] });
    expect(html).not.toMatch(/<script\s+src=/i);
    expect(html).not.toMatch(/<link[^>]+href=/i);
    expect(html).not.toMatch(/https?:\/\//);
  });

  it('escapes item text so a doc quote containing markup cannot break the page', () => {
    const html = renderDigest({
      items: [item({ title: '<img src=x onerror=alert(1)>' })],
      applied: [],
      skipped: [],
    });
    expect(html).not.toMatch(/<img src=x/);
    expect(html).toMatch(/&lt;img src=x/);
  });

  // The digest is a decision surface, not a document. Two properties keep it
  // that way, and both regressed once: every disclosure must start CLOSED (22
  // auto-expanded explanations is a wall to scroll past, not a list to work),
  // and the digest must never answer "how do I respond to this?" with a command
  // to type — the options are buttons.
  it('starts every disclosure closed', () => {
    const html = renderDigest({
      items: [item({ eli5: 'A plain-language explanation.', evidence: ['file.ts:1 — a fact'] })],
      applied: [],
      skipped: [],
    });
    expect(html).toMatch(/In plain terms/);
    expect(html).not.toMatch(/<details[^>]*\sopen[\s>]/);
  });

  it('never tells the reader to run a command to answer', () => {
    const html = renderDigest({ items: [item({ id: 'BKL-7' })], applied: [], skipped: [] });
    expect(html).not.toMatch(/nightly:review/);
    expect(html).not.toMatch(/answer\.mjs/);
  });

  it('renders an expandable ELI5 block when the item carries one', () => {
    const html = renderDigest({
      items: [item({ eli5: 'The docs say a robot double-checks the math, but no robot exists.' })],
      applied: [],
      skipped: [],
    });
    expect(html).toMatch(/In plain terms/);
    expect(html).toMatch(/no robot exists/);
  });

  it('omits the ELI5 block when the item has none', () => {
    const html = renderDigest({ items: [item({ eli5: undefined })], applied: [], skipped: [] });
    expect(html).not.toMatch(/In plain terms/);
  });

  it('calls out items open 5+ nights instead of repeating them silently', () => {
    const html = renderDigest({
      items: [item({ nights_open: 9, first_seen: '2026-07-01' })],
      applied: [],
      skipped: [],
    });
    expect(html).toMatch(/open 5\+ nights/);
    expect(html).toMatch(/9 nights/);
  });

  it('renders every leg heading, so an empty leg reads as "nothing open" not "not run"', () => {
    const html = renderDigest({ items: [], applied: [], skipped: [] });
    expect(html).toMatch(/Documentation/);
    expect(html).toMatch(/Backlog disambiguation/);
    expect(html).toMatch(/Recurring-problem solutions/);
    expect(html).toMatch(/Nothing open/);
  });

  it('surfaces a skipped leg — a quiet digest must never mean "did not look"', () => {
    const html = renderDigest({
      items: [],
      applied: [],
      skipped: ['working tree dirty — applies skipped'],
    });
    expect(html).toMatch(/Not covered this run/);
    expect(html).toMatch(/working tree dirty/);
  });
});

describe('SessionStart surface hook', () => {
  function runHook() {
    const r = spawnSyncHidden(process.execPath, [SURFACE_HOOK], {
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true,
      input: '{}',
      env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    });
    return { status: r.status, stdout: r.stdout ?? '' };
  }

  it('is silent when there are no items', () => {
    const r = runHook();
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });

  it('announces new items in ONE line', () => {
    writeOpenItems(root, { items: [item()] });
    const r = runHook();
    expect(r.stdout.trim().split('\n')).toHaveLength(1);
    expect(r.stdout).toMatch(/1 new item/);
  });

  it('goes silent on the SECOND session — an open item must not re-announce forever', () => {
    writeOpenItems(root, { items: [item()] });
    expect(runHook().stdout).toMatch(/1 new item/);
    expect(runHook().stdout.trim()).toBe('');
  });

  it('speaks again when a genuinely new subject appears', () => {
    writeOpenItems(root, { items: [item()] });
    runHook();
    writeOpenItems(root, {
      items: [item(), item({ id: 'BKL-2', leg: 'backlog', subject_key: subjectKey('docs/backlog.md', 'other') })],
    });
    expect(runHook().stdout).toMatch(/1 new item/);
  });

  it('is silent when the only open item is already settled', () => {
    const it1 = item();
    writeOpenItems(root, { items: [it1] });
    recordDecision(root, it1.subject_key, { answer: 'no change wanted' });
    expect(runHook().stdout.trim()).toBe('');
  });

  it('never blocks session start, even on a corrupt items file', () => {
    mkdirSync(join(root, '.audit-tools', 'nightly'), { recursive: true });
    writeFileSync(join(root, '.audit-tools/nightly/open-items.json'), '{ not json');
    expect(runHook().status).toBe(0);
  });
});

describe('answer CLI', () => {
  function runAnswer(args: string[]) {
    const r = spawnSyncHidden(process.execPath, [ANSWER_CLI, ...args], {
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true,
      env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  }

  beforeEach(() => {
    writeOpenItems(root, { items: [item({ id: 'DOC-1' })] });
  });

  it('records an answer against the subject key', () => {
    const r = runAnswer(['DOC-1', 'keep it as it is']);
    expect(r.status).toBe(0);
    const decisions = JSON.parse(readFileSync(join(root, '.claude/nightly-decisions.json'), 'utf8')) as Record<
      string,
      NightlyDecisionEntry
    >;
    const entry = Object.values(decisions)[0];
    expect(entry.answer).toBe('keep it as it is');
    expect(entry.disposition).toBe('settled');
  });

  it('refuses an empty answer — a silent suppression is an untrustworthy ledger', () => {
    const r = runAnswer(['DOC-1']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/answer is required/);
    expect(existsSync(join(root, '.claude/nightly-decisions.json'))).toBe(false);
  });

  it('rejects an unknown id rather than recording a decision about nothing', () => {
    const r = runAnswer(['NOPE-9', 'some answer']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Unknown item id/);
  });

  it('treats a leading dash as a flag, never an id', () => {
    const r = runAnswer(['--oops', 'text']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/a flag/);
  });

  it('supports --wontfix as a distinct, recorded disposition', () => {
    expect(runAnswer(['DOC-1', '--wontfix', 'not worth the complexity']).status).toBe(0);
    const decisions = JSON.parse(readFileSync(join(root, '.claude/nightly-decisions.json'), 'utf8')) as Record<
      string,
      NightlyDecisionEntry
    >;
    expect(Object.values(decisions)[0].disposition).toBe('wontfix');
  });

  it('--list prints the open ids', () => {
    const r = runAnswer(['--list']);
    expect(r.stdout).toMatch(/DOC-1/);
  });
});

describe('interactive review server — the buttoned surface', () => {
  let server: ReviewServer | undefined;
  let base: string;

  async function start(): Promise<ReviewServer> {
    const s = createNightlyReviewServer(root) as ReviewServer;
    server = s;
    await new Promise<void>((res) => s.listen(0, '127.0.0.1', res));
    base = `http://127.0.0.1:${s.address().port}`;
    return s;
  }
  afterEach(async () => {
    if (server) await new Promise<void>((res) => server!.close(() => res()));
    server = undefined;
  });

  it('binds to loopback only — never network-exposed', async () => {
    writeOpenItems(root, { items: [item()] });
    const server = await start();
    expect(server.address().address).toBe('127.0.0.1');
  });

  it('serves a page with a text box and Settle / Won\'t-fix buttons', async () => {
    writeOpenItems(root, { items: [item({ id: 'DOC-1', eli5: 'Plain explanation here.' })] });
    await start();
    const html = await (await fetch(`${base}/`)).text();
    expect(html).toMatch(/<textarea/);
    expect(html).toMatch(/data-act="settled"/);
    expect(html).toMatch(/data-act="wontfix"/);
    expect(html).toMatch(/In plain terms/);
  });

  // An item that poses a choice must render that choice as something pressable,
  // carrying the EXACT text it will record — otherwise the owner is composing an
  // answer the routine already knows how to phrase, and a button press is a
  // guess about what it agreed to.
  it('renders one button per option, each carrying the answer it will record', async () => {
    writeOpenItems(root, {
      items: [
        item({
          id: 'DOC-1',
          options: [
            { label: 'Correct it', answer: 'Approved. Correct the phrase and file the attestation.' },
            { label: 'Leave it', answer: 'Leave the sentence as written.' },
          ],
        }),
      ],
    });
    await start();
    const html = await (await fetch(`${base}/`)).text();
    expect(html).toMatch(/data-answer="Approved\. Correct the phrase and file the attestation\."/);
    expect(html).toMatch(/data-answer="Leave the sentence as written\."/);
    expect(html).toMatch(/Something else/);
  });

  it('settles with an option answer verbatim, so the ledger records what was pressed', async () => {
    const key = subjectKey('a.md', 'one');
    const chosen = 'Leave the sentence as written.';
    writeOpenItems(root, {
      items: [item({ id: 'DOC-1', subject_key: key, options: [{ label: 'Leave it', answer: chosen }] })],
    });
    await start();
    const r = await fetch(`${base}/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'DOC-1', answer: chosen, disposition: 'settled' }),
    });
    expect(r.status).toBe(200);
    expect(readDecisions(root)[key].answer).toBe(chosen);
  });

  it('records an answer via POST and reports the remaining open count', async () => {
    writeOpenItems(root, {
      items: [
        item({ id: 'DOC-1', subject_key: subjectKey('a.md', 'one') }),
        item({ id: 'DOC-2', subject_key: subjectKey('b.md', 'two') }),
      ],
    });
    await start();
    const r = await fetch(`${base}/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'DOC-1', answer: 'keep it as is', disposition: 'settled' }),
    });
    expect(r.status).toBe(200);
    const data = await r.json();
    expect(data.open_count).toBe(1);
    const decisions = readDecisions(root);
    expect(Object.values(decisions)[0].answer).toBe('keep it as is');
  });

  it('rejects an empty answer — the same guard the CLI enforces', async () => {
    writeOpenItems(root, { items: [item({ id: 'DOC-1' })] });
    await start();
    const r = await fetch(`${base}/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'DOC-1', answer: '   ', disposition: 'settled' }),
    });
    expect(r.status).toBe(400);
    expect(Object.keys(readDecisions(root))).toHaveLength(0);
  });

  it('rejects an unknown or already-settled id', async () => {
    writeOpenItems(root, { items: [item({ id: 'DOC-1' })] });
    await start();
    const r = await fetch(`${base}/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'NOPE', answer: 'x', disposition: 'settled' }),
    });
    expect(r.status).toBe(404);
  });

  it('records --wontfix as its own disposition', async () => {
    writeOpenItems(root, { items: [item({ id: 'DOC-1' })] });
    await start();
    await fetch(`${base}/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'DOC-1', answer: 'not worth it', disposition: 'wontfix' }),
    });
    expect(Object.values(readDecisions(root))[0].disposition).toBe('wontfix');
  });

  it('a settled subject is gone from the served page on reload', async () => {
    const it1 = item({ id: 'DOC-1' });
    writeOpenItems(root, { items: [it1] });
    await start();
    await fetch(`${base}/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'DOC-1', answer: 'done', disposition: 'settled' }),
    });
    const html = await (await fetch(`${base}/`)).text();
    expect(html).not.toMatch(/data-id="DOC-1"/);
  });
});

describe('viewed state', () => {
  it('recordViewed dedupes keys', () => {
    recordViewed(root, ['a', 'a', 'b']);
    const data = JSON.parse(readFileSync(join(root, '.audit-tools/nightly/last-viewed.json'), 'utf8'));
    expect(data.keys).toEqual(['a', 'b']);
  });
});
