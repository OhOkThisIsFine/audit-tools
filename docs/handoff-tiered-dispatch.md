# Handoff: capability-discovery / tiered-dispatch redesign

**Date:** 2026-06-12
**Branch:** `feat/provider-neutral-task-graph` (pushed to `audit-tools` remote)
**Spec:** [capability-discovery-and-tiered-dispatch-design.md](capability-discovery-and-tiered-dispatch-design.md) — read this first; it is the design of record.
**Status:** Phase-A data model + Phase-B core algorithm + **N4b (the keystone dispatch swap) landed green.** Dispatch now packetizes JIT by partitioning the task-affinity graph under the dispatching model's context + risk-mass ceilings, quota-before-packetization. Next is N5 (capability handshake — makes the budget real). See the spec's Implementation-progress section for the N4b detail.

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

## DONE: N4b — partition wired into dispatch (keystone atomic replace)

Landed on branch. What changed (`src/cli/dispatch.ts` + `reviewPackets.ts` +
`partitionTaskGraph.ts` + `taskAffinityGraph.ts` + `shared/types/sessionConfig.ts`):
- `computeDispatchQuota` → split into `buildDispatchPool` (resolves the host pool
  and *probes* `resolved_limits.context_tokens − output_tokens` as
  `contextBudgetTokens`, run **before** packetization) and `finalizeDispatchQuota`
  (capacity/wave schedule over the real per-packet token layout, run **after**).
  The probe calls `computeDispatchCapacity` with `pendingItemTokens: []` —
  resolved limits are model-derived, not work-derived, so the budget is available
  before any packet exists.
- `buildPacket` exported; new `buildReviewPacketsFromPartition(tasks, {graph,
  contextTokenBudget, riskMassBudget, lineIndex, sizeIndex, graphBundle})` calls
  `partitionTaskGraph`, maps each `GraphPacket.task_ids → AuditTask[] →
  buildPacket`, returns `ReviewPacket[]`. The old `buildReviewPackets` call is
  deleted from dispatch (same commit).
- `resolveDispatchTaskGraph` prefers the persisted `bundle.task_affinity_graph`
  (filtered to pending tasks via the new `filterTaskAffinityGraph`), falling back
  to `buildTaskAffinityGraph(orderedTasks, …)` when absent or not covering all
  pending tasks.
- Risk-mass ceiling: provisional `DEFAULT_RISK_MASS_BUDGET = 4`, overridable via
  `sessionConfig.dispatch.risk_mass_budget`.
- Tests: three new integration tests in `dispatch-features.test.mjs` prove the
  three levers (merge under budget, split on token ceiling, split on risk-mass
  ceiling). Full suite green (1788 pass). No churn to existing packet-count
  assertions — their fixtures are fully disjoint (no affinity edges), so they
  partition to one-packet-per-task exactly as before.

`review_packets.json` is left building for metrics/handoff (dispatch never read
it); stripping it as a persisted artifact is a later node.

---

## NEXT: N5 — capability handshake (makes the budget real)

Until N5, `buildDispatchPool` still resolves `model: null` → `local-subprocess`
→ 32k/4k default, so the partition splits to ~163 packets at 32k. N5 makes the
budget real:

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
