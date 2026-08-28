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
   (approach A was tried and false-tripped — do not re-add). Its emission-point answer is REFUTED and
   superseded — see *The two open answers*: the guards observe per DISPATCH, in dispatch slots.
2. **`audit-code plan` is a live direct consumer of the inner drain** (`planCommand.ts`, wired at
   `cli.ts`, documented in the shipped operator guide): it becomes a POLICY DRAW over the one
   registry — deterministic-only advance, halts at the first host boundary, no workload side
   effects. Its test helpers (`advancedBundle.mjs`, `fixture.mjs`) migrate deliberately.
3. **Lock/persist granularity is defined BY the nesting today:** keep the atomicity shape — fold
   deterministic obligations in memory under one artifact-tree lock (heartbeat on), persist ONCE at
   the halt. The old outer layer's between-transition reload/ingest/materialization become
   obligations inside the one ordering. No per-obligation persist (mid-fold disk visibility; 30s
   stale-lock self-steal risk). Its open question — whether work the outer layer ran OUTSIDE the lock
   is safe inside the fold's hold-time, or the fold releases/reacquires around it — is ANSWERED in
   *The two open answers*: one hold, and release/reacquire is not available. The self-steal risk named
   here does not apply to a live holder.
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

## Design-gate findings, 2026-08-27 — read these before writing any code

The `/design-check` pass run before implementation. Its retirement verdict is CLEAN: nothing in
`CLAUDE.md`, `docs/backlog/durable-traps.md` or the removal history says the nesting was chosen.
`6145a1a3 refactor(audit): inner deterministic drain adopts the shared obligation engine (C1)` says
in its own message that the engine "was already driving audit's CLI-level fold; this closes the last
hand-rolled copy" — so two levels are the residue of converting each level independently, not a
decision. The one mechanism that must NOT return is approach A, a `stateSignature` on the shared
engine; constraint 1 already pins that.

The pass also found three things this record did not carry. Each changes the implementation, not
only the reader's belief.

1. **The two registries are two LAYERS, not two copies of one list.** `buildDrainObligations` is
   homogeneous — `runDrainStep` for every id, and the module says so. `buildAuditObligations` is
   NOT: eight entries are the plain `deterministic(...)` shape and the rest carry bespoke `execute`
   bodies that emit a host step, consume a submission, or branch on operator consent
   (`external_analyzers_current`, `critical_flow_fallback_current`, `charter_extraction_current`,
   `intent_equivalence_current`, the two design-review completion polls, and others). So the outer
   registry's real content is PER-OBLIGATION HOST-BOUNDARY POLICY. "One registry" therefore means
   one registry that carries that policy, not one list absorbing another — and the merge has to
   answer what a heterogeneous `execute` looks like in a registry the inner drain reaches with a
   uniform runner.
2. **The two `derive` functions differ SEMANTICALLY, not only in caching.** The inner
   (`deriveObligationState` in `advance.ts`) memoizes on bundle identity AND passes
   `emitStaleness: false`, which is what makes `advanceAudit` emit ONE consolidated staleness record
   per call rather than one per drained step. The outer (`deriveObligationState` in
   `nextStepHelpers.ts`) memoizes nothing and passes no options, so it takes the emit-on-stale
   default. `findNextObligation` calls EVERY def's `derive` on every scan, so one outer scan
   performs one holistic `deriveAuditState` PER OBLIGATION — measured 25 at HEAD. The redundant
   stderr emission is masked only by the module-level last-key latch inside `emitStalenessRecord`;
   the redundant WORK is not masked at all, and it is the same regression class C1 measured and
   fixed on the inner side. The unified `derive` must therefore state its emit semantics, and the
   preserve list's "one consolidated staleness record per call" is the constraint that decides it.
3. **A precondition this record did not carry.** `advance.ts` owns the PRIORITY-ordering guarantee
   stated above `SLICE_PARTICIPANT_PRODUCERS` and reconciled by `findPriorityOrderingViolations`:
   every obligation that can rewrite a slice-projected UPSTREAM artifact is scheduled — and its
   `artifact_metadata` persisted — strictly BEFORE the first obligation that can write the
   downstream. The inner drain satisfies the "persisted" half IN MEMORY, by recomputing
   `artifact_metadata` per step through `computeArtifactMetadata` and carrying it on
   `updated_bundle`. Constraint 3's persist-once-at-the-halt is compatible with that ONLY while the
   fold keeps that in-memory carry and keeps re-deriving obligation state per step, because the
   memo is keyed on bundle identity and identity changes at every transition. State that
   explicitly in the spec; a fold that reuses one bundle object across steps breaks the guarantee
   silently.

**The failing test, and what it does NOT prove.** `tests/audit/one-holistic-derivation-per-scan.test.ts`
states finding 2 as an invariant — one fold scan performs ONE holistic audit-state derivation. It is
RED at HEAD and its message carries the measurement: one scan over 25 obligations derived the
holistic state 25 times. An earlier draft of this paragraph called it the acceptance test for the
unification. **That was wrong, and the second gate lane refuted it:** adding a per-bundle cache to
the EXISTING outer registry turns it green while both registries and both drains survive. So it
pins a SEPARABLE performance defect, and CX-02's structural collapse still has no test that can
pass only after the two drains become one.

### The second gate lane, and the constraint it refutes

A second independent lane re-ran the same three questions from source. It confirmed finding 3's
conditional and added four results, each verified here before it was written down.

- **Constraint 1's design answer is REFUTED as stated.** It says that under one drain, guards should
  prefer observing at HOST-STEP EMISSION points. They cannot: shared `advance` RETURNS on the first
  `emit` outcome, and `runDeterministicForNextStep` builds `seenStateSignatures` and
  `dispatchedSignatures` fresh on every invocation. So an emission-point observer sees at most ONE
  emission per call and can never accumulate `FINALIZATION_CYCLE_TOLERANCE`, which is 16. The
  tolerance's unit today is OUTER-FOLD transitions, counted around one `executeAndRecord` that may
  itself contain up to 64 inner dispatches. Collapsing the layers therefore has to re-state what
  that counter counts before it can keep its meaning — the guards staying in audit's Ctx (which
  constraint 1 gets right) does not by itself preserve the threshold.
- **The `stateSignature` phrasing is imprecise and reads as a false property of the engine.** Shared
  `advance` still ACCEPTS `opts.stateSignature`, maintains its `visited` set and returns
  `stopped: "cycle"`. What was rejected is AUDIT PASSING one, not the engine's capability;
  `runDeterministicForNextStep` simply omits the option. Say it that way, or a reader concludes the
  engine has no cycle detection at all.
- **Persist-once is safe in memory but NOT across a disk reload.** `runDeterministicExecutor` and
  several `buildAuditObligations` callbacks transition by RELOADING the bundle from disk. Keeping
  those reloads while deferring the write to a halt-time persist discards the in-memory
  `artifact_metadata` carry that finding 3 depends on. Every such reload has to become a
  fold-internal transition or the guarantee breaks silently.
- **Failure attribution has to become dispatch-local.** Shared `advance` awaits `obligation.execute`
  and records no executor identity; today `runSingleAdvanceStep` wraps the failure and
  `executeAndRecord` recovers it with `findExecutorFailure`. Under one drain the dispatch site must
  attribute from its own current executor and obligation, and the second-lock catch cannot remain
  inside the planned single lock hold.
- **The plan draw needs a narrower registry, not the merged one.** `cmdPlan` calls `runAuditStep`
  with no preferred executor. Making `buildAuditObligations` reachable from there also exposes
  callbacks such as `runHostDelegationObligation`, which INGESTS RESULTS and calls
  `ensureSemanticReviewRun` — side effects a plan must not have. Constraint 2's "policy draw" is
  therefore a filtered view of the one registry, and the filter is load-bearing.

## The two open answers, decided 2026-08-27

Constraint 1's answer was refuted and constraint 3 carried an open question. Both are settled here
from source, and an independent adversarial lane confirmed each mechanical premise below against
HEAD with the deciding lines quoted back. The judgments are this record's; the facts are checked.

### Constraint 1, re-answered — the guards observe PER DISPATCH, in dispatch slots

The mechanism the earlier answer missed: `checkFinalizationCycle` is a SLACK measure, not a counter.
Its condition is `index + 1 - seenStateSignatures.size < tolerance` → continue
(`nextStepHelpers.ts:1978`), and each counted event adds exactly one signature to the set. The left
side is therefore the number of counted events that landed on an ALREADY-SEEN artifact state. So 16
is *permitted revisits*, not permitted iterations, and it fires on the 16th. Both terms are in ONE
unit today — outer-fold transitions, advanced once per `transition` in `countTransitions`
(`nextStepHelpers.ts:2685-2694`) and signed once per guard call.

1. **Observation point: the dispatch site.** Emission points cannot work (refuted above: `advance`
   returns on the first emit). The obligation SCAN cannot work either — `findNextObligation` selects
   without dispatching, so a scan produces no new state to sign. The dispatch is the only point where
   a new artifact state exists. Identity is available there: the unified obligation's `execute` calls
   `decideNextStep` once, as `runDeterministicExecutor` does today (`nextStepHelpers.ts:2165`), so the
   obligation id and executor id are both in scope without re-deriving.
2. **Unit: dispatch slots** — the unit of `MAX_DRAIN_STEPS`, which is the operative graceful cap. The
   two terms of the subtraction must never be in different units.
3. **Keep 16, declared once, and do NOT derive it from the cap.** `deriveEngineBound` exists because
   the engine bound is pure slack above a cap — a quantity with no meaning of its own. The cycle
   tolerance is the opposite: it is a domain judgment about how deep a legitimate ping-pong may run.
   Any formula reproducing 16 from 64 is numerology fitted to the present pair, and it would state a
   dependence that does not exist.
4. **What IS mechanical is the ORDERING: `tolerance < MAX_DRAIN_STEPS`,** pinned by a contract test
   beside `bounded-call-single-source`. At or above the cap the guard is dead code that can never
   fire. This is the mirror of the invariant `deriveEngineBound` protects from the other side, and it
   is the honest form of "single-source it" here — the relationship is enforced, the judgment is not
   disguised as arithmetic.
5. **Accept the tightening explicitly.** Today a cross-transition ping-pong needs ~16 outer
   transitions, each up to 64 dispatches, to trip. Under one drain it trips after ~16 repeated-state
   dispatches. That is intended, because the guard is no longer load-bearing for correctness: the
   64-slot cap halts the fold gracefully whether or not the guard fires, so the guard's remaining job
   is the better DIAGNOSTIC — it names the cycling obligations, which the cap cannot.
6. **Checked and clear: the bootstrap window does not false-trip.** `computeArtifactStateSignature`
   returns the literal `"no-metadata"` before any metadata exists
   (`orchestrator/artifactMetadata.ts:66`), and unlike `checkNoProgressBeforeDispatch` the
   finalization guard has no skip for it — so at finer granularity a long pre-metadata run would
   accumulate slack fast. It cannot: the fold recomputes `artifact_metadata` on every step, so at most
   the first dispatch signs `"no-metadata"`. `checkNoProgressBeforeDispatch` itself needs no
   re-unitting — its key is `(signature, executor, obligation)` at 0 tolerance, which is unit-free.

### Constraint 3, answered — ONE hold, persist once, and the reloads go

The open question was whether the fold holds one lock across work the outer layer ran outside it, or
releases and reacquires. It holds ONE. Three facts force it, and none was in the record:

- **The inner drain is already this shape.** `runAuditStep` holds one tree lock across load → the
  whole drain of up to 64 dispatches → ONE `writeCoreArtifacts` (`cli/auditStep.ts:86-107`).
  Persist-once-under-one-hold is not new machinery; it is the existing inner contract, widened.
- **The self-steal risk the constraint cites does not apply to a live holder.** The heartbeat
  re-stamps the held lock at `STALE_LOCK_MS / 3` = 10s, token-checked (`shared/io/fileLock.ts:189`),
  and a steal requires an mtime older than 30s. Hold length is irrelevant while the heartbeat beats.
- **Release-and-reacquire is not available anyway.** `withFileLock` is non-reentrant: `acquireLock`
  does an exclusive `wx` create (`fileLock.ts:261`), so a second acquisition from inside the hold
  gets `EEXIST` — and the heartbeat keeping the outer hold fresh is exactly what stops the stale-steal
  path from rescuing it. It retries to the 10s default and throws `FileLockTimeoutError`. A
  deterministic timeout, never a success.

Three consequences follow, and each is part of the same atomic replace:

1. **Eleven reload sites become in-memory carries.** `nextStepHelpers.ts` returns
   `state: await loadArtifactBundle(...)` from eleven transitions (2203, 2297, 2323, 2346, 2384,
   2402, 2422, 2456, 2475, 2508, 2524). Under persist-once each reads the fold's own unwritten state,
   which silently rolls back everything the fold has done — a larger break than the metadata-carry
   loss the constraint names. The pattern needs no invention: `runDrainStep` already carries in memory
   (`orchestrator/advance.ts:699`), and one outer transition already does too — the result-ingest arm
   returns `ingested.updated_bundle` (`nextStepHelpers.ts:2616`).
2. **The catch's second acquisition is deleted, not moved.** `executeAndRecord`'s failure path takes
   the tree lock a second time to write `last_executor` / `last_obligation`
   (`nextStepHelpers.ts:1845-1851`); inside one hold that is the guaranteed timeout above. It becomes
   a plain in-memory mutation of the fold's bundle.
3. **The halt-time persist must therefore cover the THROW path.** Today that catch persists before it
   rethrows. A persist placed only on the success path drops the failure attribution the recovery
   path reads.

**The cost to measure, stated so it is not discovered later.** The hold now spans work the outer layer
ran unlocked — result ingest, workload materialization, analyzer spawns. The heartbeat protects the
HOLDER, not WAITERS: `withFileLock`'s default timeout is 10s (`fileLock.ts:27`) and
`LOCKED_JSON_STORE_TIMEOUT_MS` is `STALE_LOCK_MS - 10s` = 20s (`shared/io/lockedJsonStore.ts:19`). A
fold holding longer than those windows converts a concurrent second process — another `next-step`,
`review-run` (`cli/reviewRun.ts:176,195`), an analyzer-policy write — from *waiting* into *failing*.
So the live fresh-audit measurement this entry already requires before the cap is sized must measure
HOLD TIME, not only dispatch count. The residual risk is event-loop starvation rather than staleness:
a synchronous stretch over 30s inside the hold stops the heartbeat and the lock does go stale. Every
folded-in operation is async IO or an awaited child process, so a new synchronous hot loop inside the
fold is the one thing that would break it.

## Preserve list (report + refuter union)

Deterministic frontier draining within one call; every host-input stop boundary; exactly-once
`preferredExecutor` execution; lock/heartbeat behavior; one consolidated staleness record per call;
advisory delivery on the next emitted host step; the plan draw's semantics; marker-protocol
reachability for filesystem-watching hosts; failure attribution to the executor that failed.
