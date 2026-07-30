// Shared state for the nightly maintenance routine: the open-items file, the
// durable decisions ledger, and the subject key that ties them together.
//
// THE PROBLEM THIS MODULE EXISTS TO SOLVE.
// The previous doc-review routine had no durable home for an ANSWER. Its
// clear-on-apply ledger was keyed by the findings-file commit SHA and expired
// the moment the nightly regenerated that file, so a question the owner
// answered — but whose answer produced no doc edit ("keep it as it is") — came
// back every single night. Answered-and-still-asked is what trains the owner to
// ignore the channel, which then hides the items that DO matter.
//
// The fix is the subject key: a decision is recorded against the SUBJECT it was
// about (a doc path plus the normalized prose in question), not against the
// wording of that night's question or the file it was reported in. A settled
// subject is never re-asked. If the underlying prose is later edited, the key
// changes and the question legitimately returns — the same "a reword is a new
// item" rule the doc-review ledger already used, applied to the durable side.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const DECISIONS_RELPATH = '.claude/nightly-decisions.json';
export const OPEN_ITEMS_RELPATH = '.audit-tools/nightly/open-items.json';
// The answering surface is a TRACKED markdown file, not an HTML page.
//
// It was an HTML digest plus a localhost server (`npm run nightly:review`),
// because a file:// page cannot persist a click without one. That reasoning was
// sound and still is — it was the QUESTION that was wrong. Answering does not
// need buttons; it needs to be async, easy, and reachable from wherever the
// owner happens to be. A tracked markdown file with checkboxes is all three: it
// opens in any editor, it is answerable from GitHub's web UI on a phone, it
// diffs and syncs across machines like everything else in the repo, and it
// needs no server, no browser, and no ceremony. Deleting the HTML renderer and
// the server removed ~560 lines and one whole class of "is the server running"
// friction.
export const INBOX_RELPATH = 'docs/nightly-inbox.md';
export const VIEWED_RELPATH = '.audit-tools/nightly/last-viewed.json';

// The three legs of one nightly run. A leg is the KIND of work an item came
// from; it decides which section of the digest the item lands in and which
// autonomy rule governed it.
export const LEGS = ['docs', 'backlog', 'solutions'];

export const LEG_TITLES = {
  docs: 'Documentation',
  backlog: 'Backlog disambiguation',
  solutions: 'Recurring-problem solutions',
};

// Collapse whitespace and case so trivial reflow does not read as a new subject.
// Deliberately NOT stripping punctuation: a claim that gains a "not" is a
// different claim and must re-surface.
export function normalizeSubject(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// Identity of the THING under question — `<path>::<normalized subject>`.
// A printable "::" separator, never a control byte: this repo's control-byte
// guard exists because those land raw in source and turn the file binary.
export function subjectKey(path, subject) {
  const material = `${String(path ?? '').replace(/\\/g, '/')}::${normalizeSubject(subject)}`;
  return createHash('sha1').update(material, 'utf8').digest('hex').slice(0, 16);
}

function readJson(file, fallback) {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    return data && typeof data === 'object' ? data : fallback;
  } catch {
    return fallback; // absent / malformed → default, never throw
  }
}

function writeJson(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

export function decisionsPath(root) {
  return join(root, DECISIONS_RELPATH);
}

export function readDecisions(root) {
  return readJson(decisionsPath(root), {});
}

// Record the owner's answer for a subject. Permanent by design — this is the
// mechanism that stops a settled question from being asked again, so it must
// NOT expire with a run, a findings file, or a branch.
export function recordDecision(root, key, { answer, disposition, subject, path, note } = {}) {
  if (!key) throw new Error('recordDecision: a subject key is required');
  const decisions = readDecisions(root);
  const prior = decisions[key];
  decisions[key] = {
    disposition: disposition || 'settled',
    answer: answer ?? '',
    subject: subject ?? prior?.subject ?? '',
    path: path ?? prior?.path ?? '',
    ...(note ? { note } : {}),
    // Completion is carried forward, never reset by a re-answer: an owner
    // clarifying an answer must not silently un-land work that already shipped.
    ...(prior?.completed_at ? { completed_at: prior.completed_at, completed_ref: prior.completed_ref ?? '' } : {}),
    decided_at: new Date().toISOString(),
  };
  writeJson(decisionsPath(root), decisions);
  return decisions;
}

/**
 * Mark a settled subject's WORK as landed. Separate from `recordDecision`
 * because answering and doing are separate acts, and conflating them is what
 * made twelve answered items invisible on 2026-07-28: `--list` reported "No
 * open nightly items" while none of their work existed.
 *
 * `ref` is whatever makes the claim checkable later — a commit sha, a PR, or a
 * short "verified already true at HEAD".
 */
export function recordCompletion(root, key, ref) {
  const decisions = readDecisions(root);
  const entry = decisions[key];
  if (!entry) throw new Error(`recordCompletion: no settled subject "${key}"`);
  decisions[key] = {
    ...entry,
    completed_at: new Date().toISOString(),
    completed_ref: String(ref ?? '').trim(),
  };
  writeJson(decisionsPath(root), decisions);
  return decisions;
}

// Completion tracking began on this date. Everything settled BEFORE it has no
// completion record and never could have — its work may well have shipped. Those
// are reported as a count, not enumerated: listing 70 unknowable subjects as
// outstanding is a false RED, which trains the reader to skip the list exactly
// like the false GREEN it replaced.
export const COMPLETION_TRACKING_SINCE = '2026-07-28';

/**
 * Subjects the owner has ANSWERED but whose work is not recorded as landed —
 * the class the ledger used to hide entirely.
 *
 * `wontfix` and `question` are excluded for opposite reasons: a wontfix has no
 * work to land by definition, and a `question` was never an answer at all — it
 * stays in the open list instead.
 *
 * Returns `{ actionable, grandfathered }`: actionable was settled under
 * completion tracking and genuinely has no landing record; grandfathered
 * predates the mechanism and is a count only.
 */
export function answeredNotDone(decisions, since = COMPLETION_TRACKING_SINCE) {
  const pending = Object.entries(decisions ?? {})
    .filter(([, d]) => d && d.disposition === 'settled' && !d.completed_at)
    .map(([key, d]) => ({ key, ...d }));
  const actionable = [];
  const grandfathered = [];
  for (const d of pending) {
    // Absent/unparseable `decided_at` is treated as OLD, never as actionable: a
    // malformed record must not manufacture work.
    const at = typeof d.decided_at === 'string' ? d.decided_at.slice(0, 10) : '';
    (at && at >= since ? actionable : grandfathered).push(d);
  }
  return { actionable, grandfathered };
}

export function readOpenItems(root) {
  const data = readJson(join(root, OPEN_ITEMS_RELPATH), null);
  if (!data) return { generated_at: null, run: null, items: [], applied: [], skipped: [] };
  return {
    generated_at: data.generated_at ?? null,
    run: data.run ?? null,
    items: Array.isArray(data.items) ? data.items : [],
    applied: Array.isArray(data.applied) ? data.applied : [],
    skipped: Array.isArray(data.skipped) ? data.skipped : [],
  };
}

// ---------------------------------------------------------------------------
// Premise probes (determination ea4e616f). An item's premise is a fact about
// the CODE, but the queue holds the item until it is ANSWERED — a fact about
// the conversation. Nothing used to re-test the premise in between, so on
// 2026-07-25 fifteen of twenty-one surfaced items were already fixed at HEAD.
// A probe pins the premise mechanically: the literal strings the item quotes,
// verified at CREATION (the premise must be true when the item is written) and
// re-evaluated at PRESENTATION (a premise that vanished closes the item as
// resolved instead of asking the owner). Accepted trade-offs, decided with the
// determination: a rename mis-closes, a partial fix mis-holds.

/**
 * Evaluate one item's probes against the tree at `root`.
 * Returns `{ status, probes }` where status is:
 *   'unprobed'  — no well-formed probes (legacy item; never auto-closed)
 *   'resolved'  — every probe string is ABSENT (missing file counts: deleted
 *                 code IS a vanished premise)
 *   'open'      — at least one probe still present, or a read failed for any
 *                 reason other than the file being absent (fail-open:
 *                 infrastructure trouble must never auto-close an item)
 */
export function evaluateProbes(root, item) {
  const raw = Array.isArray(item?.premise_probes) ? item.premise_probes : [];
  const probes = raw.filter(
    (p) =>
      p &&
      typeof p.file === 'string' &&
      p.file.trim() !== '' &&
      typeof p.contains === 'string' &&
      p.contains.trim() !== '',
  );
  if (probes.length === 0) return { status: 'unprobed', probes: [] };

  const evaluated = probes.map((p) => {
    let state;
    try {
      state = readFileSync(join(root, p.file), 'utf8').includes(p.contains) ? 'present' : 'absent';
    } catch (err) {
      state = err && err.code === 'ENOENT' ? 'absent' : 'error';
    }
    return { file: p.file, contains: p.contains, state };
  });

  if (evaluated.some((p) => p.state === 'error')) return { status: 'open', probes: evaluated };
  const status = evaluated.every((p) => p.state === 'absent') ? 'resolved' : 'open';
  return { status, probes: evaluated };
}

// Persist this run's items, carrying `first_seen` forward from the previous run
// so `nights_open` is real. An item that has been open for many nights is the
// signal the old channel destroyed by repeating everything identically: it means
// either the owner cannot action it as posed, or it should never have been
// asked. The digest surfaces that count rather than hiding it in repetition.
//
// Every item must carry PASSING premise probes: a probe that fails at write
// time means the premise is not true at HEAD — the item is either mis-quoted
// or describes something already fixed (a carried-over item whose premise
// vanished overnight is the second case: drop it as resolved, don't re-write
// it). Refusal is the load-bearing half; without it a probe-less item would
// ride the store forever immune to auto-close.
export function writeOpenItems(root, { items, applied = [], skipped = [], run = null }) {
  for (const item of items) {
    const raw = Array.isArray(item?.premise_probes) ? item.premise_probes : [];
    const { status, probes } = evaluateProbes(root, item);
    if (probes.length === 0) {
      throw new Error(
        `writeOpenItems: item "${item?.id ?? '(no id)'}" carries no premise_probes ` +
          `(need [{file, contains}, ...] quoting literal strings from the code the item is about; ` +
          `${raw.length > 0 ? 'the probes present are malformed' : 'none were supplied'})`,
      );
    }
    const failing = probes.filter((p) => p.state !== 'present');
    if (failing.length > 0) {
      const detail = failing.map((p) => `${p.file} [${p.state}] "${p.contains.slice(0, 60)}"`).join('; ');
      throw new Error(
        `writeOpenItems: item "${item?.id ?? '(no id)'}" has a premise probe that does not pass at HEAD ` +
          `(${detail}). The premise must be TRUE at creation (status here: ${status}). ` +
          `If this item was carried from a previous run, its premise is gone — drop it as resolved. ` +
          `Otherwise fix the probe to quote the exact current text.`,
      );
    }
  }

  const previous = readOpenItems(root);
  const seenBefore = new Map(previous.items.map((it) => [it.subject_key, it]));
  const today = new Date().toISOString().slice(0, 10);

  const merged = items.map((item) => {
    const prior = seenBefore.get(item.subject_key);
    const firstSeen = item.first_seen ?? prior?.first_seen ?? today;
    return {
      ...item,
      first_seen: firstSeen,
      nights_open: nightsBetween(firstSeen, today),
    };
  });

  const payload = {
    generated_at: new Date().toISOString(),
    run,
    items: merged,
    applied,
    skipped,
  };
  writeJson(join(root, OPEN_ITEMS_RELPATH), payload);
  return payload;
}

export function nightsBetween(fromDate, toDate) {
  const a = Date.parse(`${fromDate}T00:00:00Z`);
  const b = Date.parse(`${toDate}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 1;
  return Math.max(1, Math.round((b - a) / 86_400_000) + 1);
}

// Drop items whose subject the owner has already settled, and — when a `root`
// is supplied — items whose premise probes have all vanished from the tree
// (the code the item is about no longer exists, so there is nothing to ask).
// Returns every bucket so a caller can REPORT what it suppressed rather than
// silently swallowing it: `{ open, settled, resolved }`.
export function partitionBySettled(items, decisions, root) {
  const open = [];
  const settled = [];
  const resolved = [];
  for (const item of items) {
    const decision = item.subject_key ? decisions[item.subject_key] : undefined;
    // A `question` disposition is the owner asking something BACK, not an
    // answer — the item stays open. Recording those as settled is how two of
    // the eighteen determinations on 2026-07-28 became unaskable while
    // carrying no executable answer.
    if (decision && decision.disposition !== 'question') {
      settled.push(item);
    } else if (root && evaluateProbes(root, item).status === 'resolved') {
      // Presentation-time premise check: probe-less legacy items come back
      // 'unprobed' and stay open; read errors come back 'open' (fail-open).
      resolved.push(item);
    } else {
      open.push(item);
    }
  }
  return { open, settled, resolved };
}

export function readViewed(root) {
  return readJson(join(root, VIEWED_RELPATH), { viewed_at: null, keys: [] });
}

export function recordViewed(root, keys) {
  writeJson(join(root, VIEWED_RELPATH), { viewed_at: new Date().toISOString(), keys: [...new Set(keys)] });
}
