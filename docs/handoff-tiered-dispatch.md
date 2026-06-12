# Handoff: capability-discovery / tiered-dispatch redesign

**Date:** 2026-06-12
**Branch:** `feat/provider-neutral-task-graph` (pushed to `audit-tools` remote)
**Spec:** [capability-discovery-and-tiered-dispatch-design.md](capability-discovery-and-tiered-dispatch-design.md) — read this first; it is the design of record.
**Status:** Phase-A data model + Phase-B core algorithm landed green (additive, non-behavior-changing). The keystone dispatch swap and everything after it remain.

---

## The one-paragraph mental model

Planning must stay **provider-neutral and persisted**; every model / provider /
concurrency / packet decision moves to **just-in-time at dispatch**, recomputed by
whichever provider is dispatching against the resources *it* has right then. The
persisted plan is a **weighted task-affinity graph** (frozen task nodes with
token + risk estimates; soft weighted affinity edges). At dispatch a provider runs
its own capability handshake and **partitions the graph into packets** under two
model-parameterized ceilings — token and risk-mass — routing each packet by its max
risk to a *relative* model rank. Consequence: a run started in one IDE/provider
resumes in another mid-flight with no replanning. Never hardcode model names or
limits; discover them. Conversation-first means a host LLM is always available to
review, so "deterministic suggestion → LLM review" is always on.

Binding rules (also in CLAUDE.md Conventions + memory `model-provider-ide-agnostic`):
- Provider/model/IDE agnostic — no hardcoded model names/limits/tier-maps. Discover dynamically.
- Cluster by coherence, cap risk-mass; **no risk-centrality** (rejected — see spec decision #4). Ceilings, not quotas; never pad a high-risk packet.
- Atomic-replace per node; green build+test at every commit.

---

## What's done (branch commits, all green)

| Node | Commit | Files |
|---|---|---|
| N1 — frozen estimates on tasks | `7ce4da8c` | `types.ts` (AuditTask.token_estimate/risk_estimate), `auditTaskUtils.computeRiskEstimate`, `planningExecutors` enrich, `schemas/audit_task.schema.json`, `tests/audit-task-utils.test.mjs` |
| N2 — task-affinity graph | `79ff565a` | `orchestrator/taskAffinityGraph.ts`, `io/artifacts.ts`, `orchestrator/dependencyMap.ts`, `schemas/task_affinity_graph.schema.json`, `tests/task-affinity-graph.test.mjs` |
| N4a — partition algorithm | `2dcc6c30` | `orchestrator/partitionTaskGraph.ts`, `tests/partition-task-graph.test.mjs` |
| docs | `d83bfdfb` | spec progress section |

Verify green before continuing:
```
cd C:/Code/audit-tools
npm run build -w @audit-tools/shared && npm run build
env -u CLAUDECODE npm run check          # CLAUDECODE unset, per the test gotcha
cd packages/audit-code && env -u CLAUDECODE npm test
```

Key exported primitives now available:
- `buildTaskAffinityGraph(tasks, {graphBundle})` → `TaskAffinityGraph` (nodes + weighted edges).
- `partitionTaskGraph(graph, {contextTokenBudget, riskMassBudget, promptOverheadTokens})` → `GraphPacket[]` (task_ids, token_estimate, risk_mass, routing_risk, over_budget).
- `computeRiskEstimate(task)` → risk seed in [0,1].

---

## NEXT: N4b — wire the partition into dispatch (the keystone atomic replace)

**Why it's the hard one:** dispatch currently **packetizes before it computes
quota**, and **rebuilds** packets at dispatch time (it does *not* read the persisted
`review_packets.json`):
- `src/cli/dispatch.ts:774` — `buildReviewPackets(orderedTasks, {...})`
- `src/cli/dispatch.ts:~923` — `computeDispatchQuota(...)`

So packetization can't see the model's context budget. **N4b must reorder
quota-before-packetization** so the partition is sized to
`dispatchQuota.resolved_limits.context_tokens`.

**Recommended low-risk path (preserves the `ReviewPacket` downstream contract):**
1. Export `buildPacket` (single-packet constructor, `reviewPackets.ts:342`) — it
   builds a full `ReviewPacket` (file_paths, line counts, lenses, tags, graph
   context, estimated_tokens) from a task group.
2. Add `buildReviewPacketsFromPartition(tasks, graph, {contextTokenBudget, riskMassBudget, lineIndex, sizeIndex, graphBundle})`:
   call `partitionTaskGraph`, then map each `GraphPacket.task_ids → AuditTask[] → buildPacket`. Returns `ReviewPacket[]`, so all downstream dispatch-plan / prompt / complexity / model_hint rendering is unchanged.
3. In `dispatch.ts`, move the quota computation above the packetization call, then
   replace the `buildReviewPackets(orderedTasks, …)` call with the partition-based
   builder. **Delete the old call in the same commit** (atomic-replace invariant).
4. The task graph is on the bundle as `bundle.task_affinity_graph` (built at
   planning). If absent (older artifacts), fall back to `buildTaskAffinityGraph`
   from the dispatch tasks so dispatch is self-sufficient.
5. **Risk-mass ceiling:** model-parameterized; until N5 supplies real per-model
   values, seed a sane default (e.g. derive from context budget, or a
   "max-high-risk-tasks-per-packet" cap) and expose it as a dispatch knob. Document
   the default as provisional.

**Expect test churn:** `tests/dispatch-features.test.mjs` and any test asserting
exact packet counts/boundaries will shift — packetization is now graph-partition
driven. Update assertions to the new (coherence-clustered, budget-bounded)
behavior; don't loosen them into meaninglessness.

**Don't forget:** with N4b, the persisted `review_packets.json` is no longer the
dispatch authority. Decide whether to keep building it (harmless, some consumers —
`operatorHandoff`, ingestion — may read it) or strip it; if stripping, that's its
own atomic node with its own consumer sweep. Leaving it is fine for N4b.

---

## After N4b

- **N5 — capability handshake (makes the budget real).** Extend the existing
  `provider_confirmation` step so the host reports its discovered models + context
  windows + real concurrency. **Retire `KNOWN_MODEL_LIMITS`** (`shared/src/tokens.ts`)
  as a source of truth — read discovered capabilities instead. Fix `model: null`:
  host-subagent dispatch resolved to the `local-subprocess` pool with no model
  identity (`resolveHostModel`, `shared/src/quota/limits.ts:68`; `PROVIDER_DEFAULT_HOST_MODEL`).
  After N5, N4b's `contextTokenBudget` reflects the real model (e.g. 200k) instead of
  the 32k default → the 163-packet over-split collapses to ~30.
- **N6 — condensed confirm_intent roundtrip.** One `AskUserQuestion` covering scope
  + lenses + conceptual depth (default shallow). Add `design_review?: {conceptual_depth, perspectives}`
  to `IntentCheckpoint` (`shared/src/types/intentCheckpoint.ts`). Render in
  `confirmIntentStep.ts`.
- **N7 — deep conceptual = real fan-out.** Promote the in-prompt "imagine
  perspectives" (`designReviewPrompt.ts:288-327`) to N real parallel perspective
  subagents + an **independent** judge/merge, configurable count. Wire depth from the
  checkpoint into the `design_review_parallel` dispatch (`nextStepCommand.ts:840-919`).
- **N8 — remediate-code parity.** Mirror the plan/dispatch seam + JIT into
  remediate-code's implement/verify dispatch.

---

## Gotchas (this repo)

- **Build order:** `npm run build -w @audit-tools/shared` first, then the rest. Fresh
  clone/worktree needs root `npm install` (missing symlinks → fake "missing export").
- **Tests:** audit-code uses `node --test` (`tests/*.test.mjs`, subtests must be
  `await t.test`); remediate-code uses vitest. Run with `env -u CLAUDECODE` or one
  provider test fails. EPERM/EBUSY on Windows = suspect flake; rerun alone.
- **Commit gate:** a PreToolUse hook blocks `git commit` until `npm run check` is
  green; an async PostToolUse hook typechecks the edited package after TS edits (it
  caught two errors during this work — trust it).
- **Ship:** when the whole redesign lands, use the `/ship` skill for the full
  land-and-publish flow (it encodes the CLAUDECODE/CRLF/allow-scripts traps).
- **Local checkpoint:** `.audit-tools/ws-implementation-progress.md` (gitignored)
  has the same node list; this committed handoff is the durable copy.
