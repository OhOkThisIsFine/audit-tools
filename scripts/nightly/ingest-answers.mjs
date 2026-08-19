#!/usr/bin/env node
//
// Read the owner's ticked boxes out of the tracked markdown inbox and record
// them in the durable decisions ledger.
//
// This is the half that makes answering ASYNC: the owner edits a file whenever
// and wherever, and the next agent to start here turns those edits into ledger
// entries and does the work. Nothing has to be running when they answer.
//
// REFUSAL IS THE POINT. An ambiguous answer is not guessed at — it is reported
// and left in the inbox. Ticking two boxes, or ticking Other/Won't fix/Ask back
// with an empty note, records NOTHING for that item: an empty settle would
// suppress a question while capturing no reason, which is the shape that makes a
// ledger useless a month later (see `docs/nightly-routine.md`, "Why a settled
// question stays settled"). Every other item in the file still applies — one
// malformed answer never blocks the rest.
//
// Usage:
//   node scripts/nightly/ingest-answers.mjs [--root <repo>] [--dry-run]
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { recordDecision, readOpenItems, INBOX_RELPATH } from './items.mjs';
import { MARKER_RE, CITATION_EXEMPT_RE, writeInbox } from './render-inbox.mjs';

const TICK_RE = /^\s*-\s*\[([ xX])\]\s*\*\*(.+?)\*\*\s*(?:—\s*([\s\S]*?))?$/;

/**
 * Drop the renderer's citation-exempt markers before parsing. An option line
 * quoting a code path carries one (the gate reads per line), and a numbered
 * option's recorded answer is the prose rendered beside it — so without this the
 * gate scaffolding would be recorded verbatim into the durable ledger.
 */
const stripExempt = (line) => line.replace(CITATION_EXEMPT_RE, '');

/** Pull the ```notes fenced block out of an item body. */
export function extractNote(block) {
  const m = block.match(/```notes\r?\n([\s\S]*?)```/);
  return m ? m[1].trim() : '';
}

/**
 * Parse one item block into a decision, or into a refusal explaining why not.
 * Returns { key, disposition, answer } | { key, error }.
 */
export function parseItemBlock(key, block) {
  const ticked = [];
  for (const rawLine of block.split(/\r?\n/)) {
    const m = stripExempt(rawLine).match(TICK_RE);
    if (!m) continue;
    if (m[1] === ' ') continue;
    ticked.push({ label: m[2].trim(), answer: (m[3] ?? '').trim() });
  }

  if (ticked.length === 0) return null; // unanswered — not an error
  if (ticked.length > 1) {
    return { key, error: `${ticked.length} boxes ticked (${ticked.map((t) => t.label).join(', ')}) — tick exactly one` };
  }

  const choice = ticked[0];
  const note = extractNote(block);
  const label = choice.label.replace(/^\d+\.\s*/, '');

  if (/^Won't fix$/i.test(label)) {
    if (!note) return { key, error: `"Won't fix" ticked with an empty Notes block — a settle with no reason records nothing usable` };
    return { key, disposition: 'wontfix', answer: note };
  }
  if (/^Ask back$/i.test(label)) {
    if (!note) return { key, error: `"Ask back" ticked with an empty Notes block — write the question you are asking back` };
    return { key, disposition: 'question', answer: note };
  }
  if (/^Other$/i.test(label)) {
    if (!note) return { key, error: `"Other" ticked with an empty Notes block — that is where the answer goes` };
    return { key, disposition: 'settled', answer: note };
  }

  // A numbered option: its recorded answer is the prose rendered beside it, so
  // the ledger keeps the exact wording the owner agreed to rather than a label.
  if (!choice.answer) return { key, error: `option "${label}" carries no answer text — the inbox render is malformed, re-render it` };
  return { key, disposition: 'settled', answer: choice.answer, note };
}

/** Split the inbox into { key -> block } using the rendered anchors. */
export function splitBlocks(text) {
  const blocks = new Map();
  const marks = [...text.matchAll(MARKER_RE)];
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].index + marks[i][0].length;
    const end = i + 1 < marks.length ? marks[i + 1].index : text.length;
    blocks.set(marks[i][1], text.slice(start, end));
  }
  return blocks;
}

export function ingestAnswers(root, { dryRun = false } = {}) {
  const path = join(root, INBOX_RELPATH);
  if (!existsSync(path)) return { recorded: [], errors: [], unanswered: 0, missing: true };

  const text = readFileSync(path, 'utf8');
  const blocks = splitBlocks(text);
  const byKey = new Map((readOpenItems(root).items ?? []).map((i) => [i.subject_key, i]));

  const recorded = [];
  const errors = [];
  let unanswered = 0;

  for (const [key, block] of blocks) {
    const parsed = parseItemBlock(key, block);
    if (parsed === null) { unanswered++; continue; }
    if (parsed.error) { errors.push(parsed); continue; }

    const item = byKey.get(key);
    if (!dryRun) {
      recordDecision(root, key, {
        answer: parsed.answer,
        disposition: parsed.disposition,
        subject: item?.subject,
        path: item?.path,
        note: parsed.note,
      });
    }
    recorded.push({ key, id: item?.id ?? key, disposition: parsed.disposition, answer: parsed.answer });
  }

  // Re-render so answered items drop out and the file reflects what is left. A
  // 'question' disposition deliberately stays open, so it comes back.
  if (!dryRun && recorded.length > 0) writeInbox(root);

  return { recorded, errors, unanswered, missing: false };
}

if (process.argv[1] && process.argv[1].endsWith('ingest-answers.mjs')) {
  const args = process.argv.slice(2);
  const rootIdx = args.indexOf('--root');
  const root = rootIdx >= 0 ? args[rootIdx + 1] : process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const res = ingestAnswers(root, { dryRun: args.includes('--dry-run') });

  if (res.missing) {
    console.log(`nightly: no inbox at ${INBOX_RELPATH} — nothing to ingest.`);
    process.exit(0);
  }
  for (const r of res.recorded) {
    console.log(`recorded ${r.id} [${r.disposition}] ${r.answer.slice(0, 90)}${r.answer.length > 90 ? '…' : ''}`);
  }
  for (const e of res.errors) console.error(`REFUSED ${e.key}: ${e.error}`);
  console.log(
    `nightly ingest: ${res.recorded.length} recorded, ${res.errors.length} refused, ${res.unanswered} still unanswered.`,
  );
  // Refusals are a real failure the caller must see; unanswered items are normal.
  process.exit(res.errors.length > 0 ? 1 : 0);
}
