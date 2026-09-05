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
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  baselineFromEntries,
  pruneStaleSessionRecords,
  runPorcelainStatus,
  sanitizeSessionId,
  writeSessionRecord,
} from '../../scripts/shared/sessionRegistry.mjs';

const ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const STATE_DIR = join(ROOT, '.claude', 'hooks', '.state');
const MARKER = join(STATE_DIR, 'stale-main.json');

// SessionStart payload (fail-open). Bounded: under spawnSync with no input the
// pipe closes immediately and the loop ends, but a harness that keeps stdin
// open must not burn the hook's 45s budget and kill every later leg — ~3s,
// then degrade to {} (registration is skipped with a note; every other leg
// still runs).
const payload = await new Promise((resolvePayload) => {
  const timer = setTimeout(() => resolvePayload({}), 3_000);
  timer.unref?.();
  (async () => {
    let raw = '';
    try {
      for await (const chunk of process.stdin) raw += chunk;
      resolvePayload(raw ? JSON.parse(raw) : {});
    } catch {
      resolvePayload({});
    } finally {
      clearTimeout(timer);
    }
  })();
});

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

// ── Session registration + tree-dirt baseline ────────────────────────────────
// Shared substrate for the session-scoped Stop/PreToolUse gates (child-session
// split + closeout dirt partition): a per-session_id record with the tree's
// dirt snapshot at session start. FIRST leg on purpose — registration must be
// durable before the network-touching stale-main probe can burn the hook's
// budget. Touches only `.claude/hooks/.state/`, never the working tree.
try {
  const sessionId = sanitizeSessionId(payload?.session_id);
  if (process.env.AUDIT_TOOLS_CHILD_SESSION === '1') {
    notes.push(
      'session registry: AUDIT_TOOLS_CHILD_SESSION=1 — this session is a dispatched child and was ' +
        'NOT registered; repo Stop gates will not recruit it.',
    );
  } else if (!sessionId) {
    notes.push(
      'session registry: payload carried no session_id — session not registered ' +
        '(gates fall back to whole-tree behavior).',
    );
  } else {
    // Raw `-z` porcelain via the lib — a trimmed read would eat the leading
    // space of a first-sorted ` M path` record. A status fault registers an
    // EMPTY baseline rather than skipping: an unregistered owner session loses
    // its Stop gates entirely, while an empty baseline merely restores
    // whole-tree over-firing (the safe direction).
    const status = runPorcelainStatus(ROOT);
    writeSessionRecord(ROOT, {
      version: 1,
      session_id: sessionId,
      registered_at: new Date().toISOString(),
      source: sanitizeSessionId(payload?.source) || 'unknown',
      baseline: status.ok ? baselineFromEntries(status.entries) : [],
    });
  }
  pruneStaleSessionRecords(ROOT); // light hygiene, best-effort, same leg
} catch {
  /* registration is best-effort — a probe must never block a session */
}

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

// ── Git-boundary commit gate wiring (P53) ────────────────────────────────────
// The commit legs run from the tracked `.githooks/` through `core.hooksPath`, a
// per-clone git setting no checkout carries by itself. Point it at the MAIN
// checkout's `.githooks` (the config is shared by every linked worktree, and the
// hook files resolve the gate relative to themselves, so a worktree on an older
// branch still runs the current gate against its own tree). A config write is
// instant and local — unlike an `npm ci` — so the leg SETS it and says so;
// left unset, every commit from this clone would run no gate at all, silently.
try {
  const commonDir = git(['rev-parse', '--git-common-dir']);
  if (commonDir.ok && commonDir.stdout) {
    const mainCheckout = resolve(ROOT, commonDir.stdout, '..');
    const wanted = join(mainCheckout, '.githooks').replace(/\\/g, '/');
    if (existsSync(wanted)) {
      // The EFFECTIVE value is what git will use. With `extensions.worktreeConfig`
      // a `.git/config.worktree` entry outranks the shared `.git/config`, so a
      // shared-scope write can leave the effective value unchanged (this repo's
      // main worktree carried exactly that: an absolute `.git/hooks` pinned at
      // worktree scope). Write the shared scope, re-read, and if a worktree-scope
      // value still wins, write that scope too.
      const effective = () => git(['config', '--get', 'core.hooksPath']);
      const before = effective();
      if (!before.ok || !samePath(before.stdout, wanted)) {
        let set = git(['config', 'core.hooksPath', wanted]);
        let after = effective();
        if (set.ok && (!after.ok || !samePath(after.stdout, wanted))) {
          set = git(['config', '--worktree', 'core.hooksPath', wanted]);
          after = effective();
        }
        const wired = set.ok && after.ok && samePath(after.stdout, wanted);
        notes.push(
          wired
            ? `core.hooksPath set to ${wanted} — the commit gate now runs from git's own boundary ` +
              `(was: ${before.ok && before.stdout ? before.stdout : 'unset'}).`
            : `core.hooksPath could NOT be pointed at ${wanted} (effective: ${after.ok ? after.stdout : 'unset'}); ` +
              `commits from this clone run NO commit gate until it is.`,
        );
      }
    }
  }
} catch {
  /* a probe must never block a session; an unwired gate is announced above when detectable */
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
// The delegation lanes are DECLARED DATA in the MACHINE registry
// (~/.agent-config/offload-lane-data.mjs — moved out of the repo 2026-08-29,
// owner decision F10: lane inventory is machine-scoped; llm-relay is the
// eventual owner) and this leg probes every probeable row CONCURRENTLY, each
// bounded by its own timeout, so a dead lane is a named constraint at session
// start rather than a mid-lap stall. An ABSENT registry means this machine
// declares no lanes: both lane legs skip silently (fresh machine, CI).
// AUDIT_TOOLS_OFFLOAD_LANE_REGISTRY overrides the path for hermetic tests.
// Probe only; bringing a lane up is the owner's call — each down note carries
// its row's remedy verbatim. Silent-unless-down: unprobeable rows state their
// reasons as registry data and produce no every-session line (the reap leg
// above states why — a note that fires every session gets read past).
//
// There is NO workspace-trust leg beside this one. One existed until 2026-08-29
// and reported an untrusted CLAUDE_CONFIG_DIR workspace as "OFFLOAD LANE
// UNUSABLE … it runs with no repo tools and answers from nothing" (P43). That
// consequence does not follow from that condition: measured four ways against
// the live relay pool lane, a lane in an UNTRUSTED workspace read a gitignored
// file and returned its unguessable content — with the tool flag, without it,
// and from a directory in no projects map at all. The leg was deleted here and
// in the machine registry together; the full measurement is recorded in
// ~/.agent-config/offload-lane-data.mjs beside the removal. Do not reinstate it
// on the strength of the P43 proposal still on disk — reinstate it only with a
// measurement showing trust gating tools again.
/** @type {{ OFFLOAD_LANES: any[], probeLane: Function } | null} */
let laneRegistry = null;
try {
  const registryPath =
    process.env.AUDIT_TOOLS_OFFLOAD_LANE_REGISTRY ||
    join(homedir(), '.agent-config', 'offload-lane-data.mjs');
  if (existsSync(registryPath)) {
    laneRegistry = await import(pathToFileURL(registryPath).href);
  }
} catch {
  /* an unreadable registry must never block a session — both lane legs skip */
}
const { OFFLOAD_LANES = [], probeLane } = laneRegistry ?? {};
try {
  const probed = await Promise.all(
    OFFLOAD_LANES.map(async (lane) => ({ lane, up: await probeLane?.(lane, process.env) })),
  );
  for (const { lane, up } of probed) {
    if (up !== false) continue; // up, or unprobeable (null) — silent either way
    notes.push(
      `OFFLOAD LANE DOWN — ${lane.label} is not answering (${lane.transport}). ` +
        `Plan this lap without it, or bring it up:\n    ${lane.remedy}`,
    );
  }
} catch {
  /* lane probing is best-effort — a probe must never block a session */
}

if (notes.length > 0) {
  console.log('session-start guards:\n' + notes.map((n) => `• ${n}`).join('\n'));
}
process.exit(0);
