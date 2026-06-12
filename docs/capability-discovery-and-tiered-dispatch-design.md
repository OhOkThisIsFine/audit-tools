# Design: provider-neutral planning + just-in-time tiered dispatch

Status: proposed (2026-06-12). Implement against this file.

## Non-negotiable principles (see CLAUDE.md Conventions + memory)

- **Provider / model / IDE agnostic.** No model names, per-model limits,
  tier→model maps, or available-model lists in backend code or persisted plans.
  Discover models AND capabilities **dynamically at runtime** from the host.
  Tiering routes by *relative* advertised capability, never named models. The
  static `KNOWN_MODEL_LIMITS` table is **legacy to retire**, not a fallback.
- **Conversation-first ⇒ LLM always in the loop.** "Deterministic suggestion → LLM
  review" is always available; never gate it behind "if a provider exists." The
  host agent is the provider.
- **The plan/dispatch seam (core of this design).** Planning is provider-neutral
  and persisted; *all* model/provider/concurrency choices are made just-in-time at
  dispatch by whichever provider is currently dispatching, against the resources
  *it* has right now. A run initialized in one IDE/provider must resume in another
  mid-flight with zero replanning — because the plan encodes no provider decision.

## Problem (observed in a 2026-06-12 dogfood run)

A clean `/audit-code` over the monorepo produced **163 packets, max 4 concurrent**,
`dispatch-quota.json` reporting `model: null`, `context_tokens: 32000`,
`source: provider_default`, `pool_id: "local-subprocess/*"`.

- **Concurrency 4** = loader hardcoding `--host-max-active-subagents 4`, a hard
  ceiling ([scheduler.ts](../packages/shared/src/quota/scheduler.ts)). Not an
  environment limit — and worse, a *dispatch* decision that shouldn't be fixed at
  all.
- **163 packets** = packet size capped at hardcoded
  `DEFAULT_TARGET_PACKET_TOKENS = 8000 lines × 4 = 32000`
  ([reviewPacketSizing.ts:12-23](../packages/audit-code/src/orchestrator/reviewPacketSizing.ts)),
  decoupled from any model and frozen at plan time. The fine-grained units are
  fine; what's missing is **JIT batching** to fill the active model's context.
- **`model: null`/32k** = host-subagent dispatch fell through to `local-subprocess`
  (no model identity) → `defaultLimits()` 32k/4k fallback
  ([limits.ts:105-114](../packages/shared/src/quota/limits.ts)). Nothing discovered
  the real executor's context, and the discovery should happen at *dispatch* time.
- RPM/TPM never fetched from any API (learned-from-429s only) — stays that way.
  Static context/output limits stop being hardcoded; the dispatching provider
  advertises them at dispatch time.

## The two phases

### Phase A — Planning produces a provider-neutral task graph (persisted, reviewed once)

The output of planning is a **weighted task-affinity graph**, not a packet list:

- **Nodes = tasks** (unit × lens). Each carries a **token estimate** (deterministic
  byte-based) and a **risk estimate** (lens sensitivity, critical-flow membership,
  analyzer signal, blast radius). These are **hard once reviewed**: deterministic
  first, then **one LLM review** (by whatever provider is handy) sanity-checks /
  adjusts the numbers and **freezes them**, written back into the artifact as
  documentation. Immutable thereafter. The review refines numbers; it assigns no
  model.
- **Edges = affinity between tasks. Soft / advisory**, weighted, each with a `kind`
  expressing *why* two tasks are related (descending typical strength): shared file
  → same unit → same directory → same critical flow / call-graph adjacency
  (derived from `graph_bundle`) → cross-lens-same-file → same lens. Edges are
  deterministically derived (and may be LLM-tuned), but never frozen — they are the
  flexibility that lets each provider cut its own packets.
- **No packets at plan time.** Packets do not exist as a persisted artifact; they
  are produced JIT in Phase B by partitioning this graph.

Reuse the existing **language-neutral edge contract** (`from`, `to`, `kind`,
optional `direction`/`confidence`/`reason`) extended with `weight`; keep this
task-affinity graph **distinct from `graph_bundle.json`** (code structure) — this
graph's nodes are *tasks*, derived partly from the code graph.

Nothing here is invalidated by switching provider/IDE later.

### Phase B — Dispatch (just-in-time, per active provider, nothing persisted as a decision)

Each time a provider picks up the run to dispatch, it:

1. **Capability handshake for itself** — enumerates the models it can dispatch to
   right now (opaque ordered list) and their capabilities (context window, output
   cap, relative cost/rank), plus its real current parallel capacity. (Extends the
   existing `provider_confirmation` step; re-run per dispatching session, not once.)
2. **Partitions the task graph into packets** — greedy agglomerative merge along
   descending edge weight, accumulating task nodes into a cluster until adding the
   next node would breach **either of two model-parameterized budgets**:
   - a **token ceiling** (the chosen model's discovered context, minus prompt
     overhead), and
   - a **risk-mass ceiling** (aggregate node risk / high-risk-task count a single
     agent should scrutinize at once).

   Both are *ceilings, not quotas* — a high-risk cluster may sit well under the
   token ceiling and that is correct (focused review beats a padded window; never
   pad a high-risk packet with unrelated low-risk filler). A stronger model gets a
   higher risk-mass ceiling; a weaker one a lower ceiling. High-context model →
   bundles weakly-related tasks into larger packets; low-context model → only
   tightly-coupled clusters. The **edge-weight threshold + the two budgets are the
   levers** that turn N neutral task nodes into the right packets — replacing the
   frozen 8000-line cap. When a coherent high-risk cluster exceeds the risk-mass
   ceiling, split along its **weakest internal edge** (default leans to preserving
   coherence — seam bugs in critical flows are the high-value finds — and only
   splits when the cap forces it).
3. **Routes each cluster by risk** — the cluster's routing tier = its **max** node
   risk (never under-model a risky task), mapped to a *relative* rank in the
   discovered model list (low → cheapest available; high → top available). No named
   models; degrade gracefully when fewer models are available. Coherence and risk
   correlate (a high-risk task's high-affinity neighbours are usually the rest of
   its critical flow, also high-risk), so coherent clustering is *also* what routes
   high-risk work cleanly to the top model — no risk-spreading/centrality, which
   would force every packet onto the top tier and shatter holistic flow review.
4. **Sets concurrency from its own current resources** (multi-pool capacity already
   supported — one pool per discovered model). Rolling dispatch, as today.

None of steps 1–4 are written into the plan. The dispatch-quota / capacity
artifacts are an ephemeral record of *this* session's JIT choices, not authority.

## What already exists (reuse, don't rebuild)

| Capability | State today | Anchor |
|---|---|---|
| Per-packet complexity/tier | Computed but **cosmetic + plan-time** (move risk → persisted, tier → JIT) | [dispatch.ts:215-268](../packages/audit-code/src/cli/dispatch.ts) `buildDispatchModelHint` |
| Multi-pool capacity | `computeDispatchCapacity({pools:[...]})` accepts N pools; only 1 built today | [capacity.ts:93-279](../packages/shared/src/quota/capacity.ts) |
| Capability handshake | `provider_confirmation` step exists (first obligation) | nextStep priority chain |
| Per-model static limits | Hardcoded table — **to retire**; replaced by dispatch-time discovery | [tokens.ts:17-28](../packages/shared/src/tokens.ts) `KNOWN_MODEL_LIMITS` |
| Token estimate | Deterministic byte estimate exists | `estimateTokensFromBytes` (shared) |
| Packet grouping | Directory/flow-proximity merge exists → **repurpose into edge-weight derivation** (graph, not frozen packets) | [reviewPackets.ts](../packages/audit-code/src/orchestrator/reviewPackets.ts) (commit 3e6983bc) |
| Code-structure graph | `graph_bundle.json` (units/flows/edges) — **distinct** from the new task-affinity graph | [graph_bundle.json] |
| Lens proposal (deterministic) | `buildLensProposals` heuristics | [intentCheckpointExecutor.ts:190-259](../packages/audit-code/src/orchestrator/intentCheckpointExecutor.ts) |
| Conceptual `deep` mode | One agent told to *imagine* perspectives; not real fan-out | [designReviewPrompt.ts:288-327](../packages/audit-code/src/orchestrator/designReviewPrompt.ts) |
| Parallel design-review dispatch | contract + conceptual as 2 fixed subagents | [nextStepCommand.ts:840-919](../packages/audit-code/src/cli/nextStepCommand.ts) |
| intent_checkpoint schema | scope/intent/lens fields; **no depth field** | [intentCheckpoint.ts:11-76](../packages/shared/src/types/intentCheckpoint.ts) |

## Workstreams

### WS1 — Provider-neutral task graph (Phase A data)

- Build a persisted **task-affinity graph**: nodes = tasks, each with frozen
  **token estimate** + **risk estimate** (token estimate already exists; add the
  risk estimate as a persisted score from lens sensitivity, critical-flow, analyzer
  signal, blast radius). Edges = weighted affinity (`kind` + `weight`) derived from
  shared-file / same-unit / same-dir / flow / call-adjacency / lens, reusing the
  language-neutral edge contract. Keep distinct from `graph_bundle.json`.
- **Strip plan-time packets and model/tier/pool/concurrency** out of the planning
  artifacts. `review_packets.json` / frozen `model_hint` routing go away as
  persisted authority; what persists is the graph + estimates. (The directory-/
  flow-proximity merge logic, commit 3e6983bc, is repurposed into edge-weight
  derivation rather than frozen packets.)
- **One LLM estimate-review step** that refines + freezes the token/risk node
  numbers (and may tune edge weights), written back as documentation. Always-on.

### WS2 — Just-in-time graph partition + tiered dispatch (Phase B)

- Extend `provider_confirmation` into a per-dispatch **capability handshake**:
  discovered models (opaque, ranked) + capabilities + current parallel capacity.
  **Retire `KNOWN_MODEL_LIMITS`** as a source of truth; dispatch reads discovered
  capabilities. Fix the `model: null` path — pools built from discovered models.
- At dispatch: **partition the task graph into packets** under two model-
  parameterized ceilings — token (context) and risk-mass — greedy by descending
  edge weight, splitting a too-risky coherent cluster along its weakest internal
  edge; **route each cluster by max-risk → relative model rank**; size concurrency
  from current resources (multi-pool). Both budgets are ceilings, not quotas (don't
  pad high-risk packets). Promote `model_hint` from cosmetic to real JIT routing.
  Packets and routing are ephemeral (this session's record, not authority).
- **Resumability:** a different provider/IDE resuming the run re-handshakes and
  re-partitions the same frozen graph against its own resources — no replanning.

### WS3 — Condensed user-confirmation roundtrip

One AskUserQuestion at `confirm_intent` covering **scope** (confirm/prune),
**lenses** (proposals + custom), and **conceptual depth** (shallow=1 agent / deep=
parallel perspectives; **default shallow**). Extend `IntentCheckpoint` with
`design_review?: { conceptual_depth?: "shallow" | "deep"; perspectives?: number }`.
(Per-run model choice is a *dispatch-time* concern, not a persisted plan field — so
it is not in the checkpoint; if offered to the user it's resolved against the
dispatching provider's discovered list.) Headless → defaults (full scope, proposed
lenses, shallow).

### WS4 — Shallow/deep conceptual review = real dispatch fan-out

- **Shallow (default):** 1 conceptual agent (contract pass unchanged).
- **Deep:** parallel dispatch fans out a **configurable count**
  (`design_review.perspectives`, bounded) of real perspective subagents (the
  perspectives in [designReviewPrompt.ts:288-327](../packages/audit-code/src/orchestrator/designReviewPrompt.ts),
  promoted from in-prompt imagination to real independent agents) + an
  **independent** judge/merge agent (author must not mark its own work).
- These subagents are themselves dispatched JIT by the active provider (same
  Phase-B rules), so deep review also survives a provider switch.

## Parity & invariants

- Mirror the plan/dispatch seam and JIT dispatch into **remediate-code** (it
  dispatches implement/verify subagents; same neutral-estimate + JIT-routing rules).
- Atomic-replace per node, green at every commit: hardcoded packet budget → JIT
  batching; `KNOWN_MODEL_LIMITS` → discovered capabilities; cosmetic plan-time
  `model_hint` → persisted-risk + JIT-tier.
- Capability discovery, estimates, and tiering are language- and model-neutral.

## Implementation progress (2026-06-12)

Landed green on branch `feat/provider-neutral-task-graph` (additive,
non-behavior-changing — the graph is built alongside the old packet path and the
partitioner is not yet wired, so the tree stays green and resumable):

- **N1** — frozen `token_estimate` + `risk_estimate` on every task
  (`computeRiskEstimate`, planning enrich, schema, tests).
- **N2** — `task_affinity_graph.json` artifact (`taskAffinityGraph.ts`): frozen
  task nodes + soft weighted affinity edges; io/dependency/schema/tests.
- **N4a** — `partitionTaskGraph.ts`: pure greedy union-find partition under
  token + risk-mass ceilings (Phase-B core algorithm), tested. Not yet wired.

**Next: N4b (the keystone atomic replace).** Key finding for whoever picks it up:
the dispatch flow **packetizes before it computes quota** (`buildReviewPackets`
at `src/cli/dispatch.ts:774`; `computeDispatchQuota` ~923), and dispatch
**rebuilds** packets at dispatch time rather than reading the persisted
`review_packets.json`. So N4b is localized to the dispatch flow but must
**reorder quota-before-packetization** so the partition sees the model's real
context budget (`resolved_limits.context_tokens`). Adapter path: export
`buildPacket` (the single-packet constructor at `reviewPackets.ts:342`) and add a
`buildReviewPacketsFromPartition` that maps each `GraphPacket`'s task ids →
`AuditTask[]` → `buildPacket`; swap it in at the dispatch call site and delete the
old `buildReviewPackets` call in the same commit. Expect packet-count test churn
in `dispatch-features.test.mjs`. Then **N5** (capability handshake / retire
`KNOWN_MODEL_LIMITS`) makes that budget real, **N6** condensed confirm_intent,
**N7** deep conceptual fan-out, **N8** remediate-code parity.

## Resolved decisions (2026-06-12)

1. **Plan/dispatch seam, via a task graph.** Planning persists a provider-neutral
   **weighted task-affinity graph**: nodes = tasks with **frozen** (LLM-reviewed)
   token + risk estimates; edges = **soft** weighted affinity. Packets do not exist
   at plan time — they are produced JIT at dispatch by **partitioning the graph**
   under the active model's context budget, routed by max-risk. All
   model/provider/concurrency choices are JIT. Runs resume across providers/IDEs
   mid-flight with no replanning (re-partition the same graph).
2. **No named models.** Discover dynamically; tiers map to relative rank. Retire
   `KNOWN_MODEL_LIMITS`.
3. **LLM review always-on** (estimate review + scope/lens review) — conversation-
   first, never gated on "if a provider exists."
4. **Risk-aware packing = coherence + a risk-mass ceiling, NOT centrality.**
   Partition under two dispatch-time, model-parameterized ceilings (token +
   risk-mass), both ceilings not quotas. Cluster by coherence (high-risk neighbours
   are usually the same critical flow → holistic seam review + clean top-model
   routing); cap aggregate risk per packet so no agent is overloaded; split a
   too-risky cluster along its weakest edge. Rejected risk-centrality (high+low
   pairing): it pads attention away from the high-risk task, forces filler onto
   expensive models, and shatters coherent flows. Default leans coherence-preserving
   (seam bugs are the prize); the risk-mass ceiling is tunable from real outcomes.
5. **Deep conceptual fan-out configurable** (`design_review.perspectives`), default
   ~5 + independent judge. **Conceptual depth default: shallow.**
```
