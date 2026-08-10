# Routing removal — the separation pass, corrected against source (2026-08-09)

Design record for the FIRST implementation step of the routing-removal directive
(`CLAUDE.md` → *audit-tools does NOT route*; program in
[`forward-tracks.md`](../backlog/forward-tracks.md)). The cut is decided — **(c) one execution
adapter, no backend choice at all**. This record settles *where the separation seam actually is*,
which the directive left open, and it exists because the obvious answer is wrong.

Method: seven parallel area maps over `src/shared/{quota,providers,dispatch}`, both draws' consumers,
the kept-metadata contract and the gate surface → one synthesized plan → four adversarial refuters
(kept-set independence, split-point reality, retirement collisions, first-commit greenness). All four
refuters landed hits. Every claim reproduced below was then re-verified by reading the cited code at
`48de5485`; claims that did not survive that re-read are recorded here as refuted rather than
dropped.

---

## The correction, in one line

**The admission seam already exists; the SIZING seam does not — and sizing is where reporting is
actually coupled to routing.**

The synthesized plan opened by claiming the post-cut path is already the conversation-first default:
`src/audit/cli/dispatch.ts:706` branches on `hostOwnedDispatch`, the `true` arm grants every packet,
creates no lease and sets `declaredCap = null`, so "separation is mostly naming the branch that
already exists." That is true of **admission, leases, caps and the wall**, and false of everything
that decides **how big a unit of work is**. Four sizing values on the kept side are computed *from*
pools, a roster, or a `ResolvedProviderName`:

| Kept value | Where it is produced | The routing input |
|---|---|---|
| Audit packet partition | `dispatch.ts:460` ← `contextBudgetTokens` | `probeBudget` runs `computeDispatchCapacity` over a `CapacityPool` (`dispatch/quotaPool.ts:166-176`) |
| Remediate block partition | `phases/plan.ts:749` ← `resolvePlanContextBudget` | roster-capability max (`plan.ts:800`), then provider-scoped statics (`plan.ts:802`) |
| `model_hint.tier` per packet | `dispatch.ts:661-665` | cut points from `computeDynamicRoutingTiers(risks, rankCount)` (`dispatch.ts:538-560`) |
| `oversized_packet` warning | `dispatch.ts:791-793` | `waveSchedule.confidence` + `tierBudgets` (`dispatch/packetFilter.ts:227-242`) |

So the separation the directive asks for is **not file motion**. It is: give sizing a single declared
window that owes nothing to a pool, a roster or a provider name. Everything else in the sequence is
downstream of that.

---

## Verified findings

Each was re-read at `48de5485` after the refuter raised it.

### 1. Packet sizing is a pool round-trip

`dispatch/quotaPool.ts:166-176` — `probeBudget(pool)` calls `computeDispatchCapacity({pools:[pool]})`
and reads `probe.primary.schedule.resolved_limits`. Its output is `contextBudgetTokens`, which is the
*sole* sizing input at `dispatch.ts:460`. On the roster path (`quotaPool.ts:200`) the number is
`Math.max(...tierBudgets)` — the most capable declared rank's window, i.e. a capability-rank max.

**But the underlying resolver is clean.** `resolveLimits` (`src/shared/quota/limits.ts:141-225`)
consults `providerName` at exactly one place — `hostClassFor(providerName)` at `:221` — and only to
choose between the `provider_default` and `default` *labels*; the returned window pair is `defaults`
either way. The window pair is genuinely provider-independent. That is what makes the first commit
possible.

### 2. Remediate sizes blocks off a capability rank and a provider name

`phases/plan.ts:787-800` maps `caps.models` (the declared host model roster) to per-model budgets and
returns `Math.max(...rosterBudgets)`. Only when the roster is empty does `:802` run
`resolveModelStatics(caps?.model_id, sessionConfig?.host_provider)` — and the provider argument is
load-bearing, not decorative (`quota/modelStatics.ts` resolves cheapest-on-collision without one,
pins that provider's statics with one). `host_provider` is typed from `PROVIDER_NAMES`
(`types/sessionConfig.ts:4`), the constant cut (c) deletes.

**One-core-two-draws violation, incidentally:** the audit draw already resolves statics
provider-free (`limits.ts:169` calls `resolveModelStatics(hostModel)` with no provider). Only
remediate passes one. The draws disagree about the same question today.

After C8/C10 remove provider selection and the roster, `plan.ts:800` and `:802` both degrade to the
`:809-815` throw — planning would refuse resumably for every host that reported a roster or a model
id rather than an explicit scalar pair, which is the common conversation-first case.

### 3. `src/audit/cli/dispatch.ts` is loop-core — the first commit is not free

`src/shared/loopCorePaths.ts:32` — the first entry in `LOOP_CORE_PATTERNS` is the exact string
`"src/audit/cli/dispatch.ts"`, matched by equality (`loopCorePaths.ts:59-69`), and
`.claude/hooks/pre-commit-gate.mjs` fails closed without a staged-tree-bound attestation. Every
commit in this sequence carries one, including the first.

### 4. The reporting arm is NOT the audit main path

`prepareDispatchArtifacts` has three callers. Only `semanticReviewStep.ts:102` passes
`hostOwnedDispatch: true`. `prepareDispatchCommand.ts:81` — the `audit-code prepare-dispatch` verb,
the conversation-first packet entry point — passes nothing, and `dispatch.ts:692` reads
`params.hostOwnedDispatch === true`, so `undefined` takes the **admitted** arm.
`rollingAuditDispatch.ts:421` passes `grantLeases:false` and `recordAttemptedGrant:false` but never
`hostOwnedDispatch`, so it takes the admitted arm too.

Two of three callers take the arm the plan called dead-by-default, and one of them is the primary
path. The remediate draw genuinely is as described (`nextStep.ts:2073` threads the flag) — **the
asymmetry between the draws is the finding.**

Consequence: "delete the admitted arm and what only it imports" does not reduce to deleting unused
code. It deletes the path `prepare-dispatch` uses today.

### 5. The reporting arm imports the routing half anyway

`dispatch.ts:710` — the `true` arm's first statement is `computeDispatchCapacity(...)`, from
`src/shared/quota/capacity.ts`, inside the range slated for deletion. Its `waveSchedule` output feeds
the KEPT `collectOversizedWarnings` at `:791-793`. So the "reporting arm needs zero imports from
`quota/capacity`" success criterion is falsifiable at HEAD, before any commit is written.

### 6. `attributionContract.ts` is a first-class blocker — and it is HANDOFF item 2's declared input

`src/shared/types/attributionContract.ts:9-11` imports `PROVIDER_NAMES`; `:26-34` builds
`RESOLVED_PROVIDER_NAMES` and `ResolvedProviderNameSchema` from it; `AttributionTripleSchema` is
`{provider, model, rank}` with `provider` validated against that set. `HANDOFF.md:177-181` declares
this file already on main (`14677902`) and states *"The contract is INPUT, not output… The run is the
WIRING."*

Deleting `PROVIDER_NAMES` stops it compiling. Worse: under cut (c) the provider axis is single-valued
by construction, so `deriveAggregates`'s provider→model→lens indexing collapses and the run's central
question — *which backend produces findings that survive* — is **voided, not re-pointed**. HANDOFF
accepts only the narrower break (the triple resolving from `CapacityPool`). This one is new and is an
owner call.

### 7. Self-spawn safety has no replacement in the candidate survivor

`spec/backend-identity-axes.md:10-11,46-56,82` states self-spawn safety as an invariant that
explicitly SURVIVES dispatch inversion. Its mechanism is `buildSelfSpawnExclusion`
(`providers/dispatchExclusion.ts:23-43`), whose four production consumers are all in the routing
wiring being deleted (`pausePersist.ts:338`, `nextStepHelpers.ts:2425`, `nextStep.ts:1370,2115`).

`workerCommandProvider.launch` (`providers/workerCommandProvider.ts:23-33`) spawns
`task.worker_command[0]` through `spawnLoggedCommand` with **no** `isSelfSpawnBlocked` check. Since
`worker_command` is operator-declared argv that can name the active host CLI, collapsing to that
adapter replaces a mechanical recursion refusal with nothing — the exact *enforce in tooling, never
host discretion* class `CLAUDE.md` forbids.

---

## Refuted claims — recorded so they are not re-proposed

- **"Only `prepareDispatchCommand.ts:81` reaches the admitted arm."** Two callers do (finding 4).
- **"The reporting arm's import set is zero from `quota/capacity`."** It is not (finding 5).
- **"`estimated_wave_tokens` is an independently reporting field."** `quota/scheduler.ts:874` computes
  it as `sumTopN(slotsSorted, waveSize)` over the wave the scheduler *chose*. It dies with wave
  sizing and must be re-sourced from the plan's own per-item estimates.
- **"Force `canDispatchImpl` false at `nextStep.ts:2073` to make the routing branches unreachable."**
  Inverted — `false` routes into `driveRollingImplementDispatch` (`nextStep.ts:2132`), the most
  routing-dense path in the file; `true` is host-owned (`:2172`). And `nextStep.ts:2085-2131` builds
  pools unconditionally and *consumes* `canDispatchImpl` at `:2113/:2116`. There is no one-line kill
  switch here.
- **"`detectRequestTooLargeError` is load-bearing for packet sizing."** No packet-sizing module
  references it; its only consumers are `providerLaunchFinalize.ts:137,173` inside the deleted
  cascade. It goes with the cascade.
- **"`sumWaveTokenUsage` can be lifted out and routed to the scorecard."** It has exactly one
  consumer, inside the deleted fold; `scoreTokens.ts` aggregates ledger rows itself. Lifting it
  leaves a zero-consumer export that `check:deadcode` fails on. Delete it, or name a new consumer as
  an explicit deliverable.
- **"The tier→pool capability gate enforces nothing on either draw."** `quota/apiPool.ts:447-448`
  prefers the declared `source.capability_rank` (`types/sessionConfig.ts:567`) and uses the passed
  map only as a fallback. Passing `capabilityRanks: null` removes the fallback only. The floor is
  unfed *in this checkout* because `~/.audit-code/sources-declared.json` is empty — an environment
  fact, not a code property. Do not record it as an invariant.
- **"The claim substrate guards state mutation, not dispatch."** `dispatch.ts:346` constructs a
  `ClaimRegistry` at dispatch time and `:375-377` merges the owner-token sidecar that feeds the
  shipped merge-time ownership gate. `forward-tracks.md:237-240` is a settled owner decision — *the
  claim STAYS at dispatch time… Do not re-raise it.* `dispatch.ts:267-405` must be classified as
  coordination that survives in **both** arms.
- **Two citations in the synthesized plan do not resolve:** `auditStep.ts:193,224` (the registry is
  at `:168`) and `nextStepHelpers.ts:2434` (that is `buildAuditSourcePools`, not `buildDispatchPool`).
  Re-resolve every citation before any of this is frozen into a gated registry — a wrong row in a
  gate is worse than no row, because the gate makes it look verified.

---

## The corrected sequence

Separation only. Nothing below deletes a live mechanism; the collapse (one adapter, `PROVIDER_NAMES`,
the driver tree) is a second pass, gated on the owner questions at the end.

**S1 — Give sizing one declared window.** Replace `probeBudget`'s `computeDispatchCapacity` round-trip
(`dispatch/quotaPool.ts:166-176`) with a direct `resolveLimits` call against the handshake /
models.dev rungs, which finding 1 establishes is provider-independent. `contextBudgetTokens` stops
being pool-derived; pools keep being built for the admitted arm, so nothing is deleted.
Behaviour-preserving on the single-pool path. On the roster path `Math.max(...tierBudgets)` becomes
the single declared window — a deliberate, stated change, and the first place a red-green test must
pin the new number.

**S2 — Mirror it on the remediate draw.** `resolvePlanContextBudget` (`phases/plan.ts:772-817`) drops
the roster-capability max at `:800` and the provider argument at `:802`, resolving the same single
declared window as S1. This is the draw-parity half of S1 and closes the statics-provider asymmetry
noted in finding 2. The resumable refusal at `:809-815` stays — it is the correct behaviour when no
window is declared, and it is what stops S2 from silently sizing off a guess.

**S3 — Re-source the three remaining routing-derived reporting values**, each with its replacement in
the same commit (atomic-replace): `model_hint.tier` cut points pinned to the static
`DEFAULT_DEEP/STANDARD` constants (accepting that emitted hints move on roster runs — state it in the
commit); `collectOversizedWarnings` re-thresholded on the S1 window with the `confidence === "low"`
emission gate dropped; `estimated_wave_tokens` summed from the plan's own per-item estimates.

**S4 — Extract the three branch bodies in `dispatch.ts`.** NOT a top-level selector — that cannot
typecheck, because the required fields of `PrepareDispatchResult`
(`cli/dispatch/types.ts:62-104`) are produced by unconditional work outside both arms, and making it
work means duplicating ~519 lines (which would also consume ~54% of the tree's jscpd headroom).
`prepareDispatchArtifacts` stays the sequencer owning `:268-690` and `:759-854` in place; extract only
`:706-717`, `:718-757` and `:856-928` into three functions taking an explicit context object. Watch:
`admission`/`admissionPackets` declared at `:698-704` become unread in the reporting body →
`check:lint` (`no-unused-vars`, error); and `:826-854` must not move across `:872-928`, because
`replaceActiveDispatchForRun` before `advanceHostDispatchPause` is load-bearing ordering pinned by
`tests/audit/rolling-audit-dispatch.test.ts:509` (CP-NODE-6).

**S5 — Flip `cmdPrepareDispatch` to `hostOwnedDispatch: true`** and prove a full audit run still
completes. Until this lands, the reporting arm is one narrow step's path (finding 4) and no later
deletion argument holds. This is the commit that actually makes the surviving path the default.

**S6 — Give the orphan-risk metadata a consumer before its routing readers die.** `model_hint`,
`estimated_input_tokens`, the per-task fit fact and the file-ownership sub-waves all lose their
in-tool readers in the collapse. Emitted into the step contract in the same commit that removes the
reader, or they become write-only data that still looks authoritative.

**Definition of green for every commit above:** `npm run build`, `npm run check`, `check:lint`, and
the five audit test files that call `prepareDispatchArtifacts` directly
(`rolling-audit-dispatch`, `dispatch-features`, `dispatch-owner-tokens`, `host-model-roster`, `dc4`)
— plus a staged-tree loop-core attestation on each. Gates that cannot fire here:
`check:doc-code-citations` strips the line suffix before resolving, `check:guard-reach` already claims
`src/**`, `knip.json` sets `ignoreExportsUsedInFile:true`, and no commit above adds a module so
`check:depgraph` sees no new cycle.

**Deferred deliberately:** a declared-data boundary registry (the `guard-reach-data.mjs` idiom) was
proposed as an early commit and is held back — the classification is still moving, and a wrong row in
a gated registry reads as verified. If it is built later it must key on file globs plus exported
symbols, never line ranges, which C1/S4 invalidate by construction.

---

## Owner questions

These gate the **collapse**, not S1–S6. Each is a genuine call, not a re-litigation of the cut.

1. **Does the observability run's provider dimension survive cut (c)?** `attributionContract.ts` is
   HANDOFF item 2's declared input and cannot compile without `PROVIDER_NAMES`; under one adapter its
   provider axis is single-valued, so *which backend produces surviving findings* is unanswerable.
   Options: re-scope the run to model×lens; keep a provider axis as a free-text recorded label with
   no enum; or park item 2 until the collapse lands and re-author it afterwards.
2. **Where does self-spawn refusal live post-collapse?** The spec makes it an invariant that survives
   dispatch inversion, and the candidate survivor has no check. Options: the surviving adapter gains
   the check in the same commit that deletes `dispatchExclusion.ts`; or the spec invariant is
   explicitly retired.
3. **The one adapter's name.** `worker-command` currently means both the subprocess adapter class and
   the "no automated backend, the host does this manually" sentinel (`semanticReviewStep.ts:82`,
   `envelope.ts:80-85`, `operatorHandoff.ts:203-204`). Keep the collision; rename the adapter; or
   retire the name from the reporting sites entirely.
4. **Does a residual quota report survive?** The `audit-code quota` verb reaches its answer *through*
   `buildDispatchPool` and prints a pool capacity preview; the learned `tokens_per_pct` slope
   (`quota/state.ts:225-497`) is keyed on `providerModelKey` and documented as admission's exchange
   rate, so it has no consumer once admission is gone.
5. **Persisted run state carrying routing fields** (`transient_admission_refusals`,
   `partial_completion_terminal` with `empty_pool`/`quota_paused`, `hybrid-settled-pools.json`,
   `dispatch-quota.json`, `quota-state.json` keyed `provider[#account]/model`): hard-fail, tolerate
   and ignore, or one-time migration. The in-flight observability run is live state under exactly
   this question.
