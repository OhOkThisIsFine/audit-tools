# HANDOFF — audit-tools

> Immediate state and next action only. Durable design lives in `CLAUDE.md` and `spec/`;
> open work lives in `docs/backlog/`.

## Live state

- **CX-02's six blockers have been through their refutation pass, and the record now carries a
  DECIDED shape for each.** Six independent lanes ran on 2026-08-28 — four `codex exec`, two `agy`
  — each told to break its proposal, and every claim was re-verified from source before it was
  written down. **Two landings were refuted outright and replaced; four survive with amendments
  that change the work.** The direction is untouched: one registry, one drain remains viable.
  The record's *Where each blocker lands* is the single home for all of it — read it, not this.
- **The two replacements are the reason the plan could not have been coded as written.** The
  unlink deferral would make the systemic-challenge adversary loop converge FALSELY and
  permanently, because a re-consumed submission reports a dry round. And the plan draw's blanket
  halt is wrong: 8 of 13 bespoke policy bodies are HYBRID, so `audit-code plan` would stop at a
  boundary that does not exist on that run. Both replacements are stated in the record.
- **Record landing 6 needs no work — it is already in the tree.** The audit local-command path
  runs on `runTrackedAsync` with a 120 s deadline, so a synchronous child cannot starve the held
  lock's heartbeat. CX-02's remaining implementation is landings 1 to 5 of the record's decided
  shape.
- **Repository:** `v0.50.4` is live on npm and both global bins report it; `main`, `origin/main`
  and the tag agree. No release is pending.
- **Branch `cx02-impl` (pushed) is the implementation branch.** It is `main` plus the two
  lock-site splits (`runAuditStepUnlocked`, `ensureSemanticReviewRunUnlocked`), green on typecheck
  and the orchestrator suites; `check:deadcode` reds it at release BY DESIGN until the fold adopts
  the splits. The constraint-3 acceptance test exists again at
  `.audit-tools/cx02-holding/one-lock-hold-per-next-step.test.ts` — held out of the test tree so
  no commit ships red — and its RED count against the branch is EXACTLY 3, so the record's number
  is verified. Move it into `tests/audit/` with the replace.

## Immediate next

**Implement CX-02 landings 1 to 5 on branch `cx02-impl`, starting from the record's decided
shape.** One atomic loop-core replace lands on `main`; a temporary internal seam is permitted
between commits on the branch under PH-04, every commit green.

Two things the implementing lap must not rediscover:

1. **The blast radius is larger than "three sites".** Ten in-fold call sites in
   `nextStepHelpers.ts` re-point to lock-free cores; the eight external top-level callers do NOT
   move, because each already calls the locking wrapper. The error-recovery `withFileLock` in
   `executeAndRecord`'s catch is fold-reachable and the record's old list omitted it.
2. **A handler must not return a PARTIAL bundle.** `ArtifactBundle` is `Partial` and pruning
   treats a missing value as an intent to delete, so a partial return destroys every artifact it
   did not carry. Return a full authoritative bundle or a tri-state patch.

The `tolerance < MAX_DRAIN_STEPS` contract test (record, constraint-1 answer, item 4) belongs
beside `bounded-call-single-source` and lands WITH the replace — its comparison only becomes the
live invariant once the guards observe in dispatch slots.

Still open and owner-facing: the live fresh-audit measurement before the cap is sized, which must
capture HOLD TIME as well as dispatch count — a concurrent waiter now has its number, and fails
after `DEFAULT_TIMEOUT_MS` = 10,000 ms.


## Deliberate state, not bugs

- `tests/audit/host-delegation-fold-carries-advisories.test.ts` remains deliberately unbaselined:
  its parallel-load timeout passes alone and is tracked as a known flake, so rebaselining it would
  hide a real regression.
- The detached host runner is intentionally not running.
- **The two lock-site splits live on `cx02-impl` as deliberately UNADOPTED exports** —
  `runAuditStepUnlocked` and `ensureSemanticReviewRunUnlocked`, cherry-picked from the retired
  `cx02-one-drain` branch (now deleted; its commit is preserved in the cherry-pick). They are not
  sufficient on their own (record blockers 2 to 4), and `check:deadcode` reds the branch at
  release until the fold adopts them — both intentional under PH-04.
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

- ▶ CX-02 — one audit obligation registry, one drain. · [`forward-tracks.md`](backlog/forward-tracks.md)

<!-- END GENERATED ROADMAP -->
