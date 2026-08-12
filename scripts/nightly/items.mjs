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
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
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
  writeJson(decisionsPath(root), decisions);
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
// Premise probes (determination ea4e616f; git-history rework per nightly sol-3).
// An item's premise is a fact about the CODE, but the queue holds the item until
// it is ANSWERED — a fact about the conversation. Nothing used to re-test the
// premise in between, so on 2026-07-25 fifteen of twenty-one surfaced items were
// already fixed at HEAD. A probe pins the premise mechanically: the literal
// strings the item quotes, verified at CREATION (the premise must be true when
// the item is written) and re-evaluated at PRESENTATION.
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
  if (out.error || !okStatuses.includes(out.status)) return null; // null = git could not answer
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

export function isRecordPath(file) {
  const norm = file.replace(/\\/g, '/').replace(/^\.\//, '');
  return RECORD_PATH_PREFIXES.some((p) => norm === p || norm.startsWith(`${p}/`));
}

// A positive `contains` probe passes at WRITE time in either of two ways: the
// ordinary tracked-source read ('present'), or the record-file read that is
// admitted only for a declared non-auto-closing item ('record_present'). Both
// mean "the premise is true at HEAD"; neither is ever a closing verdict.
const PASSING_CONTAINS_STATES = new Set(['present', 'record_present']);

// The repo-wide move/rename search domain. Exported because the pre-commit
// HANDOFF parity trigger must use the identical domain when deciding whether a
// staged pickaxe change can alter a presentation-time probe verdict.
export const PREMISE_GREP_PATHSPECS = [
  ':!.audit-tools/nightly',
  ':!docs/backlog',
  ':!docs/nightly-inbox.md',
  ':!docs/reviews',
  ':!docs/HANDOFF.md',
  ':!.claude',
];

// `git ls-files --error-unmatch` exits non-zero for an untracked path, so the
// okStatuses:[0] default already maps "untracked" to null. A git failure is
// indistinguishable from untracked here, which errs toward abstaining — the
// safe direction for a verdict that closes items.
function isTrackedPath(root, file) {
  return gitLines(root, ['ls-files', '--error-unmatch', '--', file]) !== null;
}

function evaluateOneProbe(root, probe, { recordPathsCarryEvidence = false } = {}) {
  // Refuse the target before reading it: a probe that cannot produce evidence
  // must not produce the verdict that closes an item.
  //
  // The RECORD-path half of that rule is split by DIRECTION. Closing and
  // creating need opposite properties from the same probe, and one rule was
  // enforcing both: a record file quotes the code it is about, so its text
  // vanishing says nothing about whether the defect was fixed (must never
  // CLOSE) — but that same text being present is exactly the premise a question
  // ABOUT a record asserts (must be checkable at CREATE). Callers on the close
  // path leave the flag off and keep the abstention unchanged; `writeOpenItems`
  // turns it on only for an item that has declared itself non-auto-closing.
  //
  // The two states below are the guarantee, and it is STRUCTURAL rather than
  // caller-dependent: neither is ever 'absent', 'appeared' or 'holds', so no
  // record-path probe can reach 'resolved' in `evaluateProbes` even if a future
  // caller passes the flag on the close path by mistake. Only the positive
  // `contains` form is admitted — a negative `absent` probe asserts the code
  // side of a divergence, which a record can never speak for.
  if (isRecordPath(probe.file)) {
    if (!recordPathsCarryEvidence || typeof probe.contains !== 'string') {
      return { state: 'untrackable', reason: 'record_path' };
    }
    let recordText = null;
    try {
      recordText = readFileSync(join(root, probe.file), 'utf8');
    } catch (err) {
      if (!err || err.code !== 'ENOENT') return { state: 'error' };
      return { state: 'record_missing' };
    }
    return recordText.includes(probe.contains)
      ? { state: 'record_present' }
      : { state: 'record_missing' };
  }
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
      if (!err || err.code !== 'ENOENT') return { state: 'error' };
      // Tracked but deleted from the worktree: the string is certainly not
      // there — the condition holds.
      return { state: 'holds' };
    }
    return text.includes(probe.absent) ? { state: 'appeared' } : { state: 'holds' };
  }

  let fileText = null;
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
  const elsewhere = gitLines(
    root,
    ['grep', '-l', '-F', '-e', needle, '--', ...PREMISE_GREP_PATHSPECS],
    { okStatuses: [0, 1] },
  );
  if (elsewhere !== null && elsewhere.length > 0) {
    return { state: 'moved', moved_to: elsewhere.slice(0, 5) };
  }

  if (fileText !== null) {
    // File present, fragment nowhere: the direct read IS the absence evidence —
    // git adds rename protection (above) and a citation (below), and when it
    // cannot answer we lose only those extras, not the verdict itself.
    const removal = gitLines(root, ['log', '-1', '--format=%h', '-S', probe.contains, '--', probe.file]);
    return { state: 'absent', commit: removal?.[0] ?? null };
  }
  // File MISSING: here git evidence is REQUIRED — without history we cannot
  // tell deleted code from a typo'd path, and the old ENOENT⇒absent inference
  // is exactly what sol-3 retires.
  if (elsewhere === null) return { state: 'unknown' };

  // File missing entirely. Distinguish "deleted" (premise vanished with the
  // code) from "never existed" (malformed probe) via history — a question the
  // old ENOENT check could not ask.
  const history = gitLines(root, ['log', '--all', '--full-history', '-1', '--format=%h', '--', probe.file]);
  if (history === null) return { state: 'unknown' };
  if (history.length > 0) return { state: 'absent', commit: history[0] };
  return { state: 'bad_path' };
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
 * `options` is forwarded verbatim to each probe evaluation. The only flag today
 * is `recordPathsCarryEvidence`, which `writeOpenItems` sets for a declared
 * non-auto-closing item; every close-path caller omits it and so keeps the
 * record-path abstention. Leaving it off is the DEFAULT, so a new caller
 * inherits the safe direction without knowing the flag exists.
 */
export function evaluateProbes(root, item, options = {}) {
  const raw = Array.isArray(item?.premise_probes) ? item.premise_probes : [];
  const wellFormedString = (v) => typeof v === 'string' && v.trim() !== '';
  const probes = raw.filter(
    (p) =>
      p &&
      wellFormedString(p.file) &&
      // Exactly one of the two forms: positive `contains` or negative `absent`.
      (wellFormedString(p.contains) !== wellFormedString(p.absent)) &&
      (wellFormedString(p.contains) || wellFormedString(p.absent)),
  );
  // One malformed sibling must not be silently dropped. Otherwise the valid
  // subset can all resolve and close the item even though an omitted probe may
  // still describe a live premise. Persisted legacy corruption therefore
  // degrades to unprobed/open; the write path sees zero accepted probes and
  // refuses the item before it reaches the queue.
  if (probes.length !== raw.length) return { status: 'unprobed', probes: [] };
  if (probes.length === 0) return { status: 'unprobed', probes: [] };

  const evaluated = probes.map((p) => ({
    file: p.file,
    form: wellFormedString(p.absent) ? 'absent' : 'contains',
    ...(wellFormedString(p.absent) ? { absent: p.absent } : { contains: p.contains }),
    ...evaluateOneProbe(root, p, options),
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
    // A leg-2 escalation asks what a RECORD should become ("is this backlog
    // entry still worth keeping, or what should it turn into"), so its premise
    // is prose in a record file and there is frequently no code side at all.
    // Such an item declares itself non-auto-closing and is then verified at
    // write exactly like any other; it leaves the queue when the owner answers,
    // which for that question is the only correct exit anyway. The direction
    // split this rides on is documented in `evaluateOneProbe`.
    const nonClosing = item?.auto_close === false;
    const { status, probes } = evaluateProbes(root, item, {
      recordPathsCarryEvidence: nonClosing,
    });
    if (probes.length === 0) {
      throw new Error(
        `writeOpenItems: item "${item?.id ?? '(no id)'}" carries no premise_probes ` +
          `(need [{file, contains}, ...] quoting literal strings from the code the item is about; ` +
          `${raw.length > 0 ? 'the probes present are malformed' : 'none were supplied'})`,
      );
    }
    // Structural rule for divergence items (P12): a negative `{file, absent}`
    // probe expresses only the code side of a relation; without a positive
    // sibling pinning the doc/prose side, nothing anchors what the item is
    // ABOUT, and the item could never auto-close off the doc side moving.
    if (probes.some((p) => p.form === 'absent') && !probes.some((p) => p.form === 'contains')) {
      throw new Error(
        `writeOpenItems: item "${item?.id ?? '(no id)'}" carries only negative {file, absent} ` +
          `probes. A divergence item needs one probe per SIDE: a {file, contains} probe quoting ` +
          `the prose/code that asserts the wrong thing, plus the {file, absent} probe on the side ` +
          `that lacks it.`,
      );
    }
    // The flag is only reachable when EVERY probe is a positive probe on a
    // record path. An item that has a code side must auto-close off that side,
    // so `auto_close: false` can never become the lazy opt-out that lets an
    // ordinary item ride the queue forever immune to closing — which is the
    // exact failure the subject-key ledger was built to end.
    if (nonClosing) {
      const offending = probes.filter((p) => p.form !== 'contains' || !isRecordPath(p.file));
      if (offending.length > 0) {
        const detail = offending.map((p) => `${p.file} [${p.form}]`).join('; ');
        throw new Error(
          `writeOpenItems: item "${item?.id ?? '(no id)'}" declares auto_close:false but carries ` +
            `${offending.length} probe(s) that are not a positive {file, contains} probe on a ` +
            `record path (${detail}). The flag exists only for a question ABOUT a record ` +
            `(docs/backlog, docs/reviews, docs/HANDOFF.md, docs/nightly-inbox.md, ` +
            `.audit-tools/nightly, .claude). ` +
            `An item with a code side must auto-close off that side — drop the flag and probe ` +
            `the tracked source file instead.`,
        );
      }
    }
    const failing = probes.filter((p) =>
      p.form === 'absent' ? p.state !== 'holds' : !PASSING_CONTAINS_STATES.has(p.state),
    );
    if (failing.length > 0) {
      const untrackable = failing.filter((p) => p.state === 'untrackable');
      if (untrackable.length > 0) {
        const detail = untrackable.map((p) => `${p.file} (${p.reason})`).join('; ');
        throw new Error(
          `writeOpenItems: item "${item?.id ?? '(no id)'}" has a premise probe whose TARGET carries ` +
            `no evidence (${detail}). A gitignored runtime artifact under ".audit-tools/", a build ` +
            `output, or a record file (docs/backlog, docs/reviews, docs/HANDOFF.md, ` +
            `docs/nightly-inbox.md, .audit-tools/nightly, .claude) says nothing about whether ` +
            `the defect is fixed. ` +
            `Quote a fragment from the tracked SOURCE file the fix would touch.`,
        );
      }
      const detail = failing
        .map((p) => `${p.file} [${p.state}] "${(p.contains ?? p.absent ?? '').slice(0, 60)}"`)
        .join('; ');
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

export function readViewed(root) {
  return readJson(join(root, VIEWED_RELPATH), { viewed_at: null, keys: [] });
}

export function recordViewed(root, keys) {
  writeJson(join(root, VIEWED_RELPATH), { viewed_at: new Date().toISOString(), keys: [...new Set(keys)] });
}
