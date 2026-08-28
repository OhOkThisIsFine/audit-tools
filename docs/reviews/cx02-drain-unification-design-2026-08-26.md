# CX-02 design inputs — one audit obligation registry, one drain (2026-08-26)

Status: premise VERIFIED and adversarially refuted (safe to proceed, heavy constraints); not yet
implemented. This record carries the refuter-pinned constraints so the implementing lap starts from
verified design inputs instead of re-deriving them. Source: the CX-02 section of
[complexity-reduction-audit-2026-08-26.md](complexity-reduction-audit-2026-08-26.md); verification
and refutation ran 2026-08-26 across a free-pool lane, an AGY lane, and 14 workflow agents.

Four claims in this record were later refuted against HEAD and are corrected in place, 2026-08-27,
by four independent verification lanes — one per claim. The corrections touch constraints 4, 5 and
6, and constraint 1's line-number citation is re-anchored to a symbol. Read the constraints as they
now stand; the superseded wording is in `git log`, not here. The evidence that raised the four is
`state-of-play-2026-08-27.md`, section *Three problems inside the one pinned item*; the repair
lanes verified each one from source rather than from that record.

## Verified premise

The nested double drain is real and live: `runDeterministicForNextStep` runs the shared
`obligationEngine.advance` as an outer drain (registry `buildAuditObligations`), and its
deterministic path reaches `runAuditStep` → `advanceAudit`, which — because `executeAndRecord`
passes no `preferredExecutor` — runs the shared engine again as an inner drain over the same
`PRIORITY`. The two registries already disagree on membership (the `friction_capture_current`
OUT_OF_BAND carve-out), reconciled only by a drift test — evidence FOR one registry. The outer
drain's `deriveObligationState` is uncached while the inner one is WeakMap-memoized.

## Refuter-pinned constraints, with the design answer for each

1. **Cycle guards (approach-B standing decision — the "Cycle guards" comment block in
   `src/audit/cli/nextStepHelpers.ts`):** `checkNoProgressBeforeDispatch` and
   `checkFinalizationCycle` STAY in audit's Ctx; the shared engine keeps NO stateSignature
   (approach A was tried and false-tripped — do not re-add). Under one drain, prefer guards
   observing at HOST-STEP EMISSION points, not per obligation, so thresholds keep their meaning
   without re-derivation.
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
4. **Three caps in two units today, not one composite:** the OUTER fold
   (`runDeterministicForNextStep`) supplies no `maxTransitions`, so its bound is the engine's
   inherited `DEFAULT_MAX_TRANSITIONS` — 100 *engine transitions*. The INNER drain carries two of
   its own: `MAX_DRAIN_STEPS`, 64 *dispatch slots*, which is the operative graceful halt (spent in
   `runDrainStep` BEFORE the dispatch it authorizes); and `engineMaxTransitions()` =
   `deriveEngineBound(MAX_DRAIN_STEPS)` — 66 *engine transitions*, a backstop the slot cap is
   derived to beat and which therefore cannot fire first. "100 x 64 ≈ 6,400" is a real ceiling on
   `runSingleAdvanceStep` dispatches per invocation, but it multiplies a transition budget by a slot
   cap and elides the third number, so it must not be read as one cap in one unit. Under one drain
   there is exactly ONE per-invocation cap and the spec must NAME ITS UNIT — dispatch slots or
   engine transitions, never both — keep the derived pairing (`ENGINE_TRANSITION_HEADROOM`,
   `deriveEngineBound`) so no second literal is ever written at a call site, and retire the outer
   site's inherited default rather than carrying it forward. The cap is pacing, not correctness:
   both layers already suspend resumably rather than throw. Size it from a live fresh-audit
   measurement before ship; migrate `bounded-call-single-source` and the blocked-message text.
5. **Observability contracts, and one generated spec that is not one:** two surfaces genuinely
   change and must be migrated. (i) The `steps/deterministic-progress.json` marker protocol — the
   only host-facing contract of the three, read by a filesystem-watching host. Its `iteration` is a
   1-based count of OUTER fold transitions (`executeAndRecord` receives the outer counter
   `iterationRef` and writes `index + 1`), so under one drain the number counts a different thing;
   state the semantics change, do not merely renumber. (ii) The failure-path read-modify-write of
   `audit_state.last_executor` / `last_obligation`, which lives in the catch of `executeAndRecord`
   (`src/audit/cli/nextStepHelpers.ts` — `cli/`, not `orchestrator/`): a
   `withFileLock(artifactTreeLockPath(...))` block that RELOADS the bundle, sets both fields and
   calls `writeCoreArtifacts`. Name it by its symbol and its lock, never by the field names —
   THREE sites inside that one function write `last_executor` / `last_obligation` (the success
   marker, this mutation, and the failure marker), and only the middle one touches the bundle. It
   is a SECOND lock acquisition, because `runAuditStep` has already released the tree lock by the
   time the catch runs; folding it into one hold is constraint 3's open question in miniature. Its
   failing identity comes from `findExecutorFailure`, which exists ONLY because `advanceAudit`
   drains internally — so under one drain that attribution input is re-derived, not carried over.
   `tests/audit/drain-failure-attribution.test.ts` pins both halves and must move with them.

   The generated `executor-producers` view is NOT a third external contract. This constraint
   previously listed it as one; that sub-claim was refuted against HEAD and is corrected here.
   `scripts/shared/generate-executor-producers.mjs` renders
   `spec/audit/executor-producers.generated.md` structurally from ONE source file,
   `src/audit/orchestrator/executors.ts` — each `EXECUTOR_REGISTRY` entry's `id` and its `produces`
   declarations, plus `LIFECYCLE_PRODUCTIONS`. `obligation_ids` never reaches the render, neither
   `PRIORITY` nor `buildAuditObligations` is read by the generator or named in the output, and
   merging two obligation lists renames no executor. Unification alone therefore leaves the render
   unchanged; `check:executor-producers` is the mechanical proof if that ever stops being true.

   Two second-order effects on it are real, and both are declaration edits rather than contract
   migrations. Its prose can go stale: the `audit_state.json` lifecycle row reads "the derived
   obligation state the fold persists after each executor run", which constraint 3's
   persist-once-at-the-halt falsifies — correct that entry's `reason` in `LIFECYCLE_PRODUCTIONS`
   and regenerate. And one MEMBERSHIP decision moves a row: if reconciling the
   `friction_capture_current` carve-out drops that obligation, `friction_capture_executor` is left
   claiming nothing — `assertExecutorRegistryCoversPriority` checks only the PRIORITY→executor
   direction, so a dead entry stays legal — and deleting it takes its `friction/run.json`
   side-channel row out of the render with it.
6. **Blast radius:** at least nine pinning test files (advance-drain-loop,
   drain-failure-attribution, finalization-cycle-guard, finalization-convergence,
   advance-error-paths, orchestration, synthesis-narrative-convergence, executor-registry-sync,
   bounded-call-single-source, plus the two helpers), the CLAUDE.md architecture paragraph, and a
   loop-core attestation. One atomic replace; no staged half-state.
   `executor-registry-sync` is AMENDED, not retired — an earlier draft of this constraint said it
   retires with the second registry, and that is wrong. It holds six tests; exactly two import
   `buildAuditObligations`: the forward guard that every engine-dispatched `PRIORITY` id has a fold
   entry (with its `friction_capture_current` OUT_OF_BAND carve-out) and its CP-NODE-14 reverse.
   Those two are DISSOLVED rather than migrated. Their subject is the divergence between a
   hand-enumerated fold array and `PRIORITY`, and the surviving registry is derived from `PRIORITY`
   the way `buildDrainObligations` already is, so an id can no longer be in one and absent from the
   other. The carve-out needs no new home either: `deriveObligationState` returns `satisfied` for an
   id `deriveAuditState` does not emit, so `friction_capture_current` stays inert by absence — which
   is why the inner drain never needed the exception the outer fold's hand-enumeration forced.
   The remaining FOUR tests name no registry the unification touches and must survive verbatim —
   `EXECUTOR_REGISTRY` claiming each `PRIORITY` obligation exactly once, `isHostDelegationExecutor`
   membership, `kind` validity across the registry, and runner ownership against `EXECUTOR_RUNNERS`.
   Deleting the file drops all four silently, and the load-time
   `assertExecutorRegistryCoversPriority` does not stand in for them: it walks `PRIORITY` only.

## Preserve list (report + refuter union)

Deterministic frontier draining within one call; every host-input stop boundary; exactly-once
`preferredExecutor` execution; lock/heartbeat behavior; one consolidated staleness record per call;
advisory delivery on the next emitted host step; the plan draw's semantics; marker-protocol
reachability for filesystem-watching hosts; failure attribution to the executor that failed.
