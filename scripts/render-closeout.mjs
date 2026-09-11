#!/usr/bin/env node
// @generated-artifact runtime-state
//
// Renderer + refusal for the end-of-sprint hand-back.
//
// It exists to hold two things at once that a hand-written report cannot: the
// report must be SHORT (an empty section is omitted, never written out as
// "none" with a paragraph explaining the "none"), and silence must be
// INTENTIONAL (an omitted section must be a decision, not a skipped step).
//
// The reconciliation is that the disposition is an INPUT, not part of the
// output. Every section in `closeout-sections-data.mjs` must appear in the
// input with a value — content, or the literal "none". Anything missing is a
// refusal that names it. What renders is only the sections with content.
//
// It also writes a record bound to the worktree CONTENT (a tree object id, not
// HEAD — committing what the report describes must not invalidate it), which
// `.claude/hooks/closeout-challenge-gate.mjs` reads: a sprint that ends with no
// record for this tree gets challenged, so the refusal cannot be sidestepped by
// hand-writing the report instead.
//
// Usage:
//   node scripts/render-closeout.mjs --in <closeout.json>
//   node scripts/render-closeout.mjs --in -            # read JSON from stdin
//   node scripts/render-closeout.mjs --template        # print a blank input
//
// Input shape (JSON object, keys = section ids):
//   { "verification": ["build + typecheck: green (abc1234)"],
//     "cleanup": "none",
//     "friction": { "ambiguous_direction": "none", ... },
//     ... }
// A value is a string, an array of strings (one bullet each), or "none".
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLOSEOUT_SECTIONS } from './closeout-sections-data.mjs';
import { closeoutReadinessFindings } from './shared/closeoutReadiness.mjs';
import { readSessionStartingHead } from './shared/sessionRegistry.mjs';
import { worktreeTree } from './shared/worktree-tree.mjs';
import { readOpenItems } from './nightly/items.mjs';

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const STATE_DIR = join(root, '.claude', 'hooks', '.state', 'closeout-render');
const SILENT = 'none';

// WHICH SESSSION IS THIS. `CLAUDE_SESSION_ID` was the name this read, and
// nothing in this harness sets it — so `record.session_id` was always null and
// the Stop gate was left comparing TIMESTAMPS, which cannot tell this session's
// render from a concurrent session's render written after this one started.
// `CLAUDE_CODE_SESSION_ID` is what the environment actually carries, and its
// value is exactly the filename of this session's record in the registry
// directory `readSessionRegistry` (scripts/shared/sessionRegistry.mjs)
// resolves from the hook payload — so the two agree on identity by construction.
// The old name is still honoured SECOND, for a host that sets only it; a name
// the environment does not supply is never guessed at.
// The fallback is a TRUTHINESS chain, not `??`: an environment that carries the
// name with an EMPTY value (a harness clearing it, a wrapper exporting it
// unset) must fall through to the other name rather than resolving to "no
// session" while a usable id sits one variable away.
const SESSION_ID = String(
  process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || '',
).replace(/[^\w.-]/g, '');

function fail(msg) {
  console.error(`render-closeout: ${msg}`);
  process.exit(1);
}

function git(args) {
  const r = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  return { ok: r.status === 0, stdout: (r.stdout ?? '').trim() };
}

// ── argv ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
let inPath = '';
let templateOnly = false;
// The sprint's start commit. `/start-lap` records it in `.claude/lap-start.json`
// and the shared renderer (`~/.agent-config/render-closeout.mjs`) has always taken
// it as `--start`, so the closeout SKILL instructs it for every repo. This
// renderer used to answer `unknown argument: --start` and exit 1, which made a
// run that followed the skill verbatim fail here. Accepting it is not enough —
// a flag that parses and does nothing is worse than one that errors — so it
// DERIVES the sprint's commit range and renders it as evidence the author did
// not type. (owner decision 2026-08-30: fix the renderer, one interface.)
let startCommit = '';
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--in') inPath = argv[++i] ?? '';
  else if (a === '--start') startCommit = argv[++i] ?? '';
  else if (a === '--template') templateOnly = true;
  else if (a === '--help' || a === '-h') {
    console.log('usage: render-closeout.mjs --in <closeout.json|-> [--start <commit>] | --template');
    for (const s of CLOSEOUT_SECTIONS) {
      console.log(`  ${s.id}${s.required ? ' (required — may not be "none")' : ''}: ${s.prompt}`);
    }
    process.exit(0);
  } else fail(`unknown argument: ${a}`);
}

function blankTemplate() {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const s of CLOSEOUT_SECTIONS) {
    if (s.bullets) {
      /** @type {Record<string, string>} */
      const b = {};
      for (const bullet of s.bullets) b[bullet.id] = SILENT;
      out[s.id] = b;
    } else out[s.id] = s.required ? [''] : SILENT;
  }
  return out;
}

if (templateOnly) {
  // The walk goes to STDERR so `--template > closeout.json` still yields valid
  // JSON. It is DERIVED from each section's own prompt, never a second copy of
  // the closeout steps: a hand-copied checklist here would drift from the
  // registry the renderer actually enforces.
  //
  // Why it prints at all: the Stop challenge can only prompt this walk AFTER a
  // report exists, so the agent re-walks, finds work, and renders a second time.
  // Surfacing the same contract at template time is what lets the fixes land
  // before the first render.
  process.stderr.write(
    'Walk these BEFORE filling anything in — each line is the contract the renderer will hold\n' +
      'the matching section to, and anything they surface is cheaper to fix now than after the\n' +
      'report has already described it. Rendering is the LAST step of the closeout, not the first.\n\n',
  );
  CLOSEOUT_SECTIONS.forEach((s, i) => {
    process.stderr.write(`  ${i + 1}. ${s.id} — ${s.prompt}\n`);
  });
  const pending = closeoutReadinessFindings(root);
  process.stderr.write(
    pending.length > 0
      ? `\nAlready outstanding, and the render will REFUSE until each is fixed:\n  - ${pending.join('\n  - ')}\n\n`
      : '\nDeterministic readiness checks: clean.\n\n',
  );
  console.log(JSON.stringify(blankTemplate(), null, 2));
  process.exit(0);
}
if (!inPath) fail('--in <closeout.json|-> is required (or --template for a blank one)');

let raw = '';
try {
  raw = inPath === '-' ? readFileSync(0, 'utf8') : readFileSync(inPath, 'utf8');
} catch (e) {
  fail(`could not read ${inPath}: ${/** @type {any} */ (e)?.message ?? e}`);
}
let input;
try {
  input = JSON.parse(raw);
} catch (e) {
  fail(`input is not valid JSON: ${/** @type {any} */ (e)?.message ?? e}`);
}
if (input === null || typeof input !== 'object' || Array.isArray(input)) {
  fail('input must be a JSON object keyed by section id');
}

// ── validate: every section stated, nothing invented ─────────────────────────
const known = new Set(CLOSEOUT_SECTIONS.map((s) => s.id));
const unknown = Object.keys(input).filter((k) => !known.has(k));
if (unknown.length > 0) {
  fail(
    `unknown section id(s): ${unknown.join(', ')}. The sections are declared in ` +
      'scripts/closeout-sections-data.mjs — add it there if the hand-back genuinely needs a new one.',
  );
}

/** @param {unknown} v */
function isSilent(v) {
  return typeof v === 'string' && v.trim().toLowerCase() === SILENT;
}

/** @param {unknown} v @returns {string[]} */
function toLines(v) {
  const arr = Array.isArray(v) ? v : [v];
  return arr.map((x) => String(x).trim()).filter((x) => x.length > 0);
}

/**
 * Does this decisions value name an OPEN item in the project's decision queue?
 *
 * The queue is the project's answerable page (`docs/nightly-inbox.md`, read
 * back by `npm run nightly:ingest`), and an item is named by its `subject_key`
 * — the identity the queue itself keys on. The key has to be BOTH well-formed
 * and present among the items still OPEN: a key that resolves to nothing, or to
 * something already answered, is not an ask in flight and is refused.
 *
 * EVERY 16-hex candidate in the value is tried, and ONE open hit accepts. The
 * value is prose the author wrote, and prose legitimately names other things:
 * a decision already settled is worth citing as context ("this replaces the
 * settled e978fad576fb2473"), and the section explicitly asks for the open
 * question alongside it. Reading only the FIRST match made that shape
 * unrenderable — the settled key won the match, and the refusal then asserted
 * the open key named no open item, which is false and unactionable.
 *
 * FAILS CLOSED, unlike every other check here. The others fail open because a
 * readiness check cannot see its evidence must not assert a problem; this one
 * is a claim by the report's AUTHOR that a question has been posed somewhere
 * answerable, and an unverifiable claim is not one. The cost of the
 * conservative direction is a re-render; the cost of the other is a decision
 * that reaches nobody while the report says it was asked.
 *
 * @param {string} root
 * @param {string} text the section's value, as joined lines
 * @returns {{ ok: true, key: string } | { ok: false, detail: string }}
 */
function queueItemVerdict(root, text) {
  const keys = [...text.matchAll(/\b[0-9a-f]{16}\b/g)].map((m) => m[0]);
  if (keys.length === 0) {
    return {
      ok: false,
      detail:
        'To use the decision queue as the answering route, name the item by its subject key (the ' +
        '16-hex id the item carries, e.g. \`e978fad576fb2473\`) — that is what makes the claim ' +
        'checkable. Run \`node scripts/nightly/answer.mjs --list\` to see the keys currently open.',
    };
  }
  let open;
  try {
    open = readOpenItems(root).items;
  } catch (error) {
    return {
      ok: false,
      detail:
        `could not read the decision queue to verify ${keys.join(', ')}: ` +
        `${/** @type {any} */ (error)?.message ?? error}. A queue item cannot be verified, so it ` +
        'cannot stand in for the question.',
    };
  }
  const openKeys = new Set((Array.isArray(open) ? open : []).map((item) => item?.subject_key));
  const hit = keys.find((key) => openKeys.has(key));
  if (hit !== undefined) return { ok: true, key: hit };
  return {
    ok: false,
    detail:
      `none of the ${keys.length} 16-hex key(s) in this value — ${keys.join(', ')} — names an OPEN ` +
      'item in the decision queue. Either they are not queue keys, or their subjects are already ' +
      'settled (a settled subject is never re-raised, so citing one asks nothing). Run ' +
      '\`node scripts/nightly/answer.mjs --list\` for the keys currently open.',
  };
}

const missing = [];
const emptied = [];
const rendered = [];
/** @type {Record<string, string>} */
const disposition = {};

for (const section of CLOSEOUT_SECTIONS) {
  if (!(section.id in input)) {
    missing.push(`${section.id} — ${section.prompt}`);
    continue;
  }
  const value = input[section.id];

  if (section.bullets) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      fail(`section "${section.id}" takes an object keyed by bullet id, one value per bullet`);
    }
    const unknownBullets = Object.keys(value).filter((k) => !/** @type {NonNullable<typeof section.bullets>} */ (section.bullets).some((b) => b.id === k));
    if (unknownBullets.length > 0) {
      fail(`section "${section.id}": unknown bullet(s) ${unknownBullets.join(', ')}`);
    }
    const lines = [];
    for (const bullet of section.bullets) {
      if (!(bullet.id in value)) {
        missing.push(`${section.id}.${bullet.id} — ${bullet.label}`);
        continue;
      }
      const bv = value[bullet.id];
      if (isSilent(bv)) continue;
      const bl = toLines(bv);
      if (bl.length === 0) {
        emptied.push({ id: `${section.id}.${bullet.id}`, required: !!bullet.required, prompt: bullet.label });
        continue;
      }
      lines.push(`- ${bullet.label}: ${bl.join('; ')}`);
    }
    disposition[section.id] = lines.length > 0 ? 'content' : SILENT;
    if (lines.length > 0) rendered.push({ section, lines });
    continue;
  }

  if (isSilent(value)) {
    if (section.required) {
      fail(
        `section "${section.id}" is required and may not be "none" — ${section.prompt}. ` +
          'There an absence reads as work skipped, not as nothing to say.',
      );
    }
    disposition[section.id] = SILENT;
    continue;
  }
  const lines = toLines(value);
  if (lines.length === 0) {
    emptied.push({ id: section.id, required: !!section.required, prompt: section.prompt });
    continue;
  }
  // A section may declare that its content has to be a QUESTION. `prompt` could
  // not carry this: it is shown only when a value is missing, so a section filled
  // with the wrong KIND of content never met it.
  if (section.requiresQuestion && !lines.join(' ').includes('?')) {
    // …UNLESS it is satisfied by a queue item, which is the one other route by
    // which a question genuinely reaches the owner. Verified, not trusted: the
    // cited key must resolve to an item that is genuinely open in the queue, so
    // a key naming nothing (or naming something already answered) is refused
    // rather than accepted as a shortcut around asking.
    if (section.acceptsQueueItem) {
      const queue = queueItemVerdict(root, lines.join(' '));
      if (queue.ok) {
        disposition[section.id] = 'content';
        rendered.push({ section, lines: lines.map((l) => (l.startsWith('- ') ? l : `- ${l}`)) });
        continue;
      }
      fail(`section "${section.id}": ${section.requiresQuestion}\n\n${queue.detail}`);
    }
    fail(`section "${section.id}": ${section.requiresQuestion}`);
  }
  // …and it may declare that its content is a LIST. A string renders as one
  // bullet, which is right for a section that says one thing and wrong for the
  // ones the owner acts on item by item.
  if (section.itemized && !Array.isArray(value)) {
    fail(`section "${section.id}": ${section.itemized}`);
  }
  disposition[section.id] = 'content';
  rendered.push({ section, lines: lines.map((l) => (l.startsWith('- ') ? l : `- ${l}`)) });
}

if (missing.length > 0) {
  fail(
    'every section must be stated, so an omission in the report is a decision and not a skipped ' +
      `step. Give a value or the literal "none" for:\n  - ${missing.join('\n  - ')}`,
  );
}
if (emptied.length > 0) {
  // Split by disposition. Telling a REQUIRED section to write "none" is the
  // advice `--template` used to walk every agent into: the blank template ships
  // `[""]` for verification and landed, and the old single message answered that
  // with the one word those two sections are the only ones forbidden to use.
  const req = emptied.filter((e) => e.required);
  const opt = emptied.filter((e) => !e.required);
  const parts = [];
  if (req.length > 0) {
    parts.push(
      'required section(s) left EMPTY. These take neither an empty value nor "none" — there an ' +
        'absence reads as work skipped, not as nothing to say. Fill in:\n  - ' +
        req.map((e) => `${e.id} — ${e.prompt}`).join('\n  - '),
    );
  }
  if (opt.length > 0) {
    parts.push(
      `empty value(s) for: ${opt.map((e) => e.id).join(', ')}. Write the literal "none" to fall ` +
        'silent on purpose — an empty string or array is indistinguishable from forgetting.',
    );
  }
  fail(parts.join('\n\n'));
}

// ── readiness: fix it BEFORE the report describes it ─────────────────────────
// The Stop challenge runs the same checks, but a Stop hook can only speak after
// a report exists — so discovering these there means rendering twice, and the
// first report was wrong when it was written. Same module, earlier boundary.
const notReady = closeoutReadinessFindings(root);
if (notReady.length > 0) {
  fail(
    'not ready to hand back — fix these first, then render ONCE:\n  - ' +
      notReady.join('\n  - ') +
      '\n\nThese are deterministic and would be raised at Stop anyway; catching them here is what ' +
      'stops the report being written twice.',
  );
}

// ── render ───────────────────────────────────────────────────────────────────
// ── the sprint's commit range, DERIVED before it is authored ────────────────
//
// `--start` is the author-supplied fallback. The PRIMARY source is the
// SessionStart record (`starting_head` — see `readSessionStartingHead` in
// scripts/shared/sessionRegistry.mjs), because which commits a sprint landed is
// a fact the repository already holds at the moment the session opens, and a
// value the author types at the end is a second copy of it. That is the same
// defect class as any hand-written state: it drifts, and nothing compares it.
//
// The record is read for THIS session (`CLAUDE_SESSION_ID`), and the range is
// still computed against the LIVE HEAD — so a record left over from an earlier
// session yields a wrong RANGE, never a wrong list: whatever `git log` prints
// is genuinely in that range.
const sessionStartingHead =
  startCommit === '' && SESSION_ID ? readSessionStartingHead(root, SESSION_ID) : null;
const rangeBase = startCommit || sessionStartingHead || '';

const out = ['## Sprint closeout', ''];
for (const { section, lines } of rendered) {
  out.push(`### ${section.heading}`, ...lines, '');
}
if (rangeBase) {
  // Derived, never authored: this is the one part of the report the author
  // cannot phrase. A range that disagrees with what `landed` claims is exactly
  // the discrepancy a reader should see without re-running git.
  const range = git(['log', '--oneline', `${rangeBase}..HEAD`]);
  if (!range.ok) {
    fail(
      `--start ${rangeBase}: git could not resolve ${rangeBase}..HEAD. Pass the sprint's ` +
        `start commit (\`/start-lap\` records it in .claude/lap-start.json).`,
    );
  }
  const commits = range.stdout.split(/\r?\n/).filter(Boolean);
  const provenance =
    startCommit === '' ? `derived from this session's starting HEAD \`${rangeBase}\``
      : `derived from \`${rangeBase}..HEAD\``;
  out.push(
    `### Commits in this sprint (${provenance})`,
    ...(commits.length > 0
      ? commits.map((c) => `- ${c}`)
      : ['- none — HEAD is unchanged since the sprint started']),
    '',
  );
}
const markdown = out.join('\n').trimEnd() + '\n';

// ── record, bound to the worktree CONTENT ────────────────────────────────────
// `tree` is the identity the Stop gate compares. `head` is kept for a human
// reading the record and for pre-v2 fallback, never as the binding: the closeout
// commits its own HANDOFF/backlog/memory updates, and a HEAD-bound record is
// invalidated by the very commit it describes.
const head = git(['rev-parse', 'HEAD']);
// Anchors let the Stop gate tell a report that was RENDERED from one that
// actually REACHED the owner. The renderer writes to stdout, which in an agent
// host is a TOOL RESULT — shown to the agent, not reliably to the person. So an
// agent could satisfy every check here, then summarise the report instead of
// pasting it, and the owner would end a sprint having seen no hand-back at all.
// Two lines the renderer alone produces: the title, and the last heading it
// emitted. Both present in one assistant message means the body between them was
// pasted; checking only these two cannot false-red a genuine full paste.
const lastHeading = rendered.length > 0 ? rendered[rendered.length - 1].section.heading : null;
const record = {
  version: 2,
  tree: worktreeTree(root),
  head: head.ok ? head.stdout : null,
  rendered_at: new Date().toISOString(),
  session_id: SESSION_ID || null,
  report_anchors: lastHeading ? ['## Sprint closeout', `### ${lastHeading}`] : [],
  disposition,
  silent_sections: Object.entries(disposition)
    .filter(([, d]) => d === SILENT)
    .map(([id]) => id),
};
// ONE FILE PER SESSION. The record used to be one repo-global `latest.json`,
// which made it last-writer-wins across concurrent sessions: a session that had
// rendered nothing could read a sibling's record as its own. With no session id
// there is nothing to key on, so the old repo-global path is kept as the
// fallback — and the Stop gate, which reads by session id, will not accept it.
// That is the correct direction: an unattributable render is not evidence that
// a given session rendered.
try {
  mkdirSync(STATE_DIR, { recursive: true });
  const recordPath = join(STATE_DIR, SESSION_ID ? `${SESSION_ID}.json` : 'latest.json');
  writeFileSync(recordPath, JSON.stringify(record, null, 2) + '\n', 'utf8');
  if (SESSION_ID) {
    // A legacy record beside it predates the split and names no session; leaving
    // it in place would let a reader that has not been updated find a stale
    // render where it expects the current one. Best-effort: a removal fault must
    // not swallow an otherwise-complete report.
    try {
      rmSync(join(STATE_DIR, 'latest.json'), { force: true });
    } catch {
      /* the report is the deliverable; the stale file is not fatal */
    }
  }
} catch {
  // The record is evidence for the Stop challenge, never a precondition of the
  // report itself — a state-dir fault must not swallow a rendered closeout.
}

process.stdout.write(markdown);
