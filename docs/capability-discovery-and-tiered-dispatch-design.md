# Design: provider-neutral planning + just-in-time tiered dispatch

The target design of how planning stays model-neutral and all
model/provider/concurrency choices are made just-in-time at dispatch. A
declarative contract, not a status log — completion is verified separately against
the code.

## Non-negotiable principles

- **Provider / model / IDE agnostic.** No model names, per-model limits,
  tier→model maps, or available-model lists in backend code or persisted plans.
  Models AND capabilities are discovered **dynamically at runtime** from the host.
  Tiering routes by *relative* advertised capability, never named models.
- **Conversation-first ⇒ LLM always in the loop.** "Deterministic suggestion → LLM
  review" is always available; never gated behind "if a provider exists." The host
  agent is the provider.
- **The plan/dispatch seam.** Planning is provider-neutral and persisted; *all*
  model/provider/concurrency choices are made just-in-time at dispatch by whichever
  provider is dispatching, against the resources *it* has at that moment. A run
  initialized in one IDE/provider resumes in another mid-flight with zero
  replanning — the plan encodes no provider decision.

## Phase A — Planning produces a provider-neutral task graph (persisted, reviewed once)

The output of planning is a **weighted task-affinity graph**, not a packet list:

- **Nodes = tasks** (unit × lens). Each carries a **token estimate** (deterministic
  byte-based) and a **risk estimate** (lens sensitivity, critical-flow membership,
  analyzer signal, blast radius). These are **frozen** once reviewed: deterministic
  first, then one LLM review sanity-checks/adjusts the numbers and freezes them into
  the artifact as documentation. Immutable thereafter; the review assigns no model.
- **Edges = affinity between tasks. Soft / advisory**, weighted, each with a `kind`
  expressing *why* two tasks are related (descending typical strength): shared file
  → same unit → same directory → same critical flow / call-graph adjacency (from
  `graph_bundle`) → cross-lens-same-file → same lens. Edges are deterministically
  derived (and may be LLM-tuned), never frozen — they are the flexibility that lets
  each provider cut its own packets.
- **No packets at plan time.** Packets are not a persisted artifact; they are
  produced JIT in Phase B by partitioning this graph.

The task-affinity graph reuses the language-neutral edge contract (`from`, `to`,
`kind`, optional `direction`/`confidence`/`reason`) extended with `weight`, and is
distinct from `graph_bundle.json` (code structure) — its nodes are *tasks*, derived
partly from the code graph.

## Phase B — Dispatch (just-in-time, per active provider, nothing persisted as a decision)

Each time a provider picks up the run to dispatch, it:

1. **Capability handshake for itself** — enumerates the models it can dispatch to
   right now (opaque ordered roster) and their capabilities (context window, output
   cap, relative rank), plus its real current parallel capacity. (Extends
   `provider_confirmation`; re-run per dispatching session, not once.)
2. **Partitions the task graph into packets** — greedy agglomerative merge along
   descending edge weight, accumulating task nodes into a cluster until adding the
   next node would breach **either** of two model-parameterized budgets:
   - a **token ceiling** (the chosen model's discovered context, minus prompt
     overhead), and
   - a **risk-mass ceiling** (aggregate node risk a single agent should scrutinize
     at once).

   Both are *ceilings, not quotas* — a high-risk cluster may sit well under the
   token ceiling and that is correct; never pad a high-risk packet with unrelated
   low-risk filler. A stronger model gets a higher risk-mass ceiling. The
   edge-weight threshold + the two budgets are the levers that turn neutral task
   nodes into the right packets. A coherent high-risk cluster that exceeds the
   risk-mass ceiling splits along its **weakest internal edge** (default leans to
   preserving coherence — seam bugs in critical flows are the high-value finds).
3. **Routes each cluster by risk** — the cluster's routing tier = its **max** node
   risk against relative cut points, mapped to a *relative* rank in the discovered
   roster (low → cheapest available; high → top available). Complexity signals
   (isolated large file, critical flow, analyzer signal, lens verification, high
   token estimate, sensitive lens) act as escalators only — they can raise a tier,
   never lower it. No named models; degrade gracefully when fewer are available.
   Coherence and risk correlate, so coherent clustering also routes high-risk work
   cleanly to the top model — no risk-centrality, which would force every packet
   onto the top tier and shatter holistic flow review.
4. **Sets concurrency from its own current resources** — one capacity pool per
   discovered rank; rolling dispatch.

None of steps 1–4 are written into the plan. The dispatch-quota / capacity
artifacts are an ephemeral record of *this* session's JIT choices, not authority.

### Roster sizing — partition-then-validate

With a multi-rank roster, partition once under the largest reported window so
coherent clusters aren't over-split, then re-split any packet whose risk-routed
tier has a smaller window (bounded fixed-point; un-splittable packets fall to a
tier-aware oversized warning). This preserves cross-tier affinity coherence. A tier
the host didn't report maps to the nearest reported rank, preferring the more
capable.

### Quota keying by opaque model identity

An optional `model_id` per roster entry (and `--host-model-id`) is an opaque
quota-key segment only — never a window authority, never matched to a name table.
Key chain: `provider/<entry.model_id ?? resolved model ?? host-model-id ?? *>`;
per-rank pools resolve quota state, cached limits, and usage snapshots per key.

## Conceptual review depth = real dispatch fan-out

Conceptual design-review depth is a provider-neutral checkpoint field
(`design_review: { conceptual_depth: "shallow" | "deep", perspectives?: number }`),
recording *how much* review, never which model:

- **Shallow (default):** one conceptual agent (contract pass unchanged).
- **Deep:** parallel fan-out of a configurable count of independent perspective
  subagents drawn from a built-in roster of maximally-dissimilar perspectives, plus
  an **independent** judge/merge agent (an author never marks its own work). The
  judge writes the single conceptual-findings artifact the orchestrator ingests;
  the perspectives' intermediate results are not ingested.

The perspectives and judge are themselves packetized JIT by the active provider
(same Phase-B rules), so deep review survives a provider switch.

## Parity & invariants

- The plan/dispatch seam and JIT dispatch apply to **remediate-code** as well (it
  dispatches implement/verify subagents; same neutral-estimate + JIT-routing rules,
  capability handshake, and per-rank pools).
- Atomic-replace per node, green at every commit.
- Capability discovery, estimates, and tiering are language- and model-neutral; a
  run that cannot discover its window sizes small and honest (conservative floor),
  never a guessed large window.
- The task-affinity graph is the only persisted dispatch surface; packets exist
  solely JIT at dispatch.
