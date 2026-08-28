#!/usr/bin/env node
// The "are you sure that was all taken care of?" challenge, automated.
//
// Asking that question by hand at the end of a sprint reliably surfaces real
// gaps — an unpushed commit, stale generated HANDOFF state, a
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
//  - the closeout-render check is SESSION-scoped and bound to worktree CONTENT:
//    an earlier session's render does not close this one, and committing exactly
//    what the report described does not invalidate it;
//  - deliberately does NOT key on stop_hook_active alone: two other Stop hooks
//    share this event, and a block from either would otherwise starve this one;
//  - skips (spending nothing) while the payload shows live background tasks or
//    scheduled session crons: that stop is a WAIT the harness resumes, not a
//    closeout, and challenging there was exactly how both cap slots kept being
//    burned mid-lap;
//  - only fires when the session actually did work (HEAD moved recently,
//    SESSION-scoped tree dirt, or unpushed commits) — nothing to close out
//    means nothing to ask. Dirt already present at session start (the
//    registered baseline) is FOREIGN: reported as pre-session, never
//    challenged, never in the dedupe key;
//  - a session with NO registry record under an ARMED registry is a dispatched
//    child — its stop is not this repo's closeout, so it exits 0 untouched;
//  - swallows every fs/git/spawn fault → exit 0.
//
// Exit 0 = allow stop, exit 2 = block (stderr is fed back to the agent).
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { latestFailedWorkflows } from '../../scripts/shared/ciRedWorkflows.mjs';
import { closeoutReadinessFindings } from '../../scripts/shared/closeoutReadiness.mjs';
import { sessionHasLiveBackgroundWork } from '../../scripts/shared/liveSessionWork.mjs';
import { worktreeTree } from '../../scripts/shared/worktree-tree.mjs';
import {
  readSessionRegistry,
  runPorcelainStatus,
  sanitizeSessionId,
  SESSIONS_DIR_SEGMENTS,
} from '../../scripts/shared/sessionRegistry.mjs';

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

const sessionId = sanitizeSessionId(payload?.session_id);
if (!sessionId) process.exit(0); // no session key → cannot cap → fail open

// ── Session registry: child skip + tree-dirt baseline ────────────────────────
// An unregistered session under an ARMED registry is a dispatched child — its
// stop is not this repo's closeout. Exit BEFORE any cap/state accounting, like
// the wait-skip above. Registry not armed, or a corrupt record → empty
// baseline → every dirt entry is "session dirt" → the old whole-tree FIRING
// behavior (the transitional-window guarantee). The read itself is not
// byte-identical to the legacy one even unarmed: `-uall` enumerates untracked
// files individually, and the .state/ self-exclusion below always applies.
const registry = readSessionRegistry(ROOT, payload?.session_id);
if (registry.isUnregisteredChild) process.exit(0);
const baseline = new Set(registry.record?.baseline ?? []);

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
// Raw `-z` porcelain via the lib — the exact argv the baseline was captured
// with, or partition identity silently breaks (untracked-dir collapse, the
// trimmed leading space of a first-sorted ` M path` record).
const porcelain = runPorcelainStatus(ROOT);
// The gate substrate's own state is never the session's work: markers and
// session records live under .claude/hooks/.state/ (gitignored in this repo —
// but in a repo without that ignore rule, `-uall` lists every marker THIS gate
// writes, so its own bookkeeping would re-key the dedupe and burn cap slots on
// itself).
const STATE_PREFIX = `${SESSIONS_DIR_SEGMENTS.slice(0, 3).join('/')}/`;
const entries = (porcelain.ok ? porcelain.entries : []).filter(
  (entry) => !entry.paths.every((p) => p.startsWith(STATE_PREFIX)),
);
// FOREIGN = every path the entry names was already dirty at session start
// (rename rows: foreign only if BOTH sides pre-existed). Everything else is
// session dirt. Foreign dirt is another session's business: it never fires the
// gate, never enters the dedupe key, and is only REPORTED alongside a
// challenge that is firing anyway.
const isForeign = (entry) => entry.paths.every((p) => baseline.has(p));
const foreign = entries.filter(isForeign);
const sessionDirt = entries.filter((entry) => !isForeign(entry));

const headTs = Number(git(['log', '-1', '--format=%ct']).out) * 1000;
const headMovedRecently = Number.isFinite(headTs) && Date.now() - headTs < RECENT_MS;

const remotes = git(['remote']).out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
const remote = remotes.includes('audit-tools') ? 'audit-tools' : remotes[0];
const unpushed = remote ? git(['log', '--oneline', `${remote}/main..HEAD`]).out : '';

if (sessionDirt.length === 0 && !headMovedRecently && !unpushed) process.exit(0);

// Already challenged this exact tree state? Then the agent answered and nothing
// moved — do not ask the same question twice about the same evidence. Foreign
// dirt is excluded so another session committing or cleaning ITS dirt cannot
// mint a fresh key and burn a cap slot. Same length-degeneracy class as the old
// whole-tree key: equal-length reshapes of session dirt do not re-key.
const sessionDirtKey = sessionDirt
  .map((entry) => entry.display)
  .sort()
  .join('|').length;
const stateKey = `${git(['rev-parse', 'HEAD']).out}:${sessionDirtKey}:${unpushed.length}`;
if ((/** @type {string[]} */ (state.states ?? [])).includes(stateKey)) process.exit(0);

// ── Mechanical evidence — the part a confident "yes" cannot survive ──────────
const findings = [];

if (sessionDirt.length > 0) {
  findings.push(
    `UNCOMMITTED work in the tree (${sessionDirt.length} path(s)):\n` +
      sessionDirt.slice(0, 12).map((entry) => `      ${entry.display}`).join('\n'),
  );
}

// Informational only: never fires the gate, never enters the stateKey, and is
// printed only when the challenge fires anyway (a Stop hook exiting 0 stays
// silent).
if (foreign.length > 0) {
  findings.push(
    `PRE-SESSION dirt — present when this session started, so NOT yours to close out ` +
      `(${foreign.length} path(s); likely a concurrent session's work — leave it alone, do not ` +
      `commit or clean it):\n` +
      foreign.slice(0, 8).map((entry) => `      ${entry.display}`).join('\n'),
  );
}

if (unpushed) {
  findings.push(
    `UNPUSHED commit(s) — the next agent clones ${remote}/main and will not see these:\n` +
      unpushed.split(/\r?\n/).slice(0, 8).map((l) => `      ${l}`).join('\n'),
  );
}

// Deterministic, session-independent readiness — the stale generated HANDOFF and
// the unindexed memory files. Shared with the RENDERER, which refuses to render
// while any is outstanding (scripts/shared/closeoutReadiness.mjs). This gate is
// the backstop, not the first line: raising them here for the first time is what
// used to force a second render of a report that was wrong when it was written.
findings.push(...closeoutReadinessFindings(ROOT));

/**
 * Did the rendered report actually reach the owner — i.e. appear in an ASSISTANT
 * message, not merely in the tool result the renderer wrote to?
 *
 * Checks the record's anchors (the report title and the last heading the
 * renderer emitted) against assistant text at or after `rendered_at`. Two
 * anchors, not the whole body, so a genuine full paste can never false-red on
 * whitespace or on the harness re-wrapping a line — and a summary ABOUT the
 * report, which is the failure being caught, carries neither.
 *
 * FAILS OPEN on every fault: an unreadable transcript, an absent path, or a
 * pre-anchor record returns true. A gate that cannot see the evidence must not
 * assert its absence.
 *
 * @param {unknown} transcriptPath
 * @param {{ report_anchors?: unknown, rendered_at?: unknown }} rec
 * @returns {boolean}
 */
function reportReachedTheOwner(transcriptPath, rec) {
  const anchors = Array.isArray(rec?.report_anchors) ? rec.report_anchors.map(String) : [];
  if (anchors.length === 0) return true; // pre-anchor record → nothing to check
  if (typeof transcriptPath !== 'string' || transcriptPath.length === 0) return true;
  let lines;
  try {
    lines = readFileSync(transcriptPath, 'utf8').split(/\r?\n/).filter(Boolean);
  } catch {
    return true;
  }
  const renderedAt = Date.parse(String(rec?.rendered_at ?? ''));
  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.type !== 'assistant') continue;
    const at = Date.parse(String(entry?.timestamp ?? ''));
    if (Number.isFinite(renderedAt) && Number.isFinite(at) && at < renderedAt) continue;
    const content = entry?.message?.content;
    if (!Array.isArray(content)) continue;
    const text = content
      .filter((c) => c?.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('\n');
    if (text && anchors.every((a) => text.includes(a))) return true;
  }
  return false;
}

// The hand-back itself: rendered through scripts/render-closeout.mjs, which
// REFUSES to render until every section carries a value or an explicit "none",
// then omits the silent ones. The record binds to the worktree CONTENT and to
// the session that wrote it, so neither a commit of what the report described
// nor an earlier session's render satisfies this check. Without one, the report
// was hand-written — and a hand-written report is exactly where a skipped
// section hides as a short one.
try {
  const rec = JSON.parse(
    readFileSync(join(ROOT, '.claude', 'hooks', '.state', 'closeout-render', 'latest.json'), 'utf8'),
  );
  // The record is ONE file per repo, so its existence proves nothing about THIS
  // session. Before this check, a session could stop at a HEAD an EARLIER session
  // had rendered and pass in silence: 19 of 29 challenged sessions hand-wrote the
  // report and only 3 were caught
  // (docs/reviews/closeout-generation-failure-2026-08-26.md).
  const startedAt = Date.parse(registry.record?.registered_at ?? '');
  const renderedAt = Date.parse(rec?.rendered_at ?? '');
  const foreignRender =
    Number.isFinite(startedAt) && Number.isFinite(renderedAt) && renderedAt < startedAt;
  const currentTree = worktreeTree(ROOT);
  if (foreignRender) {
    findings.push(
      "the closeout render on record predates this session, so it is ANOTHER session's hand-back. " +
        'The record is one file per repo, and an earlier render does not close YOUR sprint — render ' +
        'your own with `node scripts/render-closeout.mjs --in <closeout.json>`.',
    );
  } else if (rec?.tree && currentTree && rec.tree !== currentTree) {
    findings.push(
      'the closeout render on record describes different content than the tree being handed off — ' +
        're-render it (`node scripts/render-closeout.mjs --in <closeout.json>`). Committing exactly ' +
        'what the report already described does NOT trigger this; an edit made AFTER the render does.',
    );
  } else if (!rec?.tree) {
    // Pre-v2 record: HEAD-bound, and the closeout's own commit moves HEAD. Fall
    // back to the old comparison for the single session that spans the upgrade —
    // the next render writes a tree-bound record and this arm dies.
    const head = git(['rev-parse', 'HEAD']).out;
    if (head && rec?.head && rec.head !== head) {
      findings.push(
        `the closeout render on record is for ${String(rec.head).slice(0, 8)}, not the current ` +
          `${head.slice(0, 8)} — re-render it so the report describes the tree being handed off ` +
          '(`node scripts/render-closeout.mjs --in <closeout.json>`).',
      );
    }
  } else if (!reportReachedTheOwner(payload?.transcript_path, rec)) {
    // RENDERED is not the same as DELIVERED. The renderer writes to stdout, which
    // in an agent host is a TOOL RESULT — shown to the agent, not reliably to the
    // person. So every check above can pass while the owner sees no hand-back at
    // all: the agent runs the renderer, reads the output itself, and writes a
    // summary ABOUT it. Observed 2026-08-28, twice in one session, each time
    // followed by "that is the hand-back above" pointing at something the owner
    // could not see. The anchors are two lines only the renderer emits.
    findings.push(
      'the closeout was RENDERED but never PASTED — no message in this session contains the ' +
        "report's own heading lines. The renderer writes to stdout, which the owner does not see: " +
        'a tool result is shown to you, not to them. Paste the rendered markdown into your reply ' +
        'verbatim. Re-running the renderer does not fix this; the report has to appear in the ' +
        'message you send.',
    );
  }
} catch {
  findings.push(
    'no rendered closeout on record for this tree. Write the section inputs and render the ' +
      'hand-back with `node scripts/render-closeout.mjs --in <closeout.json>` ' +
      '(`--template` prints a blank one): it refuses until every section states content or an ' +
      'explicit "none", then omits the silent ones. A hand-written report can drop a section ' +
      'without anyone noticing; a rendered one cannot.',
  );
}

// (the memory-index check moved into scripts/shared/closeoutReadiness.mjs above,
// so the renderer raises it BEFORE the report is written rather than after)

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
  const ghOpts = /** @type {import('node:child_process').SpawnSyncOptionsWithStringEncoding} */ ({
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15_000,
    windowsHide: true,
  });
  let r = spawnSync('gh', ghArgs, ghOpts);
  // win32: `gh` may be a `.cmd`/`.ps1` shim, which bare spawn does NOT resolve —
  // the same trap resolveWindowsShimSpawnCommand handles in src. Every arg here
  // is a fixed literal, so the shell retry carries no interpolation.
  if ((/** @type {any} */ (r.error)?.code) === 'ENOENT' && process.platform === 'win32') {
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
    '  - every remaining step stated WITH its home doc; state "none" for that section only when ' +
    'nothing pending actually remains. A step that ' +
    'lives only in this chat is lost when the session ends;\n' +
    '  - every decision only the OWNER can make ASKED as a direct question, options spelled out ' +
    '(AskUserQuestion where available) — "your decision: see queue X / run command Y" is a pointer, ' +
    'not a question, and the owner never has to go fetch a question the agent already holds.\n\n' +
    'Fix what is real. Then produce the hand-back by RUNNING THE RENDERER:\n' +
    '  node scripts/render-closeout.mjs --in <closeout.json>   (--template prints a blank input)\n' +
    'Paste its output. Do NOT hand-write a report that imitates the renderer output: this gate reads ' +
    'the record the RENDERER writes, so a hand-written one leaves no evidence any section was ' +
    'considered.\n\n' +
    'The "none" rule has two halves, and they are opposites — keep them straight:\n' +
    '  - in the INPUT JSON, EVERY section carries a value: real content, or the literal "none";\n' +
    '  - in the RENDERED OUTPUT, the "none" sections are omitted. That omission is the ' +
    "renderer's job, never yours.\n\n" +
    'Carry the corrections this pass just made into the INPUT, then render. The rendered report IS ' +
    'the hand-back; a conversational reply ABOUT this challenge is not, and it leaves the next ' +
    'session reading a hand-back that predates the fixes. State inside the report what this pass ' +
    'changed, or that nothing was outstanding, then stop — ' +
    `this asks at most ${CHALLENGE_CAP}x per session. (Bypass: AUDIT_TOOLS_NO_CLOSEOUT_CHALLENGE=1.)`,
);
process.exit(2);
