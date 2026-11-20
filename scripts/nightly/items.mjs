// sites-pinned: tests/shared/nightly-items-mandatory-fields.test.ts, tests/shared/nightly-completion-ledger.test.ts, tests/shared/nightly-decision-key.test.ts, tests/shared/nightly-routine.test.ts, tests/shared/nightly-probe-target.test.ts, tests/shared/nightly-probe-retired-doc.test.ts
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
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { writeQueueFile } from './queue-files.mjs';
// Saving a decision refreshes projections of an existing queue.
import { writeInbox } from './render-inbox.mjs';

export const DECISIONS_RELPATH = '.claude/nightly-decisions.json';
export const OPEN_ITEMS_RELPATH = '.audit-tools/nightly/open-items.json';
// The ENUMERABLE projection of the queue — the same items, each reduced to the
// fields an agent needs to act, in a bounded read.
//
// WHY A SECOND FILE AND NOT A SMALLER `items` ARRAY. `open-items.json` is the
// machine contract, and the RENDERER reads it in full: `writeInbox` re-renders
// eli5, question, options and evidence for every item, so trimming the array
// would break rendering. It is one 659-line / 26k-token document that exceeds
// the Read cap, so enumerating it needs a hand-written `node -e` (2026-07-26
// friction walk). Splitting the store would be a larger change with a real
// blast radius; adding a derived, self-describing index beside it makes the
// enumerable form exist without touching what the renderer consumes, and the
// two are written by the same function so they cannot drift.
//
// It is ALSO the answered-state projection: the index holds `partitionBySettled`
// `open` only, so answering an item removes it here on the next write. That is
// the half `answer.mjs --list` already gets right and the raw file does not.
export const OPEN_ITEMS_INDEX_RELPATH = '.audit-tools/nightly/open-items-index.json';
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

// The three legs of one nightly run. A leg is the KIND of work an item came
// from; it decides which section of the digest the item lands in and which
// autonomy rule governed it.
export const LEGS = ['docs', 'backlog', 'solutions'];

export const LEG_TITLES = {
  docs: 'Documentation',
  backlog: 'Backlog disambiguation',
  solutions: 'Recurring-problem solutions',
};

function readJson(file, fallback) {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    return data && typeof data === 'object' ? data : fallback;
  } catch {
    return fallback; // absent / malformed → default, never throw
  }
}

export function decisionsPath(root) {
  return join(root, DECISIONS_RELPATH);
}

// CFG-7aa5185c — FAIL CLOSED. readDecisions has its OWN read path, deliberately
// not built on the permissive readJson() above: readJson conflates "the file
// does not exist" with "the file exists but is not valid JSON", collapsing
// both to the caller's fallback. That conflation is exactly right for the
// REGENERABLE files readJson still serves (open-items.json and its index —
// a bad copy of either is simply rebuilt by the next queue write), but it is wrong for THIS
// file: the decisions ledger is the durable, hand-curated record of every
// owner answer, and a truncated / half-written / merge-conflicted read must
// never be silently treated as "nothing has ever been recorded" — the next
// recordDecision/recordReply/recordCompletion call would then persist a map
// built from that empty fallback straight over the real file, permanently
// destroying every prior decision. So this function REFUSES (throws) on any
// read/parse failure OTHER than the file genuinely not existing, and every
// write path below calls it first with no try/catch of its own: a write
// attempted over an unreadable ledger throws before it ever reaches its own
// writeJson call, so the on-disk file is left byte-for-byte untouched.
export function readDecisions(root) {
  const file = decisionsPath(root);
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    if (err && /** @type {any} */ (err).code === 'ENOENT') return {}; // genuinely nothing recorded yet
    // Any other read failure (permissions, a symlink loop, ...) is refused
    // too — it cannot be told apart from "nothing recorded" and must not be
    // guessed at.
    throw new Error(`readDecisions: could not read ${file}: ${err && /** @type {any} */ (err).message ? /** @type {any} */ (err).message : err}`);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `readDecisions: ${file} exists but is not valid JSON (${err && /** @type {any} */ (err).message ? /** @type {any} */ (err).message : err}). ` +
        `This is the durable nightly decision ledger — refusing to read it as an empty ledger, which would ` +
        `let the next recorded answer silently overwrite every prior decision. Recovery is manual: inspect ` +
        `${file}, repair or restore it (e.g. from git history or a backup), then retry.`,
    );
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`readDecisions: ${file} must contain a decision object.`);
  }
  return data;
}

// The ONE ledger write. The inbox and the queue snapshot are projections of
// this ledger, so a write that skips the render leaves them stale, and the
// commit gate's `check:nightly-inbox` leg then refuses until someone runs
// `render-inbox.mjs` by hand (seen with `answer.mjs --done`, 2026-10-01).
function writeDecisions(root, decisions) {
  writeQueueFile(decisionsPath(root), JSON.stringify(decisions, null, 2) + '\n');
  if (existsSync(join(root, OPEN_ITEMS_RELPATH))) {
    try {
      writeInbox(root);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Decisions saved to ${decisionsPath(root)}. Could not refresh the stored queue: ${reason}. Retry scripts/nightly/render-inbox.mjs with --root ${JSON.stringify(root)}.`, { cause: error });
    }
  }
}

// Record the owner's answer for a subject. Permanent by design — this is the
// mechanism that stops a settled question from being asked again, so it must
// NOT expire with a run, a findings file, or a branch.
/**
 * @param {string} root
 * @param {string} key
 * @param {{answer?: string, disposition?: string, subject?: string, path?: string, note?: string}} [options]
 */
export function recordDecision(root, key, options = {}) {
  return recordDecisions(root, [{ ...options, key }]);
}

// A checked inbox may contain several answers. Save them together before
// replacing its Markdown, including when a prior projection write failed.
export function recordDecisions(root, answers) {
  const decisions = readDecisions(root);
  for (const { key, answer, disposition, subject, path, note } of answers) {
    if (!key) throw new Error('recordDecision: a subject key is required');
    const prior = decisions[key];
    const next = {
      disposition: disposition || 'settled',
      answer: answer ?? '',
      subject: subject ?? prior?.subject ?? '',
      path: path ?? prior?.path ?? '',
      ...(note ? { note } : {}),
    };
    if (prior && prior.note === next.note && Object.entries(next).every(([field, value]) => prior[field] === value)) continue;
    decisions[key] = {
      ...next,
      ...(prior?.completed_at ? { completed_at: prior.completed_at, completed_ref: prior.completed_ref ?? '' } : {}),
      decided_at: new Date().toISOString(),
    };
  }
  writeDecisions(root, decisions);
  return decisions;
}

/**
 * Answer a counter-question, so an `Ask back` becomes a two-way exchange.
 *
 * Without this the loop is one-way: the owner's question is recorded, the item
 * correctly stays open, and then the next render shows the ORIGINAL proposition
 * again with the question nowhere on the page and no channel to reply in. That
 * is not an async conversation, it is a queue that silently drops half the
 * traffic — caught the first time an item was actually asked back.
 *
 * The reply is carried on the decision, not on the item, because the item is
 * regenerated every run while the exchange is the durable part.
 */
export function recordReply(root, key, reply) {
  if (!reply || !String(reply).trim()) {
    throw new Error('recordReply: an empty reply would leave the question looking answered');
  }
  const decisions = readDecisions(root);
  const entry = decisions[key];
  if (!entry) throw new Error(`recordReply: no recorded question "${key}"`);
  decisions[key] = { ...entry, reply: String(reply).trim(), replied_at: new Date().toISOString() };
  writeDecisions(root, decisions);
  return decisions[key];
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
    completed_at: entry.completed_at && entry.completed_ref === String(ref ?? '').trim() ? entry.completed_at : new Date().toISOString(),
    completed_ref: String(ref ?? '').trim(),
  };
  writeDecisions(root, decisions);
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

export function readOpenItems(root, { required = false } = {}) {
  const file = join(root, OPEN_ITEMS_RELPATH);
  let data;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
    if (!Array.isArray(data?.items) || ['applied', 'skipped'].some(key => data[key] !== undefined && !Array.isArray(data[key]))) {
      throw new Error('expected an items array and arrays for any applied or skipped entries');
    }
  } catch (error) {
    if (!required && /** @type {NodeJS.ErrnoException} */ (error)?.code === 'ENOENT') return { generated_at: null, run: null, items: [], applied: [], skipped: [] };
    throw Object.assign(new Error(`Cannot read stored queue ${file}: ${error instanceof Error ? error.message : String(error)}`), { path: file, cause: error });
  }
  return { generated_at: null, run: null, ...data, applied: data.applied ?? [], skipped: data.skipped ?? [] };
}

// ---------------------------------------------------------------------------
// Premise probes (determination ea4e616f; git-history rework per nightly sol-3).
// An item's premise is a fact about the CODE, but the queue holds the item until
// it is ANSWERED — a fact about the conversation. Nothing used to re-test the
// premise in between, so on 2026-07-25 fifteen of twenty-one surfaced items were
// already fixed at HEAD. A probe pins the premise mechanically: the literal
// strings the stored item quotes, re-evaluated when presenting the queue.
//
// Absence is decided with GIT EVIDENCE, never inferred from a failed read
// (2026-07-30: 44% of a model-emitted probe batch named unresolvable bare
// filenames, and ENOENT scored identically to "the code was removed" — a typo
// became the strongest possible claim). The states:
//   'present'  — the named file contains the fragment.
//   'moved'    — the fragment exists in OTHER tracked files (git grep): the
//                premise still holds, the path is stale. Retires the old
//                "a rename mis-closes" concession — a rename now reads open.
//   'absent'   — the named file exists (or existed: deleted with git history)
//                and the fragment is nowhere in the tracked tree. `commit`
//                carries the last commit touching the fragment/path when git
//                can name it, so an auto-close cites checkable evidence.
//   'bad_path' — the path resolves nowhere AND git has no record it ever
//                existed: a malformed probe. Pure no-signal.
//   'unknown'  — the file is missing and history cannot be queried (shallow
//                clone, git unavailable). Fail OPEN.
//   'error'    — a read failed for a reason other than absence. Fail OPEN.
// Remaining accepted trade-off: a partial fix mis-holds; semantic staleness
// (text rewritten, bug remains) still reads as removed.

function gitLines(root, args, { okStatuses = [0] } = {}) {
  const out = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
  });
  if (out.error || !okStatuses.includes(/** @type {number} */ (out.status))) return null; // null = git could not answer
  return out.stdout.split('\n').filter((l) => l.trim() !== '');
}

// Paths the evidence chain cannot reason about. `absent` is the strongest
// verdict this module emits — all-absent is what closes an item — and it is
// justified by GIT evidence: the rename-protection `git grep` and the removal
// citation both search the TRACKED tree. A file git does not track (a
// gitignored runtime artifact under `.audit-tools/`, a build output) can
// therefore only ever fall through to `absent` for reasons that have nothing to
// do with whether the defect was fixed. It must abstain instead.
//
// The RECORD channels are the same error one step earlier: a backlog entry, a
// dated review, HANDOFF, inbox, or persisted nightly queue QUOTES the code it
// is about, so a probe aimed at one is probing the record, not the premise.
// They are excluded from the rename-protection search below for exactly this
// reason.
const RECORD_PATH_PREFIXES = [
  'docs/backlog',
  'docs/reviews',
  'docs/HANDOFF.md',
  'docs/nightly-inbox.md',
  '.audit-tools/nightly',
  '.claude',
];

// The one deliberate hole in the `.claude` ban (owner decision sol-5,
// 2026-08-12): `.claude/hooks/**` is live executable guard source — it has
// contract tests under tests/ and a declared reach registry — so a probe there
// checks the premise itself, not a record quoting it. The carve-out is NARROW:
// every other `.claude` child (decisions ledger, settings, skill write-ups),
// and any FUTURE child, stays a record channel by default.
const RECORD_PATH_EXEMPT_PREFIXES = ['.claude/hooks'];

export function isRecordPath(file) {
  const norm = file.replace(/\\/g, '/').replace(/^\.\//, '');
  if (RECORD_PATH_EXEMPT_PREFIXES.some((p) => norm === p || norm.startsWith(`${p}/`))) {
    return false;
  }
  return RECORD_PATH_PREFIXES.some((p) => norm === p || norm.startsWith(`${p}/`));
}

// The repo-wide move/rename search domain. Exported because the pre-commit
// HANDOFF parity trigger must use the identical domain when deciding whether a
// staged pickaxe change can alter a presentation-time probe verdict.
// Git pathspecs cannot re-include beneath an exclusion, so admitting
// `.claude/hooks` (sol-5) means enumerating the `.claude` record children here
// instead of banning the directory whole. Decay direction if a new `.claude`
// child appears before it is listed: it enters this search domain, so its
// quotes read as 'moved' (items stay open) and the pre-commit parity trigger
// over-fires — both the safe direction, never a mis-close.
export const PREMISE_GREP_PATHSPECS = [
  ':!.audit-tools/nightly',
  ':!docs/backlog',
  ':!docs/nightly-inbox.md',
  ':!docs/reviews',
  ':!docs/HANDOFF.md',
  ':!.claude/nightly-decisions.json',
  ':!.claude/settings.json',
  ':!.claude/skills',
];

// `git ls-files --error-unmatch` exits non-zero for an untracked path, so the
// okStatuses:[0] default already maps "untracked" to null. A git failure is
// indistinguishable from untracked here, which errs toward abstaining — the
// safe direction for a verdict that closes items.
function isTrackedPath(root, file) {
  return gitLines(root, ['ls-files', '--error-unmatch', '--', file]) !== null;
}

function evaluateOneProbe(root, probe) {
  // A record can quote stale code. Its contents cannot establish that the
  // code under discussion changed, so it never closes a stored item.
  if (isRecordPath(probe.file)) return { state: 'untrackable', reason: 'record_path' };
  // An untracked target abstains only when it is untracked AND PRESENT — that
  // is the gitignored runtime artifact this refusal was built for: a file whose
  // content varies per run and so can never be evidence.
  //
  // An untracked path that is also ABSENT from disk is the opposite case, and
  // collapsing the two is what made "retire this doc" unclosable: the doc gets
  // deleted, its path stops being tracked, and the item that ASKED for the
  // deletion abstains forever. Fall through instead — the missing-file chain
  // below already answers this exact question with git evidence, separating
  // 'absent' (history has the file: deleted) from 'bad_path' (no history: a
  // typo'd probe) and yielding to 'moved' when the prose reappears elsewhere.
  // Those three verdicts were unreachable while this check preempted them.
  if (!isTrackedPath(root, probe.file) && existsSync(join(root, probe.file))) {
    return { state: 'untrackable', reason: 'untracked' };
  }

  // Negative form (P12): `{ file, absent }` — the string must NOT be in the
  // file. It expresses the CODE side of a doc-vs-code divergence ("the code
  // does not yet contain X"). It holds while the string stays absent and flips
  // to 'appeared' the moment the string lands — direct-read evidence on a
  // tracked file, no git chain needed (presence is directly observable; only
  // ABSENCE claims need the rename-protection/citation chain below).
  if (typeof probe.absent === 'string') {
    let text = null;
    try {
      text = readFileSync(join(root, probe.file), 'utf8');
    } catch (err) {
      if (!err || /** @type {any} */ (err).code !== 'ENOENT') return { state: 'error' };
      // Tracked but deleted from the worktree: the string is certainly not
      // there — the condition holds.
      return { state: 'holds' };
    }
    return text.includes(probe.absent) ? { state: 'appeared' } : { state: 'holds' };
  }

  let fileText = null;
  /** @type {any} */
  let readErr = null;
  try {
    fileText = readFileSync(join(root, probe.file), 'utf8');
  } catch (err) {
    readErr = err;
  }
  if (fileText !== null) {
    if (fileText.includes(probe.contains)) return { state: 'present' };
  } else if (!readErr || readErr.code !== 'ENOENT') {
    return { state: 'error' };
  }

  // Fragment not in the named file (or file missing). Does it live elsewhere in
  // the tracked tree? git grep -F over the worktree (exit 1 = clean no-match);
  // null (git trouble) fails open as 'unknown' rather than letting an absence
  // claim stand unverified. grep is line-based, so a multi-line fragment is
  // represented by its longest line — a moved fragment's longest line moves
  // with it, and a false 'moved' from a common line errs open, never closed.
  const needle = probe.contains
    .split('\n')
    .map((l) => l.trim())
    .sort((a, b) => b.length - a.length)[0];
  if (!needle) return { state: 'unknown' };
  // The question/record channels QUOTE probe fragments verbatim (a backlog
  // entry quotes the code it is about), so a match there says nothing about
  // the premise — excluded, or every probe would read 'moved' off its own
  // entry and no item could ever close.
  const grepElsewhere = () =>
    gitLines(root, ['grep', '-l', '-F', '-e', needle, '--', ...PREMISE_GREP_PATHSPECS], {
      okStatuses: [0, 1],
    });

  if (fileText !== null) {
    const elsewhere = grepElsewhere();
    if (elsewhere !== null && elsewhere.length > 0) {
      return { state: 'moved', moved_to: elsewhere.slice(0, 5) };
    }
    // File present, fragment nowhere: the direct read IS the absence evidence —
    // git adds rename protection (above) and a citation (below), and when it
    // cannot answer we lose only those extras, not the verdict itself.
    const removal = gitLines(root, ['log', '-1', '--format=%h', '-S', probe.contains, '--', probe.file]);
    return { state: 'absent', commit: removal?.[0] ?? null };
  }

  // File MISSING: git evidence is REQUIRED — without history we cannot tell
  // deleted code from a typo'd path, and the old ENOENT⇒absent inference is
  // exactly what sol-3 retires. History comes BEFORE the moved-grep here:
  // 'moved' is only meaningful for a file that once held the fragment, and
  // consulting the grep for a never-existed path manufactures 'moved' — a
  // live-premise stamp — out of any common fragment (a probe on a typo'd path
  // with the fragment "x" read 'holds' off unrelated text while P22 landed).
  const history = gitLines(root, ['log', '--all', '--full-history', '-1', '--format=%h', '--', probe.file]);
  if (history === null) return { state: 'unknown' };
  if (history.length === 0) return { state: 'bad_path' };
  const elsewhere = grepElsewhere();
  if (elsewhere === null) return { state: 'unknown' };
  if (elsewhere.length > 0) return { state: 'moved', moved_to: elsewhere.slice(0, 5) };
  return { state: 'absent', commit: history[0] };
}

/**
 * Evaluate one item's probes against the tree at `root`.
 * Returns `{ status, probes }` where status is:
 *   'unprobed'  — no well-formed probes (legacy item; never auto-closed)
 *   'resolved'  — EVERY probe is 'absent' with git-backed evidence. A
 *                 'bad_path' / 'unknown' / 'error' / 'moved' probe can never
 *                 contribute to an auto-close.
 *   'open'      — anything else (fail-open).
 *
 */
export function evaluateProbes(root, item) {
  const raw = Array.isArray(item?.premise_probes) ? item.premise_probes : [];
  const wellFormedString = (v) => typeof v === 'string' && v.trim() !== '';
  const probes = raw.filter(
    (p) =>
      p &&
      wellFormedString(p.file) &&
      // Exactly one of the two forms: positive `contains` or negative `absent`.
      (wellFormedString(p.contains) !== wellFormedString(p.absent)),
  );
  // One malformed sibling must not be silently dropped. Otherwise the valid
  // subset can all resolve and close the item even though an omitted probe may
  // still describe a live premise. Persisted legacy corruption therefore
  // degrades to unprobed/open.
  if (probes.length !== raw.length) return { status: 'unprobed', probes: [] };
  if (probes.length === 0) return { status: 'unprobed', probes: [] };

  const evaluated = probes.map((p) => ({
    file: p.file,
    form: wellFormedString(p.absent) ? 'absent' : 'contains',
    ...(wellFormedString(p.absent) ? { absent: p.absent } : { contains: p.contains }),
    ...evaluateOneProbe(root, p),
  }));

  // A divergence item (any negative-form probe) resolves as soon as EITHER side
  // moves: the doc-side string vanished ('absent') or the code-side string
  // landed ('appeared') — the relation the item is about no longer holds
  // either way. A plain positive-only item keeps the original rule: EVERY
  // quoted fragment must have verifiably gone away.
  const hasNegativeForm = evaluated.some((p) => p.form === 'absent');
  const status = hasNegativeForm
    ? (evaluated.some((p) => (p.form === 'absent' ? p.state === 'appeared' : p.state === 'absent'))
      ? 'resolved'
      : 'open')
    : (evaluated.every((p) => p.state === 'absent') ? 'resolved' : 'open');
  return { status, probes: evaluated };
}

/**
 * The ONE actionable target an item names, or null when it names none.
 *
 * `path` is the file the QUESTION is about, which is frequently not the file the
 * FIX touches — so the index reports the target the item itself declares rather
 * than guessing at a fix site, exactly as `answer.mjs --list` refuses to label
 * an item ready or blocked off a path match. What it removes is the second
 * derivation: an answered items' work used to mean re-reading the eli5 to
 * rediscover which file was even meant (2026-07-26 friction walk).
 *
 * `options[0]` is the recorded answer's prose for a numbered option and is
 * deliberately NOT included — an answer is chosen at answer time, not at write
 * time, so pre-selecting one would assert a decision the owner has not made.
 */
function actionableTarget(item) {
  const path = typeof item?.path === 'string' ? item.path.trim() : '';
  return path ? { path } : null;
}

/**
 * The bounded, enumerable projection of the queue: `{ run, count, items: [{ id,
 * leg, path, title, subject_key, nights_open, target }] }`.
 *
 * Every item is reduced to what an agent needs to pick one up and act, which
 * keeps the whole file inside one Read for a queue of any realistic size —
 * the 2026-07-26 walk needed a hand-written `node -e` for exactly this.
 *
 * The index omits timestamps so regeneration from the stored queue and ledger
 * reproduces the same bytes for checkInbox.
 */
export function queueIndex({ items, run = null }) {
  return {
    run,
    count: items.length,
    items: items.map((item) => ({
      id: item.id,
      leg: item.leg,
      path: item.path ?? '',
      title: item.title,
      subject_key: item.subject_key,
      nights_open: item.nights_open ?? 1,
      target: actionableTarget(item),
    })),
  };
}

/** The on-disk form of `queueIndex`, so every writer emits identical bytes. */
export function renderQueueIndex({ items, run = null }) {
  return JSON.stringify(queueIndex({ items, run }), null, 2) + '\n';
}

export function readOpenItemsIndex(root) {
  return readJson(join(root, OPEN_ITEMS_INDEX_RELPATH), { count: 0, items: [] });
}

// Drop items whose subject the owner has already settled, and — when a `root`
// is supplied — items whose premise probes have all vanished from the tree
// (the code the item is about no longer exists, so there is nothing to ask).
// Returns every bucket so a caller can REPORT what it suppressed rather than
// silently swallowing it: `{ open, settled, resolved }`.
const TERMINAL_DECISION_DISPOSITIONS = new Set(['settled', 'wontfix']);

export function partitionBySettled(items, decisions, root) {
  const open = [];
  const settled = [];
  const resolved = [];
  for (const item of items) {
    const decision = item.subject_key ? decisions[item.subject_key] : undefined;
    // A `question` disposition is the owner asking something BACK, not an
    // answer — the item stays open. Recording those as settled is how two of
    // the eighteen determinations on 2026-07-28 became unaskable while
    // carrying no executable answer. Unknown/malformed dispositions likewise
    // fail OPEN: only the two recorded terminal states may suppress a question.
    if (TERMINAL_DECISION_DISPOSITIONS.has(decision?.disposition)) {
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
