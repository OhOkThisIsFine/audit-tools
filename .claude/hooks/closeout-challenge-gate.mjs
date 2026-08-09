#!/usr/bin/env node
// The "are you sure that was all taken care of?" challenge, automated.
//
// Asking that question by hand at the end of a sprint reliably surfaces real
// gaps — an unpushed commit, a HANDOFF that no longer matches the backlog, a
// memory file that never reached the index. The owner should not have to be the
// one who remembers to ask (enforce-in-tooling, never host discretion), so this
// blocks the stop once and asks it, WITH the mechanical evidence attached: a bare
// "are you sure?" is answerable with a confident "yes", a named unpushed commit
// is not.
//
// Safety (a Stop hook is high-blast-radius, so every path fails OPEN):
//  - honors AUDIT_TOOLS_NO_CLOSEOUT_CHALLENGE;
//  - at most CHALLENGE_CAP blocks per session, counted in the marker, so a fix
//    that moves HEAD cannot ping-pong the gate forever;
//  - deliberately does NOT key on stop_hook_active alone: two other Stop hooks
//    share this event, and a block from either would otherwise starve this one;
//  - skips (spending nothing) while the payload shows live background tasks or
//    scheduled session crons: that stop is a WAIT the harness resumes, not a
//    closeout, and challenging there was exactly how both cap slots kept being
//    burned mid-lap;
//  - only fires when the session actually did work (HEAD moved recently, dirty
//    tree, or unpushed commits) — nothing to close out means nothing to ask;
//  - swallows every fs/git/spawn fault → exit 0.
//
// Exit 0 = allow stop, exit 2 = block (stderr is fed back to the agent).
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { latestFailedWorkflows } from '../../scripts/shared/ciRedWorkflows.mjs';
import { sessionHasLiveBackgroundWork } from '../../scripts/shared/liveSessionWork.mjs';

if (process.env.AUDIT_TOOLS_NO_CLOSEOUT_CHALLENGE) process.exit(0);

const ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const STATE_DIR = join(ROOT, '.claude', 'hooks', '.state', 'closeout-challenge');
const CHALLENGE_CAP = 2;
const RECENT_MS = 12 * 60 * 60 * 1000;

let payload = {};
try {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  payload = raw ? JSON.parse(raw) : {};
} catch {
  process.exit(0);
}
if ((payload?.hook_event_name ?? 'Stop') !== 'Stop') process.exit(0);

// A wait is not a closeout: with live background tasks (or scheduled crons) the
// harness re-invokes this session, so the challenge belongs to a later, real
// stop. Exit BEFORE any cap/state accounting — a skipped wait must leave both
// untouched.
if (sessionHasLiveBackgroundWork(payload)) process.exit(0);

const sessionId = String(payload?.session_id ?? '').replace(/[^\w.-]/g, '');
if (!sessionId) process.exit(0); // no session key → cannot cap → fail open
const marker = join(STATE_DIR, `${sessionId}.json`);

let state = { count: 0, states: [] };
try {
  if (existsSync(marker)) state = JSON.parse(readFileSync(marker, 'utf8'));
} catch {
  /* corrupt marker → treat as first challenge */
}
if ((state.count ?? 0) >= CHALLENGE_CAP) process.exit(0);

function git(args, timeout = 8_000) {
  const r = spawnSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout,
    windowsHide: true,
  });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim() };
}

// ── Did this session do work worth closing out? ──────────────────────────────
const dirty = git(['status', '--porcelain']).out;
const headTs = Number(git(['log', '-1', '--format=%ct']).out) * 1000;
const headMovedRecently = Number.isFinite(headTs) && Date.now() - headTs < RECENT_MS;

const remotes = git(['remote']).out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
const remote = remotes.includes('audit-tools') ? 'audit-tools' : remotes[0];
const unpushed = remote ? git(['log', '--oneline', `${remote}/main..HEAD`]).out : '';

if (!dirty && !headMovedRecently && !unpushed) process.exit(0);

// Already challenged this exact tree state? Then the agent answered and nothing
// moved — do not ask the same question twice about the same evidence.
const stateKey = `${git(['rev-parse', 'HEAD']).out}:${dirty.length}:${unpushed.length}`;
if ((state.states ?? []).includes(stateKey)) process.exit(0);

// ── Mechanical evidence — the part a confident "yes" cannot survive ──────────
const findings = [];

if (dirty) {
  const files = dirty.split(/\r?\n/).filter(Boolean).slice(0, 12);
  findings.push(
    `UNCOMMITTED work in the tree (${dirty.split(/\r?\n/).filter(Boolean).length} path(s)):\n` +
      files.map((f) => `      ${f}`).join('\n'),
  );
}

if (unpushed) {
  findings.push(
    `UNPUSHED commit(s) — the next agent clones ${remote}/main and will not see these:\n` +
      unpushed.split(/\r?\n/).slice(0, 8).map((l) => `      ${l}`).join('\n'),
  );
}

// HANDOFF is generated from the backlog; a mismatch means the roadmap the next
// agent reads is not the backlog it points at.
try {
  // Absence is not a mismatch: a checkout without the generator (or a different
  // repo entirely) must not be reported as a stale HANDOFF.
  const script = join(ROOT, 'scripts', 'shared', 'generate-handoff-roadmap.mjs');
  const r = existsSync(script)
    ? spawnSync(process.execPath, [script, '--check'], {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 15_000,
        windowsHide: true,
      })
    : { status: 0 };
  if (r.status !== 0) {
    findings.push(
      'docs/HANDOFF.md no longer matches the backlog (generate-handoff-roadmap --check failed). ' +
        'Regenerate it before handing off.',
    );
  }
} catch {
  /* script missing / spawn fault → skip this check */
}

// A memory file that never reached MEMORY.md is invisible to the next session:
// the index is what gets loaded, not the directory.
try {
  // Host memory lives outside the repo, keyed by a slug of the project path.
  const slug = ROOT.replace(/[:\\/]/g, '-');
  const memDir = join(homedir(), '.claude', 'projects', slug, 'memory');
  const index = readFileSync(join(memDir, 'MEMORY.md'), 'utf8');
  const orphans = readdirSync(memDir)
    .filter((n) => n.endsWith('.md') && n !== 'MEMORY.md')
    .filter((n) => !index.includes(n));
  if (orphans.length > 0) {
    findings.push(
      `${orphans.length} memory file(s) are NOT linked from MEMORY.md — the index is what loads next ` +
        `session, so these are invisible:\n` +
        orphans.slice(0, 8).map((n) => `      ${n}`).join('\n'),
    );
  }
} catch {
  /* memory store absent on this box → skip */
}

// CI on the default branch. The lap rule says to check it by hand at every
// close-out; a rule that depends on remembering is the thing this project moves
// into tooling. Reading one workflow is not reading CI — `ci` stayed green for
// three commits while the suite that actually runs vitest was red.
try {
  const ghArgs = [
    'run',
    'list',
    '--branch',
    'main',
    '--limit',
    '20',
    '--json',
    'workflowName,status,conclusion,createdAt',
  ];
  const ghOpts = {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15_000,
    windowsHide: true,
  };
  let r = spawnSync('gh', ghArgs, ghOpts);
  // win32: `gh` may be a `.cmd`/`.ps1` shim, which bare spawn does NOT resolve —
  // the same trap resolveWindowsShimSpawnCommand handles in src. Every arg here
  // is a fixed literal, so the shell retry carries no interpolation.
  if (r.error?.code === 'ENOENT' && process.platform === 'win32') {
    r = spawnSync('gh', ghArgs, { ...ghOpts, shell: true });
  }
  // No gh, not authed, no network, rate-limited, a 503 from either endpoint —
  // every one of those is "cannot tell", never "CI is fine".
  if (r.status === 0 && r.stdout) {
    const red = latestFailedWorkflows(JSON.parse(r.stdout));
    if (red.length > 0) {
      findings.push(
        `CI is RED on main — the latest completed run of ${red.length} workflow(s) FAILED:\n` +
          red.map((n) => `      ${n}`).join('\n') +
          `\n      A green local suite does not clear this: the workflows do not run the same set. ` +
          `Resolve to NAMED failing files before calling the lap green.`,
      );
    }
  }
} catch {
  /* gh absent / bad JSON / spawn fault → cannot tell, so say nothing */
}

try {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(
    marker,
    JSON.stringify(
      { count: (state.count ?? 0) + 1, states: [...(state.states ?? []), stateKey], at: new Date().toISOString() },
      null,
      2,
    ),
  );
} catch {
  /* cannot record → still challenge; the cap degrades, the gate does not wedge */
}

console.error(
  'closeout challenge: are you sure that was all taken care of, and that the handoff will be clear for ' +
    'the next agent?\n\n' +
    (findings.length > 0
      ? 'Not rhetorical — these are open right now:\n' + findings.map((f) => `  • ${f}`).join('\n') + '\n\n'
      : 'Nothing mechanical is outstanding, so this is the judgment half:\n\n') +
    'Re-walk the end-of-sprint close (CLAUDE.md → End-of-sprint cleanup, docs/project-philosophy.md B4):\n' +
    '  - green verified on a CLEAN, PUSHED tree — not on the tree you were mid-edit in;\n' +
    '  - the sprint diff scanned for dead code / orphaned helpers / stray debug / TODO;\n' +
    '  - no half-done state, and any DELIBERATE intermediate state called out so it does not read as a bug;\n' +
    '  - HANDOFF trimmed to immediate-next-only; backlog status current; memory + index synced;\n' +
    '  - every remaining step stated WITH its home doc — or an explicit "nothing pending". A step that ' +
    'lives only in this chat is lost when the session ends;\n' +
    '  - every decision only the OWNER can make ASKED as a direct question, options spelled out ' +
    '(AskUserQuestion where available) — "your decision: see queue X / run command Y" is a pointer, ' +
    'not a question, and the owner never has to go fetch a question the agent already holds.\n\n' +
    'Fix what is real. Then RE-RENDER the whole closeout report to the scheme in ' +
    'docs/end-of-sprint-report-template.md, carrying the corrections this pass just made — every ' +
    'section kept, "none" / "nothing pending" written out rather than dropped. That report IS the ' +
    'hand-back; a conversational reply ABOUT the challenge is not, and it leaves the next session ' +
    'reading a hand-back that predates the fixes. State inside the report what this pass changed, or ' +
    'that nothing was outstanding, then stop — ' +
    `this asks at most ${CHALLENGE_CAP}x per session. (Bypass: AUDIT_TOOLS_NO_CLOSEOUT_CHALLENGE=1.)`,
);
process.exit(2);
