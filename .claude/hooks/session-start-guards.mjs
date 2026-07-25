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

// ── Offload-lane liveness ────────────────────────────────────────────────────
// The LiteLLM proxy is the free offload lane and it has no standalone fallback,
// so when it is down every delegated call fails — but only once the lap has
// already planned around delegation. Ten seconds at session start converts a
// mid-lap stall into a known constraint. Probe only; starting it is the owner's
// call (it needs the UTF-8 env, and a second instance would collide on the port).
const PROXY_URL = process.env.AUDIT_TOOLS_OFFLOAD_PROBE_URL ?? 'http://127.0.0.1:4000/v1/models';
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
    `OFFLOAD LANE DOWN — the LiteLLM proxy is not answering on ${PROXY_URL}, and it has no standalone ` +
      'fallback: every delegated recon/review call will fail. Plan this lap without delegation, or start it ' +
      '(the UTF-8 env is required on Windows or the startup banner crashes on cp1252):\n' +
      '    PYTHONIOENCODING=utf-8 litellm --config ~/.audit-code/litellm-config.yaml --port 4000',
  );
}

if (notes.length > 0) {
  console.log('session-start guards:\n' + notes.map((n) => `• ${n}`).join('\n'));
}
process.exit(0);
