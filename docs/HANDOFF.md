# HANDOFF — audit-tools

> Immediate state and next action only. Durable design lives in `CLAUDE.md` and `spec/`;
> open work lives in `docs/backlog/`.

## Live state

- **CX-02's design record is repaired again, and this time the repair changes the work.** Its
  constraint 3 DECISION (one hold, persist once) survives; its SCOPE did not. The answer planned to
  delete one nested artifact-tree lock acquisition. The fold reaches three acquisition sites by
  eleven paths, and `withFileLock` is non-reentrant, so each is a deterministic timeout rather than
  a race — including `persistReviewPause`, on the loop's most common exit. Also corrected: two costs
  that turn out not to be costs, one reassurance in *The cost to measure* that is false at HEAD
  (synchronous `git ls-files` already runs inside the hold), the real test blast radius, and the
  acceptance test for constraint 3 — written, and RED at a count of 3, though it does NOT prove the
  collapse. The record is the single home for all of it; read it, not this summary.
- **A ninety-minute adversarial lane then found the plan NOT SAFE TO IMPLEMENT LITERALLY.** It
  reached two of the findings above independently and added six blockers and five constraints of its
  own — among them that persist-once is not achieved by converting the eleven reloads (design review
  writes a core artifact by hand), that deferring the persist reverses a crash-safety ordering the
  code itself documents, and that the dispatch-slot cap stops sharing a unit with the engine bound
  so `deriveEngineBound` is no longer the backstop. Its verdict on the DIRECTION is unchanged: one
  registry, one drain remains viable.
- **Repository:** `main` and `origin/main` are synchronized; every commit passed its gates and the
  full suite is green. No release is pending — `v0.50.3` is live on npm, and the tag and the local
  version match it.

## Immediate next

**Resolve CX-02's six blockers, then implement.** Do NOT start by coding: a ninety-minute
adversarial pass found the plan **not safe to implement literally**, and the record now carries all
six blockers with a PROPOSED landing for each in its *Where each blocker lands* section. Four are
mechanically forced; two are judgments. None of the six proposals has been through a refutation
pass, and the last thing this record did without one was overclaim an acceptance test — so refute
them first, then code. It remains one atomic loop-core replace on `main`.

In brief, with the record as the single home:

1. **Constraint 1 is re-answered.** The guards observe per DISPATCH, counted in dispatch slots. The
   tolerance stays 16 and is deliberately NOT derived from the cap — what becomes mechanical is the
   ordering `tolerance < MAX_DRAIN_STEPS`, pinned by a new contract test, because at or above the cap
   the guard is dead code.
2. **Constraint 3 is answered — ONE hold, persist once — and its SCOPE is now corrected.**
   Release-and-reacquire is not available: `withFileLock` is non-reentrant, so any second
   acquisition inside the hold is a guaranteed `FileLockTimeoutError`. Split the three fold-reachable
   tree-lock sites into a locking wrapper plus a lock-free core, the idiom `auditStep.ts` already
   uses — `auditStep.ts:86`, `nextStepHelpers.ts:1845` and `reviewRun.ts:176`. The fourth site,
   `persistConfigErrorHandoff`, is outside the fold and is not touched. Then the eleven
   `loadArtifactBundle` transitions become in-memory carries, which forces the `handle*Branch`
   descriptors to return the updated bundle rather than rely on a reload; and the halt-time persist
   must cover the throw path. Enforce the result mechanically: nothing reachable from a fold
   `execute` may acquire `artifactTreeLockPath` — and that test must search the ALIAS
   (`handleGraphEnrichmentBranch` binds `runStep = deps.runStep ?? runAuditStep`), or it misses a
   call site exactly as a grep for the name did. **The split is necessary and NOT sufficient:** the
   record's blockers 2 to 4 name the direct core writers and the unlink ordering it does not cover.

Still open and owner-facing: the live fresh-audit measurement before the cap is sized must measure
HOLD TIME as well as dispatch count — the single hold can starve a concurrent waiter at 10s/20s.

Then the replace itself: one registry carrying the host-boundary policy, dispatch-local failure
attribution (but keep the `ExecutorFailure` contract — only the chain-walking helper retires), a
REPLACEMENT registry view for the `plan` draw — **not** a filtered one, because the engine's scan
continues past an id with no def, so an exclusion makes `plan` step OVER the host boundary instead
of halting at it — and the pinning suites migrated in the same commit: ~20 drain-dependent
`advanceAudit` call sites, while the ~29 that pass `preferredExecutor` do not move, because keeping
`runSingleAdvanceStep` as the forced primitive holds them still.

Verification is unchanged for the COLLAPSE: it still has no test that can pass only once it lands,
so the pinning suites staying green remain its only evidence. What is new is that **constraint 3 has
one** — artifact-tree lock acquisitions per `next-step`, written and RED at HEAD with a count of 3,
held out of the tree so no commit ships red. Do not mistake it for the other: hoisting the lock
turns it green with both drains still standing, which is why the record now says so in its own
*acceptance test* section, next to the mechanism.

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
