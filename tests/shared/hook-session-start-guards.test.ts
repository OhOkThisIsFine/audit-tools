// Contract tests for `.claude/hooks/session-start-guards.mjs` — the SessionStart
// probe. Same placement rule as the other hook tests: they live under tests/
// because vitest excludes `.claude/**`, so a test beside a hook never runs in CI.
//
// The probe must always exit 0 (a session must never be blocked from starting),
// so every assertion here is about what it REPORTED and what it left on disk,
// not about a verdict.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSyncHidden } from '../helpers/spawn.mjs';
import { mkdtempSync, mkdirSync, existsSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const GUARDS = join(REPO_ROOT, '.claude', 'hooks', 'session-start-guards.mjs');

// Hermetic lane probes for every hook spawn in this file: http lanes point at
// an unroutable loopback port (refused instantly), the command-probe lane is
// skipped — no live service is probed and no probe timeout is burned.
const LANE_PROBE_OVERRIDES = {
  AUDIT_TOOLS_OFFLOAD_PROBE_URL: 'http://127.0.0.1:9/',
  AUDIT_TOOLS_HEADROOM_PROBE_URL: 'http://127.0.0.1:9/',
  AUDIT_TOOLS_AGY_PROBE_CMD: 'skip',
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

// Owner decision 2026-10-04: the leg reports finished worktrees and removes
// nothing. Its removals acted on evidence that cannot be complete (an agent git
// and the worker cannot see), and each miss deleted a live agent's directory.
describe('session-start-guards: finished agent worktrees are reported, never removed', () => {
  let base: string;
  let repo: string;
  let pass: { code: number | null; stdout: string }; // the ONE pass every assertion below reads
  const wt = (name: string): string => join(base, name);

  const listedPaths = (): string[] =>
    git(repo, 'worktree', 'list', '--porcelain')
      .stdout.split(/\r?\n/)
      .filter((l) => l.startsWith('worktree '))
      .map((l) => l.slice('worktree '.length).trim().replace(/\\/g, '/').toLowerCase());

  const isListed = (path: string): boolean => listedPaths().includes(resolve(path).replace(/\\/g, '/').toLowerCase());

  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), 'wtstale-'));
    repo = join(base, 'repo');
    initRepo(repo);

    // landed: branch tip == main, nothing modified, long idle → reported.
    git(repo, 'worktree', 'add', '-q', wt('landed'), '-b', 'wt-landed');
    backdate(wt('landed'));

    // unique: carries a commit that never reached main → not reported.
    git(repo, 'worktree', 'add', '-q', wt('unique'), '-b', 'wt-unique');
    writeFileSync(join(wt('unique'), 'b.txt'), 'two\n');
    git(wt('unique'), 'add', '.');
    git(wt('unique'), 'commit', '-qm', 'unique work');
    backdate(wt('unique'));

    // dirty: landed HEAD, but an untracked file is unsaved work → not reported.
    git(repo, 'worktree', 'add', '-q', wt('dirty'), '-b', 'wt-dirty');
    writeFileSync(join(wt('dirty'), 'scratch.txt'), 'in progress\n');
    backdate(wt('dirty'));

    // fresh: landed and clean, but touched moments ago — indistinguishable from
    // a concurrent agent between `worktree add` and its first commit.
    git(repo, 'worktree', 'add', '-q', wt('fresh'), '-b', 'wt-fresh');

    // halfday: landed and clean, untouched for 12 hours — inside the 24-hour floor.
    git(repo, 'worktree', 'add', '-q', wt('halfday'), '-b', 'wt-halfday');
    backdate(wt('halfday'), 12);

    // workstate: landed, `git status` clean and idle by the index clock, but it
    // holds gitignored work state (an audit's `.audit-tools/` tree in the real
    // incident). Only an `--ignored` read sees it.
    git(repo, 'worktree', 'add', '-q', wt('workstate'), '-b', 'wt-workstate');
    mkdirSync(join(wt('workstate'), '.work'));
    writeFileSync(join(wt('workstate'), '.work', 'state.json'), '{"run":"in progress"}\n');
    backdate(wt('workstate'));

    // buildonly: landed, clean and idle; its only ignored content is installed
    // dependencies, which `npm install` regenerates → reported.
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
      /* windows lock — leave it to the temp cleaner */
    }
  });

  it('never blocks the session, whatever it finds', () => {
    expect(pass.code).toBe(0);
  });

  it('reports a worktree that is landed, clean and idle — and leaves it in place', () => {
    expect(pass.stdout).toMatch(/landed/i);
    expect(pass.stdout).toMatch(/Nothing removes them automatically/);
    expect(existsSync(join(wt('landed'), 'a.txt'))).toBe(true);
    expect(isListed(wt('landed'))).toBe(true);
  });

  it('reports a worktree whose only ignored content is installed dependencies — and leaves it in place', () => {
    expect(pass.stdout).toMatch(/buildonly/i);
    expect(existsSync(join(wt('buildonly'), 'node_modules', 'pkg', 'index.js'))).toBe(true);
    expect(isListed(wt('buildonly'))).toBe(true);
  });

  it('does not report a worktree whose HEAD never reached main', () => {
    expect(pass.stdout).not.toMatch(/unique/i);
    expect(existsSync(join(wt('unique'), 'b.txt'))).toBe(true);
  });

  it('does not report a worktree carrying uncommitted work', () => {
    expect(pass.stdout).not.toMatch(/dirty/i);
    expect(existsSync(join(wt('dirty'), 'scratch.txt'))).toBe(true);
  });

  it('does not report a freshly touched worktree — a concurrent agent may be inside it', () => {
    expect(pass.stdout).not.toMatch(/fresh/i);
  });

  it('does not report a worktree idle for less than the 24-hour floor', () => {
    expect(pass.stdout).not.toMatch(/halfday/i);
  });

  it('does not report a worktree holding gitignored work state', () => {
    expect(pass.stdout).not.toMatch(/workstate/i);
    expect(existsSync(join(wt('workstate'), '.work', 'state.json'))).toBe(true);
  });

  it('never touches the checkout the session itself is in', () => {
    expect(existsSync(join(repo, 'a.txt'))).toBe(true);
    expect(isListed(repo)).toBe(true);
  });

  it('does not report the worktree the session works in, even when the project dir is another checkout', () => {
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
        session_id: `stale-cwd-${process.pid}`,
        source: 'resume',
        cwd: wt('incwd'),
      }),
      timeout: 120_000,
      windowsHide: true,
      env: { ...inherited, ...LANE_PROBE_OVERRIDES, CLAUDE_PROJECT_DIR: repo },
    });
    expect(r.status).toBe(0);
    expect(existsSync(wt('incwd'))).toBe(true);
    expect(r.stdout ?? '').not.toMatch(/incwd/);
  });

  it('still reports with a SessionStart payload on stdin — the registration leg runs first and must not break this leg', () => {
    git(repo, 'worktree', 'add', '-q', wt('landed2'), '-b', 'wt-landed2');
    backdate(wt('landed2'));
    const inherited = { ...process.env };
    delete inherited.AUDIT_TOOLS_CHILD_SESSION; // a child env must not skip registration here
    const r = spawnSyncHidden(process.execPath, [GUARDS], {
      cwd: repo,
      encoding: 'utf8',
      input: JSON.stringify({
        hook_event_name: 'SessionStart',
        session_id: `stale-payload-${process.pid}`,
        source: 'startup',
      }),
      timeout: 120_000,
      windowsHide: true,
      env: { ...inherited, ...LANE_PROBE_OVERRIDES, CLAUDE_PROJECT_DIR: repo },
    });
    expect(r.status).toBe(0);
    expect(r.stdout ?? '').toMatch(/landed2/);
    expect(existsSync(wt('landed2'))).toBe(true);
  });
});
