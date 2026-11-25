// sites-pinned: tests/shared/nightly-probe-target.test.ts, tests/shared/nightly-probe-retired-doc.test.ts
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Premise probes (determination ea4e616f; git-history rework per nightly sol-3).
// Re-test literal code fragments against the current tree before making a claim
// about a backlog entry's premise. The recorded entry is not evidence.
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
  'docs/nightly-inbox.md', // retired record, never a code premise
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

// The repo-wide move/rename search domain.
// Git pathspecs cannot re-include beneath an exclusion, so admitting
// `.claude/hooks` (sol-5) means enumerating the `.claude` record children here
// instead of banning the directory whole. Decay direction if a new `.claude`
// child appears before it is listed: it enters this search domain, so its
// quotes read as 'moved' (items stay open) and the pre-commit parity trigger
// over-fires — both the safe direction, never a mis-close.
export const PREMISE_GREP_PATHSPECS = [
  ':!.audit-tools/nightly',
  ':!docs/backlog',
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
