# Capability evidence as an obligation, not a fail-open — plan (2026-07-18)

**Owner decision (2026-07-18):** a dispatch pool with no capability evidence must be **pinned down** —
by LLM judgment or by asking the operator — never silently routed around. Replaces the silent fail-open
at the admission capability floor.

Sequencing decision: fix the composition FIRST, ranker second — the invariant must hold whether or not a
ranker ever lands. Context: [`model-capability-ranking-sources.md`](../model-capability-ranking-sources.md).

**Revised after independent adversarial review** (v1 → v2). The review REFUTED three v1 claims; the
corrections are folded in below and the superseded reasoning is kept where it explains why v2 differs.

## The defect — stated precisely (v1 OVERSTATED this)

`FLOOR_MAX_BAND = { deep: 0, standard: 1, small: 2 }` (`admissionLoop.ts:318`) gates **eligibility** by
packet tier. An unranked pool bands to `null` (`bandOf`, `:298-308`) and fail-opens (`:324-333`) ⇒
**eligible for `deep` work it may be entirely unfit for.** That is the real harm, and it is what this
change fixes.

**v1 claimed the defect was "cost-first ranking puts them first." That is a DIFFERENT mechanism and this
plan does not fix it.** `costFirstCmp` (`:397`) is
`a.costRank - b.costRank || b.capabilityRank - a.capabilityRank || capabilityScoreCmp(a,b)` — cost
dominates absolutely, capability is only a tiebreak, and λ defaults to 0. After this change a cheap weak
pool **still wins `standard` work on price**. That is cost-first routing working as designed
(cheapest *eligible*), not a bug — but the plan must not claim to fix it.

Three distinct mechanisms produced the observed symptom:

| # | Mechanism | Status |
|---|---|---|
| 1 | unranked ⇒ fail-open ⇒ eligible for `deep` | **THIS PLAN** |
| 2 | `cost_per_mtok: 0` ⇒ sorts first among eligible | by design; **largely obviated — see below** |
| 3 | `top_k` truncates alphabetically (no score to sort by) | resolved by the ranker, not here |

### Owner clarification (2026-07-18): forcing rankings obviates most of mechanism 2

**Because the gate FORCES every pool to be pinned, there is no unranked pool at dispatch time** — the
fail-open branch stops being the operative path. Consequence the v2 scope note missed: with all pools
scored, `scoreBand` terciles them and `FLOOR_MAX_BAND.standard = 1` means the **bottom tercile is
excluded from `standard` too**, not only from `deep`. A weak free pool is pushed down to `small` work by
ELIGIBILITY, with no change to ordering. So most of what v2 declared out-of-scope arrives as a
consequence of this plan rather than needing a separate ordering change.

**The scope question is therefore withdrawn and implementation is UNBLOCKED.**

**Residue — a DIFFERENT failure mode, deliberately not solved here.** Banding is **relative**: terciles
are computed over the pools actually present, and `band <= Math.max(FLOOR_MAX_BAND[tier],
bestAvailableBand)` (`:334`) deliberately admits the best available pool however bad it is (the
anti-`no_capable_pool` guard). **So if every pool is weak, ranking them all still routes `deep` work to
the least-weak one.** Forcing rankings guarantees you know the ORDERING; it does not guarantee anyone is
good enough. Whether an ABSOLUTE capability floor is wanted is a genuine open question — but it wants
live data from a ranked run first, so it is explicitly deferred, not forgotten.

## Design

**Shape: mirror `intent_checkpoint`** (`src/audit/cli/confirmIntentStep.ts`) — tool seeds → LLM refines
with repo access → operator confirms in one round → typed input file → obligation clears. Not a new
mechanism.

**The obligation.** Gate-0's predicate (`state.ts:104-116`) gains a second delta beside
`newlyReachableBackends`: a reachable pool whose capability lookup does not resolve ⇒ `stale`.

**What clears it — three paths, all recorded:**
1. External evidence (a ranker populated `capability_rank`) ⇒ satisfied, gate never fires.
2. LLM proposes a **relative ordering** among unranked pools; operator confirms or reorders.
3. Operator declares a pool **unrankable, accept at band X** — the explicit escape.

**Define "evidenced" as "the join resolves"** — the same lookup dispatch uses, not a parallel predicate.
This is the v2 fix for the review's strongest hit (below): it makes an unjoinable pool visible at design
time rather than as an infinite re-prompt in production.

**Relative, never absolute.** The statement is an ORDERING, same shape as `cost_order`
(`admissionLoop.ts:266-279`; CLAUDE.md "never a named-model→tier map"). An LLM may rank pools against each
other; it may NOT invent an absolute score. Externally-sourced absolute numbers (OpenRouter) are fine —
someone else maintains them.

**Autonomous mode.** LLM judgment stands, recorded, no pause — consistent with the delta-only auto-confirm
scoping (`nextStepHelpers.ts:1478-1488`).

## The change — inject at CONSTRUCTION, not at the floor (v2)

**v1 proposed editing `bandOf`'s null branch. That was the wrong layer.** There are **five** floor
construction sites — `quotaPool.ts:332`, `waveScheduling.ts:317`, `admissionLoop.ts:643`,
`rollingDispatch.ts:636`, `rollingDispatch.ts:838` — and because the behavior is fail-open, **an unwired
site is indistinguishable from a working one**. v1's own red-green would have passed with three unwired.

Instead, add a rung to `capabilityScore` where the pool is BUILT, exactly symmetric to the
`confirmedPosition` rung `deriveCostRank` already takes one line above (`admissionLoop.ts:143`):

```js
// admissionLoop.ts:146 — today
capabilityScore: pool.capability_rank ?? null,
// v2
capabilityScore: pool.capability_rank
  ?? lookupConfirmedCapability(confirmedCapabilityRanks, pool.model)
  ?? null,
```

`scoreBand` picks it up unchanged. **All five floor sites, both draws, and the in-process engine inherit
by construction.** Decisively for a loop-core change: `src/shared/dispatch/` banding logic stays
byte-identical, shrinking the attestation surface to data plumbing.

**Two construction sites, not one** — `admissionPoolsFromSummaries` (`:130-161`) and the `CapacityPool`
stub in `buildCapacityPoolCapabilityFloor` (`:348-379`), which builds its own `AdmissionPool`s. Both need
the lookup or audit and remediate drift.

**The join key is already settled** — v1 wrongly treated it as open. `readConfirmedCostPositions` returns
a model-keyed map merged across `provider_pool` + `host_model_cost_order` + `source_pool_cost_order`
(`sharedProviderConfirmation.ts:1016-1050`), and `:143` joins it on `pool.model`. Capability joins
identically. v1 conflated the **gate** keyspace (four keyspaces — genuinely open) with the **dispatch**
keyspace (settled).

## v3 delta — premise re-verification against HEAD (2026-07-18, pre-implementation)

Two independent verification passes against HEAD. Ten of twelve v2 code claims CONFIRMED verbatim.
Three corrections, one of them scope-changing:

**1. Touch point #5 is not implementable as written (material).** `buildCapacityPoolCapabilityFloor`
(`admissionLoop.ts:348-379`) takes `{id, rank?, declaredCapabilityRank?}` — it **never sees a model**,
so `lookupConfirmedCapability(..., pool.model)` cannot be applied there. v2's "both construction sites"
fix only works at one of them.

**2. The correct injection point is upstream, at the CapacityPool constructors.** Both live in
`src/shared/quota/apiPool.ts`: `buildHostModelPool` (`:206`, literal `:218-232`) and `buildSourcePool`
(`:305`, literal `:326-367`). Stamping `declaredCapabilityRank` there — joined on `CapacityPool.hostModel`,
which BOTH constructors already derive (`:221`, `:335`) and which is universal where `source.model` is
optional-and-never-defaulted (`sessionConfig.ts:386`) — makes the confirmed rank part of the pool's
identity. Both downstream floors then inherit with **zero further change**: the summary path already
carries it (`capacity.ts:709` → `:755` → `admissionLoop.ts:146`), and the engine path
(`rollingDispatch.ts:636/838`) reads `declaredCapabilityRank` off the `CapacityPool` directly. A
summary-level join — v2's approach — leaves the **in-process rolling engine on registry ranks only**.
Cost: 9 signatures across 6 files, plus a `root` param on `gateHostFanout` (`hostFanoutGate.ts:200`, has
`artifactsDir` but not `root`) and on `cmdQuota` (`quotaCommand.ts:63`, argv-only). Both are one field,
not a chain. `readConfirmedCostPositions`'s existing loader sites all have `root` in scope, so one
combined reader serves both maps off a single `readSharedProviderConfirmation` parse.

**3. NEW — host pools carry NO capability evidence at all today.** `declaredCapabilityRank` has exactly
one writer (`apiPool.ts:358`, source pools); `buildHostModelPool`'s literal omits the field entirely. So
every host pool bands to `null` and takes the fail-open branch (`:307` → `:324`) on **every ordinary
single-host wave**. v2 never noticed this. It is in scope by the owner's decision — the host is a pool
with no capability evidence — but it expands what the gate prompts for, in the common case.

### Owner decision on the host pool (2026-07-18) — it is not a special case

The framing "the host pool is unevidenced, so it must be pinned" is **wrong**, and the three options
built on it were all rejected. **The host knows what it can dispatch, and the host's models are ranked
exactly like every other model.** A host pool is not evidence-less by nature — it is evidence-less only
because nothing currently looks its model up. `buildHostModelPool` already derives its model
(`parseProviderModelKey(params.poolKey).model`, `:221`) and `buildHostModelPools` fans out one pool per
`HostModelRosterEntry`, each with a real model id.

So the fix at `buildHostModelPool` is the **same join as every other pool**, resolving through path 1
(external evidence) with no operator interaction: a ranked roster clears the obligation silently. The
gate therefore fires only for pools whose model resolves in NO rank source — which, once the ranker
lands, is the genuinely-unknown tail, not the common single-host run. No host special-casing, no
seeded-best-band proposal, no exemption.

**4. Minor.** The "no zod here" trap has its mechanism backwards: `provider_pool` passes through the
parser wholesale (`sharedProviderConfirmation.ts:884`), so a new *pool-entry* field survives the read
path; the round-trip drop is caused solely by `toPersistedPoolEntry` (`:247-253`). `backendGateKey` is
defined at `:471`, not `:570` (that is a call site). Attestation surface is larger than v2's
"data plumbing" claim: `state.ts`, `admissionLoop.ts`, `rollingDispatch.ts`, `apiPool.ts`, `capacity.ts`,
`waveScheduling.ts`, `quotaPool.ts` all match `LOOP_CORE_PATTERNS`.

## Touch points

| # | File | Change |
|---|---|---|
| 1 | `src/shared/types/providerConfirmation.ts` | `PersistedPoolEntry` has no capability field — add one (optional). `SourcePoolCostEntry.capability_rank` already exists and is **write-only in the confirmation copy** (`providerConfirmation.ts:413` writes; no reader) — read that field rather than adding a parallel channel. **NB:** `capability_rank` on `DispatchableSource` is a *different, live* field (`apiPool.ts:358` → `capacity.ts:755` → `admissionLoop.ts:146`); do not conflate them. |
| 2 | `src/shared/providers/sharedProviderConfirmation.ts` | extend `toPersistedPoolEntry` (`:247`) + `parseSharedProviderConfirmation` (`:843`); add `readConfirmedCapabilityRanks()` beside `readConfirmedCostPositions` (`:1016`). |
| 3 | `src/audit/orchestrator/state.ts:104-116` | extend the Gate-0 predicate with the precomputed delta, defined over the join lookup. |
| 4 | `src/audit/cli/nextStepHelpers.ts:1469-1504` + `providerConfirmationStep.ts` | emit/consume branch + the prompt asking for a relative ordering. |
| 5 | `src/shared/dispatch/admissionLoop.ts:146` **+ `:348-379` stub** | the `capabilityScore` rung. **No change to `bandOf` or the banding logic.** |

**Both draws:** audit is the single WRITER (`intakeExecutors.ts:130-135`); remediate a pure consumer
(`marshal.ts:418,421`). Gate stays audit-side, remediate rejoins by reading — the existing `cost_order`/λ
split. No fork.

## Traps (each verified, several found by the review)

- **The model-less pool re-fires forever.** The gate key is `backendGateKey(modelId, provider)` =
  `model_id ?? provider` (`sharedProviderConfirmation.ts:570`), but the dispatch join is `pool.model`
  (`costRank.ts:283-290`). A pool with **no** `model` gets a gate key but is unjoinable by the model-keyed
  lookup ⇒ operator answers, it persists, it cannot attach ⇒ predicate still sees no evidence ⇒ **infinite
  re-prompt**. v2 answers this by defining "evidenced" as "the join resolves" and requiring escape (3) to
  be recorded under a key the join can reach. [[gate-must-be-traced-not-designed]]
- **Stale input file short-circuits the gate.** `execute` calls `readProviderConfirmationInput`
  **first, unconditionally** (`nextStepHelpers.ts:1472-1475`) before consulting the gate — a leftover input
  on disk skips straight to `runDeterministicExecutor` and the capability prompt never emits. Harmless for
  reach (the executor fail-closed-excludes); for capability it would promote with no statement.
- **Livelock: v1's mechanism was WRONG, the conclusion survives.** `MAX_DRAIN_STEPS = 64`
  (`advance.ts:48`) returns `{kind:"emit"}` at `:420` — a **graceful halt**, not a crash; and
  `!result.progress_made` returns `emit` at `:416-418` **before** the cap check, so a non-progressing
  obligation exits after ONE iteration. The real failure is an infinite **operator re-prompt** on the
  attended path, not a drain spin. Escape (3) is still load-bearing — for that reason.
- **The floor cannot manufacture `no_capable_pool`** — `band <= Math.max(FLOOR_MAX_BAND[tier],
  bestAvailableBand)` (`:334`) always admits the min-band pool. Confirmed safe.
- **Precompute the delta in the CLI, never in `deriveAuditState`** — sync/pure, called ~20× including 3×
  inside the drain (`state.ts:70-86`); deriving reach there means 1,100+ spawns per `next-step`.
- **Read the gate BY REFERENCE** (`nextStepHelpers.ts:1310-1321`) — a stale read of `PRIORITY[0]`'s gate
  is a drain livelock. [[gate-state-must-be-mutable-not-frozen]]
- **Schema: no zod here.** `parseSharedProviderConfirmation` (`:843-894`) is hand-rolled, ignores unknown
  top-level keys, and `isPersistedPoolEntry` (`:803-808`) checks only `typeof value.name === "string"`. So
  wholesale-discard risk is near-nil — but the parser **reconstructs field-by-field**, so a new field is
  dropped on round-trip unless touch point #2 extends it. (v1 had the risk backwards.)
- **Remediate passes no `onFailOpen`** (`waveScheduling.ts:317` is a bare call) — its fail-opens are
  invisible, so there is NO baseline for how often this fires there. Wire it or the before/after is
  unmeasurable. [[silent-fail-closed-on-one-draw]]

## Sign convention — the example that contradicted itself

`capability_rank` is **LOWER = better** (`proxyCatalog.ts:350`). OpenRouter's `agentic_index` is
**HIGHER = better** (glm-5.2 43.1 strong, gpt-oss-120b 13.2 weak). v1 quoted the raw agentic numbers as
its motivating example while mandating the lower-better convention — internally contradictory in exactly
the place the plan flags as the trap. **Any ranker MUST invert, and that inversion needs its own
red-green test**; getting it backwards silently reverses routing.

## Red-green obligations

- Model-less pool: gate must NOT re-prompt forever (the review's concrete break).
- Sign: an inverted mapping must fail a test, not silently reverse routing.
- Both construction sites honor the confirmed rank (a test passing with only one wired is not a test).
- Additive schema: a `1.0.0` artifact WITHOUT the new field still parses and still yields cost order + λ.
- A pinned-weak pool is excluded from `deep` but still eligible for `standard` — the intended scope.

## Explicitly NOT in scope

Mechanisms 2 and 3 above (cost-first ordering among eligible pools; alphabetical `top_k`). The ranker
itself — decision 3, OpenRouter runtime-fetch → LiteLLM `model_info`, which `proxyCatalog.ts:159` already
ingests. This change holds with or without it.
