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

A fifth repair, 2026-08-28, is appended rather than inlined, because it corrects the SCOPE of an
answer whose decision stands: *Constraint 3's SCOPE is refuted*, immediately before the preserve
list. Read it before constraint 3 and before the two open answers — it changes how much work
constraint 3 is, and it corrects constraint 6's test count. Anything above it that implies a single
nested lock acquisition is superseded by it.

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

## Constraint 3's SCOPE is refuted, 2026-08-28 — it counted one nested acquisition of eleven

The DECISION above survives; its scope does not. *ONE hold, persist once* names a single second
acquisition of the artifact-tree lock — `executeAndRecord`'s catch — and plans to delete it. Under
one fold-wide hold there are ELEVEN, and the same paragraph's own finding is what makes each one
fatal rather than untidy: `withFileLock` is non-reentrant, so none of them can release and
reacquire its way out. Each is a deterministic `FileLockTimeoutError`. Verified at HEAD by direct
enumeration:

1. `nextStepHelpers.ts:1845` — the catch. The one the answer found.
2. `reviewRun.ts:176` — `persistReviewPause`, reached from `ensureSemanticReviewRun`, which
   `runHostDelegationObligation` calls at `nextStepHelpers.ts:2620`. That is the audit loop's most
   common exit path, so the plan as written breaks the ordinary case, not an edge case. It is also
   the only one of the eleven on an EMIT path rather than a transition.
3–11. Nine `runAuditStep` calls inside the fold, each locking via `auditStep.ts:82` —
   `nextStepHelpers.ts` 1419, 1464, 1511, 1611, 1663, 1705, 1760 (the submission-apply forced
   dispatches inside the `handle*Branch` descriptors' `apply` callbacks), 1812 (`executeAndRecord`'s
   normal path) and 2601 (the result-ingest arm).

**Count the SITES, not the paths — an independent sweep sharpened this and it changes the work.**
The whole source tree holds exactly FOUR `withFileLock(artifactTreeLockPath(...))` acquisition
sites: `auditStep.ts:86`, `nextStepHelpers.ts:1845`, `reviewRun.ts:176` and `reviewRun.ts:195`.
Three of the four are reachable from the fold; `reviewRun.ts:195`
(`persistConfigErrorHandoff`) is not — its only caller is `nextStepCommand.ts:311`, the CLI error
handler outside the fold, so it keeps its wrapper untouched. The eleven above are the eleven PATHS
by which the fold reaches those three, and nine of them funnel through the single `auditStep.ts:86`.
So the edit is three splits, not eleven; the eleven is what makes it unavoidable, not what sizes it.

**The resolving shape is already in the tree, so this is scope rather than a new judgment.**
`runAuditStep` is split three ways today — `runAuditStep` (lock) → `runAuditStepLocked` (load +
persist) → `executeAdvance` (pure; its own comment says it was split out so a caller can execute it
UNLOCKED). Every tree-lock acquisition reachable from a fold `execute` splits the same way: a
locking wrapper for the eight external CLI commands, a lock-free core the fold calls. The property
is mechanically enforceable and must be enforced — a contract test that nothing reachable from a
fold `execute` acquires `artifactTreeLockPath`.

### Two costs this record implied are NOT costs, checked against HEAD

Both were raised against WIDEN while writing the above, and both fail. They are recorded because a
later reader will raise them again.

- **The hold does not newly span analyzer child processes.**
  `external_analyzer_acquisition_executor`, `graph_enrichment_executor`, `auto_fix_executor` and
  `syntax_resolution_executor` are all `EXECUTOR_RUNNERS` entries (`executorRunners.ts:93, 103, 189,
  197`), dispatched from inside `runAuditStep`'s existing hold. Child processes already run under the
  tree lock. The honest delta is hold LENGTH, not a new class of work under the lock.
- **A crash mid-fold does not newly lose much.** `runAuditStepLocked` is load → `executeAdvance` →
  ONE `writeCoreArtifacts`, and `executeAdvance` drains up to `MAX_DRAIN_STEPS` in memory with no
  intermediate persist. Today's worst-case loss is already a 64-dispatch drain; persist-once extends
  the unpersisted window from one inner drain to the fold, and on a fresh deterministic run the inner
  drain already covers nearly all of it.

What survives as a real cost is the one the record already states: a longer hold converts a
concurrent waiter into a FAILURE at the 10s `withFileLock` default and the 20s
`LOCKED_JSON_STORE_TIMEOUT_MS`. The deferred hold-time measurement is still owed.

### And one reassurance in *The cost to measure* is FALSE at HEAD

That paragraph closes by saying every folded-in operation is async IO or an awaited child process,
so a NEW synchronous hot loop inside the fold is the one thing that would break the heartbeat.
Synchronous work is already in there, and it is child-process work:

- `findingGrounding.ts:120` — `spawnSync("git", ["ls-files", "-z"])` with a 64 MB `maxBuffer`,
  enumerating every tracked path. Reached inside the hold from `auditStep.ts:285`
  (`verifyFindingGrounding`). On a very large repository this is the most plausible multi-second
  synchronous stretch in the fold.
- `disposition.ts:517` and `:522` — `spawnSync` for the VCS-ignore and untracked rules, in the
  `file_disposition` obligation. Injectable (`options.spawn ?? spawnSync`), so the default is the
  synchronous one.
- `candidates.ts:452` — a synchronous `readdirSync` breadth-first walk in analyzer candidate
  discovery. This one is SAFE by construction and should stay that way: `LIZARD_WALK_MAX_ENTRIES`
  bounds it at 5,000 entries (`candidates.ts:433`).

None of this blocks the change — all three already run inside `runAuditStep`'s hold, so the
heartbeat is already exposed to them and persist-once does not add the exposure. What it changes is
what the deferred measurement must look for: the risk is not a hypothetical future hot loop, it is
`git ls-files` on a large repository today. Correct the reassurance; do not rely on it.

### The alternative granularity, stated so it is not rediscovered as an open question

Today is NEITHER endpoint: one hold per OUTER transition, each covering an INNER drain. The obvious
alternative — one hold per dispatch — is rejected here rather than left implicit. It would REGRESS
what exists, cutting the inner drain's 64-dispatch hold to one dispatch and exposing the tree
mid-cascade far more often, to buy back a crash window the point above shows is largely already
there. WIDEN is an extension of the existing inner contract; NARROW is a retreat from it.

### Constraint 6's blast radius is understated on tests, and overstated on shape

`advanceAudit` has 49 call sites across 15 test files, not nine. But roughly 29 of them pass
`preferredExecutor`, which bypasses the engine entirely and is unaffected by the collapse —
including the fixture driver `tests/audit/helpers/advancedBundle.mjs`, whose stages are all forced
precisely so a bare call cannot overshoot. So the migration is the ~20 drain-dependent sites,
concentrated in `advance-drain-loop`, `orchestration`, `finalization-convergence` and
`orchestrator-remediation`. Keeping `runSingleAdvanceStep` as the forced single-step primitive is
what holds the other 29 still.

One layering assumption should not be made: there is no rule forcing the one registry into either
area. `src/audit/orchestrator/` already imports `../cli/lineIndex.js` in three modules
(`requeueFold.ts:19`, `taskBuilder.ts:16`, `trivialAudit.ts:3`), so "orchestrator must not import
cli" is not an available argument for where the registry lands. Decide it on the host-boundary
policy the registry carries, which is CLI-shaped, not on a layering rule that does not exist.

### An acceptance test for CONSTRAINT 3 — written and RED-validated, and NOT one for the collapse

Read the last paragraph of this subsection before quoting the first: the first draft of it
overclaimed, in precisely the way this record already documents once.

Artifact-tree lock acquisition COUNT per `next-step` is a real red-green test. Today the fold
acquires and releases once per outer transition; under one hold it is exactly one.

Drafted and run against HEAD, 2026-08-28: **RED, and the count is 3** — over the
`batch-deterministic-block` fixture, the longest guaranteed deterministic drain in the suite, so the
pre-collapse number is not one by accident. Mechanism: a `vi.mock` of `audit-tools/shared` wrapping
`withFileLock` and counting only acquisitions whose path ends `artifact-tree.lock`. That works
because `nextStepHelpers.ts` and `auditStep.ts` both import the lock from that one subpath, and it
cannot be inflated by the analyzer-policy or submission-ledger locks, which are different paths. The
file is held OUT of the tree until its change lands, so no commit ships red.

**What it does NOT prove — and this is the same trap the record already fell into once.** An earlier
draft of this very subsection called it the acceptance test for the COLLAPSE. It is not. Hoist the
lock into the fold driver and point the in-fold calls at lock-free cores, and the count goes to one
**with both registries and both drains still standing** — that is constraint 3 alone. So it is an
acceptance test for ONE HOLD, PERSIST ONCE, and nothing more. The record's finding stands unchanged:
the structural collapse still has no test that can pass only once it lands, and the pinning suites
staying green are still its only evidence.

What this does establish is that **constraint 3 is SEPARABLE from the registry collapse** — it has
its own mechanism, its own blast radius (three lock-site splits and the eleven carries) and now its
own red-green test, none of which touch `buildDrainObligations`.

**Separable is not a reason to separate, and this is settled — do not re-open it.** The case for
landing constraint 3 on its own was that a regression would localise to one of two changes instead
of one large diff. That is a debugging-effort argument, and effort, complexity and refactor size are
explicitly NOT costs here; correctness is the only thing that gates pace, and the intermediate state
is not a correctness problem. The proof is not lost either: the lock-count test lands WITH the
replace and still goes 3 → 1 in it, so constraint 3 is still mechanically gated — just not in
isolation. One atomic replace on `main` stands, with a temporary internal seam permitted between
commits on the branch under PH-04. Deferring the collapse to a later lap is settled against by the
same line.

## Six more blockers and five constraints, from a slow adversarial lane, 2026-08-28

An independent deep lane re-ran the whole brief against HEAD over about ninety minutes. It reached
the same-lock re-entry finding above on its own, and the synchronous-child heartbeat finding on its
own — corroboration rather than news, and worth more than either would be alone. It also found four
blockers and five constraints that nothing above carries, and it corrected two of this record's own
claims. Its verdict on the direction is unchanged — one registry, one drain remains viable — but the
plan **is not safe to implement literally**.

Each item below was re-verified from source here before it was written down; the lane's own citations
were the starting point, not the evidence.

### Persist-once breaks the submission consume/persist ORDERING, and loses host submissions

`runOmittableGate` consumes a lane submission in this order: `descriptor.apply(...)` — which today
calls `runAuditStep`, so the effect is PERSISTED — then `unlink(incoming.path)` to remove the
submission file, then `recordLaneOutcome`. That order is crash-safe in both directions. Die before
the persist and the file survives to be re-consumed; die after it and the effect is on disk and the
file is correctly gone.

Persist-once inverts it. The apply becomes an in-memory carry, the unlink still happens immediately,
and the core write moves to the halt — so a process killed between the two has **deleted the host's
submission without ever persisting its effect**. That is silent loss of host input, not a lost
derivation the next call recomputes.

So the halt-time persist is not the only ordering the fold owns: every submission unlink must be
DEFERRED behind it. The fold has to carry a pending-deletion list and apply it after the persist
succeeds. State that in the spec; it is not implied by "persist once".

### The plan draw must HALT at a host boundary, and an exclusion filter SKIPS it instead

Constraint 2 calls the plan draw "a FILTERED registry view". Read literally as removing the
host-boundary entries, it is wrong, and the engine says why:
`findFirstActionableObligation` walks `priority` and does
`obligations.find((o) => o.id === id)` per id, **continuing to the next id when no def matches**
(`obligationEngine.ts:63-68`). An excluded obligation therefore does not stop the scan — the scan
steps over it and selects a LATER obligation. A `plan` built that way would run PAST the first host
boundary rather than halting at it, which inverts the one semantic constraint 2 gives it
("deterministic-only advance, halts at the first host boundary").

The filter must therefore be a REPLACEMENT, not a removal: every id stays in the view, and the
host-boundary ones get an `execute` that emits a halt. That also keeps the side-effect exclusion the
constraint actually wants — `runHostDelegationObligation` never runs, so nothing ingests results or
calls `ensureSemanticReviewRun` — while preserving ordering and the halt point. And the exclusion
must cover more than that one callback: other bespoke bodies persist analyzer consent and settings,
and consume edge / review / charter / narrative submissions.

### Persist-once is NOT achieved by converting the eleven reloads — there are direct core writes too

The design-review consumption path writes a CORE artifact by hand, outside `writeCoreArtifacts`:
`writeJsonFile(join(artifactsDir, "design_assessment.json"), existing)` at `nextStepHelpers.ts:1040`
and again at `:1208`, plus the pass snapshots that follow it. So converting the reloads to carries
leaves those writes landing mid-fold, and the "one persist boundary" claim is simply false — a later
throw leaves a partly persisted fold. Removing them instead loses the state, because the handlers
return an `action`, not a bundle. Every direct AND indirect core writer has to be enumerated and
converted into an in-memory transaction result that the single outer commit consumes.

### The dispatch-slot cap and the engine bound stop sharing a unit — `deriveEngineBound` stops being a backstop

This is the subtlest of the set and the proposed `tolerance < MAX_DRAIN_STEPS` test does not cover
it. The shared engine increments its transition counter on EVERY `transition`
(`obligationEngine.ts:320-325`). Under the unified heterogeneous registry, bespoke policy bodies can
transition WITHOUT dispatching an executor — a consumed analyzer consent returns a transition at
`nextStepHelpers.ts:2293-2297`, a consumed design review at `:2519-2524`. If `MAX_DRAIN_STEPS`
counts only executor dispatches, as constraint 4 says it must, those policy transitions spend engine
budget and no slot. Four of them plus 63 dispatches crosses the 66-transition engine bound before
the 64th dispatch can reach the graceful slot cap — so the derived bound is no longer guaranteed to
fire second, which is the whole invariant `deriveEngineBound` exists to hold. Either charge every
obligation execution to the same named unit, or re-specify the cap and its headroom. Either way it
needs a mixed policy-transition test, which nothing in the blast radius currently provides.

### Three preservation constraints the plan must carry

- **Every transition must produce a FRESH bundle identity, and one callback currently mutates in
  place.** Both derives memoize on bundle identity. Design review takes
  `const existing = bundle.design_assessment` (`:1083`) and mutates it (`:1141-1143`, `:1175-1198`),
  relying on the later reload at `:2524` to mint a new identity. Replace that reload with
  `state: bundle` and the WeakMap hands back the PRE-mutation `AuditState`, so the just-completed
  review can be selected again and the slice ordering premise breaks silently. Carries must be fresh
  immutable bundles, nested objects included.
- **The forced-executor bypass is load-bearing and must stay explicit.** `advanceAuditInner` branches
  on `preferredExecutor` and runs exactly one step INSTEAD of entering the drain
  (`advance.ts:763-768`). Route a forced call through the unified drain and it can execute subsequent
  obligations, breaking the single-action contract every submission-ingest caller depends on. Keep an
  explicit one-dispatch path and pin it with a contract test.
- **`tests/audit/host-delegation-fold-carries-advisories.test.ts` must migrate, and the record's
  blast radius does not name it.** It pins the transition-then-next-emission advisory carry, whose
  accumulator is initialized once per call at `:2762-2766`. A stateless shared `execute`, or a
  context recreated per transition, silently drops the accepted-with-warning notice.

### Two smaller corrections to this record's own claims

- **`findExecutorFailure` may retire; the structured error contract may NOT.** Its only production
  consumer is `nextStepHelpers.ts:1839`, so the chain-walking helper goes once attribution is
  dispatch-local. But dispatch still wraps failures as `ExecutorFailure` (`advance.ts:264-275, 462`),
  and deleting that with the helper leaves a nested forced dispatch — result ingestion, say —
  attributable only to the outer `semantic_review_executor`.
- **`one-holistic-derivation-per-scan.test.ts`'s own header comment is now STALE.** Lines 20-22 say
  it is RED at HEAD and goes green when the two registries become one. The outer per-bundle cache has
  since landed, so it passes today with both registries standing — which is exactly the refutation
  this record already records, now contradicted by the test file's own prose. Fix the comment with
  the collapse.

### And the lock-path count above is one short — an ALIAS hides a call site from grep

`handleGraphEnrichmentBranch` binds `const runStep = deps.runStep ?? runAuditStep`
(`nextStepHelpers.ts:496`) for its injected-runner seam, then applies the edge-reasoning submission
through `runStep(...)` at `:601`. A search for `runAuditStep(` does not find it — mine did not — so
the in-fold path list above is one short, and any future sweep for lock re-entry must search the
ALIAS as well as the name. That site is also where the crash-safety ordering is stated in the code
itself: "Apply BEFORE deleting the submission: if runStep throws (locks, crash), the submission
survives for the retry instead of being lost" (`:599-600`).

## Where each blocker lands — REFUTED 2026-08-28, and this is the decided shape

Every landing below went through an independent adversarial pass on 2026-08-28 (six lanes: four
`codex exec`, two `agy`, one enumeration sweep). Each lane was told to BREAK its proposal, and
every claim it returned was re-verified from source here before it was written down — a lane
citation was the starting point, never the evidence.

**Two landings were refuted outright and are replaced. Four survive with amendments that change
the work.** The direction — one registry, one drain — is untouched.

1. **Lock re-entry — STANDS, with the site list and the test replaced.** Wrapper plus lock-free
   core at each fold-reachable site, the idiom `auditStep.ts` already uses.
   - The site list is one longer than stated: the explicit `withFileLock` in the error-recovery
     block at `nextStepHelpers.ts:1845` is fold-reachable and must split too.
   - The blast radius is TEN in-fold call sites in `nextStepHelpers.ts` (601 through the `runStep`
     alias, 1419, 1464, 1511, 1611, 1663, 1705, 1760, 1812, 2601), not three. The eight external
     top-level callers need NO change: each calls the public `runAuditStep`, which keeps its lock.
   - `persistReviewPause` is safe outside its own hold. It reads only in-memory parameters and
     writes through `writeCoreArtifacts` / `writeHandoffOnly` (`reviewRun.ts:151-188`); under a
     continuous outer hold there is no time-of-check race to reintroduce.
   - **The proposed contract test is refuted.** "Nothing reachable from a fold `execute`" is a
     static reachability claim over dynamic dispatch and injected callbacks — the engine calls
     `def.execute`, `runOmittableGate` calls `descriptor.apply` (`:1375`) — so a static analyzer
     can silently pass an unsplit path. That is the test-that-cannot-fail case. Replace it with two
     fail-closed mechanisms: an import-boundary rule (`nextStepHelpers.ts` may not import
     `withFileLock` or `runAuditStep`, only the lock-free cores), AND a dynamic assertion of ZERO
     inner acquisitions across `runDeterministicForNextStep` (`:2717`) — which is what the
     lock-count acceptance test below already measures.

2. **Direct core writes — STANDS, but a bundle return is NOT a sufficient shape.**
   - The core writer list is `:1040`, `:1146`, `:1208` and the `writeCoreArtifacts` at `:1850`.
     `:1146` is a third raw `design_assessment.json` write this record previously missed.
   - **A partial bundle DELETES.** `ArtifactBundle` is `Partial<ArtifactPayloadMap>`
     (`artifacts.ts:154`) and pruning treats a missing value as an intent to unlink (`:447-458`).
     The return must be a FULL authoritative bundle, or a tri-state patch separating untouched
     from set from delete.
   - **Design-review snapshots are state-critical and are not core artifacts.** They live under
     `design-review-snapshots/`, are loaded specially (`artifacts.ts:157-162`), and
     `writeCoreArtifacts` never writes them — while `state.ts:44-47` treats a COMPLETED pass with
     no snapshot as `satisfied`. A snapshot lost between fold and commit silently marks the pass
     done rather than re-firing it. Commit them with the core, not after it.
   - The failure path throws without returning a bundle (`:1842`), so pending state must survive
     exceptions. The submission ledger and `agent_reflections` are append-only and must never
     round-trip through a write-back (`artifacts.ts:145-152, :173-180`).
   - **The marker protocol is EXEMPT and must stay mid-fold.** The five
     `steps/deterministic-progress.json` writes (`:1805, :1820, :1852, :1929, :1984`) exist so a
     host watching the filesystem can see which executor is active DURING a long step, which the
     preserve list protects. Their value is being visible mid-fold. So the property this landing
     delivers is ONE CORE WRITE BOUNDARY, not "one persist boundary" — state it that way, or a
     later lap folds the markers in and breaks the observability contract.
   - Define "one commit". `writeCoreArtifacts` writes sequentially (`artifacts.ts:437-446`); only
     each individual file is atomic temp-then-rename (`json.ts:99`). The result is one logical
     locked flush, not crash-atomic all-or-nothing.

3. **Unlink ordering — REFUTED. Deferral introduces a silent, permanent failure.**
   A deferred deletion creates a re-consumption path, and one apply is not idempotent under it.
   **Systemic challenge falsely converges, for good.** `foldChallengeRound` counts a finding as new
   only when it is absent from `prior` (`systemicChallengeLoop.ts:107-113`) and sets
   `dry = new_finding_ids.length === 0` (`:122`); the executor sets `converged: folded.dry`
   (`systemicChallengeExecutor.ts:109`). Re-consuming an already-folded submission therefore
   reports a dry round and terminates the adversary loop permanently. (This instance depends on
   convergence being ONE dry round — open decision `backlog-1`. Answering that two-or-more blunts
   the instance without fixing the class.)
   Three more: an `emit` exit is the COMMON exit and returns immediately (`:2784`) while earlier
   transitions may already have written outside `artifactsDir`; throw and guard paths
   (`:1831-1869`, and the no-progress / blocked / cycle / stopped-fold guards) discard a staged
   list; and `recordLaneOutcome` appends an immutable ledger event
   (`laneSubmissions.ts:481-518`) that double-records on re-consumption.
   **Replacement landing:** durable STAGING, not an in-memory list — atomically rename a
   submission into a staging directory before applying, so recovery can tell whether it was
   already folded. Commit lane outcomes and deletions in the same phase as the artifact commit,
   applied on EVERY fold exit including `emit`. Iterative-fold executors record submission
   identity in their own register and ignore a duplicate.

4. **Plan draw — REFUTED. A blanket replacement halt is wrong; the policy must be
   branch-sensitive.** The premise holds: `findFirstActionableObligation` skips a missing def and
   continues (`obligationEngine.ts:63-68`), so an exclusion filter steps OVER a host boundary. But
   of 25 definitions, 13 have bespoke policy bodies and EIGHT are HYBRID — host on one branch,
   deterministic on another: `external_analyzers_current`, `graph_enrichment_current`,
   `intent_equivalence_current`, `charter_extraction_current`, `charter_delta_current`,
   `charter_clarification_current`, `systemic_challenge_current`, `synthesis_narrative_current`.
   Counterexample: `planCommand.ts:4-10` passes no acquisition option, so
   `pendingAnalyzerConsent` returns `[]` (`hostInputPause.ts:96`) and the obligation takes its
   DETERMINISTIC arm. A blanket halt stops `plan` at a boundary that does not exist on that run.
   Also: this record's exclusion list MISSES `critical_flow_fallback_current`,
   `intent_checkpoint_current`, `intent_equivalence_current` and `systemic_challenge_current`, and
   it OVERSTATES consent persistence — only declines are durable; grants modify the run-scoped
   token (`:428-450`).
   **There is no halt outcome.** `ObligationOutcome` is exactly `transition | emit`
   (`obligationEngine.ts:109-111`), so a halt is an `emit` with a stated step. And `plan` has TWO
   output shapes at HEAD — the accumulated last deterministic result after progress
   (`advance.ts:644-699`), and, entered at a no-runner boundary, the host executor with the exact
   summary `Executor <id> is selected and requires its bound host step.` (`:406-443`). A generic
   halt changes the first.
   **Replacement landing:** preserve every id, `derive` closure, membership and priority position;
   enumerate all 13 bespoke ids; give the eight hybrids a PURE, branch-sensitive plan policy that
   runs deterministic arms and halts only when the live branch needs host work or would consume or
   persist host input; retain the last `AdvanceAuditResult` so both output shapes survive.
   Decide EXPLICITLY whether entry-at-a-hybrid-boundary is preserved or corrected — HEAD detects
   the pause after dispatch (`:684-699`), so a call entering there runs its deterministic runner
   first, and both cannot be claimed at once.
   One hazard is CLOSED: a satisfied obligation does not become actionable under a replacement
   view, because selection derives state before `execute` and admits only `missing`/`stale`
   (`obligationEngine.ts:313-320`).
   Residual: the classifier cannot "peek" by calling today's handlers — several poll, quarantine,
   apply, unlink, persist and ledger-record before returning a branch decision (`:1363-1393`). So
   either the classifier is pure, or the policy bodies split into classify and apply halves.

5. **Cap unit — STANDS, with its stated invariant corrected.** Charge every obligation execution
   to the slot. But **"slots and engine transitions return to 1:1" is FALSE**: an `emit` returns
   before the counter (`obligationEngine.ts:321-323`), so an emitting execution spends a slot and
   no transition budget. The true and sufficient invariant is
   **`engine transitions <= charged executions`** — if every execution takes a slot, every
   transition took one first, so the engine cannot reach `cap + 2` before the execution cap.
   The alternative (enlarge the headroom) is worse: policy obligations LOOP — charter
   clarification and systemic challenge (`:2440-2475`), host-result ingestion (`:2547-2616`) — and
   no fixed headroom bounds a loop. Note the margin today is TWO
   (`ENGINE_TRANSITION_HEADROOM = 2`), so three uncharged policy transitions already invert the
   ordering.
   Must add: ONE wrapper owning both charging and cap enforcement over every definition; a
   structured, resumable cap halt for policy bodies, which return only transition state
   (`:2293-2297, :2519-2524`) and have no cap field in `AdvanceAuditResult`
   (`advanceTypes.ts:91-100`); and an explicit supersession of the "64 dispatches" contract,
   reframing `tests/audit/advance-drain-loop.test.ts:179-254` — its fixture has no policy
   transitions, so it stays green either way and its MEANING changes while its number does not.
   The mixed acceptance test: four policy-only transitions plus a perpetually-actionable
   state-changing executor; assert exactly 64 executions, resumable, no engine-bound stop.

6. **Synchronous children in the hold — unchanged as a judgment, and CHEAPER than stated.**
   The mechanism is confirmed: the heartbeat is a `setInterval` (`fileLock.ts:204-211`) and
   `spawnSync` (`exec.ts:359`) blocks the event loop, so a synchronous child outliving
   `STALE_LOCK_MS` (30 s) lets another process steal a lock the holder still believes it holds.
   Reachable into today's hold via `autoFixExecutor.ts` and `syntaxResolutionExecutor.ts`.
   **The fix is one option at one call site, not a new facility:** `runTracked` already forwards
   `timeout` to `spawnSync` (`exec.ts:363`); `localCommands.ts:164-168` simply omits it.
   Contention cost of the single outer hold, now measured: a concurrent CLI blocks up to
   `DEFAULT_TIMEOUT_MS` = 10,000 ms (`fileLock.ts:27`) before `FileLockTimeoutError`.

**One correction to this record's own preservation constraints.** The in-place mutation hazard is
real — `handleDesignReviewBranch` aliases and mutates `bundle.design_assessment`
(`:1083, :1141-1143, :1176-1197`) while both derive caches key on bundle identity
(`:2266`, `advance.ts:787`). But this record attributes "nested objects included" to the
memoization, and the memoization does not require it: a shallow `{...bundle}` mints a fresh key and
re-derives correctly. Keep the requirement; its real reason is ALIASING, so an earlier carry cannot
observe a later mutation. Stated wrongly, the next lap satisfies it with a shallow copy and
believes it satisfied both.

**And the constraint-3 acceptance test does not exist on disk.** This record says it was written
and RED at a count of 3. It is not in the tree, not untracked, and not among the nightly proposals.
The mechanism above is precise enough to re-derive it, but the count of 3 is unverifiable from the
repository until someone does. Re-derive before quoting the number again.

## Preserve list (report + refuter union)

Deterministic frontier draining within one call; every host-input stop boundary; exactly-once
`preferredExecutor` execution; lock/heartbeat behavior; one consolidated staleness record per call;
advisory delivery on the next emitted host step; the plan draw's semantics; marker-protocol
reachability for filesystem-watching hosts; failure attribution to the executor that failed.
