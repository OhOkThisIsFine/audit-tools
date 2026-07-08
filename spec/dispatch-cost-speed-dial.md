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

## The throughput axis — declared signals only

**Throughput is composed only from signals the provider or operator DECLARES. Nothing is learned or
measured.** This is a direct consequence of the settled rule *"concurrency is declared or absent,
never learned"* ([[concurrency-is-declared-or-absent-never-learned]]): the earlier dial sketch
defined speed against an AIMD adaptive concurrency ceiling, which was built, adversarially reviewed,
and reverted. There is no learned ceiling to lean on, and we do not add a measured tokens/sec signal
(that is the same class of learned dispatch signal C3-AIMD burned on).

The declared inputs already exist on every pool, on `discoveredLimits` / `resolved_limits`
(`src/shared/quota/types.ts` `ResolvedLimits`) and `source.quota` (`QuotaModelLimits`):

- `input_tokens_per_minute` / `output_tokens_per_minute` (TPM) — the sustained token intake rate.
- `requests_per_minute` (RPM) — the sustained request rate.
- `concurrencyCap` / `declaredCap` — a hard in-flight COUNT cap (already enforced as a hard admission
  gate in the `admitBatch` spill loop; it is a parallelism bound, not a rate).

**`throughputScore(pool)`** — the sustained token-intake rate the pool's declared limits permit
(higher = faster):

1. **TPM present** → `throughputScore = input_tokens_per_minute` (the aggregate sustained rate; a
   provider's own concurrency allowance is already subsumed by the rate it publishes).
2. **TPM absent, RPM present** → derive from RPM against a representative packet size
   (`requests_per_minute × REPRESENTATIVE_PACKET_TOKENS`), a declared-signal proxy for token rate.
3. **No declared rate limit** → the pool is rate-unbounded; it ranks as **fastest**
   (`+Infinity`). This is correct: an unmetered endpoint (e.g. a local NIM server) is
   hardware-bound, not rate-capped, and the operator's declared config is authoritative.

`declaredCap` does **not** enter `throughputScore` (it is a count, not a rate); it stays the hard
parallelism gate it already is in the spill loop. Capability is likewise a separate hard floor, not a
throughput term.

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

The blend enters at exactly one place — the sort in `admitBatch` (`admissionLoop.ts:167-169`), the
single point where pool ordering is decided. Spill (walk to the next pool on budget/cap exhaustion),
the reservation ledger, and `ClaimRegistry` claim-before-assign are all unchanged: the dial reorders
*which pool is tried first*, never weakens a headroom or safety gate.

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
- **Throughput uses declared signals only.** No learned ceiling, no measured tokens/sec, no
  EWMA on the dispatch path. `throughputScore` is a pure function of `ResolvedLimits` / `QuotaModelLimits`.
- **Capability stays a hard floor.** The `capable()` filter runs first and is untouched; the dial
  ranks only among capable pools and never trades capability for cost or speed.
- **The dial reorders, never un-gates.** declaredCap, budget headroom (ledger), cooldowns, and
  claim-before-assign are all applied after the dial's ordering exactly as today.
- **Parity.** Both orchestrators derive the ordering through the one shared `admitBatch`; the bias is
  threaded identically via `computeDispatchAdmission`. They cannot drift.
- **No model→price or model→rate literal in backend code.** Throughput inputs come only from declared
  config / discovered limits, like `costRank`'s price (two-tier dependency policy).

## Deferred / open

- **Quality as a tradeable axis (true 2D dial).** Default recorded = 1D cost↔speed + capability
  floor. A 2D dial needs a per-task quality-worth weighting; revisit only on an owner call.
- **Free-source registration** (opencode-free / vertex-trial / multi-account OAuth) — the arbitrage
  track [[arbitrage-dispatch-tier-design]], not this spec.
- **UI beyond a 1D slider.** MVP is a single `dispatch_bias` scalar at Gate-0; a 2D frontier plot
  (achievable curve, dominated region greyed) is a later visualization, not a routing change.
