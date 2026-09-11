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
import { latestFailedWorkflows } from '../../scripts/shared/ciRedWorkflows.mjs';
import {
  liveSessionWorkReason,
  pendingQueuedResume,
  sessionHasLiveBackgroundWork,
} from '../../scripts/shared/liveSessionWork.mjs';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, delimiter } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const QUESTION_GATE = join(REPO_ROOT, '.claude', 'hooks', 'question-philosophy-gate.mjs');
const CLOSEOUT_GATE = join(REPO_ROOT, '.claude', 'hooks', 'closeout-challenge-gate.mjs');

interface HookPayload {
  hook_event_name?: string;
  tool_name?: string;
  session_id?: string | undefined;
  tool_input?: Record<string, unknown>;
  transcript_path?: string;
  stop_hook_active?: boolean;
  background_tasks?: Array<Record<string, unknown>>;
  session_crons?: Array<Record<string, unknown>>;
}

interface RunHookOptions {
  root?: string;
  env?: NodeJS.ProcessEnv;
}

function runHook(
  hook: string,
  payload: HookPayload,
  { root = REPO_ROOT, env = {} }: RunHookOptions = {},
): { code: number | null; stderr: string } {
  // Scrub the session/bypass env before every spawn: a dispatched child session
  // carries AUDIT_TOOLS_CHILD_SESSION=1, and kill switches may be exported in
  // the invoking shell — inherited, either would flip the very behavior these
  // tests pin. A case testing one re-adds it via `env`.
  const inherited = { ...process.env };
  delete inherited.AUDIT_TOOLS_CHILD_SESSION;
  delete inherited.LLM_RELAY_DISPATCH_DEPTH;
  delete inherited.AUDIT_TOOLS_AGENT_GIT;
  delete inherited.AUDIT_TOOLS_NO_CLOSEOUT_CHALLENGE;
  delete inherited.AUDIT_TOOLS_NO_QUESTION_PHILOSOPHY;
  delete inherited.AUDIT_TOOLS_NO_FRICTION_STOP_GATE;
  const r = spawnSyncHidden(process.execPath, [hook], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
    env: { ...inherited, CLAUDE_PROJECT_DIR: root, ...env },
  });
  return { code: r.status, stderr: r.stderr ?? '' };
}

// Every case gets its own session id: both gates dedupe on it, so a shared id
// would make the second test in a file depend on the first having run.
let seq = 0;
const sid = (label: string): string => `test-${label}-${process.pid}-${seq++}`;

const askPayload = (session: string): HookPayload => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'AskUserQuestion',
  session_id: session,
  tool_input: { questions: [{ question: 'Big refactor or the smaller change?' }] },
});

// A root carrying only the philosophy doc — enough for the question gate, and
// isolated from the repo's own hook state dir.
let docRoot: string;
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
  it('blocks the first AskUserQuestion and injects BOTH halves of the brief', () => {
    const { code, stderr } = runHook(QUESTION_GATE, askPayload(sid('ask')), { root: docRoot });
    expect(code).toBe(2);
    // The single highest-yield line — the one that dissolves most scope questions.
    expect(stderr).toContain('are NOT costs');
    // A question can be about either half, so both must be present.
    expect(stderr).toContain('trustworthy even when the host agent is weak');
    expect(stderr).toContain('Ask on genuine ambiguity');
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
    const payload: HookPayload = { hook_event_name: 'PreToolUse', tool_name: 'Bash', session_id: sid('bash') };
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
    const payload: HookPayload = { ...askPayload('x'), session_id: undefined };
    expect(runHook(QUESTION_GATE, payload, { root: docRoot }).code).toBe(0);
  });

  describe('Stop trigger — only a message that ENDS in a question counts', () => {
    function transcriptRoot(finalText: string): { root: string; transcript: string } {
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
      const payload: HookPayload = { hook_event_name: 'Stop', session_id: sid('stop-q'), transcript_path: transcript };
      expect(runHook(QUESTION_GATE, payload, { root }).code).toBe(2);
      rmSync(root, { recursive: true, force: true });
    });

    it('allows a statement-only close, even when a question mark appears mid-message', () => {
      const { root, transcript } = transcriptRoot('You asked whether it was green? It is. Nothing pending.');
      const payload: HookPayload = { hook_event_name: 'Stop', session_id: sid('stop-noq'), transcript_path: transcript };
      expect(runHook(QUESTION_GATE, payload, { root }).code).toBe(0);
      rmSync(root, { recursive: true, force: true });
    });

    it('fails OPEN on an unreadable transcript', () => {
      const payload: HookPayload = {
        hook_event_name: 'Stop',
        session_id: sid('stop-bad'),
        transcript_path: join(tmpdir(), 'definitely-not-here.jsonl'),
      };
      expect(runHook(QUESTION_GATE, payload, { root: docRoot }).code).toBe(0);
    });

    it('allows a re-entrant stop (already blocked once)', () => {
      const { root, transcript } = transcriptRoot('Shall I continue?');
      const payload: HookPayload = {
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
  let repo: string;
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'closeout-'));
    const g = (...args: string[]) =>
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

  const stop = (session: string): HookPayload => ({ hook_event_name: 'Stop', session_id: session });

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

  it('demands owner decisions be ASKED in the hand-back, not pointed at', () => {
    // The recurring failure: "your decision — item X" with the actual question
    // (which the agent holds, options and all) never posed to the owner.
    const { stderr } = runHook(CLOSEOUT_GATE, stop(sid('ask-decisions')), { root: repo });
    expect(stderr).toContain('ASKED as a direct question');
    expect(stderr).toContain('a pointer, not a question');
  });

  it('demands the hand-back come from the RENDERER, not a conversational "yes, it was handled"', () => {
    // Left to its own devices the agent answers the challenge in prose and the
    // structured hand-back — the thing the next session actually reads — is
    // never re-emitted with the corrections this pass just made.
    //
    // What is pinned is the COMMAND and both halves of the "none" rule, not the
    // doc name. The message used to say "RE-RENDER the whole closeout report to
    // the scheme in <doc> ... never written out as none", which reads as an
    // instruction to hand-write markdown against a scheme, and applies the
    // OUTPUT rule to the INPUT, where every section must state a value or the
    // literal "none". 19 of 29 challenged sessions hand-wrote the report
    // (docs/reviews/closeout-generation-failure-2026-08-26.md).
    const { stderr } = runHook(CLOSEOUT_GATE, stop(sid('re-render')), { root: repo });
    expect(stderr).toContain('scripts/render-closeout.mjs --in');
    expect(stderr).toContain('INPUT JSON, EVERY section carries a value');
    expect(stderr).toContain('RENDERED OUTPUT');
    expect(stderr).toMatch(/render/i);
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

  // OBL-ci-red-verdict-vocabulary-fail-4: a CORRUPT challenge marker-file
  // degrades to "treat as first challenge", never a wedge. Pre-writing invalid
  // JSON where a valid `{count:2}` (at CHALLENGE_CAP) would have suppressed
  // this call proves the corrupt bytes were NOT read as an already-spent cap.
  it('a corrupt challenge marker-file degrades to first-challenge, never a silent wedge', () => {
    const session = sid('corrupt-marker');
    const markerDir = join(repo, '.claude', 'hooks', '.state', 'closeout-challenge');
    mkdirSync(markerDir, { recursive: true });
    writeFileSync(join(markerDir, `${session}.json`), 'not valid json {{{');
    expect(runHook(CLOSEOUT_GATE, stop(session), { root: repo }).code).toBe(2);
  });

  // The mid-task misfire class (backlog 2026-08-05/07-28): a stop that is a WAIT
  // on live background work is a turn boundary the harness resumes, not a
  // closeout — challenging there spends the cap before the real close.
  describe('live background work — the challenge waits for the real closeout', () => {
    it('does not spend the cap while a background task is live, and still challenges at the real stop', () => {
      const session = sid('live-bg');
      const live = {
        ...stop(session),
        background_tasks: [{ id: 'a1', type: 'subagent', status: 'running', agent_type: 'Explore' }],
      };
      expect(runHook(CLOSEOUT_GATE, live, { root: repo }).code).toBe(0);
      // Same session, same tree, no live work: the cap and the state-dedupe must
      // both be untouched by the skipped stop, so THIS one challenges.
      expect(runHook(CLOSEOUT_GATE, stop(session), { root: repo }).code).toBe(2);
    });

    it('ignores task type — a live workflow blocks the challenge like a subagent does', () => {
      const live = {
        ...stop(sid('live-wf')),
        background_tasks: [{ id: 'wf_x', type: 'workflow', status: 'running' }],
      };
      expect(runHook(CLOSEOUT_GATE, live, { root: repo }).code).toBe(0);
    });

    it('still challenges when every background task is terminal', () => {
      const harvested = {
        ...stop(sid('terminal-bg')),
        background_tasks: [
          { id: 'a1', type: 'subagent', status: 'completed' },
          { id: 'b2', type: 'shell', status: 'failed' },
        ],
      };
      expect(runHook(CLOSEOUT_GATE, harvested, { root: repo }).code).toBe(2);
    });

    it('treats an unknown task status as live — the cheap failure is a skipped challenge', () => {
      const odd = { ...stop(sid('odd-bg')), background_tasks: [{ id: 'x' }] };
      expect(runHook(CLOSEOUT_GATE, odd, { root: repo }).code).toBe(0);
    });

    it('skips while session crons are scheduled — a loop session stop is not an end', () => {
      const cron = { ...stop(sid('cron')), session_crons: [{ id: 'c1' }] };
      expect(runHook(CLOSEOUT_GATE, cron, { root: repo }).code).toBe(0);
    });

    // The terminated-but-unharvested window (2026-08-29 firing, diagnosed in
    // docs/reviews/closeout-gate-queued-resume-2026-08-29.md): a task's entry
    // leaves `background_tasks` on process EXIT, not on harvest, so a Stop
    // landing between the exit and the notification delivery sees an empty
    // array while the harness holds queued input it resumes seconds later.
    // The transcript's queue-operation depth is the positive evidence.
    function queueTranscript(lines: Array<Record<string, unknown>>): string {
      const dir = mkdtempSync(join(tmpdir(), 'closeout-queue-'));
      const t = join(dir, 'transcript.jsonl');
      writeFileSync(t, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
      return t;
    }

    it('does not fire — and spends nothing — while a task notification is queued but unabsorbed', () => {
      const session = sid('queued-resume');
      const transcript = queueTranscript([
        {
          type: 'queue-operation',
          operation: 'enqueue',
          content: '<task-notification>\n<task-id>b1</task-id>\n<status>failed</status>\n</task-notification>',
        },
      ]);
      const waiting = { ...stop(session), background_tasks: [], transcript_path: transcript };
      expect(runHook(CLOSEOUT_GATE, waiting, { root: repo }).code).toBe(0);
      // Same session, no queued input: the skipped wait left the cap and the
      // state-dedupe untouched, so the REAL stop still challenges.
      expect(runHook(CLOSEOUT_GATE, stop(session), { root: repo }).code).toBe(2);
    });

    it('fires once the queued notification has been absorbed', () => {
      const transcript = queueTranscript([
        {
          type: 'queue-operation',
          operation: 'enqueue',
          content: '<task-notification>\n<task-id>b1</task-id>\n</task-notification>',
        },
        // As the harness writes it: dequeue records carry no content, no task-id.
        { type: 'queue-operation', operation: 'dequeue' },
      ]);
      const absorbed = { ...stop(sid('absorbed')), background_tasks: [], transcript_path: transcript };
      expect(runHook(CLOSEOUT_GATE, absorbed, { root: repo }).code).toBe(2);
    });
  });

  it('fails OPEN outside a git repo — no work signal, nothing to challenge', () => {
    const bare = mkdtempSync(join(tmpdir(), 'closeout-bare-'));
    expect(runHook(CLOSEOUT_GATE, stop(sid('nogit')), { root: bare }).code).toBe(0);
    rmSync(bare, { recursive: true, force: true });
  });

  it('ignores a non-Stop event', () => {
    const payload: HookPayload = { hook_event_name: 'PreToolUse', tool_name: 'Bash', session_id: sid('notstop') };
    expect(runHook(CLOSEOUT_GATE, payload, { root: repo }).code).toBe(0);
  });

  // The WIRING, not just the predicate: a gate whose mechanism is tested but whose
  // call path is not is a gate that can silently stop reporting.
  describe('CI-on-main evidence', () => {
    // POSIX only, and not an arbitrary exclusion: a PATH-shadowing fake `gh` is
    // not constructible on win32. Node's plain spawn cannot execute a `.cmd`, so
    // it walks past the shim and finds the real gh.exe — and the only way to stop
    // that is to strip PATH, which also removes the `git` this gate runs first.
    // CI is ubuntu, so the wiring is covered where it is enforced. (The win32
    // shim path itself is handled in the hook by the ENOENT shell retry.)
    const posixOnly = process.platform === 'win32' ? it.skip : it;

    const fakeGh = (binDir: string, stdout: string, exitCode = 0): NodeJS.ProcessEnv => {
      mkdirSync(binDir, { recursive: true });
      writeFileSync(
        join(binDir, 'gh'),
        `#!/bin/sh\n${stdout ? `cat <<'JSON'\n${stdout}\nJSON\n` : ''}exit ${exitCode}\n`,
        { mode: 0o755 },
      );
      return { PATH: `${binDir}${delimiter}${process.env.PATH}` };
    };

    posixOnly('NAMES the red workflow when the latest run on main failed', () => {
      const binDir = mkdtempSync(join(tmpdir(), 'ghred-'));
      const json = JSON.stringify([
        { workflowName: 'ci', status: 'completed', conclusion: 'success', createdAt: '2026-07-26T02:00:00Z' },
        {
          workflowName: 'audit-code-test-suite',
          status: 'completed',
          conclusion: 'failure',
          createdAt: '2026-07-26T02:00:00Z',
        },
      ]);
      const { code, stderr } = runHook(CLOSEOUT_GATE, stop(sid('cired')), {
        root: repo,
        env: fakeGh(binDir, json),
      });
      expect(code).toBe(2);
      expect(stderr).toContain('CI is RED on main');
      expect(stderr).toContain('audit-code-test-suite');
      // The green sibling must not be reported — an over-broad red trains the
      // reader to wave at it.
      expect(stderr).not.toMatch(/^ {6}ci$/m);
      rmSync(binDir, { recursive: true, force: true });
    });

    posixOnly('says NOTHING about CI when gh is unavailable — cannot tell is not "fine"', () => {
      const binDir = mkdtempSync(join(tmpdir(), 'ghfail-'));
      const { stderr } = runHook(CLOSEOUT_GATE, stop(sid('cifail')), {
        root: repo,
        env: fakeGh(binDir, '', 1),
      });
      expect(stderr).not.toContain('CI is RED');
      rmSync(binDir, { recursive: true, force: true });
    });

    // OBL-ci-red-verdict-vocabulary-inv-2 / fail-1: the vocabulary fix must
    // actually reach the gate's own CI-red finding, not just the pure
    // latestFailedWorkflows unit — only 'failure' was covered here before.
    posixOnly('NAMES a timed_out workflow as red too, not only failure', () => {
      const binDir = mkdtempSync(join(tmpdir(), 'ghtimedout-'));
      const json = JSON.stringify([
        { workflowName: 'ci', status: 'completed', conclusion: 'success', createdAt: '2026-07-26T02:00:00Z' },
        {
          workflowName: 'audit-code-test-suite',
          status: 'completed',
          conclusion: 'timed_out',
          createdAt: '2026-07-26T02:00:00Z',
        },
      ]);
      const { code, stderr } = runHook(CLOSEOUT_GATE, stop(sid('citimedout')), {
        root: repo,
        env: fakeGh(binDir, json),
      });
      expect(code).toBe(2);
      expect(stderr).toContain('CI is RED on main');
      expect(stderr).toContain('audit-code-test-suite');
      rmSync(binDir, { recursive: true, force: true });
    });

    // fail-1's non-JSON half: `gh` exiting 0 with malformed stdout must also
    // degrade to silence (JSON.parse throws, the surrounding try/catch
    // swallows it) rather than an uncaught exception or a false claim.
    posixOnly('says NOTHING about CI when gh returns malformed (non-JSON) stdout', () => {
      const binDir = mkdtempSync(join(tmpdir(), 'ghmalformed-'));
      const { code, stderr } = runHook(CLOSEOUT_GATE, stop(sid('cimalformed')), {
        root: repo,
        env: fakeGh(binDir, 'not valid json {{{'),
      });
      // The gate must still resolve its own verdict on the rest of the tree
      // (dirt/HEAD-age), never crash uncaught because of the CI probe alone.
      expect(code).toBe(2);
      expect(stderr).not.toContain('CI is RED');
      rmSync(binDir, { recursive: true, force: true });
    });
  });
});

// The closeout gate's Build 3 leg: whole-tree dirt partitioned by the session's
// registered tree-dirt baseline. Dirt present at session start is FOREIGN —
// reported as pre-session, never challenged, never in the dedupe key.
describe('closeout-challenge-gate: tree-dirt baseline partition (Build 3)', () => {
  // Arming the registry is PERMANENT for a root: one `*.json` under
  // `.claude/hooks/.state/sessions/` flips every later spawn in that root onto
  // the partition/child-skip path. So EVERY case here gets a FRESH mkdtemp
  // repo — the shared beforeAll fixture above must stay UNARMED for the legacy
  // whole-tree cases (which double as the transitional-window regression
  // guard).
  const partitionRoots: string[] = [];
  afterAll(() => {
    for (const root of partitionRoots) {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        /* windows lock — leave it to the temp reaper */
      }
    }
  });

  function freshRepo({ backdatedHours = 24 }: { backdatedHours?: number } = {}): string {
    const root = mkdtempSync(join(tmpdir(), 'closeout-part-'));
    partitionRoots.push(root);
    const g = (args: string[], env: NodeJS.ProcessEnv = {}) =>
      spawnSyncHidden('git', args, {
        cwd: root,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 30_000,
        env: { ...process.env, ...env },
      });
    g(['init', '-q']);
    g(['config', 'user.email', 'test@example.com']);
    g(['config', 'user.name', 'test']);
    g(['config', 'commit.gpgsign', 'false']);
    writeFileSync(join(root, 'a.ts'), 'export const one = 1;\n');
    g(['add', '.']);
    // Backdated so `headMovedRecently` is false and the DIRT signal alone
    // decides (a fresh commit fires the gate regardless of the partition).
    const when = new Date(Date.now() - backdatedHours * 60 * 60 * 1000).toISOString();
    g(
      ['commit', '-qm', 'initial'],
      backdatedHours > 0 ? { GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when } : {},
    );
    return root;
  }

  async function register(root: string, sessionId: string, baseline: string[]): Promise<void> {
    // The lib's own writer — the same write path the SessionStart leg uses, so
    // this fixture can never drift from the frozen record shape. Imported
    // lazily so a tree without the lib fails only these cases, not the file.
    const lib = await import('../../scripts/shared/sessionRegistry.mjs');
    lib.writeSessionRecord(root, {
      version: 1,
      session_id: sessionId,
      registered_at: new Date().toISOString(),
      source: 'test',
      baseline,
    });
  }

  const stopPayload = (session: string): HookPayload => ({ hook_event_name: 'Stop', session_id: session });

  it("foreign-only dirt does not challenge — pre-session dirt is not this session's work", async () => {
    const repo = freshRepo();
    writeFileSync(join(repo, 'pre.txt'), 'pre-session\n');
    const session = sid('foreign-only');
    await register(repo, session, ['pre.txt']);
    expect(runHook(CLOSEOUT_GATE, stopPayload(session), { root: repo }).code).toBe(0);
  });

  it('a first-sorted TRACKED modification in the baseline is classified foreign', async () => {
    // The trim trap: ` M a.ts` sorts first, so its leading space is the first
    // byte of the porcelain output — a trimmed read mangles exactly this
    // record and the phantom path never matches the baseline.
    const repo = freshRepo();
    writeFileSync(join(repo, 'a.ts'), 'export const one = 2;\n'); // unstaged ` M a.ts`
    const session = sid('tracked-mod-foreign');
    await register(repo, session, ['a.ts']);
    expect(runHook(CLOSEOUT_GATE, stopPayload(session), { root: repo }).code).toBe(0);
  });

  it('session dirt still challenges, with the evidence partitioned into yours vs pre-session', async () => {
    const repo = freshRepo();
    writeFileSync(join(repo, 'pre.txt'), 'pre-session\n');
    const session = sid('partitioned');
    await register(repo, session, ['pre.txt']);
    writeFileSync(join(repo, 'own.txt'), 'session work\n');
    const { code, stderr } = runHook(CLOSEOUT_GATE, stopPayload(session), { root: repo });
    expect(code).toBe(2);
    expect(stderr).toContain('UNCOMMITTED work in the tree (1 path(s))');
    expect(stderr).toContain('own.txt');
    expect(stderr).toMatch(/PRE-SESSION dirt/);
    expect(stderr).toMatch(/NOT yours/i);
    // pre.txt appears ONLY as pre-session evidence, after the marker — never
    // in the UNCOMMITTED block.
    expect(stderr.indexOf('pre.txt')).toBeGreaterThan(stderr.indexOf('PRE-SESSION'));
    expect(stderr.indexOf('own.txt')).toBeLessThan(stderr.indexOf('PRE-SESSION'));
  });

  it('foreign changes cannot re-key the challenge dedupe', async () => {
    const repo = freshRepo();
    writeFileSync(join(repo, 'pre.txt'), 'pre\n');
    writeFileSync(join(repo, 'gone.txt'), 'pre, about to be cleaned by its owner\n');
    const session = sid('rekey');
    await register(repo, session, ['pre.txt', 'gone.txt']);
    writeFileSync(join(repo, 'own.txt'), 'session work\n');
    expect(runHook(CLOSEOUT_GATE, stopPayload(session), { root: repo }).code).toBe(2);
    // Another session commits/cleans ITS dirt: the porcelain text shrinks, but
    // this session's dirt is unchanged — the same challenge must not re-fire
    // and burn the second cap slot.
    rmSync(join(repo, 'gone.txt'));
    expect(runHook(CLOSEOUT_GATE, stopPayload(session), { root: repo }).code).toBe(0);
  });

  it("an unregistered session under an ARMED registry is skipped — its stop is not this repo's closeout", async () => {
    // Fresh HEAD + dirty tree: the strongest work signal, still skipped. This
    // is the gate-side half of the child-session split, landed with the
    // partition because the decision tree forces it.
    const repo = freshRepo({ backdatedHours: 0 });
    await register(repo, 'someone-else', []);
    writeFileSync(join(repo, 'work.txt'), "a child's deliverable\n");
    expect(runHook(CLOSEOUT_GATE, stopPayload(sid('unregistered-child')), { root: repo }).code).toBe(0);
  });

  it('a skipped child stop spends NOTHING — no marker written, full cap available after registration', async () => {
    // The skip must cost the child nothing AND leave the session's cap intact:
    // if the skip wrote a marker or spent a cap slot, registering the same id
    // later would find a half-spent gate it never interacted with.
    const repo = freshRepo({ backdatedHours: 0 });
    await register(repo, 'someone-else', []);
    writeFileSync(join(repo, 'work.txt'), "a child's deliverable\n");
    const child = sid('cap-not-spent');
    expect(runHook(CLOSEOUT_GATE, stopPayload(child), { root: repo }).code).toBe(0);
    // The skip recorded no state for the child id.
    expect(
      existsSync(join(repo, '.claude', 'hooks', '.state', 'closeout-challenge', `${child}.json`)),
    ).toBe(false);
    // Same id, now registered: the full cap is available, so this challenges.
    await register(repo, child, []);
    expect(runHook(CLOSEOUT_GATE, stopPayload(child), { root: repo }).code).toBe(2);
  });

  it('a CORRUPT record degrades to whole-tree challenging, never to gate silence', () => {
    // Near-miss for the child skip: corrupt ≠ absent. A corrupt record still
    // arms the registry, but the session counts as REGISTERED with an empty
    // baseline — no worse than today, never silent for the owner.
    const repo = freshRepo();
    const session = sid('corrupt-record');
    const sessions = join(repo, '.claude', 'hooks', '.state', 'sessions');
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, `${session}.json`), 'not json{{{');
    writeFileSync(join(repo, 'work.txt'), 'session work\n');
    const { code, stderr } = runHook(CLOSEOUT_GATE, stopPayload(session), { root: repo });
    expect(code).toBe(2);
    expect(stderr).toContain('work.txt');
  });

  it('an UNARMED registry still fires on any dirt — the transitional-window guarantee', () => {
    const repo = freshRepo();
    writeFileSync(join(repo, 'pre-existing.txt'), 'dirt from before the session\n');
    const { code, stderr } = runHook(CLOSEOUT_GATE, stopPayload(sid('unarmed')), { root: repo });
    expect(code).toBe(2);
    expect(stderr).toContain('pre-existing.txt');
  });
});

// OBL-ci-red-verdict-vocabulary-inv-4 / fail-3: REL-cfc0b00d's specific
// reproduction (later cases in the shared-repo describe above depend on the
// first case's dirty.txt to fire) does NOT hold at HEAD — headMovedRecently,
// from the shared beforeAll's non-backdated commit, is an independent,
// dirt-free trigger. These two cases pin that boundary directly and
// hermetically (their OWN isolated repo each, never the shared describe's
// mutable fixture), so a future change to the shared beforeAll's commit step
// cannot silently make the case above pass for the wrong reason. Together
// they are the red-green PAIR: #1 alone proves headMovedRecently fires;
// #2 alone proves the SAME fixture stays silent once that trigger is removed
// (dirt-free, unpushed-free) — without #2, #1 could pass for an unrelated
// reason (e.g. an accidental default-dirty temp dir).
// The gate named a condition it did not test. "UNPUSHED commit(s) — the next
// agent clones origin/main and will not see these" asserts the work is only
// local; what the gate reads is `git log origin/main..HEAD`, which is true of a
// lap that pushed every commit to its own branch. A gate whose HEADLINE is
// falsifiable teaches the reader to discount it and skim the accurate clause
// underneath — the same corrosion a false red causes.
describe('closeout-challenge-gate: the not-on-main finding names what it TESTS', () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots) {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        /* windows lock — leave it to the temp reaper */
      }
    }
  });

  /** A repo on branch `feat` with one commit past `main`, optionally pushed. */
  function repoWithBranch({ pushed }: { pushed: boolean }): string {
    const root = mkdtempSync(join(tmpdir(), 'closeout-upstream-'));
    roots.push(root);
    const g = (...args: string[]) => spawnSyncHidden('git', args, { cwd: root, encoding: 'utf8' });
    g('init', '-q');
    g('config', 'user.email', 'test@example.com');
    g('config', 'user.name', 'test');
    g('config', 'commit.gpgsign', 'false');
    writeFileSync(join(root, 'a.txt'), 'one\n');
    g('add', '.');
    g('commit', '-qm', 'initial');
    g('branch', '-M', 'main');
    // A real local bare remote: a URL that does not resolve would make the
    // upstream questions unanswerable for reasons unrelated to the gate.
    const bare = mkdtempSync(join(tmpdir(), 'closeout-bare-'));
    roots.push(bare);
    spawnSyncHidden('git', ['init', '-q', '--bare', bare], { encoding: 'utf8' });
    g('remote', 'add', 'origin', bare);
    g('checkout', '-q', '-b', 'feat');
    writeFileSync(join(root, 'b.txt'), 'work\n');
    g('add', '.');
    g('commit', '-qm', 'the work this branch carries');
    // `origin/main` must exist for the range to resolve at all.
    g('push', '-q', 'origin', 'main');
    if (pushed) g('push', '-q', '-u', 'origin', 'feat');
    g('fetch', '-q', 'origin');
    return root;
  }

  it('names the tested condition — NOT MERGED into main — instead of asserting the work is local', () => {
    const { code, stderr } = runHook(
      CLOSEOUT_GATE,
      { hook_event_name: 'Stop', session_id: sid('upstream-name') },
      { root: repoWithBranch({ pushed: false }) },
    );
    expect(code).toBe(2);
    expect(stderr).toContain('NOT MERGED into');
    // The false headline must be gone: it is the thing this test exists for.
    expect(stderr).not.toContain('UNPUSHED');
  });

  it('says the work is NOT local-only when the branch upstream exists and is current', () => {
    // The case the entry was filed from: a lap that pushed every commit to its
    // own branch, upstream current, read a flat assertion it could disprove in
    // one command.
    const { code, stderr } = runHook(
      CLOSEOUT_GATE,
      { hook_event_name: 'Stop', session_id: sid('upstream-current') },
      { root: repoWithBranch({ pushed: true }) },
    );
    expect(code).toBe(2);
    expect(stderr).toContain('NOT MERGED into');
    expect(stderr).toMatch(/IS pushed and current on/);
    expect(stderr).toMatch(/not local-only/);
  });

  it('says the work IS local-only when no upstream is configured for the branch', () => {
    const { code, stderr } = runHook(
      CLOSEOUT_GATE,
      { hook_event_name: 'Stop', session_id: sid('upstream-absent') },
      { root: repoWithBranch({ pushed: false }) },
    );
    expect(code).toBe(2);
    expect(stderr).toMatch(/No upstream is configured/);
    expect(stderr).not.toMatch(/IS pushed and current/);
  });
});

describe('closeout-challenge-gate: headMovedRecently is independently sufficient (hermetic, no shared fixture)', () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots) {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        /* windows lock — leave it to the temp reaper */
      }
    }
  });

  function isolatedRepo(backdatedHours: number): string {
    const root = mkdtempSync(join(tmpdir(), 'closeout-hermetic-'));
    roots.push(root);
    const g = (args: string[], env: NodeJS.ProcessEnv = {}) =>
      spawnSyncHidden('git', args, {
        cwd: root,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 30_000,
        env: { ...process.env, ...env },
      });
    g(['init', '-q']);
    g(['config', 'user.email', 'test@example.com']);
    g(['config', 'user.name', 'test']);
    g(['config', 'commit.gpgsign', 'false']);
    writeFileSync(join(root, 'a.txt'), 'one\n');
    g(['add', '.']);
    const when = new Date(Date.now() - backdatedHours * 60 * 60 * 1000).toISOString();
    g(['commit', '-qm', 'initial'], backdatedHours > 0 ? { GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when } : {});
    return root;
  }

  it('a fresh, non-backdated, dirt-free repo still challenges — headMovedRecently alone triggers it', () => {
    const root = isolatedRepo(0);
    const { code, stderr } = runHook(CLOSEOUT_GATE, { hook_event_name: 'Stop', session_id: sid('hermetic-fresh') }, { root });
    expect(code).toBe(2);
    expect(stderr).toContain('are you sure that was all taken care of');
  });

  it('the SAME dirt-free repo stays silent once backdated ~24h — proving test 1 is headMovedRecently, not an accident', () => {
    const root = isolatedRepo(24);
    const { code } = runHook(CLOSEOUT_GATE, { hook_event_name: 'Stop', session_id: sid('hermetic-backdated') }, { root });
    expect(code).toBe(0);
  });
});

// This is the bug fix test: a NEW session registered AFTER an old commit
// should NOT be challenged by headMovedRecently. The HEAD commit time must
// be compared against the session's registered_at, not wall-clock time.
// This is the same comparison used for foreign render detection (line 283
// in closeout-challenge-gate.mjs).
describe('closeout-challenge-gate: HEAD time vs session registered_at (foreign commit detection)', () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots) {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        /* windows lock — leave it to the temp reaper */
      }
    }
  });

  async function register(root: string, sessionId: string, baseline: string[]): Promise<void> {
    const lib = await import('../../scripts/shared/sessionRegistry.mjs');
    lib.writeSessionRecord(root, {
      version: 1,
      session_id: sessionId,
      registered_at: new Date().toISOString(),
      source: 'test',
      baseline,
    });
  }

  function isolatedRepo(backdatedHours: number): string {
    const root = mkdtempSync(join(tmpdir(), 'closeout-headtime-'));
    roots.push(root);
    const g = (args: string[], env: NodeJS.ProcessEnv = {}) =>
      spawnSyncHidden('git', args, {
        cwd: root,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 30_000,
        env: { ...process.env, ...env },
      });
    g(['init', '-q']);
    g(['config', 'user.email', 'test@example.com']);
    g(['config', 'user.name', 'test']);
    g(['config', 'commit.gpgsign', 'false']);
    writeFileSync(join(root, 'a.txt'), 'one\n');
    g(['add', '.']);
    const when = new Date(Date.now() - backdatedHours * 60 * 60 * 1000).toISOString();
    g(['commit', '-qm', 'initial'], backdatedHours > 0 ? { GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when } : {});
    return root;
  }

  // Bug: RECENT_MS = 12h. A commit 8h ago is "recent" by wall clock, but if the
  // session registered NOW (after that commit), the commit is FOREIGN. The buggy
  // gate challenges because it only checks wall clock. The fix compares commit
  // time against session registered_at.
  it('a session registered after an 8h-old commit does NOT challenge — HEAD is foreign to this session', async () => {
    const repo = isolatedRepo(8); // commit 8h ago (within 12h RECENT_MS)
    const session = sid('session-after-8h-commit');
    await register(repo, session, []); // register NOW
    const { code } = runHook(CLOSEOUT_GATE, { hook_event_name: 'Stop', session_id: session }, { root: repo });
    expect(code).toBe(0); // should NOT challenge - HEAD is foreign to this session
  });

  // Session registered first, then a fresh commit made - HEAD time >=
  // registered_at (commit happens after registration, so it's this session's work)
  it('a session registered before a fresh commit DOES challenge — HEAD time >= session registered_at', async () => {
    const repo = isolatedRepo(24); // old commit, won't trigger
    const session = sid('session-before-fresh-commit');
    await register(repo, session, []); // register NOW
    // Small delay to ensure commit time > registered_at
    await new Promise((r) => setTimeout(r, 50));
    // Now make a FRESH commit (after registration) with explicit future timestamp
    const g = (args: string[], env: NodeJS.ProcessEnv = {}) =>
      spawnSyncHidden('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true, timeout: 30_000, env: { ...process.env, ...env } });
    writeFileSync(join(repo, 'fresh.txt'), 'fresh work\n');
    g(['add', '.']);
    const when = new Date(Date.now() + 1000).toISOString(); // 1 second in future
    g(['commit', '-qm', 'fresh commit'], { GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when });
    const { code } = runHook(CLOSEOUT_GATE, { hook_event_name: 'Stop', session_id: session }, { root: repo });
    expect(code).toBe(2); // SHOULD challenge - HEAD is this session's work
  });
});

// The closeout render record used to be ONE repo-global file, and its session
// ownership rested on a TIMESTAMP — so a CONCURRENT session that rendered after
// this one started read as this one's own render, and the tree comparison caught
// it only when the content differed. The record is now keyed per session on the
// id the environment actually supplies.
describe('closeout-challenge-gate: only a record THIS session wrote closes it', () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots) {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        /* windows lock — leave it to the temp reaper */
      }
    }
  });

  async function armedRepo(): Promise<{ root: string; session: string; tree: string }> {
    const root = mkdtempSync(join(tmpdir(), 'closeout-render-rec-'));
    roots.push(root);
    const g = (...args: string[]) => spawnSyncHidden('git', args, { cwd: root, encoding: 'utf8' });
    g('init', '-q');
    g('config', 'user.email', 'test@example.com');
    g('config', 'user.name', 'test');
    g('config', 'commit.gpgsign', 'false');
    writeFileSync(join(root, 'a.txt'), 'one\n');
    g('add', '.');
    g('commit', '-qm', 'initial');
    const session = sid('render-record');
    const lib = await import('../../scripts/shared/sessionRegistry.mjs');
    lib.writeSessionRecord(root, {
      version: 1,
      session_id: session,
      registered_at: new Date().toISOString(),
      source: 'test',
      baseline: [],
    });
    const { worktreeTree } = await import('../../scripts/shared/worktree-tree.mjs');
    // A fixture repo with no identity would make every case below vacuous, so
    // this asserts rather than widening the type to a null no case can use.
    const tree = worktreeTree(root);
    expect(tree, 'fixture repo has no worktree tree identity').toBeTruthy();
    return { root, session, tree: tree as string };
  }

  /**
   * Write a render record. `sessionId` names the FILE (which session's record
   * this is); `namedAs` overrides the id INSIDE it, so a case can reproduce a
   * record that sits at one session's path while claiming to be another's.
   */
  function writeRecord(
    root: string,
    sessionId: string | null,
    tree: string,
    { namedAs }: { namedAs?: string } = {},
  ): void {
    const dir = join(root, '.claude', 'hooks', '.state', 'closeout-render');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, sessionId === null ? 'latest.json' : `${sessionId}.json`),
      JSON.stringify({
        version: 2,
        tree,
        head: null,
        rendered_at: new Date().toISOString(),
        session_id: namedAs === undefined ? sessionId : namedAs,
        report_anchors: [],
      }),
    );
  }

  const stop = (session: string): HookPayload => ({ hook_event_name: 'Stop', session_id: session });

  it("a CONCURRENT session's record — same tree, written after this one started — does NOT close it", async () => {
    // The exact case the timestamp could not tell apart: the render is NEWER
    // than this session's registration, so `rendered_at >= registered_at` held
    // and the old arm accepted it. Only the session id separates the two.
    //
    // The record sits at THIS session's bound path but NAMES another session —
    // the shape a concurrent writer actually produces, since the two sessions
    // share a checkout and only the id tells them apart. (A record at the OTHER
    // session's path is the ordinary nothing-here case, covered above.)
    const { root, session, tree } = await armedRepo();
    writeFileSync(join(root, 'own.txt'), 'this session did work\n');
    writeRecord(root, session, tree, { namedAs: 'some-other-session' });
    const { code, stderr } = runHook(CLOSEOUT_GATE, stop(session), { root });
    expect(code).toBe(2);
    expect(stderr).toContain("is NOT this session's hand-back");
    expect(stderr).toContain('some-other-session');
  });

  it("a record written for THIS session, describing this tree, closes the render check", async () => {
    const { root, session, tree } = await armedRepo();
    writeFileSync(join(root, 'own.txt'), 'this session did work\n');
    writeRecord(root, session, tree);
    const { code, stderr } = runHook(CLOSEOUT_GATE, stop(session), { root });
    // The gate still fires on other evidence (no suite-green stamp, no CI read
    // here) — what this pins is that the render finding is ABSENT.
    expect(stderr).not.toContain("is NOT this session's hand-back");
    expect(stderr).not.toContain('no rendered closeout on record');
    expect(code).toBe(2);
  });

  it('a legacy repo-global record — the old `latest.json`, session_id null — satisfies nobody', async () => {
    // The upgrade path, and deliberately the conservative direction: the record
    // lives at the OLD repo-global path and names no session, so a reader that
    // looks up this session's own file finds nothing and re-renders once. An
    // unattributable render is not evidence that THIS session rendered.
    const { root, session, tree } = await armedRepo();
    writeFileSync(join(root, 'own.txt'), 'this session did work\n');
    writeRecord(root, null, tree);
    const { stderr } = runHook(CLOSEOUT_GATE, stop(session), { root });
    expect(stderr).toContain('no rendered closeout on record for THIS session');
    // And specifically NOT accepted: neither arm that would mean the record was
    // read and honoured may fire.
    expect(stderr).not.toContain("is NOT this session's hand-back");
  });
});

// The question gate's Build 1 leg: the unregistered-child skip is STOP-LEG ONLY.
// A child's closing question is part of its returned deliverable — exit-2'ing it
// hijacks the hand-back (P23). A child that explicitly calls AskUserQuestion is
// performing an interactive act the philosophy injection legitimately governs,
// so that leg still fires.
// Step 8 of the global /start-lap skill MANDATES ending the turn with a direct
// request to approve the lap plan, and requires it be asked WITH
// AskUserQuestion. No standing conviction can settle it — the question asks for
// scope AUTHORIZATION, not for how to proceed, and the brief this gate prints is
// about the latter.
//
// The exemption is ONE QUESTION, not one boundary. The signal alone (a lap record
// with nothing committed since) is true of every question asked between the lap
// opening and its first commit, so the use is RECORDED, keyed on the lap record's
// `lapId`, in this session's own state: the first question at the boundary passes
// on BOTH legs, every later one is challenged as normal.
//
// It never applies to a lap record another session opened. The mechanical test is
// the record FILE's mtime against this session's `registered_at`: /start-lap
// writes the record at step 1, after the session registered, so a record older
// than the registration belongs to a lap this session did not open.
describe('question-philosophy-gate: the lap-APPROVAL question is exempt by construction', () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots) {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        /* windows lock — leave it to the temp reaper */
      }
    }
  });

  /** The `lapId` the hook keys the exemption on — 8 hex, as /start-lap mints it. */
  const LAP_ID = 'deadbeef';

  /**
   * A repo at a lap boundary, with a registered owner session and a transcript.
   * `lapMtimeMs` backdates the lap RECORD's mtime, the mechanical signal for
   * "another session opened this lap".
   *
   * The once-per-session philosophy marker is deliberately NOT pre-written. It is
   * checked unconditionally on both legs and exits 0 on its own, BEFORE the
   * exemption is consulted — so a session carrying it never reaches the code
   * these cases are about, and every question in that session exits 0 whatever
   * the exemption decides. Leaving it unwritten is what makes the exemption the
   * thing under test; the cost is that a case's FIRST question spends the marker,
   * so the SECOND call is what the assertions below actually read.
   *
   * `finalText` is the transcript's closing message. The default ENDS in a
   * question, which is what the Stop-leg cases need; a case proving that a
   * statement-only Stop spends nothing must pass a text that does not.
   */
  async function lapQuestionRoot({
    lapStart,
    commitSinceRegistration,
    lapMtimeMs = 0,
    finalText = 'Shall I start the lap as planned?',
  }: {
    lapStart: boolean;
    commitSinceRegistration: boolean;
    lapMtimeMs?: number;
    finalText?: string;
  }): Promise<{ root: string; transcript: string; session: string }> {
    const root = mkdtempSync(join(tmpdir(), 'philgate-lap-'));
    roots.push(root);
    mkdirSync(join(root, 'docs'), { recursive: true });
    cpSync(join(REPO_ROOT, 'docs', 'project-philosophy.md'), join(root, 'docs', 'project-philosophy.md'));
    const g = (...args: string[]) => spawnSyncHidden('git', args, { cwd: root, encoding: 'utf8' });
    g('init', '-q');
    g('config', 'user.email', 'test@example.com');
    g('config', 'user.name', 'test');
    g('config', 'commit.gpgsign', 'false');
    writeFileSync(join(root, 'seed.txt'), 'seed\n');
    g('add', '.');
    // BACKDATED by an hour: at second granularity a same-second registration
    // and commit are indistinguishable, and the fixture would then be testing
    // clock resolution rather than the boundary. Found the hard way — the first
    // version of this fixture committed in the same second it registered and
    // the exemption arm read it as "work has landed".
    const when = new Date(Date.now() - 3600_000).toISOString();
    spawnSyncHidden('git', ['commit', '-qm', 'seed'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when },
    });
    if (lapStart) {
      mkdirSync(join(root, '.claude'), { recursive: true });
      // The real record shape /start-lap's opener writes (lap-worktree.mjs):
      // `lapId` is the 8-hex id the exemption is keyed on.
      const lapPath = join(root, '.claude', 'lap-start.json');
      writeFileSync(
        lapPath,
        JSON.stringify({ start: 'x', date: '2026-01-01', goal: 'the lap', lapId: LAP_ID, checkout: root }),
      );
      if (lapMtimeMs > 0) {
        const t = new Date(Date.now() - lapMtimeMs);
        utimesSync(lapPath, t, t);
      }
    }
    // Arm the registry with a resident owner record: an unregistered session
    // under an armed registry is a CHILD, and a child is skipped EARLIER on both
    // legs — before the exemption is consulted. Without this record every
    // AskUserQuestion case below would exit 0 for a reason that has nothing to
    // do with the lap; the Stop-leg cases stay green either way, which is exactly
    // why the record has to be here rather than only where it changes the answer.
    const session = sid('lap-approval');
    const lib = await import('../../scripts/shared/sessionRegistry.mjs');
    lib.writeSessionRecord(root, {
      version: 1,
      session_id: session,
      registered_at: new Date().toISOString(),
      source: 'test',
      baseline: [],
    });
    if (commitSinceRegistration) {
      writeFileSync(join(root, 'later.txt'), 'later work\n');
      g('add', '.');
      g('commit', '-qm', 'work after the lap opened');
    }
    const transcript = join(root, 'transcript.jsonl');
    writeFileSync(
      transcript,
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: finalText }],
        },
      }) + '\n',
    );
    return { root, transcript, session };
  }

  const lapAsk = (session: string): HookPayload => askPayload(session);

  it('does NOT challenge the approval request at a lap that has not begun', async () => {
    const { root, transcript, session } = await lapQuestionRoot({
      lapStart: true,
      commitSinceRegistration: false,
    });
    const payload: HookPayload = {
      hook_event_name: 'Stop',
      session_id: session,
      transcript_path: transcript,
    };
    expect(runHook(QUESTION_GATE, payload, { root }).code).toBe(0);
  });

  // D1: /start-lap step 8 requires the approval request be asked WITH
  // AskUserQuestion, so a Stop-leg-only exemption challenged the one question it
  // exists for. The first AskUserQuestion at the boundary must pass BOTH legs.
  it('does NOT challenge the FIRST AskUserQuestion at the boundary — the approval request is asked with the tool', async () => {
    const { root, session } = await lapQuestionRoot({ lapStart: true, commitSinceRegistration: false });
    expect(runHook(QUESTION_GATE, lapAsk(session), { root }).code).toBe(0);
  });

  it('DOES challenge a SECOND AskUserQuestion in the same lap — the exemption is ONE question, not the boundary', async () => {
    // The property the lapId-keyed record exists for. Without it, every question
    // asked between the lap opening and its first commit would pass.
    const { root, session } = await lapQuestionRoot({ lapStart: true, commitSinceRegistration: false });
    expect(runHook(QUESTION_GATE, lapAsk(session), { root }).code).toBe(0);
    expect(runHook(QUESTION_GATE, lapAsk(session), { root }).code).toBe(2);
  });

  it('DOES challenge an AskUserQuestion once the lap has committed — the exemption is the BOUNDARY, not the lap', async () => {
    // The other half, and the one that keeps this from becoming a blanket
    // exemption for every session that ever opened a lap.
    const { root, session } = await lapQuestionRoot({ lapStart: true, commitSinceRegistration: true });
    expect(runHook(QUESTION_GATE, lapAsk(session), { root }).code).toBe(2);
  });

  it("DOES challenge when the lap record is OLDER than this session's registration — another session opened it", async () => {
    // /start-lap writes the record at step 1, after the session registered. A
    // record predating the registration is a lap this session did not open, and
    // its approval question is not this session's to spend the exemption on.
    const { root, session } = await lapQuestionRoot({
      lapStart: true,
      commitSinceRegistration: false,
      lapMtimeMs: 600_000, // the record was written 10 minutes before now
    });
    expect(runHook(QUESTION_GATE, lapAsk(session), { root }).code).toBe(2);
  });

  it('DOES challenge on the STOP leg once the lap has committed — the Stop leg keeps its behavior', async () => {
    // The Stop leg keeps its current behaviour: the same boundary test governs
    // it, so a committed lap challenges there too.
    const { root, transcript, session } = await lapQuestionRoot({
      lapStart: true,
      commitSinceRegistration: true,
    });
    const payload: HookPayload = {
      hook_event_name: 'Stop',
      session_id: session,
      transcript_path: transcript,
    };
    expect(runHook(QUESTION_GATE, payload, { root }).code).toBe(2);
  });

  // The exemption is spent by ONE question, and the question that spends it is
  // the one the gate would otherwise CHALLENGE — the exemption is consulted after
  // the once-per-session marker and after the Stop leg's trailing-question test.
  // A Stop whose final message asks the owner nothing never reaches it, so it
  // cannot use the exemption up. This is the pair that pins the placement: the
  // same Stop payload, the same boundary, and the two cases differ ONLY in
  // whether the closing line ends in a question.
  it('does NOT spend the exemption on a Stop whose closing message asks NOTHING', async () => {
    // The placement, not the exemption: the gate is consulted after the Stop
    // leg's trailing-question test, so a turn that asks the owner nothing never
    // reaches it. The value is that the approval request usually arrives as a
    // Stop — the lap plan is presented and asked about in one message — so an
    // exemption spent by every other turn's Stop would be gone by the time the
    // mandated question is asked.
    //
    // Both halves are ONE behaviour, so they are ONE case: the second assertion
    // IS the observation (the exemption is still unspent). The transcript must
    // be statement-only — with a question-ending close the Stop legitimately
    // reaches the exemption and this case would be asserting the opposite of
    // what it says.
    const { root, transcript, session } = await lapQuestionRoot({
      lapStart: true,
      commitSinceRegistration: false,
      finalText: 'Landed the fix. Nothing pending.',
    });
    const payload: HookPayload = { hook_event_name: 'Stop', session_id: session, transcript_path: transcript };
    expect(runHook(QUESTION_GATE, payload, { root }).code).toBe(0);
    expect(runHook(QUESTION_GATE, lapAsk(session), { root }).code).toBe(0);
  });

  it('spends the exemption on a question-ending Stop, and challenges the question that follows', async () => {
    // The other side of the same coin, and the half the first case cannot see:
    // a Stop-leg use that is never RECORDED. The Stop below reaches the
    // exemption (the marker is unwritten and its close does end in a question),
    // so it passes either way — the second assertion is what observes whether
    // the use was written down. An unrecorded use leaves the boundary looking
    // unspent and the next question exempt as well.
    const { root, transcript, session } = await lapQuestionRoot({ lapStart: true, commitSinceRegistration: false });
    const payload: HookPayload = { hook_event_name: 'Stop', session_id: session, transcript_path: transcript };
    expect(runHook(QUESTION_GATE, payload, { root }).code).toBe(0);
    expect(runHook(QUESTION_GATE, lapAsk(session), { root }).code).toBe(2);
  });

  it('DOES challenge a question when no lap record exists at all', async () => {
    // "Nothing committed recently" alone is true of any idle session, so the
    // record is load-bearing: without it the exemption would swallow questions
    // in sessions that never opened a lap.
    const { root, transcript, session } = await lapQuestionRoot({
      lapStart: false,
      commitSinceRegistration: false,
    });
    const payload: HookPayload = {
      hook_event_name: 'Stop',
      session_id: session,
      transcript_path: transcript,
    };
    expect(runHook(QUESTION_GATE, payload, { root }).code).toBe(2);
  });
});


describe('question-philosophy-gate: unregistered-child skip is Stop-leg only (Build 1)', () => {
  const childRoots: string[] = [];
  afterAll(() => {
    for (const root of childRoots) {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        /* windows lock — leave it to the temp reaper */
      }
    }
  });

  async function armedQuestionRoot(finalText: string): Promise<{ root: string; transcript: string }> {
    const root = mkdtempSync(join(tmpdir(), 'philgate-child-'));
    childRoots.push(root);
    mkdirSync(join(root, 'docs'), { recursive: true });
    cpSync(join(REPO_ROOT, 'docs', 'project-philosophy.md'), join(root, 'docs', 'project-philosophy.md'));
    const transcript = join(root, 'transcript.jsonl');
    writeFileSync(
      transcript,
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: finalText }] } }) +
        '\n',
    );
    // Arm the registry with a resident owner — same writer the SessionStart leg
    // uses, so the fixture can never drift from the frozen record shape.
    const lib = await import('../../scripts/shared/sessionRegistry.mjs');
    lib.writeSessionRecord(root, {
      version: 1,
      session_id: 'resident-owner',
      registered_at: new Date().toISOString(),
      source: 'test',
      baseline: [],
    });
    return { root, transcript };
  }

  it("skips the Stop leg for an unregistered session — the closing question is the child's deliverable", async () => {
    const { root, transcript } = await armedQuestionRoot('Diff attached. Anything else before I hand back?');
    const payload: HookPayload = {
      hook_event_name: 'Stop',
      session_id: sid('child-stop-q'),
      transcript_path: transcript,
    };
    expect(runHook(QUESTION_GATE, payload, { root }).code).toBe(0);
  });

  it('still injects on the AskUserQuestion leg for the same unregistered session', async () => {
    const { root } = await armedQuestionRoot('irrelevant');
    const { code, stderr } = runHook(QUESTION_GATE, askPayload(sid('child-ask')), { root });
    expect(code).toBe(2);
    expect(stderr).toContain('ASK IT AGAIN');
  });

  it("a REGISTERED session's closing question is still gated under an armed registry", async () => {
    const { root, transcript } = await armedQuestionRoot('Shall I split the backlog too?');
    const payload: HookPayload = {
      hook_event_name: 'Stop',
      session_id: 'resident-owner',
      transcript_path: transcript,
    };
    expect(runHook(QUESTION_GATE, payload, { root }).code).toBe(2);
  });
});

// The lap rule "end every lap by checking CI on main" is enforced here rather
// than remembered. These pin the verdict; the gate does the network call.
describe('latestFailedWorkflows: reading ONE workflow is not reading CI', () => {
  const run = (workflowName: string, conclusion: string | null, createdAt: string, status = 'completed') => ({
    workflowName,
    status,
    conclusion,
    createdAt,
  });

  it('reports a workflow that is red while a SIBLING workflow is green', () => {
    // The exact 2026-07-25 shape: `ci` green throughout, the suite red.
    expect(
      latestFailedWorkflows([
        run('ci', 'success', '2026-07-26T02:00:00Z'),
        run('audit-code-test-suite', 'failure', '2026-07-26T02:00:00Z'),
      ]),
    ).toEqual(['audit-code-test-suite']);
  });

  it('does not report a failure a LATER run turned green', () => {
    expect(
      latestFailedWorkflows([
        run('suite', 'failure', '2026-07-26T01:00:00Z'),
        run('suite', 'success', '2026-07-26T02:00:00Z'),
      ]),
    ).toEqual([]);
  });

  it('still reports a workflow whose newest run went red after a green one', () => {
    expect(
      latestFailedWorkflows([
        run('suite', 'success', '2026-07-26T01:00:00Z'),
        run('suite', 'failure', '2026-07-26T02:00:00Z'),
      ]),
    ).toEqual(['suite']);
  });

  it('treats `cancelled` as routine supersession, never as red', () => {
    expect(latestFailedWorkflows([run('suite', 'cancelled', '2026-07-26T02:00:00Z')])).toEqual([]);
  });

  it('does not let a NEWER cancelled run mask an older failure', () => {
    // The load-bearing case: a cancelled run carries no signal, so it must be
    // skipped outright rather than becoming the workflow's newest verdict — which
    // would silently clear a red main. Asserting only "a lone cancelled is not
    // red" passes whether or not the rule exists.
    expect(
      latestFailedWorkflows([
        run('suite', 'failure', '2026-07-26T01:00:00Z'),
        run('suite', 'cancelled', '2026-07-26T02:00:00Z'),
      ]),
    ).toEqual(['suite']);
  });

  it('treats `skipped` as no-signal, never as red', () => {
    // A skipped run means the workflow did not run at all (path filters didn't
    // match, or a conditional job was skipped) — it carries no failure signal,
    // exactly like `cancelled`.
    expect(latestFailedWorkflows([run('suite', 'skipped', '2026-07-26T02:00:00Z')])).toEqual([]);
  });

  it('does not let a NEWER skipped run mask an older failure', () => {
    // Mirrors the cancelled case: a skipped run must be excluded outright
    // rather than becoming the workflow's newest verdict, which would
    // silently clear a red main.
    expect(
      latestFailedWorkflows([
        run('suite', 'failure', '2026-07-26T01:00:00Z'),
        run('suite', 'skipped', '2026-07-26T02:00:00Z'),
      ]),
    ).toEqual(['suite']);
  });

  it('lets an in-flight run neither red nor CLEAR a workflow', () => {
    // The pending run must not launder the older failure into a pass.
    expect(
      latestFailedWorkflows([
        run('suite', 'failure', '2026-07-26T01:00:00Z'),
        run('suite', null, '2026-07-26T02:00:00Z', 'in_progress'),
      ]),
    ).toEqual(['suite']);
    // ...and a still-running job carrying a conclusion is not a verdict either.
    // Without the status rule this reports red for a run that has not finished.
    expect(latestFailedWorkflows([run('suite', 'failure', '2026-07-26T02:00:00Z', 'in_progress')])).toEqual([]);
  });

  it('degrades to "cannot tell" on junk rather than inventing a verdict', () => {
    expect(latestFailedWorkflows(null)).toEqual([]);
    expect(latestFailedWorkflows([null, {}, run('', 'failure', '2026-07-26T02:00:00Z')])).toEqual([]);
    // An unparseable timestamp must not sort as newest.
    expect(latestFailedWorkflows([run('suite', 'failure', 'not-a-date')])).toEqual([]);
  });

  // OBL-ci-red-verdict-vocabulary-inv-1 / fail-2: the conclusion vocabulary is
  // EXHAUSTIVE, not an enumerated allowlist of `failure`. Every one of these
  // reproduces the incident class the module header names — main sitting red
  // while the check reports green.
  it('reports red for every non-success, non-cancelled conclusion GitHub can emit', () => {
    for (const conclusion of ['failure', 'timed_out', 'startup_failure', 'action_required', 'stale', 'neutral']) {
      expect(
        latestFailedWorkflows([run('suite', conclusion, '2026-07-26T02:00:00Z')]),
        `conclusion '${conclusion}' must read red`,
      ).toEqual(['suite']);
    }
  });

  it('does not let a NEWER timed_out run mask an older genuine failure', () => {
    // The exact shadowing failure mode: a non-'failure' but non-passing newest
    // run must not clear an older red verdict for the same workflow.
    expect(
      latestFailedWorkflows([
        run('suite', 'failure', '2026-07-26T01:00:00Z'),
        run('suite', 'timed_out', '2026-07-26T02:00:00Z'),
      ]),
    ).toEqual(['suite']);
  });

  it('treats an unrecognized future conclusion as red too — exhaustive by construction, not by an enumerated list', () => {
    // A conclusion string this file has never seen (GitHub adding one tomorrow)
    // must fail toward red by default, never fall through to green.
    expect(latestFailedWorkflows([run('suite', 'a_future_conclusion_nobody_named_yet', '2026-07-26T02:00:00Z')])).toEqual([
      'suite',
    ]);
  });
});

// Both Stop gates read this ONE definition of "the stop is a wait, not an end";
// the payload fields are harness-version-dependent (probed 2026-08-07 on
// CC 2.1.222), so the junk-tolerance cases are the contract that matters.
describe('sessionHasLiveBackgroundWork: the wait-vs-end predicate', () => {
  it('is false on payloads from builds without the fields — the gates keep their old behavior', () => {
    expect(sessionHasLiveBackgroundWork({})).toBe(false);
    expect(sessionHasLiveBackgroundWork(undefined)).toBe(false);
    expect(sessionHasLiveBackgroundWork({ hook_event_name: 'Stop' })).toBe(false);
  });

  it('is true for any non-terminal task regardless of type', () => {
    expect(sessionHasLiveBackgroundWork({ background_tasks: [{ status: 'running', type: 'shell' }] })).toBe(true);
    expect(sessionHasLiveBackgroundWork({ background_tasks: [{ status: 'running', type: 'subagent' }] })).toBe(true);
    expect(sessionHasLiveBackgroundWork({ background_tasks: [{ status: 'queued', type: 'never-seen' }] })).toBe(true);
  });

  it('is false when every task is terminal', () => {
    expect(
      sessionHasLiveBackgroundWork({
        background_tasks: [{ status: 'completed' }, { status: 'failed' }, { status: 'killed' }],
      }),
    ).toBe(false);
    expect(sessionHasLiveBackgroundWork({ background_tasks: [] })).toBe(false);
  });

  it('counts unknown shapes as live — the conservative direction for a capped gate', () => {
    expect(sessionHasLiveBackgroundWork({ background_tasks: [{}] })).toBe(true);
    expect(sessionHasLiveBackgroundWork({ background_tasks: [null] })).toBe(true);
    expect(sessionHasLiveBackgroundWork({ background_tasks: ['garbage'] })).toBe(true);
  });

  it('tolerates non-array junk in the fields themselves', () => {
    expect(sessionHasLiveBackgroundWork({ background_tasks: 'x', session_crons: 42 })).toBe(false);
  });

  it('treats a scheduled session cron as live work', () => {
    expect(sessionHasLiveBackgroundWork({ session_crons: [{ id: 'c1' }] })).toBe(true);
    expect(sessionHasLiveBackgroundWork({ session_crons: [] })).toBe(false);
  });

  describe('queued-resume leg — positive evidence only, no absent→idle inversion', () => {
    function transcriptOf(lines: Array<Record<string, unknown> | string>): string {
      const dir = mkdtempSync(join(tmpdir(), 'queue-depth-'));
      const t = join(dir, 'transcript.jsonl');
      writeFileSync(
        t,
        lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n',
      );
      return t;
    }

    it('a missing, empty, or unreadable transcript_path is FALSE — the gates fire as today', () => {
      expect(pendingQueuedResume(undefined)).toBe(false);
      expect(pendingQueuedResume('')).toBe(false);
      expect(pendingQueuedResume(join(tmpdir(), 'definitely-not-here.jsonl'))).toBe(false);
      expect(liveSessionWorkReason({ background_tasks: [] })).toBe(null);
    });

    it('an unabsorbed enqueue reads as queued_resume; its dequeue clears it', () => {
      const pending = transcriptOf([
        { type: 'queue-operation', operation: 'enqueue', content: '<task-notification>…</task-notification>' },
      ]);
      expect(pendingQueuedResume(pending)).toBe(true);
      expect(liveSessionWorkReason({ background_tasks: [], transcript_path: pending })).toBe('queued_resume');

      const absorbed = transcriptOf([
        { type: 'queue-operation', operation: 'enqueue', content: '<task-notification>…</task-notification>' },
        { type: 'queue-operation', operation: 'dequeue' }, // no content/id, as the harness writes it
      ]);
      expect(pendingQueuedResume(absorbed)).toBe(false);
    });

    it('a remove drains depth like a dequeue, the floor is zero, and junk lines are skipped', () => {
      const removed = transcriptOf([
        { type: 'queue-operation', operation: 'dequeue' }, // stray drain below zero
        'not json at all {{{',
        { type: 'assistant', message: { role: 'assistant' } },
        { type: 'queue-operation', operation: 'enqueue', content: '<task-notification>…</task-notification>' },
        { type: 'queue-operation', operation: 'remove', reason: 'absorbed_mid_turn' },
      ]);
      expect(pendingQueuedResume(removed)).toBe(false);
    });

    it('a live task outranks the queue in the reason vocabulary', () => {
      const pending = transcriptOf([
        { type: 'queue-operation', operation: 'enqueue', content: '<task-notification>…</task-notification>' },
      ]);
      expect(
        liveSessionWorkReason({
          background_tasks: [{ status: 'running', type: 'shell' }],
          transcript_path: pending,
        }),
      ).toBe('live_background_task');
    });
  });
});
