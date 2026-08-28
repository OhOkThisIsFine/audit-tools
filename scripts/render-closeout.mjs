#!/usr/bin/env node
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
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLOSEOUT_SECTIONS } from './closeout-sections-data.mjs';
import { closeoutReadinessFindings } from './shared/closeoutReadiness.mjs';
import { worktreeTree } from './shared/worktree-tree.mjs';

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const STATE_DIR = join(root, '.claude', 'hooks', '.state', 'closeout-render');
const SILENT = 'none';

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
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--in') inPath = argv[++i] ?? '';
  else if (a === '--template') templateOnly = true;
  else if (a === '--help' || a === '-h') {
    console.log('usage: render-closeout.mjs --in <closeout.json|-> | --template');
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
    fail(`section "${section.id}": ${section.requiresQuestion}`);
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
const out = ['## Sprint closeout', ''];
for (const { section, lines } of rendered) {
  out.push(`### ${section.heading}`, ...lines, '');
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
  session_id: process.env.CLAUDE_SESSION_ID ?? null,
  report_anchors: lastHeading ? ['## Sprint closeout', `### ${lastHeading}`] : [],
  disposition,
  silent_sections: Object.entries(disposition)
    .filter(([, d]) => d === SILENT)
    .map(([id]) => id),
};
try {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(join(STATE_DIR, 'latest.json'), JSON.stringify(record, null, 2) + '\n', 'utf8');
} catch {
  // The record is evidence for the Stop challenge, never a precondition of the
  // report itself — a state-dir fault must not swallow a rendered closeout.
}

process.stdout.write(markdown);
