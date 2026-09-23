// Contract tests for `.claude/hooks/session-start-guards.mjs` — the SessionStart
// probe. Same placement rule as the other hook tests: they live under tests/
// because vitest excludes `.claude/**`, so a test beside a hook never runs in CI.
//
// The probe must always exit 0 (a session must never be blocked from starting),
// so every assertion here is about what it DID to the tree, not about a verdict.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSyncHidden } from '../helpers/spawn.mjs';
import { mkdtempSync, existsSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
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

describe('session-start-guards: stale agent worktrees are reaped', () => {
  let base: string;
  let repo: string;
  let pass: { code: number | null; stdout: string }; // the ONE prune pass every assertion below reads
  const wt = (name: string): string => join(base, name);

  const git = (cwd: string, ...args: string[]) =>
    spawnSyncHidden('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 60_000 });

  /**
   * Age a worktree past the idle floor by backdating the per-worktree git admin
   * files — the same clock the guard reads to tell an abandoned worktree from one
   * a concurrent agent is still working in.
   */
  function backdate(path: string, hours = 7): void {
    const adminDir = git(path, 'rev-parse', '--absolute-git-dir').stdout.trim();
    const when = new Date(Date.now() - hours * 60 * 60 * 1000);
    for (const p of [join(adminDir, 'index'), adminDir]) {
      if (existsSync(p)) utimesSync(p, when, when);
    }
  }

  const listedPaths = (): string[] =>
    git(repo, 'worktree', 'list', '--porcelain')
      .stdout.split(/\r?\n/)
      .filter((l) => l.startsWith('worktree '))
      .map((l) => l.slice('worktree '.length).trim().replace(/\\/g, '/').toLowerCase());

  const isListed = (path: string): boolean => listedPaths().includes(resolve(path).replace(/\\/g, '/').toLowerCase());

  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), 'wtprune-'));
    repo = join(base, 'repo');
    git(base, 'init', '-q', '-b', 'main', 'repo');
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'test');
    git(repo, 'config', 'commit.gpgsign', 'false');
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'initial');

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

  it('never touches the checkout the session itself is in', () => {
    expect(existsSync(join(repo, 'a.txt'))).toBe(true);
    expect(isListed(repo)).toBe(true);
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
