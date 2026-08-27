# CX-02 design inputs — one audit obligation registry, one drain (2026-08-26)

Status: premise VERIFIED and adversarially refuted (safe to proceed, heavy constraints); not yet
implemented. This record carries the refuter-pinned constraints so the implementing lap starts from
verified design inputs instead of re-deriving them. Source: the CX-02 section of
[complexity-reduction-audit-2026-08-26.md](complexity-reduction-audit-2026-08-26.md); verification
and refutation ran 2026-08-26 across a free-pool lane, an AGY lane, and 14 workflow agents.

## Verified premise

The nested double drain is real and live: `runDeterministicForNextStep` runs the shared
`obligationEngine.advance` as an outer drain (registry `buildAuditObligations`), and its
deterministic path reaches `runAuditStep` → `advanceAudit`, which — because `executeAndRecord`
passes no `preferredExecutor` — runs the shared engine again as an inner drain over the same
`PRIORITY`. The two registries already disagree on membership (the `friction_capture_current`
OUT_OF_BAND carve-out), reconciled only by a drift test — evidence FOR one registry. The outer
drain's `deriveObligationState` is uncached while the inner one is WeakMap-memoized.

## Refuter-pinned constraints, with the design answer for each

1. **Cycle guards (approach-B standing decision, `nextStepHelpers.ts` ~1872-1881):**
   `checkNoProgressBeforeDispatch` and `checkFinalizationCycle` STAY in audit's Ctx; the shared
   engine keeps NO stateSignature (approach A was tried and false-tripped — do not re-add).
   Under one drain, prefer guards observing at HOST-STEP EMISSION points, not per obligation, so
   thresholds keep their meaning without re-derivation.
2. **`audit-code plan` is a live direct consumer of the inner drain** (`planCommand.ts`, wired at
   `cli.ts`, documented in the shipped operator guide): it becomes a POLICY DRAW over the one
   registry — deterministic-only advance, halts at the first host boundary, no workload side
   effects. Its test helpers (`advancedBundle.mjs`, `fixture.mjs`) migrate deliberately.
3. **Lock/persist granularity is defined BY the nesting today:** keep the atomicity shape — fold
   deterministic obligations in memory under one artifact-tree lock (heartbeat on), persist ONCE at
   the halt. The old outer layer's between-transition reload/ingest/materialization become
   obligations inside the one ordering. No per-obligation persist (mid-fold disk visibility; 30s
   stale-lock self-steal risk). Open question the spec must answer first: whether work the outer
   layer ran OUTSIDE the lock (workload materialization, result ingest) is safe inside the fold's
   hold-time, or the fold releases/reacquires around it.
4. **The bounded-call cap is a composite today (100 outer x 64 inner ≈ 6,400 dispatches):** one
   per-invocation cap replaces it; the cap is pacing, not correctness (a capped call suspends
   resumable). Size it from a live fresh-audit measurement before ship; migrate
   `bounded-call-single-source` and the blocked-message text.
5. **External observability contracts:** the `steps/deterministic-progress.json` marker protocol
   (its `iteration` currently means outer fold position), the failure RMW of
   `audit_state.last_executor/last_obligation` under lock, and the generated
   `executor-producers` view all change meaning or producer names — each must be migrated and
   regenerated, with the marker-semantics change stated.
6. **Blast radius:** at least nine pinning test files (advance-drain-loop,
   drain-failure-attribution, finalization-cycle-guard, finalization-convergence,
   advance-error-paths, orchestration, synthesis-narrative-convergence, executor-registry-sync —
   which retires with the second registry — bounded-call-single-source, plus the two helpers), the
   CLAUDE.md architecture paragraph, and a loop-core attestation. One atomic replace; no staged
   half-state.

## Preserve list (report + refuter union)

Deterministic frontier draining within one call; every host-input stop boundary; exactly-once
`preferredExecutor` execution; lock/heartbeat behavior; one consolidated staleness record per call;
advisory delivery on the next emitted host step; the plan draw's semantics; marker-protocol
reachability for filesystem-watching hosts; failure attribution to the executor that failed.
