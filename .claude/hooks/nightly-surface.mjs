#!/usr/bin/env node
//
// SessionStart pointer to the nightly digest. ONE line, and only when something
// is new since the digest was last opened.
//
// This replaces the old doc-review surface hook, which printed the entire
// decision table into every conversation. That failed three ways at once: the
// tables were unreadable in a terminal, the block was big enough to need its own
// clip budget (and to be persisted to a side file as an unexplained one-line
// preview when it overflowed), and it arrived at every session regardless of
// whether the owner was in a position to act — so it became wallpaper.
//
// The digest itself is the channel now (an HTML file the run opens). This hook
// exists only so a session that starts LATER still learns there is something
// waiting. Silent when there is nothing new, which is what keeps it worth
// reading when it does speak.
import {
  readOpenItems,
  readDecisions,
  readViewed,
  recordViewed,
  partitionBySettled,
  answeredNotDone,
  INBOX_RELPATH,
} from '../../scripts/nightly/items.mjs';

const ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();

try {
  const decisions = readDecisions(ROOT);

  // ANSWERED-BUT-NOT-APPLIED comes first, because it is the only state where the
  // agent — not the owner — is the one holding things up. The owner has already
  // done their part; saying "N new items" at them again would be nagging about
  // work they finished.
  const seen = new Set(readViewed(ROOT).keys ?? []);

  // ANSWERED-BUT-NOT-APPLIED, announced AT MOST ONCE per subject.
  //
  // Only `actionable`: the grandfathered subjects predate completion tracking, so
  // their landing state is unknowable and announcing them would be a standing
  // false RED at every session start.
  //
  // The once-only bound is load-bearing, not politeness. Plenty of answers imply
  // NO work — "keep the pin, it is a deliberate anchor" is settled and correct and
  // will never be marked done — so an unbounded "ready to apply" nudge would
  // reappear every session forever. That is the exact failure the subject-key
  // ledger was built to kill, and re-growing it in a new place would be the same
  // bug with a new name. Announced once, the agent has been told; after that the
  // inbox banner and `answer.mjs --list` are where the state lives.
  const { actionable } = answeredNotDone(decisions);
  const freshWork = actionable.filter((d) => !seen.has(`${d.key}:apply`));
  if (freshWork.length > 0) {
    process.stdout.write(
      `nightly: ${freshWork.length} answered item${freshWork.length === 1 ? '' : 's'} ready to apply ` +
        `→ \`node scripts/nightly/ingest-answers.mjs\`, do the work, then record each with ` +
        `\`answer.mjs --done <key> "<ref>"\`\n`,
    );
    recordViewed(ROOT, [...seen, ...actionable.map((d) => `${d.key}:apply`)]);
    process.exit(0);
  }

  const state = readOpenItems(ROOT);
  if (state.items.length === 0) process.exit(0);

  // Passing ROOT makes this the presentation-time premise check: an item whose
  // probe strings have all vanished from the tree is RESOLVED, not surfaced —
  // the fix already landed, so there is nothing to ask.
  const { open, resolved } = partitionBySettled(state.items, decisions, ROOT);

  // NOTHING OPEN => SAY NOTHING. Not even a count of what was auto-closed.
  //
  // This used to print `nightly: 0 open, N auto-closed (premise gone)` whenever
  // the queue emptied by probe rather than by answer — and because the items
  // file is only rewritten by the nightly run, that line then repeated at EVERY
  // session start until the next run, hours later. So the exact moment the owner
  // finished answering and an agent landed the fixes, the channel started
  // nagging about work that was already done. A notification that fires after
  // the action is complete cannot be acted on, which is precisely how the
  // predecessor hook taught everyone to skip it.
  //
  // The auto-close count is not lost: it is reported in the digest, which is
  // where a fact about the queue belongs. This hook exists solely to say "there
  // is something waiting for you", so having nothing waiting is silence.
  if (open.length === 0) process.exit(0);
  const resolvedNote = resolved.length > 0 ? `, ${resolved.length} auto-closed (premise gone)` : '';

  // "New" = a subject the owner has not been shown yet. An item that is merely
  // still open is NOT new — re-announcing it is the nagging this hook was
  // rebuilt to stop. (`seen` was read above, before the apply-nudge.)
  const fresh = open.filter((it) => !seen.has(it.subject_key));
  if (fresh.length === 0) process.exit(0);

  const stuck = open.filter((it) => Number(it.nights_open) >= 5).length;
  const legs = [...new Set(fresh.map((it) => it.leg))].join(', ');

  process.stdout.write(
    `nightly: ${fresh.length} new item${fresh.length === 1 ? '' : 's'} (${legs})` +
      `${open.length > fresh.length ? `, ${open.length} open total` : ''}` +
      `${stuck > 0 ? `, ${stuck} open 5+ nights` : ''}` +
      resolvedNote +
      ` → answer by ticking a box in ${INBOX_RELPATH}\n`,
  );

  // Announced once. Every currently-open subject is marked seen — not just the
  // fresh ones — so an item that stays open does not re-announce every session.
  // Its persistence is reported in the digest (the `open N nights` count), which
  // is where a stuck item belongs; repeating it here is what stopped the old
  // channel from being read at all.
  recordViewed(ROOT, open.map((it) => it.subject_key));
} catch {
  /* a notification must never block session start */
}
process.exit(0);
