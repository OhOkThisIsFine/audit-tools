#!/usr/bin/env node
// A question is about to reach the owner — surface the project philosophy FIRST.
//
// Most questions the owner gets asked are already answered by a standing
// conviction ("effort/complexity is not a cost", "ideal code over compatibility",
// "deliverables land in a file"), and answering them by hand is the owner
// re-reading their own philosophy aloud. This gate injects PART B + the BRIDGE of
// `docs/project-philosophy.md` once per session, at the moment a question is
// actually being asked, and lets the question through on the retry.
//
// It does NOT discourage asking. B1 itself says *ask on ambiguity, don't defer
// silently* — so the message says exactly that: if the question survives the
// principles, ask it again and it goes through.
//
// TWO TRIGGERS, one concern:
//   PreToolUse (AskUserQuestion) — the question interface, detected exactly.
//   Stop                        — the final message ends in a question to the owner.
//
// ── What is exempt ───────────────────────────────────────────────────────────
// EXACTLY ONE QUESTION: the lap APPROVAL request, and only the FIRST one.
//
// Step 8 of the global /start-lap skill MANDATES asking the owner to approve the
// lap plan, and requires it be asked WITH AskUserQuestion. No standing conviction
// can settle that question — it asks for scope AUTHORIZATION, not for how to
// proceed, and the brief printed here is about the latter. So it is exempt on
// BOTH legs, which is why the exemption is not gated on the Stop leg alone.
//
// The exemption is ONE question, not one boundary. The signal alone (a lap record
// with nothing committed since) is true for every question asked between the lap
// opening and the lap's first commit, so keying the exemption on the signal alone
// would exempt all of them. The use is therefore RECORDED, keyed on the lap
// record's `lapId`, in THIS session's own state: the first question at the
// boundary passes, every later one is challenged as normal.
// Only a question the gate would otherwise CHALLENGE spends the exemption: it is
// consulted after the once-per-session marker and the Stop leg's trailing-question
// test, so a turn that ends without a question cannot use it up.
//
// It ends at the lap's FIRST COMMIT (a mid-lap question is an ordinary one), and
// it never applies to a lap record another session opened — tested MECHANICALLY
// as: the lap record file's mtime is at or after this session's `registered_at`.
// /start-lap writes the record at step 1, after the session registered, so a
// record older than the registration was written by an earlier session.
//
// ONCE PER SESSION, keyed on session_id: after the first injection the philosophy
// is in the transcript, so re-injecting is pure token waste — and keying on the
// question text instead would re-fire forever as the agent reformulates.
//
// Fails OPEN on everything (unparseable payload, missing/restructured doc, fs
// fault). A gate on the question path must never wedge a session.
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdirSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readSessionRegistry, sanitizeSessionId } from '../../scripts/shared/sessionRegistry.mjs';

if (process.env.AUDIT_TOOLS_NO_QUESTION_PHILOSOPHY) process.exit(0);

const ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const STATE_DIR = join(ROOT, '.claude', 'hooks', '.state', 'philosophy-injected');
// The lap-approval exemption's own state, beside the per-session one above and
// deliberately NOT merged into it: that marker is keyed per SESSION (has this
// session been injected at all), this one per LAP RECORD (`lapId`) — a session
// that opens a second lap later must get its approval question exempt again.
const LAP_EXEMPTION_DIR = join(ROOT, '.claude', 'hooks', '.state', 'lap-approval-exempted');

/**
 * The lap record's `lapId`, or null when there is no usable one.
 *
 * `/start-lap`'s opener (`lap-worktree.mjs`) is the only writer of the record and
 * mints the id as 8 lowercase hex characters. Anything else — an absent, corrupt,
 * or foreign record — is NOT an id, and an exemption keyed on a non-id would
 * exempt every question in the lap. Fails soft to null.
 */
function readLapRecord(root) {
  const recordPath = join(root, '.claude', 'lap-start.json');
  if (!existsSync(recordPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(recordPath, 'utf8'));
    const lapId = parsed?.lapId;
    if (typeof lapId !== 'string' || !/^[0-9a-f]{8}$/.test(lapId)) return null;
    // The record's own write time — the mechanical half of "another session
    // opened this lap" (see `isLapApprovalBoundary`).
    const mtimeMs = statSync(recordPath).mtimeMs;
    return { lapId, mtimeMs: Number.isFinite(mtimeMs) ? mtimeMs : null };
  } catch {
    return null;
  }
}

/**
 * Is this a question at the lap-approval boundary — the first one, on a lap THIS
 * session opened, before its first commit?
 *
 * Four facts, all required:
 *  - a lap record with a usable `lapId` is present (the record alone is present
 *    the whole lap long, so it cannot decide on its own);
 *  - this session has not already spent the exemption on THIS lap record;
 *  - the session has committed nothing at or after it registered (both halves
 *    load-bearing: "no recent commit" alone is true of any idle session, and the
 *    record alone is true all lap);
 *  - the record is not older than the session's registration — a lap another
 *    session opened must not have its approval question exempted for this one.
 *
 * Fails OPEN — i.e. does NOT exempt — on every fault. A gate that cannot read its
 * evidence must not use that blindness to stand down; the cheap failure here is
 * the wasted round trip this exemption exists to remove.
 */
function isLapApprovalBoundary(root, registryRecord, sessionId) {
  try {
    const lap = readLapRecord(root);
    if (!lap) return false;
    const startedAt = Date.parse(registryRecord?.record?.registered_at ?? '');
    // No registration timestamp: the registry cannot say when this session
    // began, so neither "nothing committed since" nor "not another session's
    // lap" can be established. Do not exempt.
    if (!Number.isFinite(startedAt)) return false;
    // Another session's lap: /start-lap writes the record after the session
    // registered, so a record written BEFORE this session registered belongs to
    // a lap this session did not open. Second granularity, matching the commit
    // comparison below — the two halves must not disagree about the boundary.
    if (lap.mtimeMs !== null && Math.floor(lap.mtimeMs / 1000) < Math.floor(startedAt / 1000)) {
      return false;
    }
    if (hasSpentLapExemption(root, sessionId, lap.lapId)) return false;
    const r = spawnSync('git', ['log', '-1', '--format=%ct'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 8_000,
      windowsHide: true,
    });
    // No commits at all is the strongest form of "nothing has landed" — the
    // approval boundary, not a fault.
    if (r.error || r.status !== 0) return true;
    const headTs = Number((r.stdout ?? '').trim()) * 1000;
    if (!Number.isFinite(headTs)) return true;
    // Same second-granularity floor the closeout gate uses: git's `%ct` carries
    // seconds while `registered_at` carries milliseconds.
    return Math.floor(headTs / 1000) < Math.floor(startedAt / 1000);
  } catch {
    return false;
  }
}

/** This session's record of the lap ids it has already spent the exemption on. */
function lapExemptionPath(root, sessionId) {
  return join(root, '.claude', 'hooks', '.state', 'lap-approval-exempted', `${sessionId}.json`);
}

/**
 * Has this session already exempted a question on this lap record?
 *
 * A record naming a DIFFERENT lapId does not count: a later lap in the same
 * session is a new approval boundary and earns its own exemption. A corrupt or
 * unreadable record answers TRUE — the conservative direction, since the
 * exemption is a convenience and "cannot tell" must not hand out a second one.
 */
function hasSpentLapExemption(root, sessionId, lapId) {
  const path = lapExemptionPath(root, sessionId);
  if (!existsSync(path)) return false;
  try {
    return JSON.parse(readFileSync(path, 'utf8'))?.lapId === lapId;
  } catch {
    return true;
  }
}

/** Record the use. Best-effort: an unrecorded use means the NEXT question at
 * this boundary is exempt too, which is a wasted round trip, not a wrong answer. */
function spendLapExemption(root, sessionId, lapId) {
  try {
    mkdirSync(LAP_EXEMPTION_DIR, { recursive: true });
    writeFileSync(
      lapExemptionPath(root, sessionId),
      JSON.stringify({ session: sessionId, lapId, at: new Date().toISOString() }, null, 2),
    );
  } catch {
    /* cannot record → still exempt once; a repeat is cheaper than never firing */
  }
}

let payload = {};
try {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  payload = raw ? JSON.parse(raw) : {};
} catch {
  process.exit(0);
}

const event = payload?.hook_event_name ?? '';
const isAskTool = (payload?.tool_name ?? '') === 'AskUserQuestion';
const isStop = event === 'Stop';
if (!isAskTool && !isStop) process.exit(0);

// Re-entrant stop (we already blocked once and Claude is continuing) — let it go.
if (isStop && payload?.stop_hook_active) process.exit(0);

// ── Once per session ─────────────────────────────────────────────────────────
// No session_id (older payload shape) → fail open rather than guess, or the gate
// would fire on every single question.
const sessionId = sanitizeSessionId(payload?.session_id);
if (!sessionId) process.exit(0);
// Build 1 (P23): Stop leg only — an unregistered (child) session's closing
// question is part of its returned deliverable, not a question to the owner.
// The AskUserQuestion leg still fires for children on purpose: explicitly
// calling the question interface is an interactive act the philosophy
// injection legitimately governs. Unarmed registry / any registry fault →
// legacy behavior.
const registry = readSessionRegistry(ROOT, sessionId);
if (isStop && registry.isUnregisteredChild) process.exit(0);

const marker = join(STATE_DIR, `${sessionId}.json`);
if (existsSync(marker)) process.exit(0);

// ── Stop path: is the final message actually asking the owner something? ─────
// Only a trailing question counts. A question mark mid-message is usually the
// agent quoting, framing, or naming an open item — not a request for a decision.
function finalMessageAsksAQuestion(transcriptPath) {
  let lines;
  try {
    lines = readFileSync(transcriptPath, 'utf8').split(/\r?\n/).filter(Boolean);
  } catch {
    return false; // unreadable transcript → fail open
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (entry?.type !== 'assistant' && entry?.message?.role !== 'assistant') continue;
    const content = entry?.message?.content ?? entry?.content;
    const text = Array.isArray(content)
      ? content.filter((c) => c?.type === 'text').map((c) => c.text).join('\n')
      : typeof content === 'string'
        ? content
        : '';
    if (!text.trim()) return false;
    // Last non-empty line, minus trailing markdown emphasis/backticks.
    const lastLine = text.trim().split(/\r?\n/).filter((l) => l.trim()).pop() ?? '';
    return /\?\s*$/.test(lastLine.replace(/[*_`)\]]+$/, ''));
  }
  return false;
}

if (isStop && !finalMessageAsksAQuestion(payload?.transcript_path ?? '')) process.exit(0);

// …and the lap-approval exemption, which is the one question this gate knows by
// construction that no conviction settles. It is consulted HERE — after the
// once-per-session marker and after the Stop leg's trailing-question test — so
// it is spent only by a question this gate would otherwise challenge. A Stop
// whose final message asks nothing, or a session that already saw the brief,
// never uses it up. It is NOT stop-leg-only: /start-lap step 8 requires the
// approval request be asked WITH AskUserQuestion, so a Stop-leg-only exemption
// would challenge the very question it exists for.
if (isLapApprovalBoundary(ROOT, registry, sessionId)) {
  const lap = readLapRecord(ROOT);
  if (lap) spendLapExemption(ROOT, sessionId, lap.lapId);
  process.exit(0);
}

// ── Extract THE BRIEF (never copy it — the doc is the single home) ───────────
// The brief is the canonical short statement of the whole philosophy, both
// halves: Product (what audit-tools is) and Working (how the work gets done). A
// question can be about either, so both are injected — and the brief is short
// enough that injecting it whole beats guessing which half applies. The same
// block generates README.md's Philosophy section (scripts/check-philosophy-brief.mjs),
// so there is exactly one place to edit a conviction.
const DOC = 'docs/project-philosophy.md';
let brief = '';
try {
  const text = readFileSync(join(ROOT, DOC), 'utf8');
  const begin = text.indexOf('<!-- BEGIN philosophy-brief');
  const end = text.indexOf('<!-- END philosophy-brief -->');
  if (begin === -1 || end === -1 || end < begin) process.exit(0); // restructured → fail open
  brief = text.slice(text.indexOf('-->', begin) + 3, end).trim();
  if (!brief) process.exit(0);
} catch {
  process.exit(0);
}

try {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(marker, JSON.stringify({ session: sessionId, event, at: new Date().toISOString() }, null, 2));
} catch {
  /* cannot record → still inject once; a repeat is cheaper than never firing */
}

const trigger = isAskTool
  ? 'You are about to ask the owner a question'
  : 'Your closing message ends in a question to the owner';

console.error(
  `${trigger}. Most questions here are already answered by a standing conviction — check yours against ` +
    `these BEFORE asking. This fires ONCE per session.\n\n` +
    `IF THE QUESTION SURVIVES, ASK IT AGAIN AND IT GOES THROUGH — B1 says *ask on ambiguity, don't defer ` +
    `silently*, and this gate does not override that. What it refuses is a question the philosophy already ` +
    `settles: effort/complexity is NOT a cost, ideal code over compatibility, deliverables land in a file, ` +
    `a needed manual flag is a bug signal.\n\n` +
    `${brief}\n\n` +
    `Extracted from ${DOC} — the single home, where each line is argued in full. Read it if the ` +
    `question is about the product's architecture rather than about how to proceed.\n` +
    `(Bypass for this session: AUDIT_TOOLS_NO_QUESTION_PHILOSOPHY=1.)`,
);
process.exit(2);
