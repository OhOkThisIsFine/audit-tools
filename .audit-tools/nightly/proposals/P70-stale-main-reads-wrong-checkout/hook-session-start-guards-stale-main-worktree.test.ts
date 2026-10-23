// Regression for open-bugs.md: "The session-start 'commits BEHIND origin/main'
// warning measures the main checkout, not the session's worktree
// (2026-10-06, medium)." `.claude/hooks/session-start-guards.mjs` ran its
// stale-main check against CLAUDE_PROJECT_DIR (the main checkout) unconditionally,
// so a session working in a linked worktree that is already level with
// `origin/main` still saw a false "N commit(s) BEHIND" warning whenever the
// main checkout's own local HEAD happened to be the stale one.
//
// This lives beside tests/shared/hook-session-start-guards.test.ts (same
// placement rule: vitest excludes `.claude/**`, so a test beside the hook
// never runs in CI).
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSyncHidden } from '../helpers/spawn.mjs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const GUARDS = join(REPO_ROOT, '.claude', 'hooks', 'session-start-guards.mjs');

const LANE_PROBE_OVERRIDES = {
  AUDIT_TOOLS_OFFLOAD_PROBE_URL: 'http://127.0.0.1:9/',
  AUDIT_TOOLS_HEADROOM_PROBE_URL: 'http://127.0.0.1:9/',
  AUDIT_TOOLS_AGY_PROBE_CMD: 'skip',
};

const git = (cwd: string, ...args: string[]) =>
  spawnSyncHidden('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 60_000 });

describe('session-start-guards: stale-main check reads the SESSION worktree, not CLAUDE_PROJECT_DIR', () => {
  let base: string;

  afterAll(() => {
    try {
      rmSync(base, { recursive: true, force: true });
    } catch {
      /* windows lock — leave it to the temp cleaner */
    }
  });

  it('does not warn BEHIND when the session worktree is level with origin/main, even though the main checkout is stale', () => {
    base = mkdtempSync(join(tmpdir(), 'staleworktree-'));
    const origin = join(base, 'origin.git');
    const mainCheckout = join(base, 'main-checkout');
    const wt = join(base, 'wt');

    // Bare "origin" with one commit on main.
    git(base, 'init', '-q', '--bare', '-b', 'main', origin);

    // Main checkout tracks origin and starts level with it.
    git(base, 'clone', '-q', origin, mainCheckout);
    git(mainCheckout, 'config', 'user.email', 'test@example.com');
    git(mainCheckout, 'config', 'user.name', 'test');
    git(mainCheckout, 'config', 'commit.gpgsign', 'false');
    writeFileSync(join(mainCheckout, 'a.txt'), 'one\n');
    git(mainCheckout, 'add', '.');
    git(mainCheckout, 'commit', '-qm', 'initial');
    git(mainCheckout, 'push', '-q', 'origin', 'main');

    // A linked worktree, branched from the SAME commit as main right now.
    git(mainCheckout, 'worktree', 'add', '-q', wt, '-b', 'lap-branch');

    // Origin advances with a second commit (simulating other work landing
    // while the lap worktree is open) — pushed from a disposable clone so the
    // main checkout's own ref is left untouched.
    const pusher = join(base, 'pusher');
    git(base, 'clone', '-q', origin, pusher);
    git(pusher, 'config', 'user.email', 'test@example.com');
    git(pusher, 'config', 'user.name', 'test');
    git(pusher, 'config', 'commit.gpgsign', 'false');
    writeFileSync(join(pusher, 'b.txt'), 'two\n');
    git(pusher, 'add', '.');
    git(pusher, 'commit', '-qm', 'second');
    git(pusher, 'push', '-q', 'origin', 'main');

    // The session catches its OWN worktree up to origin/main's new tip...
    git(wt, 'fetch', '-q', 'origin', 'main');
    git(wt, 'merge', '-q', '--ff-only', 'origin/main');

    // ...but the main checkout is never touched again — its local HEAD is
    // now the stale one. This is the exact incident shape: the worktree is
    // level with origin/main while CLAUDE_PROJECT_DIR (main checkout) is not.
    const r = spawnSyncHidden(process.execPath, [GUARDS], {
      cwd: wt,
      encoding: 'utf8',
      input: JSON.stringify({
        hook_event_name: 'SessionStart',
        session_id: `stale-main-wt-${process.pid}`,
        source: 'startup',
        cwd: wt,
      }),
      timeout: 120_000,
      windowsHide: true,
      env: { ...process.env, ...LANE_PROBE_OVERRIDES, CLAUDE_PROJECT_DIR: mainCheckout },
    });

    expect(r.status).toBe(0);
    // The session's own tree (wt) is level with origin/main — it must not be
    // told to sync. Before the fix this read the main checkout instead and
    // reported "1 commit(s) BEHIND".
    expect(r.stdout ?? '').not.toMatch(/BEHIND/);
  });
});
