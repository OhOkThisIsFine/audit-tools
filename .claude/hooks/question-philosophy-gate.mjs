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
// ONCE PER SESSION, keyed on session_id: after the first injection the philosophy
// is in the transcript, so re-injecting is pure token waste — and keying on the
// question text instead would re-fire forever as the agent reformulates.
//
// Fails OPEN on everything (unparseable payload, missing/restructured doc, fs
// fault). A gate on the question path must never wedge a session.
import { readFileSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

if (process.env.AUDIT_TOOLS_NO_QUESTION_PHILOSOPHY) process.exit(0);

const ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const STATE_DIR = join(ROOT, '.claude', 'hooks', '.state', 'philosophy-injected');

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
const sessionId = String(payload?.session_id ?? '').replace(/[^\w.-]/g, '');
if (!sessionId) process.exit(0);
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
