# Handoff: capability-discovery / tiered-dispatch redesign

**Date:** 2026-06-12
**Branch:** `feat/provider-neutral-task-graph` (pushed to `audit-tools` remote)
**Spec:** [capability-discovery-and-tiered-dispatch-design.md](capability-discovery-and-tiered-dispatch-design.md) — read this first; it is the design of record.
**Status:** Phase-A data model + Phase-B core (N4b) + N5a/N5b (capability handshake) + **N5c (`KNOWN_MODEL_LIMITS` retired) landed green.** Dispatch packetizes JIT under the dispatching model's context + risk-mass ceilings; the host reports its real context window (`--host-context-tokens`/`--host-output-tokens`); and the static known-model table is gone — discovered capability (or explicit config) is the sole window authority, falling to a conservative 32k floor when nothing is discovered (never a guessed per-model window). Next is **N6** (condensed `confirm_intent` roundtrip). See the spec's Implementation-progress section for the per-node detail.

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
| N4b — partition wired into dispatch | `1e22fd06` | `cli/dispatch.ts`, `orchestrator/reviewPackets.ts`, `orchestrator/taskAffinityGraph.ts`, `orchestrator/partitionTaskGraph.ts`, `shared/types/sessionConfig.ts`, `tests/dispatch-features.test.mjs` |
| N5a — discovered-capability threading (shared) | `17ef3e02` | `shared/quota/limits.ts`, `shared/quota/scheduler.ts`, `shared/quota/types.ts`, `shared/tests/scheduler.test.mjs` |
| N5b — handshake wired into dispatch budget | `b5ac76d9` | `cli/{args,dispatch,prepareDispatchCommand,semanticReviewStep,nextStepCommand}.ts`, `quota/discoveredLimits.ts`, `skills/audit-code/audit-code.prompt.md`, `tests/dispatch-features.test.mjs` |
| docs | `d83bfdfb` (+ inline in above) | spec progress section |

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

## DONE: N5a/N5b — capability handshake makes the budget real

The host now reports its dispatch model's real context window at the handshake,
so packets fill the real window instead of the conservative 32k floor.

- **N5a (shared):** `resolveLimits` gains a `discovered_capability` rung between
  explicit per-model config and the static known-model table — a reported
  context/output window outranks the hardcoded table and the 32k default.
  `DiscoveredRateLimitsInput`/`DiscoveredRateLimits` gain
  `context_tokens`/`output_tokens`; `scheduleWave` forwards `discoveredLimits` into
  `resolveLimits`; `LimitSource` gains `discovered_capability`. Additive — nothing
  populated the window until N5b. Three scheduler tests cover the rung.
- **N5b (audit-code):** new `--host-context-tokens` / `--host-output-tokens` flags
  (`getHostContextTokens`/`getHostOutputTokens`), reported alongside
  `--host-max-active-subagents` on every `next-step`. Plumbed
  `next-step → renderSemanticReviewStep → prepareDispatchArtifacts →
  buildDispatchPool`, which merges them FIRST into the pool's `discoveredLimits`
  (`source: "host_capability"`). N5a's rung then sizes `contextBudgetTokens` to the
  real window. `dispatch-quota.json` records it (`source: "discovered_capability"`,
  real `context_tokens`). Skill prompt instructs the host to discover + report its
  window; omitting falls back to the conservative default. Integration test: a
  2×20000-token shared-file cluster splits to 2 packets at the 32k default, packs
  into 1 under a reported 200k window. The `163 → ~30` collapse happens whenever
  the host reports its window. Full suite green (1789 pass).

---

## DONE: N5c — `KNOWN_MODEL_LIMITS` retired as authority

Landed on branch (atomic replace, all three suites green: shared 385 /
audit-code 1787 / remediate 1133). Discovered capability (or explicit config) is
now the sole context-window authority.

- **`shared/src/quota/limits.ts`:** deleted the static known-model rung (rung 2)
  from `resolveLimits`, the `lookupKnownModel` helper, and
  `PROVIDER_DEFAULT_HOST_MODEL` (the hardcoded `anthropic/claude-opus-4-8` id).
  `resolveHostModel` now returns `null` when there is no explicit/config/env
  signal — no hardcoded per-provider model; quota learning keys on `provider/*`
  and the handshake supplies the window.
- **`shared/src/tokens.ts`:** deleted `KNOWN_MODEL_LIMITS`, `lookupModelLimits`,
  and the `ModelTokenLimits` type. `resolveContextBudget` lost its `hostModel`
  param + table lookup. `DEFAULT_CONTEXT_TOKENS`/`DEFAULT_OUTPUT_TOKENS` lowered
  to the conservative floor (32k / 4096) matching the quota subsystem — a run
  that can't discover its window sizes small and honest, never a guessed 200k.
- **Barrels + types:** removed the re-exports (`shared/src/index.ts`,
  both `quota/index.ts`) and dropped `"known_metadata"` from the `LimitSource`
  union (`quota/types.ts`).
- **Schemas:** both `dispatch_quota.schema.json` enums swap `known_metadata` →
  `discovered_capability` (the latter was an N5b gap — the source the file
  actually carries was never in the enum).
- **Remediate consumer sweep:** `plan.ts:resolveContextBudgetFromConfig` dropped
  its `hostModel` arg. Remediate still honors `block_quota.context_tokens` when
  configured; absent that it now sizes to the conservative floor. The fuller
  remediate move onto the discovered-capability *channel* (host-window flags like
  audit's N5b) rides **N8**.
- **Tests:** updated `tokens.test.mjs`, `quota-limits.test.mjs`,
  `quota-scheduler.test.mjs`, `json-schema-assert.test.mjs` — the old
  `known_metadata` assertions become `discovered_capability` (handshake reports a
  window) or `provider_default` (named model, no discovered window).

## DONE: N6 — condensed confirm_intent roundtrip

Landed on branch (all three suites green: shared 385 / audit-code 1788 /
remediate 1133). The user-confirmed checkpoint now carries conceptual-depth intent;
N7 consumes it for the actual fan-out.

- `IntentCheckpoint` (`shared/src/types/intentCheckpoint.ts`) gains
  `design_review?: { conceptual_depth?: "shallow" | "deep"; perspectives?: number }`
  — provider-neutral (records *how much* review, never which model).
- **Vocabulary unified on `"shallow" | "deep"`.** The pre-existing
  `DesignReviewConfig.conceptual_depth` (`sessionConfig.ts`) and
  `DesignReviewOptions.conceptual_depth` (`designReviewPrompt.ts`) `"standard"`
  value was renamed to `"shallow"` — only `=== "deep"` was ever read, so it's
  behavior-preserving. (The `"standard"` still in `dispatch-model-hint`/
  `review-packets` tests is the unrelated model-hint *tier*, untouched.)
- `renderConfirmIntentPrompt` (`confirmIntentStep.ts`) renders a "Conceptual
  design-review depth" section, folds the depth question into the single
  confirmation round (default **shallow**), and offers `design_review` in the JSON
  shape. New prompt test in `intent-checkpoint.test.mjs`.
- `intent_checkpoint.schema.json` gains `design_review` and (same drift-fix pass)
  the three live-but-unschema'd fields `constraint_clauses` /
  `disposition_overrides` / `lens_selection` + `confirmed_by: draft` — the schema
  had `additionalProperties: false` while lagging the type. Not enforced at runtime
  today (validation only requireKeys), but now correct.
- Headless auto-complete (`intentCheckpointExecutor.ts`) unchanged: omitting
  `design_review` ⇒ shallow.

## NEXT: the remaining nodes

- **N7 — deep conceptual = real fan-out.** Promote the in-prompt "imagine
  perspectives" (`designReviewPrompt.ts:288-327`) to N real parallel perspective
  subagents + an **independent** judge/merge, configurable count. Wire depth from the
  checkpoint into the `design_review_parallel` dispatch (`nextStepCommand.ts:840-919`).
- **N8 — remediate-code parity.** Mirror the plan/dispatch seam + JIT into
  remediate-code's implement/verify dispatch (folds in the N5c consumer sweep).

### N5b follow-ons worth noting (not blocking)
- **Model identity on `model: null`.** N5b threads the context *window* but not a
  model *id* when `resolveHostModel` returns null; quota learning still keys on
  `provider/*`. A handshake-reported opaque model id (for the quota key + multi-pool
  routing) is a clean follow-on — fold into N7's tiered routing or N5c.
- **Multi-model roster + tiered routing.** N5b reports a single active window. The
  spec's full vision (opaque ordered model list, route each packet by max-risk →
  relative rank) is **N7 territory** — `partitionTaskGraph` already computes
  `routing_risk` per packet; nothing consumes it for model selection yet.

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
