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
- **Repository:** `v0.50.3` is live on npm; `main` carries fixes newer than the tag.

## Immediate next

**Implement CX-02, starting from the record's decided shape.** The refute-first step the previous
handoff called for is DONE, so the next lap codes. It remains one atomic loop-core replace on
`main`, with a temporary internal seam permitted between commits on the branch under PH-04.

Three things the implementing lap must not rediscover:

1. **Re-derive the constraint-3 acceptance test first — it does not exist on disk.** The record
   says it was written and RED at a count of 3. It is not tracked, not untracked, and not among
   the stored proposal directories. Its mechanism is recorded precisely enough to rebuild (a
   `vi.mock` of `audit-tools/shared` wrapping `withFileLock`, counting only paths ending
   `artifact-tree.lock`,
   over the `batch-deterministic-block` fixture). The count of 3 is unverifiable until it is
   rebuilt, so rebuild it before quoting the number.
2. **The blast radius is larger than "three sites".** Ten in-fold call sites in
   `nextStepHelpers.ts` re-point to lock-free cores; the eight external top-level callers do NOT
   move, because each already calls the locking wrapper. The error-recovery `withFileLock` at
   `:1845` is fold-reachable and the record's old list omitted it.
3. **A handler must not return a PARTIAL bundle.** `ArtifactBundle` is `Partial` and pruning
   treats a missing value as an intent to delete, so a partial return destroys every artifact it
   did not carry. Return a full authoritative bundle or a tri-state patch.

Still open and owner-facing: the live fresh-audit measurement before the cap is sized, which must
capture HOLD TIME as well as dispatch count — a concurrent waiter now has its number, and fails
after `DEFAULT_TIMEOUT_MS` = 10,000 ms.


## Deliberate state, not bugs

- `tests/audit/host-delegation-fold-carries-advisories.test.ts` remains deliberately unbaselined:
  its parallel-load timeout passes alone and is tracked as a known flake, so rebaselining it would
  hide a real regression.
- The detached host runner is intentionally not running.
- **Branch `cx02-one-drain` (`4aabe6c9`) holds two prepared, UNMERGED lock-site splits** —
  `runAuditStepUnlocked` and `ensureSemanticReviewRunUnlocked`. Both typecheck and both are needed
  under every proposed resolution, but they are deliberately unadopted, so `check:deadcode` would red
  them at release. They are not sufficient on their own either (record blockers 2 to 4). Adopt them
  with the replace, or delete the branch and re-derive them from the record — do not merge it alone.
  ⚠ It forked BEFORE this lap's documentation commits, so a plain merge would REVERT the design
  record's refutation sections and the open-bugs entry. Rebase it onto `main` first, or cherry-pick
  the two source files; never merge the branch as it stands.
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
