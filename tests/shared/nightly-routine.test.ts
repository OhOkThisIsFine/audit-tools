// Contract tests for the nightly maintenance routine's state + surfacing.
//
// The property under test throughout is the one the previous channel got wrong:
// AN ANSWERED QUESTION STAYS ANSWERED. The old clear-on-apply ledger was keyed
// by the findings file's commit SHA and expired whenever the routine regenerated
// that file, so a settled question returned every night and the whole channel
// became noise. These tests pin the durable half.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSyncHidden } from '../helpers/spawn.mjs';
import { spawnSync } from 'node:child_process';
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
  recordReply,
} from '../../scripts/nightly/items.mjs';
import { renderInbox, writeInbox } from '../../scripts/nightly/render-inbox.mjs';
import { ingestAnswers } from '../../scripts/nightly/ingest-answers.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const SURFACE_HOOK = join(REPO_ROOT, '.claude', 'hooks', 'nightly-surface.mjs');
const ANSWER_CLI = join(REPO_ROOT, 'scripts', 'nightly', 'answer.mjs');

// Every fixture item carries a probe against this file, because writeOpenItems
// refuses an item whose premise is not verifiably true at creation. The file
// must be git-TRACKED: P8 refuses a probe target git cannot speak about, so a
// bare temp dir (no repo) reads as "untrackable" and every write is refused.
const PROBE_FILE = 'src-probe.txt';

function fixtureGit(cwd: string, ...args: string[]): void {
  const out = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (out.status !== 0) throw new Error(`git ${args.join(' ')}: ${out.stderr}`);
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nightly-'));
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(join(root, PROBE_FILE), 'const ANCHOR_PRESENT = 1;\n');
  fixtureGit(root, 'init', '-q');
  fixtureGit(root, 'config', 'user.email', 't@example.com');
  fixtureGit(root, 'config', 'user.name', 't');
  fixtureGit(root, 'add', PROBE_FILE);
  fixtureGit(root, 'commit', '-qm', 'probe anchor');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

interface NightlyItemOption {
  label: string;
  answer: string;
}

interface NightlyPremiseProbe {
  file: string;
  contains: string;
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
  premise_probes?: NightlyPremiseProbe[];
}

const item = (over: Partial<NightlyItemFixture> = {}): NightlyItemFixture => ({
  id: 'DOC-1',
  leg: 'docs',
  path: 'spec/foo.md',
  title: 'A claim the code contradicts',
  question: 'Should this stay?',
  evidence: ['grep found zero hits'],
  subject_key: subjectKey('spec/foo.md', 'the claim prose'),
  // Every item carries options: an item without them degrades to a bare text
  // box, which is what shipped on 2026-07-29 and made 18 items cost an essay
  // each to answer.
  options: [
    { label: 'Keep it', answer: 'Keep the pin, it is a deliberate anchor.' },
    { label: 'Drop it', answer: 'Remove the claim; it no longer holds.' },
  ],
  premise_probes: [{ file: PROBE_FILE, contains: 'ANCHOR_PRESENT' }],
  ...over,
});

type NightlyItem = NightlyItemFixture;

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

// The premise-probe contract (determination ea4e616f): an item quotes literal
// strings from the code it is about; the strings are verified at CREATION (the
// premise must be true when the item is written) and re-evaluated at
// PRESENTATION (a vanished premise closes the item instead of asking the
// owner). 15 of 21 items walked on 2026-07-25 were already fixed at HEAD — the
// queue held them because "answered" is a conversation fact, not a code fact.
describe('premise probes — an item whose quoted code has vanished closes itself', () => {
  it('resolves an item ALL of whose probe strings have vanished, instead of surfacing it', () => {
    const gone = item({ premise_probes: [{ file: PROBE_FILE, contains: 'REMOVED_BY_A_FIX' }] });
    const { open, resolved } = partitionBySettled([gone], readDecisions(root), root);
    expect(resolved).toHaveLength(1);
    expect(open).toHaveLength(0);
  });

  it('keeps an item open while ANY probe string is still present — a partial fix mis-holds by design', () => {
    const half = item({
      premise_probes: [
        { file: PROBE_FILE, contains: 'ANCHOR_PRESENT' },
        { file: PROBE_FILE, contains: 'REMOVED_BY_A_FIX' },
      ],
    });
    const { open, resolved } = partitionBySettled([half], readDecisions(root), root);
    expect(open).toHaveLength(1);
    expect(resolved).toHaveLength(0);
  });

  // sol-3 (2026-07-30): a missing file used to score identically to removed
  // code, so a typo'd path became the strongest possible claim ("already
  // done") — 44% of one model-emitted probe batch named unresolvable paths.
  // Absence of a FILE now needs git evidence (deleted-with-history) to close;
  // in a root with no queryable history the item stays open (fail-open).
  it('keeps an item OPEN when its probed file is missing and git history cannot vouch for a deletion', () => {
    const gone = item({ premise_probes: [{ file: 'deleted-module.ts', contains: 'anything' }] });
    const { open, resolved } = partitionBySettled([gone], readDecisions(root), root);
    expect(open).toHaveLength(1);
    expect(resolved).toHaveLength(0);
  });

  it('fails OPEN on a probe read error — infrastructure trouble never auto-closes an item', () => {
    mkdirSync(join(root, 'a-directory'), { recursive: true });
    const weird = item({ premise_probes: [{ file: 'a-directory', contains: 'x' }] });
    const { open, resolved } = partitionBySettled([weird], readDecisions(root), root);
    expect(open).toHaveLength(1);
    expect(resolved).toHaveLength(0);
  });

  it('grandfathers a probe-less legacy item as open — never auto-closed', () => {
    const legacy = item();
    delete legacy.premise_probes;
    const { open, resolved } = partitionBySettled([legacy], readDecisions(root), root);
    expect(open).toHaveLength(1);
    expect(resolved).toHaveLength(0);
  });

  it('writeOpenItems refuses an item carrying no probes', () => {
    const bare = item();
    delete bare.premise_probes;
    expect(() => writeOpenItems(root, { items: [bare] })).toThrow(/premise_probes/);
  });

  it('writeOpenItems refuses a probe whose string is not in the tree — the premise must be true at creation', () => {
    const stale = item({ premise_probes: [{ file: PROBE_FILE, contains: 'NOT_IN_THE_FILE' }] });
    expect(() => writeOpenItems(root, { items: [stale] })).toThrow(/premise/i);
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

describe('inbox render — the tracked markdown answering surface', () => {
  it('renders one anchored block per open item, with every option as a tickable box', () => {
    const md = renderInbox({ items: [item({ id: 'DOC-1' })] });
    expect(md).toContain('<!-- nightly:item key=');
    expect(md).toMatch(/- \[ \] \*\*1\. /);
    expect(md).toContain('```notes');
  });

  it('always offers the three escape hatches, not just the routine\'s proposed options', () => {
    const md = renderInbox({ items: [item()] });
    // An item that only offers the answers the routine thought of cannot record
    // a disagreement — which is the failure mode the free-text box exists for.
    expect(md).toContain('**Other**');
    expect(md).toContain("**Won't fix**");
    expect(md).toContain('**Ask back**');
  });

  it('needs no server, no browser and no scripts — it is plain markdown', () => {
    const md = renderInbox({ items: [item()], applied: [], skipped: [] });
    expect(md).not.toMatch(/<script/i);
    expect(md).not.toMatch(/localhost|127\.0\.0\.1|http:\/\//);
  });

  it('says so plainly when there is nothing to answer', () => {
    const md = renderInbox({ items: [] });
    expect(md).toMatch(/Nothing to answer/);
  });

  it('calls out answered-but-not-applied work, since that is the agent\'s debt not the owner\'s', () => {
    const key = subjectKey('a.md', 'some subject');
    const decisions = {
      [key]: { disposition: 'settled', answer: 'do it', decided_at: '2026-07-29T00:00:00Z' },
    };
    const md = renderInbox({ items: [], decisions });
    expect(md).toMatch(/not yet marked done/);
  });

  it('surfaces a stuck item\'s age — a question that keeps coming back is itself a finding', () => {
    const md = renderInbox({ items: [{ ...item(), nights_open: 7 }] });
    expect(md).toMatch(/open 7 nights/);
  });
});

describe('inbox ingest — a ticked box becomes a ledger entry', () => {
  function writeInboxFor(items: NightlyItem[]): void {
    writeOpenItems(root, { items });
    writeInbox(root);
  }
  const tick = (label: string): void => {
    const p = join(root, 'docs', 'nightly-inbox.md');
    const s = readFileSync(p, 'utf8').replace(`- [ ] **${label}**`, `- [x] **${label}**`);
    writeFileSync(p, s);
  };
  const setNote = (text: string): void => {
    const p = join(root, 'docs', 'nightly-inbox.md');
    writeFileSync(p, readFileSync(p, 'utf8').replace('```notes\n\n```', '```notes\n' + text + '\n```'));
  };

  it('records the option\'s exact answer prose, not its label', () => {
    writeInboxFor([item({ id: 'DOC-1' })]);
    tick('1. Keep it');
    const res = ingestAnswers(root);
    expect(res.recorded).toHaveLength(1);
    expect(res.errors).toHaveLength(0);
    const decisions = readDecisionsRaw(root);
    const rec = Object.values(decisions)[0] as { answer: string; disposition: string };
    expect(rec.answer).toBe('Keep the pin, it is a deliberate anchor.');
    expect(rec.disposition).toBe('settled');
  });

  it('drops an answered item from the inbox on re-render', () => {
    writeInboxFor([item({ id: 'DOC-1' })]);
    tick('1. Keep it');
    ingestAnswers(root);
    expect(readFileSync(join(root, 'docs', 'nightly-inbox.md'), 'utf8')).toMatch(/Nothing to answer/);
  });

  it('REFUSES two ticked boxes rather than guessing which one was meant', () => {
    writeInboxFor([item({ id: 'DOC-1' })]);
    tick('1. Keep it');
    tick('Other');
    const res = ingestAnswers(root);
    expect(res.recorded).toHaveLength(0);
    expect(res.errors[0].error).toMatch(/tick exactly one/);
    expect(Object.keys(readDecisionsRaw(root))).toHaveLength(0);
  });

  it('REFUSES a note-less Won\'t fix — an empty settle suppresses the question and records no reason', () => {
    writeInboxFor([item({ id: 'DOC-1' })]);
    tick("Won't fix");
    const res = ingestAnswers(root);
    expect(res.errors[0].error).toMatch(/empty Notes/);
    expect(Object.keys(readDecisionsRaw(root))).toHaveLength(0);
  });

  it('records Won\'t fix with its reason when the note is there', () => {
    writeInboxFor([item({ id: 'DOC-1' })]);
    tick("Won't fix");
    setNote('not worth the churn');
    const res = ingestAnswers(root);
    expect(res.recorded[0].disposition).toBe('wontfix');
    expect(res.recorded[0].answer).toBe('not worth the churn');
  });

  it('keeps an "Ask back" item OPEN — a counter-question is not an answer', () => {
    writeInboxFor([item({ id: 'DOC-1' })]);
    tick('Ask back');
    setNote('which of the two paths do you mean?');
    ingestAnswers(root);
    // disposition 'question' is excluded from settled by partitionBySettled, so
    // the item must still be in the regenerated inbox.
    expect(readFileSync(join(root, 'docs', 'nightly-inbox.md'), 'utf8')).toContain('<!-- nightly:item key=');
  });

  it('one malformed answer never blocks the others', () => {
    writeInboxFor([item({ id: 'DOC-1' }), item({ id: 'DOC-2', subject_key: subjectKey('spec/bar.md', 'a second claim') })]);
    const p = join(root, 'docs', 'nightly-inbox.md');
    // tick a valid option on the first block, and a note-less Other on the last
    writeFileSync(p, readFileSync(p, 'utf8').replace('- [ ] **1. Keep it**', '- [x] **1. Keep it**'));
    const s = readFileSync(p, 'utf8');
    const i = s.lastIndexOf('- [ ] **Other**');
    writeFileSync(p, s.slice(0, i) + '- [x] **Other**' + s.slice(i + '- [ ] **Other**'.length));

    const res = ingestAnswers(root);
    expect(res.recorded).toHaveLength(1);
    expect(res.errors).toHaveLength(1);
  });

  it('--dry-run reports without touching the ledger', () => {
    writeInboxFor([item({ id: 'DOC-1' })]);
    tick('1. Keep it');
    const res = ingestAnswers(root, { dryRun: true });
    expect(res.recorded).toHaveLength(1);
    expect(Object.keys(readDecisionsRaw(root))).toHaveLength(0);
  });

  it('renders an ASK BACK exchange — the question and its reply, above fresh answer boxes', () => {
    // Without this the item returns looking untouched: the owner's question is
    // recorded but invisible, and there is nowhere to reply. That makes the loop
    // one-way, which is not an async conversation.
    const it1 = item({ id: 'DOC-1' });
    writeInboxFor([it1]);
    tick('Ask back');
    setNote('which of the two paths do you mean?');
    ingestAnswers(root);

    let md = readFileSync(join(root, 'docs', 'nightly-inbox.md'), 'utf8');
    expect(md).toContain('You asked back');
    expect(md).toContain('which of the two paths do you mean?');
    expect(md).toMatch(/Not answered yet/);

    recordReply(root, it1.subject_key, 'The second one — via the shared core.');
    writeInbox(root);
    md = readFileSync(join(root, 'docs', 'nightly-inbox.md'), 'utf8');
    expect(md).toContain('The second one — via the shared core.');
    expect(md).not.toMatch(/Not answered yet/);
    // …and it is still answerable.
    expect(md).toMatch(/- \[ \] \*\*1\. /);
  });

  it('refuses an empty reply — it would leave the question looking answered', () => {
    const it1 = item({ id: 'DOC-1' });
    writeInboxFor([it1]);
    tick('Ask back');
    setNote('a question');
    ingestAnswers(root);
    expect(() => recordReply(root, it1.subject_key, '   ')).toThrow(/empty reply/);
  });

  it('an answer AFTER an ask-back settles it and drops it from the inbox', () => {
    const it1 = item({ id: 'DOC-1' });
    writeInboxFor([it1]);
    tick('Ask back');
    setNote('a question');
    ingestAnswers(root);
    recordReply(root, it1.subject_key, 'here is the answer');
    writeInbox(root);

    tick('1. Keep it');
    ingestAnswers(root);
    expect(readFileSync(join(root, 'docs', 'nightly-inbox.md'), 'utf8')).toMatch(/Nothing to answer/);
  });

  it('an untouched inbox records nothing and reports the items as unanswered', () => {
    writeInboxFor([item({ id: 'DOC-1' })]);
    const res = ingestAnswers(root);
    expect(res.recorded).toHaveLength(0);
    expect(res.errors).toHaveLength(0);
    expect(res.unanswered).toBe(1);
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

  it('never re-asks a settled subject as an open question', () => {
    const it1 = item();
    writeOpenItems(root, { items: [it1] });
    recordDecision(root, it1.subject_key, { answer: 'no change wanted' });
    expect(runHook().stdout).not.toMatch(/new item/);
  });

  it('nudges ONCE that an answered item is ready to apply, then never again', () => {
    // The bound is the whole point. Plenty of answers imply no work at all
    // ("keep the pin, it is a deliberate anchor"), so they are never marked
    // done — an unbounded nudge would reappear every session forever, which is
    // the exact trap the subject-key ledger exists to kill.
    const it1 = item();
    writeOpenItems(root, { items: [it1] });
    recordDecision(root, it1.subject_key, { answer: 'no change wanted' });

    expect(runHook().stdout).toMatch(/ready to apply/);
    expect(runHook().stdout.trim()).toBe('');
    expect(runHook().stdout.trim()).toBe('');
  });

  it('does not nudge for grandfathered answers — their landing state is unknowable, so it would be a standing false RED', () => {
    const it1 = item();
    writeOpenItems(root, { items: [it1] });
    recordDecision(root, it1.subject_key, { answer: 'answered long ago' });
    // Backdate past the completion-tracking cutover.
    const p = join(root, '.claude', 'nightly-decisions.json');
    const raw = JSON.parse(readFileSync(p, 'utf8'));
    raw[it1.subject_key].decided_at = '2026-07-01T00:00:00.000Z';
    writeFileSync(p, JSON.stringify(raw));
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

describe('viewed state', () => {
  it('recordViewed dedupes keys', () => {
    recordViewed(root, ['a', 'a', 'b']);
    const data = JSON.parse(readFileSync(join(root, '.audit-tools/nightly/last-viewed.json'), 'utf8'));
    expect(data.keys).toEqual(['a', 'b']);
  });
});
