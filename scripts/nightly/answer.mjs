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
//   node scripts/nightly/answer.mjs --list                 # show open ids
//   node scripts/nightly/answer.mjs --settled              # show settled subjects
import { readOpenItems, readDecisions, recordDecision, partitionBySettled, DECISIONS_RELPATH } from './items.mjs';

const ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const argv = process.argv.slice(2);

function fail(message) {
  console.error(message);
  process.exit(1);
}

const state = readOpenItems(ROOT);
const decisions = readDecisions(ROOT);
const { open } = partitionBySettled(state.items, decisions);

if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
  console.log(
    'Usage:\n' +
      '  node scripts/nightly/answer.mjs <ID> "the answer"\n' +
      '  node scripts/nightly/answer.mjs <ID> --wontfix "why"\n' +
      '  node scripts/nightly/answer.mjs --list | --settled',
  );
  process.exit(0);
}

if (argv[0] === '--list') {
  if (open.length === 0) {
    console.log('No open nightly items.');
    process.exit(0);
  }
  for (const item of open) {
    console.log(`${item.id}\t[${item.leg}]\t${item.nights_open}n\t${item.title}`);
  }
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

const rest = argv.slice(1);
const wontfixAt = rest.indexOf('--wontfix');
const disposition = wontfixAt !== -1 ? 'wontfix' : 'settled';
const answer = (wontfixAt !== -1 ? rest.slice(wontfixAt + 1) : rest).join(' ').trim();

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

console.log(`Settled ${item.id} (${disposition}) → ${DECISIONS_RELPATH}`);
console.log(`  subject: ${item.path || '(no path)'} — ${item.title}`);
console.log('  This subject will not be raised again unless the underlying prose changes.');
