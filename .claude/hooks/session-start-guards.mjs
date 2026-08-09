#!/usr/bin/env node
// SessionStart probe for the two lap-opening traps. Reports on stdout (the
// agent reads it as session context) and, for the stale-main case, records a
// marker that `tool-input-guard.mjs` turns into a deny-once on the first source
// edit — the mechanical half the `start-lap` skill's instruction cannot provide.
//
// Always exits 0: a probe must never block a session from starting. Network and
// git faults degrade to silence.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { get as httpGet } from 'node:http';
import { join, resolve } from 'node:path';

const ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const STATE_DIR = join(ROOT, '.claude', 'hooks', '.state');
const MARKER = join(STATE_DIR, 'stale-main.json');

function gitIn(cwd, args, timeout = 25_000) {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout,
    windowsHide: true,
  });
  return { ok: r.status === 0, stdout: (r.stdout ?? '').trim() };
}

const git = (args, timeout) => gitIn(ROOT, args, timeout);

// git reports forward slashes even on win32, where the drive letter's case also
// varies between `rev-parse` and the worktree list — so path identity is only
// meaningful normalized.
function samePath(a, b) {
  const norm = (p) => resolve(p).replace(/\\/g, '/').replace(/\/+$/, '');
  const [x, y] = [norm(a), norm(b)];
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
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
let remoteName = null; // shared with the worktree leg below
try {
  // Remote is discovered, never assumed: this repo's remote is `audit-tools`,
  // but a worktree or clone may name it differently.
  const remotes = git(['remote']).stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const remote = remotes.includes('audit-tools') ? 'audit-tools' : remotes[0];
  remoteName = remote ?? null;
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

// ── Stale git lock ───────────────────────────────────────────────────────────
// `index.lock` / `shallow.lock` outlive a killed or timed-out git process, and
// every later write fails with "Unable to create '...': File exists" — read as a
// permissions or corruption fault far more often than as the leftover it is. A
// live lock is held for well under a second, so age is the discriminator.
// Reported, never removed: deleting the lock of a git process that IS running
// corrupts the index.
try {
  const gitDir = git(['rev-parse', '--git-dir'], 5_000);
  if (gitDir.ok && gitDir.stdout) {
    // `--git-dir` is relative in a plain checkout and ABSOLUTE in a linked
    // worktree — resolve, never join, or the absolute form is appended to ROOT.
    for (const lock of ['index.lock', 'shallow.lock']) {
      const p = resolve(ROOT, gitDir.stdout, lock);
      if (!existsSync(p)) continue;
      const ageMs = Date.now() - statSync(p).mtimeMs;
      if (ageMs < 60_000) continue; // plausibly a live git process
      notes.push(
        `STALE git lock: ${lock} (${Math.round(ageMs / 60_000)} min old). Every git write will fail ` +
          `with "Unable to create ... File exists" until it is cleared. Confirm no git process is running, ` +
          `then remove it:\n    rm "${p.replace(/\\/g, '/')}"`,
      );
    }
  }
} catch {
  /* not a git repo / stat fault — stay silent */
}

// ── Stale agent worktrees ────────────────────────────────────────────────────
// Agent runs add linked worktrees and nothing reaps them once the work lands, so
// they accumulate across sessions. Reaped rather than reported: every condition
// that makes a worktree disposable is mechanically checkable, and a note that
// fires every session is a note that gets read past.
//
// THREE conditions, all required — a stale worktree is not necessarily a
// duplicate (of four cleared by hand, one held a superseded ALTERNATIVE branch):
//   landed — HEAD is reachable from a main line, so it holds no unique commit
//   clean  — no modified or untracked file, so it holds no unsaved work
//   idle   — a CONCURRENT agent's worktree is landed AND clean for the whole
//            window between `worktree add` and its first commit, so freshness is
//            what separates in-flight from abandoned
// Anything unreadable — a vanished directory, a git that errors — is left alone:
// this leg only ever acts on a positive answer to all three.
const WORKTREE_IDLE_MS = 6 * 60 * 60 * 1000;

/**
 * Milliseconds since the last git activity in a worktree. The per-worktree index
 * is rewritten by every status/add/commit, which makes it the cheapest activity
 * clock available. An unknown age reads as ACTIVE (0) — never reap on a guess.
 */
function msSinceWorktreeActivity(path) {
  const adminDir = gitIn(path, ['rev-parse', '--absolute-git-dir'], 5_000);
  const clocks = adminDir.ok && adminDir.stdout ? [join(adminDir.stdout, 'index'), adminDir.stdout] : [path];
  for (const clock of clocks) {
    try {
      return Date.now() - statSync(clock).mtimeMs;
    } catch {
      /* try the next clock */
    }
  }
  return 0;
}

function parseWorktreePorcelain(text) {
  const entries = [];
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length).trim(), head: '', disqualified: false };
      entries.push(current);
    } else if (!current) {
      continue;
    } else if (line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length).trim();
    } else if (/^(bare|locked|prunable)\b/.test(line)) {
      // `locked` is an explicit hands-off marker; `bare` and `prunable` have no
      // working tree to reason about.
      current.disqualified = true;
    }
  }
  return entries;
}

try {
  const listed = git(['worktree', 'list', '--porcelain'], 15_000);
  // The main worktree is always listed first and is never a candidate; the
  // session's own checkout must survive whichever position it holds.
  const linked = listed.ok ? parseWorktreePorcelain(listed.stdout).slice(1) : [];
  const selfTop = git(['rev-parse', '--show-toplevel'], 5_000);
  const selfPath = selfTop.ok && selfTop.stdout ? selfTop.stdout : ROOT;
  // Reachability is judged against every main line this checkout has: the local
  // branch and, when a remote was discovered above, its tracking counterpart.
  const mainRefs = [remoteName ? `${remoteName}/main` : null, 'main']
    .filter(Boolean)
    .filter((ref) => git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], 5_000).ok);

  const reaped = [];
  const stuck = [];
  // Sorted by path so the reported order is content-derived, not list order.
  for (const wt of linked.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    if (wt.disqualified || !wt.head || !existsSync(wt.path)) continue;
    if (samePath(wt.path, selfPath) || samePath(wt.path, ROOT)) continue;
    // A repo with no main line at all yields no refs, so nothing is reachable
    // and nothing is reaped — the empty case needs no separate guard.
    if (!mainRefs.some((ref) => git(['merge-base', '--is-ancestor', wt.head, ref], 10_000).ok)) continue;
    // Read the clock BEFORE the status call below — status can rewrite the index
    // it reads, which would reset the very signal being measured.
    if (msSinceWorktreeActivity(wt.path) < WORKTREE_IDLE_MS) continue;
    const status = gitIn(wt.path, ['status', '--porcelain'], 20_000);
    // git re-checks cleanliness during `remove` too, but only as a refusal —
    // without this check a worktree someone is working in would be attempted
    // every session and reported as "stuck" each time.
    if (!status.ok || status.stdout !== '') continue;
    // No --force: git re-checks cleanliness itself, so a race between the check
    // above and the removal still fails closed.
    (git(['worktree', 'remove', wt.path], 60_000).ok ? reaped : stuck).push(wt.path);
  }

  const asList = (paths) => paths.map((p) => `    ${p.replace(/\\/g, '/')}`).join('\n');
  if (reaped.length > 0) {
    notes.push(
      `Reaped ${reaped.length} finished worktree(s) — HEAD already on main, tree clean, idle:\n${asList(reaped)}`,
    );
  }
  if (stuck.length > 0) {
    notes.push(
      `Could not remove ${stuck.length} finished worktree(s) — on Windows a still-open handle under ` +
        `node_modules/ blocks the delete:\n${asList(stuck)}\n  Retry once nothing is running in them.`,
    );
  }
} catch {
  /* not a git repo / removal fault — stay silent */
}

// ── Offload-lane liveness ────────────────────────────────────────────────────
// The local router is the free offload lane and it has no standalone fallback,
// so when it is down every delegated call fails — but only once the lap has
// already planned around delegation. Ten seconds at session start converts a
// mid-lap stall into a known constraint. Probe only; starting it is the owner's
// call (a second instance would collide on the port).
const PROXY_URL = process.env.AUDIT_TOOLS_OFFLOAD_PROBE_URL ?? 'http://127.0.0.1:3001/health';
const proxyUp = await new Promise((resolve) => {
  let settled = false;
  const done = (v) => {
    if (!settled) {
      settled = true;
      resolve(v);
    }
  };
  try {
    const req = httpGet(PROXY_URL, (res) => {
      res.resume(); // drain — status is the whole signal
      done(res.statusCode !== undefined && res.statusCode < 500);
    });
    req.setTimeout(2_000, () => {
      req.destroy();
      done(false);
    });
    req.on('error', () => done(false));
  } catch {
    done(false);
  }
});
if (!proxyUp) {
  notes.push(
    `OFFLOAD LANE DOWN — the local router is not answering on ${PROXY_URL}, and it has no standalone ` +
      'fallback: every delegated recon/review call will fail. Plan this lap without delegation, or start it:\n' +
      '    powershell -File C:\\Users\\ethan\\freellmapi\\start.ps1',
  );
}

if (notes.length > 0) {
  console.log('session-start guards:\n' + notes.map((n) => `• ${n}`).join('\n'));
}
process.exit(0);
