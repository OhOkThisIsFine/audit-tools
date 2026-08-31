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
- **The session-registry liveness sketch is dead and the question it served is CLOSED** — the guard
  it would have fixed was deleted instead (see *Immediate next*). Five designs died on it; the whole
  record, including what each died of, is in
  [`sweep-timing-measurement-2026-08-30.md`](reviews/sweep-timing-measurement-2026-08-30.md). Do not
  reopen it from this file.

## Immediate next

**SETTLED 2026-08-30 — the root-delta check is DELETED, and root cleanliness is now owned by
nothing inside this repo.** The owner ruled that the artifacts are no longer this project's problem,
and the guard's own creation commit `f3cac01b` had already measured exactly that. So the guard was
removed rather than repaired: `repoRootProblems`, `rootEntriesAtSetup`, `unexpectedRootEntries` and
`RUN_OWNED_ROOT_ENTRIES` are gone from `tests/helpers/global-setup.ts`, with their pinned cases and
docblocks. `inTreeFixtureProblems` and `liveChildProblems` still THROW — those are the halves a run
can answer for, because it can establish what it started.

The snapshot-at-the-commit-boundary track was **retired in the same decision**, not left paused: no
mechanism is queued to take the property back, and that is recorded rather than implied.

**Three costs were accepted knowingly**, and the guard-reach row carries them as data: `npm test` can
now mint green over a tree containing an unignored root leak; a future regression in this project's
own spawn discipline goes unwatched at test time; and any leak matching an ignore rule is invisible
to every gate, including the `git add -A` tree the stamp binds. The diagnosis and remedy moved to
[`durable-traps.md`](backlog/durable-traps.md) before their carriers were deleted.

Two assets survive for unrelated work: `samePath` (`.claude/hooks/session-start-guards.mjs`) is the
correct checkout-comparison primitive, and a tool child already knows its own session
(`CLAUDE_CODE_SESSION_ID` plus a live `CLAUDE_PID`, surviving `npm exec`).

Of the three residuals this section used to list, ONE remains in
[`open-bugs.md`](backlog/open-bugs.md), unpinned: the lane-DETECTION half, still open under its own
recorded abstention. The child-session refusal's arming-by-worktree-provenance defect is closed, and
its entry was deleted rather than restated — after the fix its property was word-for-word the
detection entry's, and two entries stating one property is the duplication this repo bans.
⚠ **The mid-lap PAUSE-versus-END residual LEFT this repo** (owner ruling 2026-08-30: it is a global
issue, not an audit-tools one). Its home is now the machine-wide backlog, `C:\Code\docs\backlog.md`,
created that day because the machine-wide scope had no work tracker at all. `~/.claude/CLAUDE.md`
carries the pointer and the belongs-here test.

⚠ **One lesson outlives all of it, and it is why this closed the way it did:** three separate times a
stated BLOCKING CAUSE for a design turned out to be an untested premise, and the last one was the
guard's own justification. Check the premise before designing against it.

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
- The repo root is DELIBERATELY unobserved by the suite (2026-08-30). The added-root-entry teardown
  check was deleted, not fixed and not paused, so a root leak passing `npm test` is the accepted
  state rather than a regression. The costs are declared as data in the `run-hermeticity-test` row of
  `scripts/guard-reach-data.mjs`, and the diagnosis lives in
  [`durable-traps.md`](backlog/durable-traps.md).
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
