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
import { compareCodeUnits } from './../shared/primitives.mjs';
import { parseArgv, refusalMessage, USAGE_EXIT } from './../shared/argvGuard.mjs';

const ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const argv = process.argv.slice(2);

// ARGV IS REFUSED, NOT IGNORED. This script's default action writes the durable
// decisions ledger, so a mistyped flag must never be read as an item id or as
// consent to settle something (2026-09-06). `--help`/`-h` print usage rather
// than erroring, so the universal query flag is answered, never performed.
//
// The parsed form is used ONLY for that verdict: the settle path below keeps
// its full argv, because an answer is free prose that may itself begin with a
// dash (`answer.mjs DOC-1 -- "--keep the pin"` is a legitimate answer).
const USAGE = [
  'Usage:',
  '  node scripts/nightly/answer.mjs <ID> "the answer"',
  '  node scripts/nightly/answer.mjs <ID> --wontfix "why"',
  '  node scripts/nightly/answer.mjs <ID> --question "what you need answered"  (stays OPEN)',
  '  node scripts/nightly/answer.mjs --done <SUBJECT_KEY> "<commit|note>"',
  '  node scripts/nightly/answer.mjs --list | --settled',
].join('\n');

/** @returns {never} */
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
        `  ${err && /** @type {any} */ (err).message ? /** @type {any} */ (err).message : String(err)}\n` +
      `This is a REFUSAL, not an empty ledger — recording an answer now would silently overwrite every ` +
      `prior decision. Recovery is manual: inspect the file named above, repair or restore it (e.g. from ` +
      `git history or a backup), then retry.`,
  );
}
const { open, resolved } = partitionBySettled(state.items, decisions, ROOT);

if (argv.length === 0) {
  console.log(USAGE);
  process.exit(0);
}

// One union spec: which flag is present selects the branch below, and the
// variadic tail is the answer (or `--done`'s ref). An unrecognized flag is
// refused rather than absorbed, and the parsed positionals — not raw argv — are
// what the settle path records, so the `--` data separator never lands in the
// answer text.
const parsedArgv = parseArgv(argv, {
  flags: ['--list', '--settled', '--done', '--wontfix', '--question'],
  positionals: Infinity,
});
if (parsedArgv.help) {
  console.log(USAGE);
  process.exit(0);
}
if (!parsedArgv.ok) {
  const refusal = refusalMessage(parsedArgv, {
    name: 'answer',
    usage: 'node scripts/nightly/answer.mjs --help   (prose starting with "-" goes after `--`)',
  });
  if (refusal) process.stderr.write(refusal);
  process.exit(USAGE_EXIT);
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
  rows.sort((a, b) => compareCodeUnits(a.id, b.id));
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
  const key = parsedArgv.positionals[0];
  const ref = parsedArgv.positionals.slice(1).join(' ').trim();
  if (!key) fail('--done needs a SUBJECT KEY (see --list or --settled).');
  if (!ref) fail('--done needs a ref: a commit sha, a PR, or "verified already true at HEAD".');
  try {
    recordCompletion(ROOT, key, ref);
  } catch (err) {
    fail(String(/** @type {any} */ (err).message ?? err));
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

// The id is the FIRST POSITIONAL, so the guard has already refused any flag
// this CLI does not declare — a mistyped flag can never be recorded as a
// decision about a subject that does not exist.
const id = parsedArgv.positionals[0];
if (!id || id.startsWith('-')) {
  fail(`Not an item id: "${id ?? ''}" (a leading "-" is a flag). Run with --help for usage.`);
}

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

// The answer is the variadic tail after the id, with the `--` data separator
// already consumed by the guard — so prose beginning with a dash is carried
// verbatim instead of being read as a flag.
const rest = parsedArgv.positionals.slice(1);
// `--question` is an answer that asks something BACK. It is recorded (so the
// exchange is not lost) but does NOT settle the subject, because there is nothing
// executable in it — `partitionBySettled` keeps it in the open list. Two of the
// eighteen determinations on 2026-07-28 were exactly this shape and were filed as
// `settled`, which made them unaskable while carrying no answer anyone could act on.
const wontfixAt = argv.indexOf('--wontfix');
const questionAt = argv.indexOf('--question');
const disposition = wontfixAt !== -1 ? 'wontfix' : questionAt !== -1 ? 'question' : 'settled';
const answer = rest.join(' ').trim();

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
