# HANDOFF — audit-tools

> Immediate state and next action only. Durable design lives in `CLAUDE.md` and `spec/`;
> open work lives in `docs/backlog/`.

## Live state

- **Both copy-then-delete fallbacks in `foldTransaction.ts` now report what they achieved, and they
  take OPPOSITE arms — the asymmetry is the design, not an inconsistency.** `moveFile` THROWS on a
  non-ENOENT unlink failure: all three call sites already rethrow non-missing errors and none has
  consumed or recorded anything, so the fold fails and retries with the content intact.
  `quarantineSubmissionFile` RECORDS instead, returning `sourceSurvived`, because every caller
  awaits it and THEN records the `rejected` event — a throw would suppress that event and leave the
  file bound, wedging the fold with nothing on the ledger. `quarantineSurvivalNote` is the one home
  for the wording and reaches the durable ledger message, not only stderr. The reasoning, the
  independent refutation, and one claim that refutation corrected are in
  [`design-gate-copy-fallback-2026-08-30.md`](reviews/design-gate-copy-fallback-2026-08-30.md).
- **`src/audit/cli/foldTransaction.ts` is now loop-core** (owner decision 2026-08-30). It never was,
  although `quarantineSubmissionFile` moved into it out of `nextStepHelpers.ts` at `b4a3eb4a` — so
  the fold's one core write boundary sat outside attestation coverage. The instance is closed; the
  CLASS (a symbol leaving coverage by being moved) is an open entry.
- **v0.50.17 is live**, published from `514cd31c`. The lap changed `src/`, so `dist/` differed and
  the publish was owed — check that before assuming a lap owes one.
  ⚠ **A release ends with the green stamp STALE by construction:** the bump commit changes the tree
  after the pre-tag gate, so a closeout after a release needs one more full suite run. Tracked in
  [`open-bugs.md`](backlog/open-bugs.md).
  ⚠ **The pre-tag CI gate refuses an IN-FLIGHT run rather than waiting for it**, so a release fired
  straight after a push fails and must be retried once CI is green. Now an open entry.
- ⚠ **Session-registry cutover, stated because it is silent:** a session that registered in a
  worktree BEFORE the registry moved to the repository store has no record there, and is classified
  an unregistered child until it re-registers —
  `node scripts/shared/sessionRegistry.mjs --register <session-id>`.
- **The owner-approved session-registry liveness sketch is DEAD (`6e4b0f12`).** See *Immediate next*.

## Immediate next

**Nothing is pinned, by owner decision 2026-08-30.** The empty roadmap below was reviewed and chosen
at the hand-back, against pinning either the fresh-worktree disarm or the session-registry liveness
signal. It is a statement, not an omission — the next session picks from the backlog on its own
judgement.

Of the three residuals this section used to list, ONE remains in
[`open-bugs.md`](backlog/open-bugs.md), unpinned: the lane-DETECTION half, still open under the
abstention above. The child-session refusal's arming-by-worktree-provenance defect is closed, and
its entry was deleted rather than restated — after the fix its property was word-for-word the
detection entry's, and two entries stating one property is the duplication this repo bans.
⚠ **The mid-lap PAUSE-versus-END residual LEFT this repo** (owner ruling 2026-08-30: it is a global
issue, not an audit-tools one). Its home is now the machine-wide backlog, `C:\Code\docs\backlog.md`,
created that day because the machine-wide scope had no work tracker at all. `~/.claude/CLAUDE.md`
carries the pointer and the belongs-here test.

⚠ **That "approved as a lap of its own" liveness signal is DEAD as sketched (2026-08-30).** It was
put through the design gate and stopped there before any code: `pid` cannot live on the session
record, because only hooks write it and a hook is dead before anything reads its pid. The owner
STOPPED the lap rather than substitute a design, so the replacement shape is UNCHOSEN and is the
next decision on that entry. The dead sketch and the storage prior art
(`tests/helpers/suiteLock.ts`) are recorded in [`open-bugs.md`](backlog/open-bugs.md).

The standing program direction remains *redesign before scheduled autonomy* → the autonomous
audit→remediate→PR capstone once the architecture items are worked off.


## Deliberate state, not bugs

- `tests/audit/host-delegation-fold-carries-advisories.test.ts` remains deliberately unbaselined:
  its parallel-load timeout passes alone and is tracked as a known flake, so rebaselining it would
  hide a real regression.
- The detached host runner is intentionally not running.
- The tracked decision-queue snapshot STILL disagrees with the ledger that settles it, and it will
  keep doing so: its writer refuses a batch that drops a record-path item on its own, so no lap can
  quietly true it up. What changed is the consumer, not the artifact — `start-lap` step 5 now asks
  the decision ledger (`answer.mjs --list`) and treats it as the authority (`0ada039a`), because
  trusting the snapshot cost a lap four questions the ledger had already recorded settled AND landed.
  **Ask the ledger. Never read the snapshot for what is open.** The artifact's own freshness gate
  remains the real fix and is stated in full in its [`open-bugs.md`](backlog/open-bugs.md) entry,
  which is its home.
- The item-6 checkJs sweep remains type-only by contract; behavioral changes are bugs, not part of
  that refactor.
- The added-root-entry teardown false red is LEFT OPEN on purpose. Two adversarial rounds killed
  both candidate mechanisms by measurement — writer attribution is unavailable in ESM, and no
  exclusivity predicate exists — so nothing was changed rather than shipping a false green. The
  entry in [`open-bugs.md`](backlog/open-bugs.md) carries the dead designs and the three constraints
  a third attempt must satisfy, so the next try starts ahead rather than repeating these two.
- The attest preflight now ABSTAINS whenever the worktree and staged trees differ. That is a
  deliberate coverage reduction, not an oversight: it trades unreliable refusals for a recorded
  abstention, and its three uncovered halves are stated in the backlog entry and as `uncovered` data
  in the guard-reach registry.

<!-- BEGIN GENERATED LIVE STATUS — scripts/shared/generate-handoff-roadmap.mjs — DO NOT EDIT BY HAND -->
<!-- END GENERATED LIVE STATUS -->

<!-- BEGIN GENERATED ROADMAP — scripts/shared/generate-handoff-roadmap.mjs — DO NOT EDIT BY HAND -->

> **This list is GENERATED from [`docs/backlog/`](backlog/) — do not hand-edit it.**
> It is the IMMEDIATE NEXT work only, never the full open set. Prefix an entry's bold title with
> `▶` in the backlog file that owns it and it appears here; empty means nothing is
> pinned, which is a statement rather than an omission.
> **Every open item lives in [`docs/backlog/`](backlog/)**, reachable by the seek index in
> [`backlog.md`](backlog.md) — this block is not a second index of it.
> Every line is a POINTER: the backlog entry's own title, verbatim, and a link to the file that
> holds its spec. Nothing here restates a spec, so this list and the backlog cannot drift.
> Regenerate: `node scripts/shared/generate-handoff-roadmap.mjs` (`--check` gates it in
> `verify:checks` and at commit). 0 pinned item(s).

### ▶ Next up — pinned in the backlog

*(nothing pinned — no immediate next step is set. Every open item is in [`docs/backlog/`](backlog/).)*

<!-- END GENERATED ROADMAP -->
