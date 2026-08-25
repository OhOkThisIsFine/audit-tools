#!/usr/bin/env node
//
// Settle a nightly-routine item: record the owner's answer against the item's
// SUBJECT so the question is never asked again.
//
// This is the counterpart to the old `doc-review-resolve.mjs`, and the
// difference is the whole point. That command recorded "I saw this" against the
// findings-file SHA, which expired the next time the routine regenerated that
// file — so an answered question came back forever unless the answer happened to
// produce a doc edit. This records the ANSWER against the subject, permanently.
// "Leave it as it is" becomes a representable, durable outcome.
//
// Usage:
//   node scripts/nightly/answer.mjs <ID> "the answer"      # settle one item
//   node scripts/nightly/answer.mjs <ID> --wontfix "why"   # settle as not-doing
//   node scripts/nightly/answer.mjs <ID> --question "..."  # an answer that asks BACK — stays open
//   node scripts/nightly/answer.mjs --done <KEY> "<ref>"   # the answered work LANDED
//   node scripts/nightly/answer.mjs --list                 # open ids + answered-but-not-done
//   node scripts/nightly/answer.mjs --settled              # show settled subjects
//
// ⚠ ANSWERED IS NOT DONE. Settling records the owner's REPLY; it does not claim
// the work exists. `--list` therefore reports both what is unanswered and what is
// answered-but-unlanded. On 2026-07-28 it said "No open nightly items" while
// twelve answers had no corresponding change anywhere in the tree, because the
// ledger could not tell the two apart — and a settled subject is never re-raised,
// so that work was invisible rather than merely pending.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  readOpenItems,
  readDecisions,
  recordDecision,
  recordCompletion,
  answeredNotDone,
  COMPLETION_TRACKING_SINCE,
  partitionBySettled,
  DECISIONS_RELPATH,
} from './items.mjs';

const ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const argv = process.argv.slice(2);

function fail(message) {
  console.error(message);
  process.exit(1);
}

// CFG-7aa5185c — fail-closed at the CLI boundary too: readDecisions now
// REFUSES (throws) on a malformed ledger rather than degrading to {}, so every
// branch below — --list, --done, --settled, and the default settle path —
// must surface that refusal usably instead of letting an uncaught exception
// (or, before this fix, a silently-empty ledger) stand in for a real answer.
// CFG-7aa5185c — fail-closed at the CLI boundary too: readDecisions now
// REFUSES (throws) on a malformed ledger rather than degrading to {}, so every
// branch below — --list, --done, --settled, and the default settle path —
// must surface that refusal usably instead of letting an uncaught exception
// (or, before this fix, a silently-empty ledger) stand in for a real answer.
let state;
let decisions;
try {
  state = readOpenItems(ROOT);
  decisions = readDecisions(ROOT);
} catch (err) {
  fail(
    `Cannot proceed: the nightly decisions ledger could not be read.\n` +
      `  ${err && err.message ? err.message : String(err)}\n` +
      `This is a REFUSAL, not an empty ledger — recording an answer now would silently overwrite every ` +
      `prior decision. Recovery is manual: inspect the file named above, repair or restore it (e.g. from ` +
      `git history or a backup), then retry.`,
  );
}
const { open, resolved } = partitionBySettled(state.items, decisions, ROOT);

if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
  console.log(
    'Usage:\n' +
      '  node scripts/nightly/answer.mjs <ID> "the answer"\n' +
      '  node scripts/nightly/answer.mjs <ID> --wontfix "why"\n' +
      '  node scripts/nightly/answer.mjs <ID> --question "what you need answered"  (stays OPEN)\n' +
      '  node scripts/nightly/answer.mjs --done <SUBJECT_KEY> "<commit|note>"\n' +
      '  node scripts/nightly/answer.mjs --list | --settled',
  );
  process.exit(0);
}

// An answered decision often implies a CODE fix, and a remediation run in flight
// may already claim the file that fix would touch. Applying into a claimed file
// corrupts the run's workload binding, so the fact has to be in front of the
// reader — otherwise every session re-derives it from the run state by hand, and
// gets it wrong in the over-broad direction (2026-08-23: four items parked, one
// of them for no reason).
//
// This REPORTS the open run's write scope; it never labels an answered item ready
// or blocked. A decision record carries the path its QUESTION was about, which is
// frequently not the file its FIX touches, so a path-match verdict would hand out
// a false READY. The tool supplies the fact and leaves the judgement.
function openRunWriteScope(root) {
  let state;
  try {
    state = JSON.parse(
      readFileSync(join(root, '.audit-tools', 'remediation', 'state.json'), 'utf8'),
    );
  } catch {
    return null; // No run, unreadable state: nothing to say.
  }
  if (!state || typeof state !== 'object') return null;
  if (state.status === 'complete' || state.status === 'closing') return null;

  const TERMINAL = new Set(['resolved', 'resolved_no_change', 'ignored', 'abandoned']);
  const blocks = new Map();
  for (const block of Array.isArray(state?.plan?.blocks) ? state.plan.blocks : []) {
    if (block?.id) blocks.set(block.id, block);
  }

  const rows = [];
  for (const [id, item] of Object.entries(state.items ?? {})) {
    if (TERMINAL.has(item?.status)) continue;
    const files = blocks.get(item?.block_id)?.touched_files;
    rows.push({
      id,
      status: item?.status ?? '(no status)',
      files: Array.isArray(files) ? [...files].sort() : [],
    });
  }
  // Content-derived order, never object-key order.
  rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return rows.length > 0 ? rows : null;
}

if (argv[0] === '--list') {
  const { actionable, grandfathered } = answeredNotDone(decisions);
  if (open.length === 0 && actionable.length === 0) {
    console.log('No open nightly items, and every tracked answer is recorded as done.');
    if (resolved.length > 0) {
      console.log(`(${resolved.length} auto-closed — the code each one quoted is no longer in the tree.)`);
    }
    if (grandfathered.length > 0) {
      console.log(
        `(${grandfathered.length} answered before completion tracking began ${COMPLETION_TRACKING_SINCE} — ` +
          `landing state unknown by construction, not asserted either way.)`,
      );
    }
    process.exit(0);
  }
  console.log(`UNANSWERED (${open.length}):`);
  for (const item of open) {
    console.log(`  ${item.id}\t[${item.leg}]\t${item.nights_open}n\t${item.title}`);
  }
  if (resolved.length > 0) {
    console.log(
      `\nAUTO-CLOSED (${resolved.length}) — the code each item quoted is no longer in the tree, so there is nothing to ask:`,
    );
    for (const item of resolved) {
      console.log(`  ${item.id}\t[${item.leg}]\t${item.title}`);
    }
  }
  // The half the ledger used to hide entirely. Nothing re-raises these: the
  // subject is settled, so the queue is silent about them forever.
  if (actionable.length > 0) {
    console.log(`\nANSWERED, NOT RECORDED AS DONE (${actionable.length}) — nothing will re-raise these:`);
    for (const d of actionable) {
      console.log(`  ${d.key}\t${d.path || '(no path)'}\t${(d.subject || '').slice(0, 70)}`);
    }
    console.log(`\nVerify each against HEAD, then: node scripts/nightly/answer.mjs --done <KEY> "<ref>"`);
    const scope = openRunWriteScope(ROOT);
    if (scope) {
      console.log(
        `
A REMEDIATION RUN IS OPEN — ${scope.length} item(s) still claim a write scope. An answered` +
          ` fix that touches a file below collides with that item's binding; one that does not, does not.`,
      );
      for (const row of scope) {
        console.log(`  ${row.id}	[${row.status}]	${row.files.join(', ') || '(no declared write scope)'}`);
      }
    }
  }
  if (grandfathered.length > 0) {
    console.log(
      `\n(${grandfathered.length} more were answered before completion tracking began ` +
        `${COMPLETION_TRACKING_SINCE}; their landing state is unknown by construction and is NOT claimed. ` +
        `Use --settled to inspect them.)`,
    );
  }
  process.exit(0);
}

if (argv[0] === '--done') {
  const key = argv[1];
  const ref = argv.slice(2).join(' ').trim();
  if (!key) fail('--done needs a SUBJECT KEY (see --list or --settled).');
  if (!ref) fail('--done needs a ref: a commit sha, a PR, or "verified already true at HEAD".');
  try {
    recordCompletion(ROOT, key, ref);
  } catch (err) {
    fail(String(err.message ?? err));
  }
  console.log(`Marked ${key} DONE (${ref}) → ${DECISIONS_RELPATH}`);
  process.exit(0);
}

if (argv[0] === '--settled') {
  const entries = Object.entries(decisions);
  if (entries.length === 0) {
    console.log('No settled subjects yet.');
    process.exit(0);
  }
  for (const [key, d] of entries) {
    console.log(`${key}\t${d.disposition}\t${d.path || '(no path)'}\t${(d.answer || '').slice(0, 80)}`);
  }
  process.exit(0);
}

// A leading `-` is always a flag, never an id — so a mistyped flag can never be
// recorded as a decision about a subject that does not exist.
const id = argv[0];
if (id.startsWith('-')) fail(`Not an item id: "${id}" (a leading "-" is a flag).`);

const item = open.find((it) => it.id === id) || state.items.find((it) => it.id === id);
if (!item) {
  const known = open.map((it) => it.id).join(', ') || '(none open)';
  fail(`Unknown item id "${id}". Open ids: ${known}\nRun --list to see them.`);
}
// The `state.items` fallback deliberately reaches settled AND auto-resolved
// items — re-answering (clarifying) a subject is legitimate. But an answer to
// an auto-closed item should know it is one: the premise is already gone.
if (resolved.some((it) => it.id === id)) {
  console.log(`note: ${id} was auto-closed — the code it quoted is no longer in the tree. Recording anyway.`);
}

const rest = argv.slice(1);
const wontfixAt = rest.indexOf('--wontfix');
// `--question` is an answer that asks something BACK. It is recorded (so the
// exchange is not lost) but does NOT settle the subject, because there is nothing
// executable in it — `partitionBySettled` keeps it in the open list. Two of the
// eighteen determinations on 2026-07-28 were exactly this shape and were filed as
// `settled`, which made them unaskable while carrying no answer anyone could act on.
const questionAt = rest.indexOf('--question');
const flagAt = wontfixAt !== -1 ? wontfixAt : questionAt;
const disposition = wontfixAt !== -1 ? 'wontfix' : questionAt !== -1 ? 'question' : 'settled';
const answer = (flagAt !== -1 ? rest.slice(flagAt + 1) : rest).join(' ').trim();

if (!answer) {
  // An empty answer would suppress the question while recording nothing about
  // why — the exact shape that makes a ledger untrustworthy a month later.
  fail(
    `An answer is required: it is what the routine reads next run.\n` +
      `  node scripts/nightly/answer.mjs ${id} "keep it as it is — the version pin is a deliberate anchor"`,
  );
}

recordDecision(ROOT, item.subject_key, {
  answer,
  disposition,
  subject: item.title,
  path: item.path,
});

console.log(`Recorded ${item.id} (${disposition}) → ${DECISIONS_RELPATH}`);
console.log(`  subject: ${item.path || '(no path)'} — ${item.title}`);
if (disposition === 'question') {
  console.log('  STAYS OPEN: a counter-question is not an answer, so the item is still raised.');
} else if (disposition === 'wontfix') {
  console.log('  This subject will not be raised again unless the underlying prose changes.');
} else {
  console.log('  This subject will not be raised again unless the underlying prose changes.');
  console.log(`  ⚠ Not yet DONE — --list keeps showing it until: --done ${item.subject_key} "<ref>"`);
}
