# HANDOFF — audit-tools

> Immediate state and next action only. Durable design lives in `CLAUDE.md` and `spec/`;
> open work lives in `docs/backlog/`.

## Live state

- **CX-02 is CLOSED end-to-end.** The unification shipped (`v0.50.6`); the deferred live
  measurement ran and shipped with fold_hold telemetry (`v0.50.7`); the owner's waiter decision
  landed (waiter window 120 s, waiter-side only, one acquisition surface). The landed shape lives
  in [`cx02-drain-unification-design-2026-08-26.md`](reviews/cx02-drain-unification-design-2026-08-26.md);
  the measurement and the decided window live in
  [`cx02-hold-time-measurement-2026-08-29.md`](reviews/cx02-hold-time-measurement-2026-08-29.md).

## Immediate next

**Land the decided sync-children migration** (owner, 2026-08-28, CX-02 record §6): move
`runFirstAvailableCommand` onto `runTrackedAsync` with a 120 s deadline so no synchronous child
inside the hold can outlive the lock heartbeat — remediate already migrated, audit did not. Home:
the "Synchronous child processes reachable from the audit fold carry NO timeout" entry in
[`open-bugs.md`](backlog/open-bugs.md).


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
> `verify:checks` and at commit). 1 pinned item(s).

### ▶ Next up — pinned in the backlog

- ▶ Synchronous child processes reachable from the audit fold carry NO timeout, so one hung binary can outlive the lock heartbeat (2026-08-28, medium, friction: tool_should_decide). · [`open-bugs.md`](backlog/open-bugs.md)

<!-- END GENERATED ROADMAP -->
