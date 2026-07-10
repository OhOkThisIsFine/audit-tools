# Cost↔speed dispatch dial — a tunable operating point on the cost/throughput frontier

Design of record for the operator-set **dispatch bias**: a single durable policy that slides
routing along the cost-vs-throughput frontier among *capable* pools. Pairs with
[`cost-first-routing.md`](cost-first-routing.md) (which owns `costRank`, the cost axis) and
[`audit/dispatch-admission-control.md`](audit/dispatch-admission-control.md) (the admission loop
`admitBatch` that consumes the ordering).

The cost-first router is **not replaced** — it is the **λ=0 corner** of this frontier
(cheapest-capable-fill = the minimum-cost solution). The dial adds the ability to move *off* that
corner toward throughput when the operator is willing to pay for speed.

## The frame

Among the pools *capable* of a packet (capability is a hard floor — see below), two independent
axes rank a pool:

- **cost** — `costRank` (dollars per unit work; `cost-first-routing.md`). Lower = cheaper.
- **throughput** — how fast the pool sustainably absorbs work (below). Higher = faster.

These axes trade off: the cheapest pool is rarely the fastest. The set of non-dominated
(cost, throughput) pools is a discrete Pareto frontier. The **dial** picks an operating point on
that frontier:

- **λ = 0** → pure cost. Identical to today's cost-first router (the frontier's min-cost corner).
- **λ = 1** → pure throughput. Route to the fastest capable pool regardless of price.
- **0 < λ < 1** → a blended operating point between the two.

The dial is **1D**: cost ↔ throughput, with **capability as a hard floor** (not a tradeable axis).
Whether *quality* also becomes tradeable (a true 2D dial needing a per-task quality-worth weighting)
is deferred — see *Deferred*.

## The throughput axis — concurrency, auto-derived (no declaration)

**Throughput is the pool's declared CONCURRENCY — how many packets it runs in parallel — and it is
auto-derived from what the provider already states. Nothing is learned, measured, or hand-declared.**

Two constraints shape this:

- *"Concurrency is declared or absent, never learned"* ([[concurrency-is-declared-or-absent-never-learned]]):
  an earlier dial sketch ranked speed against an AIMD adaptive concurrency ceiling, which was built,
  adversarially reviewed, and reverted. There is no learned ceiling, and we do not add a measured
  tokens/sec signal (the same class of learned dispatch signal C3-AIMD burned on).
- *A needed manual flag is a bug signal*: the operator must **not** have to
  hand-declare a per-pool rate to get correct speed routing. So the throughput signal must come from
  what is already known auto-magically, never from a new operator field.

The signal that satisfies both is the pool's **effective parallelism**, sourced auto from what the
provider already declares. But it must be derived **pool-class-aware**, because the naïve "read it off
`declaredCap`" is a trap: `declaredCap == null` (no in-flight cap) means *opposite* speeds on the two
pool classes — "hardware-parallel, genuinely fast" for a backend source, but "no subagent budget
declared ⇒ effectively sequential" for the conversation host. Reusing that one ambiguous sentinel for
the speed rank crowns the default zero-declaration host as fastest and lets it monopolize the wave at
λ=1 — the exact opposite of the dial's intent (a real defect, caught in adversarial review).

**`deriveThroughputConcurrency(pool)`** (higher = faster), keyed on the host-vs-source discriminator
`DispatchCapacityPoolSummary.is_conversation_host` (auto — a pool built from a backend
`CapacityPool.source` is a source; one without is the host):

- **Backend source** — an endpoint that accepts concurrent requests: `source.quota.max_concurrent` when
  declared (Codex 6, a NIM `max_num_seqs`), else **`+Infinity`** (uncapped ⇒ hardware-parallel ⇒ fastest;
  a local NIM server is HW-bound, and the operator's config is authoritative).
- **Conversation host** — its parallelism IS its subagent budget: `host_concurrency_limit.active_subagents`
  when declared, else **`1`** (unspecified ⇒ effectively SEQUENTIAL ⇒ ranks slowest). This is what stops
  λ=1 from crowning the default host over a metered parallel source — with **no** manual declaration.

So at λ=1 an uncapped/high-concurrency source out-ranks a sequential host, and the operator's dial toward
speed actually pushes work onto the parallel pool. `declaredCap` still separately feeds the hard in-flight
cap gate in the spill loop (unchanged); the throughput rank is its own pool-class-aware quantity, not a
reuse of the cap's ambiguous null. Declared rate limits (TPM/RPM) are **not** part of the throughput rank
(mixing a tokens/min magnitude with a concurrency count is unsound); their effect is already in the pool's
*budget* (the scheduler folds TPM into `remaining_token_budget`), which gates admission separately.
Capability is likewise a separate hard floor, not a throughput term.

**One builder, no drift.** Both orchestrators construct their `AdmissionPool[]` through the single shared
`admissionPoolsFromSummaries(summaries, confirmedCostPositions)` — audit summarizes its dispatch capacity,
remediate passes `schedule.capacity_pools`, both feed the same function that derives budget / declaredCap /
costRank / capabilityRank / throughputConcurrency / capacityTokens once. There is no per-orchestrator pool
map to drift (the earlier duplicated build sites are deleted).

**Future refinement (auto, not manual):** the deferred openai-compatible `/models` capability probe
(`docs/backlog.md`) can *discover* an endpoint's concurrency / context window at run time and feed it
here — a richer auto signal, still never a hand-declared rate. It must sanity-clamp a probed value
before it reaches the rank (a poisoned probe must not over-admit).

## Operating-point selection — ordinal blend (total order preserved)

`costRank` lives in disjoint numeric bands (confirmed / price / tier — `costRank.ts`); a $/Mtok value
cannot be linearly blended against a tokens/min value. So the blend is over **per-axis ordinals
within the current candidate set**, computed *after* the capability filter:

```
candidates   = pools.filter(capable(·, packet))        // capability hard floor, unchanged
costOrdinal   = rank of pool by costRank ascending       // 0 = cheapest
speedOrdinal  = rank of pool by throughputScore descending// 0 = fastest
blended(pool) = (1 − λ)·costOrdinal + λ·speedOrdinal
sort candidates by blended ascending, tiebreak capabilityRank descending
```

Properties:

- **λ = 0 ⇒ `blended = costOrdinal` ⇒ byte-identical to today's `costRank asc, capabilityRank desc`
  sort.** The current router is exactly this corner; the dial is additive and default-off.
- **Total order preserved.** Ordinals are dense integers over the same candidate set, so the blend is
  always a well-defined total order — no scale-mixing, matching the cost-first "no scale-mixing"
  invariant.
- **Frontier walk.** As λ rises, the blend's argmin walks the non-dominated (cost, throughput) pools
  from the min-cost corner toward the max-throughput corner — the LP-duality "pick λ → get an
  operating point" the frontier framing describes.

The blend enters at exactly one place — `orderCandidates` feeding the per-packet loop in `admitBatch`,
the single point where pool ordering is decided. Spill (walk to the next pool on budget/cap
exhaustion), the reservation ledger, and `ClaimRegistry` claim-before-assign are all unchanged: the
dial reorders *which pool is tried first*, never weakens a headroom or safety gate. The λ clamp coerces
a non-finite bias to 0 at this chokepoint, so no caller can make it emit a NaN comparator.

## Where the dial is set — Gate-0 durable policy

λ is a **durable policy captured once** at the `provider_confirmation` Gate-0 step (alongside the
cost ordering it already captures — `cost-first-routing.md`), **not** a per-packet menu (that would
tax conversation-first context and, per the routing rethink, risks livelock).

- Extend the `provider-confirmation-input/v1` schema (`src/shared/types/providerConfirmation.ts`)
  with an optional **`dispatch_bias`** ∈ [0,1], **default 0** (cost-first — backward compatible; an
  operator who says nothing gets today's behavior exactly).
- The deterministic executor persists it onto the shared confirmation artifact next to the confirmed
  cost order; it is read back at dispatch by the same `readConfirmedCostPositions` path (extended to
  also return the bias) and threaded into both build sites → `admitBatch`.
- **Headless** (`advanceAudit`, no CLI host) auto-completes with `dispatch_bias = 0`, so nothing
  blocks and the default is the safe cost-first corner.
- **Static policy, dynamic execution.** Gate-0 fixes the *policy* (λ); the router *realizes* it
  against the LIVE frontier every dispatch — declared limits, live budget headroom, cooldowns, and
  contention all shift under rolling dispatch and parallel IDEs, so λ is applied to whatever the
  candidate set actually is at admission time, never to a frozen Gate-0 snapshot. Same
  static-policy/dynamic-execution split as the cost-order confirmation.

## Free-pool maximization — falls out of the frontier

Price-0 pools have the minimum `costRank`, so at **every** operating point (any λ < 1) they are
first-fill before any paid pool — free capacity is saturated before paid capacity **automatically**,
a property of the frontier, not a new mechanism. "Saturated" means filled to the pool's declared
sustainable ceiling (`declaredCap` hard cap + rate limits + the reactive 429 floor) — **not**
flooded; the naive-free-flood failure mode is exactly what the declared-cap gate and reactive backoff
already prevent.

The real work of *free-pool max* — **registering** actual free sources (opencode-free, vertex-trial,
multi-account OAuth) as price-0 pools — is **out of scope for this dial** and belongs to the
arbitrage-tier track ([[arbitrage-dispatch-tier-design]], Phase 0 zero-ban-risk first, Phase 1
multi-account OAuth). This spec only guarantees that *once registered* a price-0 pool is first-fill,
which the existing `costRank` already delivers.

## Invariants

- **λ = 0 is behavior-identical to the pre-dial cost-first router.** The dial is additive; the
  default operating point is the min-cost corner. (Enforced by a test asserting the λ=0 admission
  order equals the pre-dial order on a mixed pool set.)
- **Throughput is auto-derived, pool-class-aware effective parallelism — never learned, measured, or
  hand-declared.** `deriveThroughputConcurrency` is a pure function of the declared source cap / host
  subagent budget + the `is_conversation_host` discriminator. No learned ceiling, no measured tokens/sec,
  no EWMA, and no new operator rate field (a needed manual flag is a bug signal).
- **One AdmissionPool builder.** Both orchestrators go through `admissionPoolsFromSummaries`; there is no
  per-orchestrator pool-construction map to drift.
- **Capability stays a hard floor.** The `capable()` filter runs first and is untouched; the dial
  ranks only among capable pools and never trades capability for cost or speed.
- **The dial reorders, never un-gates.** declaredCap, budget headroom (ledger), cooldowns, and
  claim-before-assign are all applied after the dial's ordering exactly as today.
- **Parity.** Both orchestrators derive the ordering through the one shared `admitBatch`; the bias is
  threaded identically via `computeDispatchAdmission`. They cannot drift.
- **No model→price or model→concurrency literal in backend code.** Throughput comes only from the
  provider's declared concurrency (or a future discovered probe), like `costRank`'s price (two-tier
  dependency policy).

## Deferred / open

- **Quality as a tradeable axis (true 2D dial).** Default recorded = 1D cost↔speed + capability
  floor. A 2D dial needs a per-task quality-worth weighting; revisit only on an owner call.
- **Free-source registration** (opencode-free / vertex-trial / multi-account OAuth) — the arbitrage
  track [[arbitrage-dispatch-tier-design]], not this spec.
- **UI beyond a 1D slider.** MVP is a single `dispatch_bias` scalar at Gate-0; a 2D frontier plot
  (achievable curve, dominated region greyed) is a later visualization, not a routing change.
