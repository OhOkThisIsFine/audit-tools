// Contract tests for the two SESSION-LIFECYCLE gates in `.claude/hooks/` — the
// question-philosophy gate (PreToolUse AskUserQuestion + Stop) and the closeout
// challenge (Stop). Kept apart from hook-trap-guards.test.mjs, which pins durable
// SHELL traps; these two pin conversation-shaped obligations instead.
//
// Same placement rule as that file: they live under tests/ because vitest excludes
// `.claude/**`, so a test beside a hook never runs in CI.
//
// Both gates block by exiting 2 with stderr fed back to the agent, and both must
// fail OPEN (exit 0) on every fault — a wedged Stop hook cannot be escaped from
// inside the session.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSyncHidden } from '../helpers/spawn.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const QUESTION_GATE = join(REPO_ROOT, '.claude', 'hooks', 'question-philosophy-gate.mjs');
const CLOSEOUT_GATE = join(REPO_ROOT, '.claude', 'hooks', 'closeout-challenge-gate.mjs');

function runHook(hook, payload, { root = REPO_ROOT, env = {} } = {}) {
  const r = spawnSyncHidden(process.execPath, [hook], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
    env: { ...process.env, CLAUDE_PROJECT_DIR: root, ...env },
  });
  return { code: r.status, stderr: r.stderr ?? '' };
}

// Every case gets its own session id: both gates dedupe on it, so a shared id
// would make the second test in a file depend on the first having run.
let seq = 0;
const sid = (label) => `test-${label}-${process.pid}-${seq++}`;

const askPayload = (session) => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'AskUserQuestion',
  session_id: session,
  tool_input: { questions: [{ question: 'Big refactor or the smaller change?' }] },
});

// A root carrying only the philosophy doc — enough for the question gate, and
// isolated from the repo's own hook state dir.
let docRoot;
beforeAll(() => {
  docRoot = mkdtempSync(join(tmpdir(), 'philgate-'));
  mkdirSync(join(docRoot, 'docs'), { recursive: true });
  cpSync(join(REPO_ROOT, 'docs', 'project-philosophy.md'), join(docRoot, 'docs', 'project-philosophy.md'));
});
afterAll(() => {
  try {
    rmSync(docRoot, { recursive: true, force: true });
  } catch {
    /* windows lock — leave it to the temp reaper */
  }
});

describe('question-philosophy-gate: the philosophy reaches the agent before the owner does', () => {
  it('blocks the first AskUserQuestion and injects PART B verbatim', () => {
    const { code, stderr } = runHook(QUESTION_GATE, askPayload(sid('ask')), { root: docRoot });
    expect(code).toBe(2);
    // The single highest-yield line — the one that dissolves most scope questions.
    expect(stderr).toContain('is NOT a cost');
    expect(stderr).toContain('PART A (governs the PRODUCT itself)');
  });

  it('tells the agent to ask again if the question survives (B1 still says ask on ambiguity)', () => {
    const { stderr } = runHook(QUESTION_GATE, askPayload(sid('ask-again')), { root: docRoot });
    expect(stderr).toContain('ASK IT AGAIN');
  });

  it('fires ONCE per session — the second question in the same session goes through', () => {
    const session = sid('once');
    expect(runHook(QUESTION_GATE, askPayload(session), { root: docRoot }).code).toBe(2);
    expect(runHook(QUESTION_GATE, askPayload(session), { root: docRoot }).code).toBe(0);
  });

  it('ignores tools that are not the question interface', () => {
    const payload = { hook_event_name: 'PreToolUse', tool_name: 'Bash', session_id: sid('bash') };
    expect(runHook(QUESTION_GATE, payload, { root: docRoot }).code).toBe(0);
  });

  it('honours the kill switch', () => {
    const r = runHook(QUESTION_GATE, askPayload(sid('kill')), {
      root: docRoot,
      env: { AUDIT_TOOLS_NO_QUESTION_PHILOSOPHY: '1' },
    });
    expect(r.code).toBe(0);
  });

  it('fails OPEN when the philosophy doc has been restructured away', () => {
    const bare = mkdtempSync(join(tmpdir(), 'philgate-bare-'));
    mkdirSync(join(bare, 'docs'), { recursive: true });
    writeFileSync(join(bare, 'docs', 'project-philosophy.md'), '# Something else entirely\n');
    expect(runHook(QUESTION_GATE, askPayload(sid('nodoc')), { root: bare }).code).toBe(0);
    rmSync(bare, { recursive: true, force: true });
  });

  it('fails OPEN with no session_id — it cannot dedupe, so it must not fire at all', () => {
    const payload = { ...askPayload('x'), session_id: undefined };
    expect(runHook(QUESTION_GATE, payload, { root: docRoot }).code).toBe(0);
  });

  describe('Stop trigger — only a message that ENDS in a question counts', () => {
    function transcriptRoot(finalText) {
      const root = mkdtempSync(join(tmpdir(), 'philgate-stop-'));
      mkdirSync(join(root, 'docs'), { recursive: true });
      cpSync(join(REPO_ROOT, 'docs', 'project-philosophy.md'), join(root, 'docs', 'project-philosophy.md'));
      const t = join(root, 'transcript.jsonl');
      writeFileSync(
        t,
        JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: finalText }] } }) +
          '\n',
      );
      return { root, transcript: t };
    }

    it('blocks when the closing line asks the owner something', () => {
      const { root, transcript } = transcriptRoot('Landed the fix.\n\nWant me to also split the backlog?');
      const payload = { hook_event_name: 'Stop', session_id: sid('stop-q'), transcript_path: transcript };
      expect(runHook(QUESTION_GATE, payload, { root }).code).toBe(2);
      rmSync(root, { recursive: true, force: true });
    });

    it('allows a statement-only close, even when a question mark appears mid-message', () => {
      const { root, transcript } = transcriptRoot('You asked whether it was green? It is. Nothing pending.');
      const payload = { hook_event_name: 'Stop', session_id: sid('stop-noq'), transcript_path: transcript };
      expect(runHook(QUESTION_GATE, payload, { root }).code).toBe(0);
      rmSync(root, { recursive: true, force: true });
    });

    it('fails OPEN on an unreadable transcript', () => {
      const payload = {
        hook_event_name: 'Stop',
        session_id: sid('stop-bad'),
        transcript_path: join(tmpdir(), 'definitely-not-here.jsonl'),
      };
      expect(runHook(QUESTION_GATE, payload, { root: docRoot }).code).toBe(0);
    });

    it('allows a re-entrant stop (already blocked once)', () => {
      const { root, transcript } = transcriptRoot('Shall I continue?');
      const payload = {
        hook_event_name: 'Stop',
        session_id: sid('stop-reentrant'),
        transcript_path: transcript,
        stop_hook_active: true,
      };
      expect(runHook(QUESTION_GATE, payload, { root }).code).toBe(0);
      rmSync(root, { recursive: true, force: true });
    });
  });
});

describe('closeout-challenge-gate: the "are you sure?" question, with evidence attached', () => {
  // A real throwaway git repo — the gate's trigger IS git state, so a fake root
  // would only exercise the fail-open path.
  let repo;
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'closeout-'));
    const g = (...args) =>
      spawnSyncHidden('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    g('init', '-q');
    g('config', 'user.email', 'test@example.com');
    g('config', 'user.name', 'test');
    g('config', 'commit.gpgsign', 'false');
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    g('add', '.');
    g('commit', '-qm', 'initial');
  });
  afterAll(() => {
    try {
      rmSync(repo, { recursive: true, force: true });
    } catch {
      /* windows lock */
    }
  });

  const stop = (session) => ({ hook_event_name: 'Stop', session_id: session });

  it('blocks and NAMES the uncommitted work rather than asking rhetorically', () => {
    writeFileSync(join(repo, 'dirty.txt'), 'uncommitted\n');
    const { code, stderr } = runHook(CLOSEOUT_GATE, stop(sid('dirty')), { root: repo });
    expect(code).toBe(2);
    expect(stderr).toContain('are you sure that was all taken care of');
    expect(stderr).toContain('dirty.txt');
  });

  it('names the home doc for every remaining step — the point of the challenge', () => {
    const { stderr } = runHook(CLOSEOUT_GATE, stop(sid('homes')), { root: repo });
    expect(stderr).toContain('nothing pending');
    expect(stderr).toMatch(/HANDOFF/);
  });

  it('does not re-ask about a tree state it already challenged', () => {
    const session = sid('same-state');
    expect(runHook(CLOSEOUT_GATE, stop(session), { root: repo }).code).toBe(2);
    expect(runHook(CLOSEOUT_GATE, stop(session), { root: repo }).code).toBe(0);
  });

  it('caps at 2 challenges per session even as the tree keeps changing', () => {
    const session = sid('cap');
    writeFileSync(join(repo, 'c1.txt'), '1\n');
    expect(runHook(CLOSEOUT_GATE, stop(session), { root: repo }).code).toBe(2);
    writeFileSync(join(repo, 'c2.txt'), '2\n');
    expect(runHook(CLOSEOUT_GATE, stop(session), { root: repo }).code).toBe(2);
    writeFileSync(join(repo, 'c3.txt'), '3\n');
    expect(runHook(CLOSEOUT_GATE, stop(session), { root: repo }).code).toBe(0);
  });

  it('honours the kill switch', () => {
    const r = runHook(CLOSEOUT_GATE, stop(sid('kill')), {
      root: repo,
      env: { AUDIT_TOOLS_NO_CLOSEOUT_CHALLENGE: '1' },
    });
    expect(r.code).toBe(0);
  });

  it('fails OPEN outside a git repo — no work signal, nothing to challenge', () => {
    const bare = mkdtempSync(join(tmpdir(), 'closeout-bare-'));
    expect(runHook(CLOSEOUT_GATE, stop(sid('nogit')), { root: bare }).code).toBe(0);
    rmSync(bare, { recursive: true, force: true });
  });

  it('ignores a non-Stop event', () => {
    const payload = { hook_event_name: 'PreToolUse', tool_name: 'Bash', session_id: sid('notstop') };
    expect(runHook(CLOSEOUT_GATE, payload, { root: repo }).code).toBe(0);
  });
});
