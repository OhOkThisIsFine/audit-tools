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
  readDecisions,
  partitionBySettled,
  writeOpenItems,
  readOpenItems,
  nightsBetween,
  recordViewed,
} from '../../scripts/nightly/items.mjs';
import { renderDigest } from '../../scripts/nightly/render-digest.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const SURFACE_HOOK = join(REPO_ROOT, '.claude', 'hooks', 'nightly-surface.mjs');
const ANSWER_CLI = join(REPO_ROOT, 'scripts', 'nightly', 'answer.mjs');

let root;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nightly-'));
  mkdirSync(join(root, '.claude'), { recursive: true });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const item = (over = {}) => ({
  id: 'DOC-1',
  leg: 'docs',
  path: 'spec/foo.md',
  title: 'A claim the code contradicts',
  question: 'Should this stay?',
  evidence: ['grep found zero hits'],
  subject_key: subjectKey('spec/foo.md', 'the claim prose'),
  ...over,
});

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

  it('gives every item its exact answer command', () => {
    const html = renderDigest({ items: [item({ id: 'BKL-7' })], applied: [], skipped: [] });
    expect(html).toMatch(/answer\.mjs BKL-7/);
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
  function runAnswer(args) {
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
    const decisions = JSON.parse(readFileSync(join(root, '.claude/nightly-decisions.json'), 'utf8'));
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
    const decisions = JSON.parse(readFileSync(join(root, '.claude/nightly-decisions.json'), 'utf8'));
    expect(Object.values(decisions)[0].disposition).toBe('wontfix');
  });

  it('--list prints the open ids', () => {
    const r = runAnswer(['--list']);
    expect(r.stdout).toMatch(/DOC-1/);
  });
});

describe('viewed state', () => {
  it('recordViewed dedupes keys', () => {
    recordViewed(root, ['a', 'a', 'b']);
    const data = JSON.parse(readFileSync(join(root, '.audit-tools/nightly/last-viewed.json'), 'utf8'));
    expect(data.keys).toEqual(['a', 'b']);
  });
});
