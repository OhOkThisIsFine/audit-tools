# HANDOFF — audit-tools

> Immediate state and next action only. Durable design lives in `CLAUDE.md` and `spec/`;
> open work lives in `docs/backlog/`.

## Live state

- **The sync-children hazard is CLOSED on BOTH halves.** Audit half: every audit-fold-reachable
  spawn on the async exec twin with the shared 120 s deadline (`v0.50.9`). Remediate half: the
  ingestion corroboration probes, the triage reverify (now argv through the shared required-test
  runner, no shell), and the grounding/contract-gate enumerations all run async with declared
  deadlines; the acquisition default runners and the closing-phase spawns carry declared
  deadlines too. INV-SSF pins seven fold-reachable modules;
  `tests/shared/analyzer-default-runner-deadline.test.ts` pins the acquisition default runners
  behaviorally (its header states the one unpinned half: close.ts's in-code deadlines).
- **CX-02 is CLOSED end-to-end** (`v0.50.6`–`v0.50.8`; waiter window 120 s, one acquisition
  surface). Landed shape:
  [`cx02-drain-unification-design-2026-08-26.md`](reviews/cx02-drain-unification-design-2026-08-26.md);
  measurement: [`cx02-hold-time-measurement-2026-08-29.md`](reviews/cx02-hold-time-measurement-2026-08-29.md).

## Immediate next

**Nothing is pinned.** The queue is the backlog ([`backlog.md`](backlog.md)); the standing
program direction remains *redesign before scheduled autonomy* → the autonomous
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
