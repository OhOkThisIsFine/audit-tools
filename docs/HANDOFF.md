# HANDOFF — audit-tools

> Immediate state and next action only. Durable design lives in `CLAUDE.md` and `spec/`;
> open work lives in `docs/backlog/`.

## Live state

- **CX-02's design record is repaired, gated, and now ANSWERED.** Its four refuted claims were
  corrected in place, a `/design-check` found three more things it did not carry, and the two
  questions that gate left open are now decided in its *The two open answers* section (`3c2835c8`).
  The record is the single home for all of it — read it, not a summary. The item is ready to code,
  and its separable performance half already landed, so the collapse itself is what remains.
- **Repository:** `main` and `origin/main` are synchronized; every commit passed its gates and the
  full suite is green. No release is pending — `v0.50.3` is live on npm, and the tag and the local
  version match it.

## Immediate next

**Implement CX-02's structural collapse.** One atomic loop-core replace; never stage half of it. The
design gate is done, and **the two answers it left open are now written** into the record's *The two
open answers* section — each premise checked against HEAD and confirmed by an independent adversarial
lane. So this lap starts by coding. In brief, with the record as the single home:

1. **Constraint 1 is re-answered.** The guards observe per DISPATCH, counted in dispatch slots. The
   tolerance stays 16 and is deliberately NOT derived from the cap — what becomes mechanical is the
   ordering `tolerance < MAX_DRAIN_STEPS`, pinned by a new contract test, because at or above the cap
   the guard is dead code.
2. **Constraint 3 is answered: ONE hold, persist once.** Release-and-reacquire is not available —
   `withFileLock` is non-reentrant, so a second acquisition inside the hold is a guaranteed
   `FileLockTimeoutError`. Three consequences ride with it: eleven `loadArtifactBundle` transitions
   become in-memory carries, the catch's second lock acquisition is deleted rather than moved, and the
   halt-time persist must cover the throw path.

Still open and owner-facing: the live fresh-audit measurement before the cap is sized must measure
HOLD TIME as well as dispatch count — the single hold can starve a concurrent waiter at 10s/20s.

Then the replace itself: one registry carrying the host-boundary policy, dispatch-local failure
attribution, a FILTERED registry view for the `plan` draw (`runHostDelegationObligation` ingests
results, which a plan must not do), and the nine-plus pinning suites migrated in the same commit.
Note what verification is available: the collapse has NO test that can pass only once it lands, so
the pinning suites staying green is the evidence.

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

- ▶ CX-02 — one audit obligation registry, one drain. · [`forward-tracks.md`](backlog/forward-tracks.md)

<!-- END GENERATED ROADMAP -->
