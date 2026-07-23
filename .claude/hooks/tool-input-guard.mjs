#!/usr/bin/env node
// PreToolUse guard on Edit / Write / Agent — the traps that live in a tool's
// INPUT rather than in a shell command.
//
// Payload on stdin: { tool_name, tool_input }. Exit 0 = allow, exit 2 = block
// (stderr is fed back to the agent). FAIL-OPEN on anything unexpected.
//
// Three rules:
//   1. Raw control byte in written content  (Edit|Write)
//   2. Agent `isolation: "worktree"` on a dispatch node  (Agent)
//   3. Stale-main deny-once before the first source edit  (Edit|Write)
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';

const ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();

let raw = '';
try {
  for await (const chunk of process.stdin) raw += chunk;
} catch {
  process.exit(0);
}

let payload;
try {
  payload = JSON.parse(raw);
} catch {
  process.exit(0);
}

const toolName = payload?.tool_name ?? '';
const input = payload?.tool_input ?? {};

function block(message) {
  console.error(message);
  process.exit(2);
}

// Is `p` inside the project tree? Scratchpad / temp writes are out of scope for
// the source-tree rules below.
function inProject(p) {
  if (!p) return false;
  const abs = isAbsolute(p) ? p : join(ROOT, p);
  const rel = relative(ROOT, abs).replace(/\\/g, '/');
  return rel !== '' && !rel.startsWith('../');
}

// ── Rule 2: Agent worktree isolation on a dispatch node ──────────────────────
// The tool's own dispatch plan already creates and names the node's worktree.
// Adding the Agent tool's OWN `isolation: "worktree"` spawns a SECOND, unrelated
// worktree; the subagent edits source there instead of the tool-designated tree,
// and `accept-node`'s cherry-pick then sees no diff.
if (toolName === 'Agent') {
  const prompt = String(input?.prompt ?? '');
  const dispatchShaped =
    /\b(remediate-code|audit-code|accept-node|merge-implement-results|merge-and-ingest)\b/i.test(prompt) ||
    /\b(implement|dispatch)\s+node\b/i.test(prompt) ||
    /\bnode[_-]?(id|worktree)\b/i.test(prompt);
  if (input?.isolation === 'worktree' && dispatchShaped) {
    block(
      'tool-input guard: never pass `isolation: "worktree"` when dispatching an audit-code / remediate-code ' +
        'node.\nThe tool\'s dispatch plan ALREADY created and named the node\'s worktree. A second, unrelated ' +
        'worktree means the subagent edits source in the wrong tree and `accept-node`\'s cherry-pick sees no diff.\n' +
        '  fix: drop `isolation` and give the agent the workdir the dispatch plan names.',
    );
  }
  process.exit(0);
}

if (toolName !== 'Edit' && toolName !== 'Write') process.exit(0);

// ── Rule 1: raw control byte in written content ──────────────────────────────
// A NUL in a template literal (or a backslash-u escape decoded by the tool-call
// JSON layer) lands as a REAL control byte: tsc and vitest read the file fine,
// but git marks it BINARY — `git diff` shows `Bin` and every grep over the file
// silently returns nothing. Bit four times. `npm run check:control-bytes`
// already encodes this rule for the whole tracked tree; this is the same rule
// moved to the keystroke that causes it, so it fails in one edit rather than at
// the release gate.
//
// Scanned with a char-code LOOP rather than a regex character class on purpose:
// authoring that class requires backslash-u escapes, and those decode to real
// control bytes on the way through the tool-call JSON — writing the guard would
// trip the guard (it did, on the first draft of this file).
const isForbiddenCode = (c) => c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d;
function findControlByte(text) {
  for (let i = 0; i < text.length; i++) {
    if (isForbiddenCode(text.charCodeAt(i))) return i;
  }
  return -1;
}

const filePath = String(input?.file_path ?? '');

const written = [];
if (typeof input?.content === 'string') written.push(input.content);
if (typeof input?.new_string === 'string') written.push(input.new_string);
if (Array.isArray(input?.edits)) {
  for (const e of input.edits) if (typeof e?.new_string === 'string') written.push(e.new_string);
}

if (inProject(filePath)) {
  for (const text of written) {
    const at = findControlByte(text);
    if (at === -1) continue;
    const code = text.charCodeAt(at);
    const line = text.slice(0, at).split('\n').length;
    const context =
      text.slice(Math.max(0, at - 40), at).replace(/\s+/g, ' ') +
      '<<HERE>>' +
      text.slice(at + 1, at + 41).replace(/\s+/g, ' ');
    block(
      `tool-input guard: raw control byte 0x${code.toString(16).padStart(2, '0')} in the content written to ` +
        `${filePath} (line ${line} of the new text).\n` +
        'git treats a file containing a byte < 0x20 (other than tab/LF/CR) as BINARY — `git diff` shows `Bin`, ' +
        'and every grep or code search over the file silently returns nothing.\n' +
        `  context: ...${context}...\n` +
        '  fix: emit a source escape the compiler resolves at runtime (a backslash-u escape written so it stays ' +
        'text — e.g. build it with String.fromCharCode) or use a printable delimiter. Never embed the raw byte. ' +
        'Same rule as `npm run check:control-bytes`, applied at write time.',
    );
  }
}

// ── Rule 3: stale-main deny-once ─────────────────────────────────────────────
// A worktree branched from a STALE local main once re-implemented a whole commit
// that had already landed, and built the next stage blind to a design section it
// lacked. The `start-lap` skill asks for the sync, but an instruction is not
// enforcement — this is the mechanical half: the SessionStart probe records that
// HEAD is behind the remote, and the first edit to SOURCE refuses ONCE.
// Deny-ONCE on purpose: it must interrupt the lap before code is written, not
// wedge a session where editing against the older tree is the actual intent.
const SOURCE_EDIT = /^(src|tests|scripts)\//;
const relPath = isAbsolute(filePath)
  ? relative(ROOT, filePath).replace(/\\/g, '/')
  : filePath.replace(/\\/g, '/');

if (inProject(filePath) && SOURCE_EDIT.test(relPath)) {
  const markerPath = join(ROOT, '.claude', 'hooks', '.state', 'stale-main.json');
  if (existsSync(markerPath)) {
    let marker = null;
    try {
      marker = JSON.parse(readFileSync(markerPath, 'utf8'));
    } catch {
      marker = null;
    }
    // Consume the marker whatever happens next — this fires at most once per
    // detection, so a second attempt at the same edit proceeds.
    try {
      rmSync(markerPath, { force: true });
    } catch {
      /* ignore */
    }
    if (marker && Number(marker.behind) > 0) {
      block(
        `tool-input guard: HEAD is ${marker.behind} commit(s) BEHIND ${marker.remote}/main — refusing the first ` +
          `source edit of this lap.\n` +
          'A lap branched from stale main once re-implemented an entire commit that had already landed, and built ' +
          'the next stage blind to a design section it did not have.\n' +
          `  fix: git fetch ${marker.remote} main && git rebase ${marker.remote}/main   (or reset --hard if the branch is disposable)\n` +
          '  then retry the edit. This guard fires ONCE per detection — retrying immediately proceeds, for when ' +
          'editing against the older tree is genuinely intended.',
      );
    }
  }
}

process.exit(0);
