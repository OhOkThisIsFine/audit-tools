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
  DIGEST_RELPATH,
} from '../../scripts/nightly/items.mjs';

const ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();

try {
  const state = readOpenItems(ROOT);
  if (state.items.length === 0) process.exit(0);

  const { open } = partitionBySettled(state.items, readDecisions(ROOT));
  if (open.length === 0) process.exit(0);

  // "New" = a subject the owner has not seen in a digest yet. An item that is
  // merely still open is NOT new — re-announcing it is the nagging this hook
  // was rebuilt to stop.
  const seen = new Set(readViewed(ROOT).keys ?? []);
  const fresh = open.filter((it) => !seen.has(it.subject_key));
  if (fresh.length === 0) process.exit(0);

  const stuck = open.filter((it) => Number(it.nights_open) >= 5).length;
  const legs = [...new Set(fresh.map((it) => it.leg))].join(', ');

  process.stdout.write(
    `nightly: ${fresh.length} new item${fresh.length === 1 ? '' : 's'} (${legs})` +
      `${open.length > fresh.length ? `, ${open.length} open total` : ''}` +
      `${stuck > 0 ? `, ${stuck} open 5+ nights` : ''}` +
      ` → review with buttons: \`npm run nightly:review\` (or read ${DIGEST_RELPATH})\n`,
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
