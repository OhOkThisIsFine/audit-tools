#!/usr/bin/env node
// SessionStart probe for the two lap-opening traps. Reports on stdout (the
// agent reads it as session context) and, for the stale-main case, records a
// marker that `tool-input-guard.mjs` turns into a deny-once on the first source
// edit — the mechanical half the `start-lap` skill's instruction cannot provide.
//
// Always exits 0: a probe must never block a session from starting. Network and
// git faults degrade to silence.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const STATE_DIR = join(ROOT, '.claude', 'hooks', '.state');
const MARKER = join(STATE_DIR, 'stale-main.json');

function git(args, timeout = 25_000) {
  const r = spawnSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout,
    windowsHide: true,
  });
  return { ok: r.status === 0, stdout: (r.stdout ?? '').trim() };
}

const notes = [];

// ── Fresh-worktree node_modules ──────────────────────────────────────────────
// Without node_modules, `audit-tools/shared` resolves a STALE dist/ and tsc
// reports phantom "no exported member" errors that look like a real contract
// break. One existsSync — the cheapest trap on the list.
if (existsSync(join(ROOT, 'package.json')) && !existsSync(join(ROOT, 'node_modules'))) {
  notes.push(
    'node_modules is MISSING in this checkout. `audit-tools/shared` will resolve a stale dist/ and produce ' +
      'phantom "no exported member" type errors. Run `npm install` before trusting any typecheck.',
  );
}

// ── Stale main ───────────────────────────────────────────────────────────────
// A lap branched from stale local main once re-implemented a commit that had
// already landed. Measure the gap, don't assume it.
try {
  // Remote is discovered, never assumed: this repo's remote is `audit-tools`,
  // but a worktree or clone may name it differently.
  const remotes = git(['remote']).stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const remote = remotes.includes('audit-tools') ? 'audit-tools' : remotes[0];
  if (remote) {
    git(['fetch', remote, 'main']);
    const count = git(['rev-list', '--count', `HEAD..${remote}/main`]);
    const behind = count.ok ? Number(count.stdout) : 0;
    mkdirSync(STATE_DIR, { recursive: true });
    if (Number.isFinite(behind) && behind > 0) {
      writeFileSync(MARKER, JSON.stringify({ behind, remote, at: new Date().toISOString() }, null, 2));
      notes.push(
        `HEAD is ${behind} commit(s) BEHIND ${remote}/main. Sync BEFORE writing code — a lap branched from ` +
          `stale main once re-implemented an entire commit that had already landed:\n` +
          `    git fetch ${remote} main && git rebase ${remote}/main`,
      );
    } else {
      // Up to date — clear any marker from a previous session so the deny-once
      // cannot fire against a tree that has since been synced.
      try {
        rmSync(MARKER, { force: true });
      } catch {
        /* ignore */
      }
    }
  }
} catch {
  /* offline / not a git repo — stay silent */
}

if (notes.length > 0) {
  console.log('session-start guards:\n' + notes.map((n) => `• ${n}`).join('\n'));
}
process.exit(0);
