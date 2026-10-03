// Contract tests for `.claude/hooks/session-start-guards.mjs` — the SessionStart
// probe. Same placement rule as the other hook tests: they live under tests/
// because vitest excludes `.claude/**`, so a test beside a hook never runs in CI.
//
// The probe must always exit 0 (a session must never be blocked from starting),
// so every assertion here is about what it DID to the tree, not about a verdict.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { runBounded, spawnSyncHidden } from '../helpers/spawn.mjs';
import { mkdtempSync, mkdirSync, existsSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const GUARDS = join(REPO_ROOT, '.claude', 'hooks', 'session-start-guards.mjs');

// Hermetic lane probes for every hook spawn in this file: http lanes point at
// an unroutable loopback port (refused instantly), the command-probe lane is
// skipped — no live service is probed and no probe timeout is burned.
// The agent-dispatch checkout is pointed at a directory that does not exist:
// no worker is installed, so the reap leg never asks the machine's real worker.
const LANE_PROBE_OVERRIDES = {
  AUDIT_TOOLS_OFFLOAD_PROBE_URL: 'http://127.0.0.1:9/',
  AUDIT_TOOLS_HEADROOM_PROBE_URL: 'http://127.0.0.1:9/',
  AUDIT_TOOLS_AGY_PROBE_CMD: 'skip',
  AGENT_DISPATCH_REPO: join(tmpdir(), `no-agent-dispatch-${process.pid}`),
};

const git = (cwd: string, ...args: string[]) =>
  spawnSyncHidden('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 60_000 });

/**
 * Age a worktree past the idle floor by backdating the per-worktree git admin
 * files — the same clock the guard reads to tell an abandoned worktree from one
 * a concurrent agent is still working in.
 */
function backdate(path: string, hours = 25): void {
  const adminDir = git(path, 'rev-parse', '--absolute-git-dir').stdout.trim();
  const when = new Date(Date.now() - hours * 60 * 60 * 1000);
  for (const p of [join(adminDir, 'index'), adminDir]) {
    if (existsSync(p)) utimesSync(p, when, when);
  }
}

/** A one-commit repository on `main`, with the identity a commit needs. */
function initRepo(repo: string): void {
  git(resolve(repo, '..'), 'init', '-q', '-b', 'main', repo);
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  writeFileSync(join(repo, '.gitignore'), '.work/\nnode_modules/\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'initial');
}

describe('session-start-guards: stale agent worktrees are reaped', () => {
  let base: string;
  let repo: string;
  let pass: { code: number | null; stdout: string }; // the ONE prune pass every assertion below reads
  const wt = (name: string): string => join(base, name);

  const listedPaths = (): string[] =>
    git(repo, 'worktree', 'list', '--porcelain')
      .stdout.split(/\r?\n/)
      .filter((l) => l.startsWith('worktree '))
      .map((l) => l.slice('worktree '.length).trim().replace(/\\/g, '/').toLowerCase());

  const isListed = (path: string): boolean => listedPaths().includes(resolve(path).replace(/\\/g, '/').toLowerCase());

  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), 'wtprune-'));
    repo = join(base, 'repo');
    initRepo(repo);

    // landed: branch tip == main, nothing modified, long idle → disposable.
    git(repo, 'worktree', 'add', '-q', wt('landed'), '-b', 'wt-landed');
    backdate(wt('landed'));

    // unique: carries a commit that never reached main → must survive (the
    // superseded-alternative branch a blanket prune would have destroyed).
    git(repo, 'worktree', 'add', '-q', wt('unique'), '-b', 'wt-unique');
    writeFileSync(join(wt('unique'), 'b.txt'), 'two\n');
    git(wt('unique'), 'add', '.');
    git(wt('unique'), 'commit', '-qm', 'unique work');
    backdate(wt('unique'));

    // dirty: landed HEAD, but an untracked file is unsaved work → must survive.
    git(repo, 'worktree', 'add', '-q', wt('dirty'), '-b', 'wt-dirty');
    writeFileSync(join(wt('dirty'), 'scratch.txt'), 'in progress\n');
    backdate(wt('dirty'));

    // fresh: landed and clean, but touched moments ago — indistinguishable from
    // a concurrent agent between `worktree add` and its first commit.
    git(repo, 'worktree', 'add', '-q', wt('fresh'), '-b', 'wt-fresh');

    // halfday: landed and clean, untouched for 12 hours — still inside the
    // owner's 24-hour idle floor, so a quiet agent there keeps its tree.
    git(repo, 'worktree', 'add', '-q', wt('halfday'), '-b', 'wt-halfday');
    backdate(wt('halfday'), 12);

    // workstate: landed, `git status` clean and idle by the index clock, but it
    // holds gitignored work state (an audit's `.audit-tools/` tree in the real
    // incident). `status --porcelain` cannot see it and `worktree remove` deletes
    // it, so only an `--ignored` read keeps this work alive.
    git(repo, 'worktree', 'add', '-q', wt('workstate'), '-b', 'wt-workstate');
    mkdirSync(join(wt('workstate'), '.work'));
    writeFileSync(join(wt('workstate'), '.work', 'state.json'), '{"run":"in progress"}\n');
    backdate(wt('workstate'));

    // buildonly: landed, clean and idle; its only ignored content is installed
    // dependencies, which `npm install` regenerates → still disposable.
    git(repo, 'worktree', 'add', '-q', wt('buildonly'), '-b', 'wt-buildonly');
    mkdirSync(join(wt('buildonly'), 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(wt('buildonly'), 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;\n');
    backdate(wt('buildonly'));

    // ONE pass, read by every case below. A pass per case would not be
    // independent: the guard's own `git status` probe rewrites the per-worktree
    // index, which resets the idle clock the next pass reads.
    const r = spawnSyncHidden(process.execPath, [GUARDS], {
      cwd: repo,
      encoding: 'utf8',
      timeout: 120_000,
      windowsHide: true,
      env: { ...process.env, ...LANE_PROBE_OVERRIDES, CLAUDE_PROJECT_DIR: repo },
    });
    pass = { code: r.status, stdout: r.stdout ?? '' };
  });

  afterAll(() => {
    try {
      rmSync(base, { recursive: true, force: true });
    } catch {
      /* windows lock — leave it to the temp reaper */
    }
  });

  it('never blocks the session, whatever it finds', () => {
    expect(pass.code).toBe(0);
  });

  it('removes a worktree that is landed, clean and idle — and says so', () => {
    expect(existsSync(wt('landed'))).toBe(false);
    expect(isListed(wt('landed'))).toBe(false);
    expect(pass.stdout).toMatch(/landed/i);
  });

  it('keeps a worktree whose HEAD never reached main', () => {
    expect(existsSync(join(wt('unique'), 'b.txt'))).toBe(true);
    expect(isListed(wt('unique'))).toBe(true);
    expect(pass.stdout).not.toMatch(/unique/i);
  });

  it('keeps a worktree carrying uncommitted work, without even attempting it', () => {
    expect(existsSync(join(wt('dirty'), 'scratch.txt'))).toBe(true);
    expect(isListed(wt('dirty'))).toBe(true);
    // Survival alone would also hold if the guard tried and git refused — which
    // would nag about a "stuck" worktree every session. Silence is the contract.
    expect(pass.stdout).not.toMatch(/dirty/i);
  });

  it('keeps a freshly touched worktree — a concurrent agent may be inside it', () => {
    expect(existsSync(wt('fresh'))).toBe(true);
    expect(isListed(wt('fresh'))).toBe(true);
    expect(pass.stdout).not.toMatch(/fresh/i);
  });

  it('keeps a worktree idle for less than the 24-hour floor', () => {
    expect(existsSync(wt('halfday'))).toBe(true);
    expect(isListed(wt('halfday'))).toBe(true);
    expect(pass.stdout).not.toMatch(/halfday/i);
  });

  it('never touches the checkout the session itself is in', () => {
    expect(existsSync(join(repo, 'a.txt'))).toBe(true);
    expect(isListed(repo)).toBe(true);
  });

  it('keeps a worktree holding gitignored work state, without even attempting it', () => {
    expect(existsSync(join(wt('workstate'), '.work', 'state.json'))).toBe(true);
    expect(isListed(wt('workstate'))).toBe(true);
    expect(pass.stdout).not.toMatch(/workstate/i);
  });

  it('still reaps a worktree whose only ignored content is installed dependencies', () => {
    expect(existsSync(wt('buildonly'))).toBe(false);
    expect(isListed(wt('buildonly'))).toBe(false);
    expect(pass.stdout).toMatch(/buildonly/i);
  });

  it('never touches the worktree the session works in, even when the project dir is another checkout', () => {
    // The incident: CLAUDE_PROJECT_DIR named the main checkout while the session
    // worked in a linked worktree, so the self-skip protected the wrong tree.
    git(repo, 'worktree', 'add', '-q', wt('incwd'), '-b', 'wt-incwd');
    backdate(wt('incwd'));
    const inherited = { ...process.env };
    delete inherited.AUDIT_TOOLS_CHILD_SESSION;
    const r = spawnSyncHidden(process.execPath, [GUARDS], {
      cwd: repo,
      encoding: 'utf8',
      input: JSON.stringify({
        hook_event_name: 'SessionStart',
        session_id: `reap-cwd-${process.pid}`,
        source: 'resume',
        cwd: wt('incwd'),
      }),
      timeout: 120_000,
      windowsHide: true,
      env: { ...inherited, ...LANE_PROBE_OVERRIDES, CLAUDE_PROJECT_DIR: repo },
    });
    expect(r.status).toBe(0);
    expect(existsSync(wt('incwd'))).toBe(true);
    expect(isListed(wt('incwd'))).toBe(true);
    expect(r.stdout ?? '').not.toMatch(/incwd/);
  });

  it('still reaps with a SessionStart payload on stdin — the registration leg runs first and must not break the reap leg', () => {
    // A NEW reapable worktree: the beforeAll pass already consumed `landed`,
    // and re-running against it would not exercise anything.
    git(repo, 'worktree', 'add', '-q', wt('landed2'), '-b', 'wt-landed2');
    backdate(wt('landed2'));
    const inherited = { ...process.env };
    delete inherited.AUDIT_TOOLS_CHILD_SESSION; // a child env must not skip registration here
    const r = spawnSyncHidden(process.execPath, [GUARDS], {
      cwd: repo,
      encoding: 'utf8',
      input: JSON.stringify({
        hook_event_name: 'SessionStart',
        session_id: `reap-payload-${process.pid}`,
        source: 'startup',
      }),
      timeout: 120_000,
      windowsHide: true,
      env: { ...inherited, ...LANE_PROBE_OVERRIDES, CLAUDE_PROJECT_DIR: repo },
    });
    expect(r.status).toBe(0);
    expect(r.stdout ?? '').toMatch(/landed2/);
    expect(existsSync(wt('landed2'))).toBe(false);
  });
});

// The 2026-10-02 incident: an agent-dispatch worker session ran a read-only
// review in a landed, clean, idle-by-git-clock worktree, and the reap removed
// the tree under it. A read-only job (or a job between edits) leaves no trace
// git can see, so the worker itself is asked. The fake checkout supplies the
// connection the way agent-dispatch's own `connectOpenCode`
// (src/services/connection.ts) does; the fake worker answers
// `GET /session/status?directory=` as the real one does — a map of the
// sessions running in exactly that directory.
describe('session-start-guards: a worktree a live worker session uses is kept', () => {
  let base: string;
  let repo: string;
  let worker: Server;
  const asked: string[] = [];
  const wt = (name: string): string => join(base, name);
  const norm = (p: string): string => resolve(p).replace(/\\/g, '/').toLowerCase();

  /** A stand-in agent-dispatch checkout whose connection names `baseUrl`. */
  function fakeAgentDispatch(name: string, baseUrl: string): string {
    const checkout = join(base, name);
    mkdirSync(join(checkout, 'src', 'services'), { recursive: true });
    writeFileSync(
      join(checkout, 'src', 'services', 'connection.ts'),
      `export async function connectOpenCode() {\n` +
        `  return { baseUrl: ${JSON.stringify(baseUrl)}, username: 'opencode', password: 'secret' };\n` +
        `}\n`,
    );
    return checkout;
  }

  /** One hook pass with the given agent-dispatch checkout. Async: the fake worker must answer meanwhile. */
  const runGuards = (checkout: string) =>
    runBounded(process.execPath, [GUARDS], {
      cwd: repo,
      env: { ...process.env, ...LANE_PROBE_OVERRIDES, AGENT_DISPATCH_REPO: checkout, CLAUDE_PROJECT_DIR: repo },
    });

  beforeAll(async () => {
    base = mkdtempSync(join(tmpdir(), 'wtlive-'));
    repo = join(base, 'repo');
    initRepo(repo);
    // Each is landed, clean and idle by the index clock — reapable on git evidence alone.
    for (const name of ['busy', 'unused', 'unreachable']) {
      git(repo, 'worktree', 'add', '-q', '--detach', wt(name));
      backdate(wt(name));
    }
    worker = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://worker');
      const expected = `Basic ${Buffer.from('opencode:secret').toString('base64')}`;
      if (url.pathname !== '/session/status' || req.headers.authorization !== expected) {
        res.writeHead(401).end();
        return;
      }
      const directory = url.searchParams.get('directory') ?? '';
      asked.push(directory);
      const sessions = norm(directory) === norm(wt('busy')) ? { ses_review: { type: 'busy' } } : {};
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(sessions));
    });
    await new Promise<void>((done) => worker.listen(0, '127.0.0.1', done));
  });

  afterAll(async () => {
    await new Promise<void>((done) => worker.close(() => done()));
    try {
      rmSync(base, { recursive: true, force: true });
    } catch {
      /* windows lock — leave it to the temp reaper */
    }
  });

  it('keeps a clean, landed, idle worktree while a worker session is busy in it, and reaps the one no session uses', async () => {
    const address = worker.address();
    if (address === null || typeof address === 'string') throw new Error('worker has no port');
    // `unreachable` is held out of this pass by a dirt file, so that the next case finds it untouched.
    writeFileSync(join(wt('unreachable'), 'hold.txt'), 'held\n');
    const { stdout } = await runGuards(fakeAgentDispatch('dispatch-live', `http://127.0.0.1:${String(address.port)}`));
    rmSync(join(wt('unreachable'), 'hold.txt'));

    expect(asked.map(norm)).toContain(norm(wt('busy')));
    expect(existsSync(wt('busy'))).toBe(true);
    expect(git(repo, 'worktree', 'list', '--porcelain').stdout.toLowerCase()).toContain(norm(wt('busy')));
    expect(stdout).not.toMatch(/busy/);
    // The worker check holds only the tree a session runs in.
    expect(existsSync(wt('unused'))).toBe(false);
    expect(stdout).toMatch(/unused/);
  });

  it('keeps every candidate when the worker cannot be asked — never reaps on an unknown answer', async () => {
    backdate(wt('unreachable'));
    // Port 9 (discard) on loopback refuses at once: the worker is installed but not answering.
    const { stdout } = await runGuards(fakeAgentDispatch('dispatch-down', 'http://127.0.0.1:9'));
    expect(existsSync(wt('unreachable'))).toBe(true);
    expect(stdout).toMatch(/unreachable/);
    expect(stdout).toMatch(/could not ask the agent-dispatch worker/i);
  });
});
