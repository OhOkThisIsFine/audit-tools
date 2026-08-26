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
import { sessionHasLiveBackgroundWork } from '../../scripts/shared/liveSessionWork.mjs';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync } from 'node:fs';
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

// The question gate's Build 1 leg: the unregistered-child skip is STOP-LEG ONLY.
// A child's closing question is part of its returned deliverable — exit-2'ing it
// hijacks the hand-back (P23). A child that explicitly calls AskUserQuestion is
// performing an interactive act the philosophy injection legitimately governs,
// so that leg still fires.
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
});
