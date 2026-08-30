# HANDOFF — audit-tools

> Immediate state and next action only. Durable design lives in `CLAUDE.md` and `spec/`;
> open work lives in `docs/backlog/`.

## Live state

- **v0.50.15 is live. The lap head is `07c8cdce`** — the dispatched-lane and closeout-gate lap. Two
  session-attribution defects closed, one half deliberately abstained.
  `shell-trap-guard.mjs` now REFUSES a write-capable lane invocation that would run inside any
  worktree of this repo, unless the lane declares `AUDIT_TOOLS_CHILD_SESSION=1` in either shell
  dialect, carries read-only tools, or is pointed outside the repository (`1f9da704`). Neither
  pre-existing lane pattern matched a BARE `claude -p`, which is exactly what the relay ladder
  renders and what caused the incident.
  The DETECTION half ABSTAINS by owner decision (`674fa682`): two independent refutation lanes and a
  source pass agreed that no honest failing test can be written for it, and the dead designs are
  recorded in the entry so a next attempt starts ahead.
  `closeout-challenge-gate.mjs` no longer attributes another session's commit to this one
  (`6db20e2c`, `07c8cdce`). Its `headMovedRecently` was a 12-hour wall-clock proxy, so at a lap START
  the previous lap's closing commit made it fire with nothing to close; it now compares HEAD's commit
  time against the session's `registered_at`, single-sourced with the closeout-render test that
  already asked the same question.

## Immediate next

**Nothing is pinned, by owner decision 2026-08-30.** The empty roadmap below was reviewed and chosen
at the hand-back, against pinning either the fresh-worktree disarm or the session-registry liveness
signal. It is a statement, not an omission — the next session picks from the backlog on its own
judgement.

Three live residuals are in [`open-bugs.md`](backlog/open-bugs.md), none pinned. The largest was
found while verifying this lap's own worker and is new: the child-session commit/push refusal is
STRUCTURALLY INERT in a dedicated worktree, because `enforcementArmed` reads a gitignored per-worktree
directory that starts empty — so giving a lane its own worktree, the correct answer to every other
hazard here, is exactly what removes that guard. The other two: the closeout gate still cannot tell a
mid-lap PAUSE from a sprint that ended, since once a lap has committed anything its own commits are
at-or-after `registered_at`; and the lane-DETECTION half stays open under the abstention above.

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
