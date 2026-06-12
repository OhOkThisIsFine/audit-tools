# Handoff: tiered-dispatch follow-ons (relative model-rank routing + roster)

**Date:** 2026-06-12
**Branch:** start a fresh branch off `main` (e.g. `feat/tiered-model-routing`). `main` is current: shared 0.16.0 / audit-code 0.19.0 / remediate 0.16.0, all published & global bins reinstalled.
**Parent work:** the N1→N8 redesign is DONE and live — see [handoff-tiered-dispatch.md](handoff-tiered-dispatch.md) and the design of record [capability-discovery-and-tiered-dispatch-design.md](capability-discovery-and-tiered-dispatch-design.md). Read the spec's "Resolved decisions" first.
**Why this doc exists:** the redesign keeps landing *partway* — the machinery to route packets by risk to a relative model rank exists but is **half-wired**. This handoff specifies every remaining piece concretely enough to finish the whole set in one push. **Definition of done is at the bottom — don't stop until all of F1–F5 are green and shipped.**

---

## The crucial reframe (read this before touching anything)

A tiered-routing path **already exists end-to-end** in both orchestrators. It is NOT greenfield:

1. **Assign** — each dispatch entry gets a `model_hint: { tier: "small"|"standard"|"deep", reasons: string[] }`.
   - audit-code: `buildDispatchModelHint(complexity)` — [dispatch.ts:221](../packages/audit-code/src/cli/dispatch.ts) — tier from **complexity** (priority / tokens / tags). **Does not look at risk.**
   - remediate-code: `buildImplementModelHint(block, state)` — [dispatch.ts:689](../packages/remediate-code/src/steps/dispatch.ts) — tier from **finding severity + `classifyFindingRisk`**. Already risk-driven.
2. **Render** — the host is told to map the tier to one of its models:
   - audit: [prompts.ts:75](../packages/audit-code/src/cli/prompts.ts) — only when `--host-can-select-subagent-model` is reported ([nextStepCommand.ts:719](../packages/audit-code/src/cli/nextStepCommand.ts)).
   - remediate: [nextStep.ts:1014](../packages/remediate-code/src/steps/nextStep.ts) — "Each item's `model_hint.tier` suggests which model to use".
3. **Consume** — the host LLM picks an actual model. This is the conversation-first contract; the backend never names a model.

The shared type is `DispatchModelTier = "small" | "standard" | "deep"` / `DispatchModelHint` in [shared/src/types/stepContract.ts:3](../packages/shared/src/types/stepContract.ts).

**So the gaps are precise:**
- **audit-code's tier ignores `routing_risk`** — the graph partition computes `routing_risk` (max member risk per packet) and throws it away; the tier comes from complexity instead. The spec says "route each packet by its **max risk** → relative rank." (F1)
- **The handshake is single-window** — the host reports ONE `(context, output)` window, so the backend can't size the partition per-tier or know how many ranks exist. (F2)
- **Quota keys on `provider/*`** when no model id is discoverable — no opaque model identity from the handshake. (F3)
- **Conceptual fan-out subagents carry no tier** — perspectives/judge dispatch bare. (F4)
- **`review_packets.json` is still persisted** though dispatch rebuilds packets JIT and only the validator reads the artifact. (F5)

---

## F1 — audit-code: `routing_risk` drives the tier (the core unwired piece)

**Goal.** Make an audit packet's `model_hint.tier` a function of its `routing_risk` (the partition's max member risk), so the "route by max risk → relative rank" contract is actually honored. Complexity signals become **escalators only** (they can raise a tier, never lower it) so genuinely-large/critical-flow packets still get the top rank even at low risk.

**Where the data is.**
- `GraphPacket.routing_risk` — [partitionTaskGraph.ts:22](../packages/audit-code/src/orchestrator/partitionTaskGraph.ts) (type) and `:128` (`Math.max` over member `risk_estimate`). risk is a seed in `[0,1]` from `computeRiskEstimate(task)`.
- Packets flow `partitionTaskGraph → buildReviewPacketsFromPartition` ([reviewPackets.ts:524](../packages/audit-code/src/orchestrator/reviewPackets.ts)) → the dispatch loop in [dispatch.ts:934–1020](../packages/audit-code/src/cli/dispatch.ts), where `model_hint: buildDispatchModelHint(complexity)` is set at `:1008`.

**Problem to solve first:** `routing_risk` lives on `GraphPacket`, but the dispatch loop iterates `ReviewPacket`s, and `buildDispatchModelHint` takes a `DispatchComplexity` — neither currently carries `routing_risk`. So step zero is **thread `routing_risk` from `GraphPacket` onto the `ReviewPacket` (or a parallel map keyed by `packet_id`)** through `buildReviewPacketsFromPartition`, then into the dispatch loop.

**Implementation.**
1. Add `routing_risk?: number` to `ReviewPacket` (its type lives in [reviewPackets.ts](../packages/audit-code/src/orchestrator/reviewPackets.ts); also update `schemas/review_packet.schema.json` if F5 hasn't removed it yet). Populate it in `buildReviewPacketsFromPartition` from the `GraphPacket`.
2. Change the tier decision. Recommended shape — a new `resolveDispatchTier({ routingRisk, complexity })`:
   - **risk-primary baseline** from `routing_risk` against thresholds: `>= deepAt → "deep"`, `>= standardAt → "standard"`, else `"small"`.
   - **complexity escalator**: keep the existing `deepReasons` checks from `buildDispatchModelHint` (`isolated_large_file`, `critical_flow`, `external_analyzer_signal`, `lens_verification`, `high_estimated_tokens`) — if any fire, floor the tier at `"deep"`. Likewise a sensitive-lens / medium-priority signal floors at `"standard"`. Escalators never *lower* the risk baseline.
   - Merge `reasons[]`: `["routing_risk:0.74", ...escalatorReasons]` for attributability.
   - **Default thresholds (provider-neutral, relative):** `deepAt = 0.66`, `standardAt = 0.33`. Make them overridable via `sessionConfig.dispatch.routing_tiers = { deep_at, standard_at }` (extend `sessionConfig.ts` `dispatch` block — mirror how `risk_mass_budget` was added in N4b). These are *relative* cut points on a normalized risk scale, NOT model names — keep it that way.
3. Replace `buildDispatchModelHint(complexity)` at the call site with `resolveDispatchTier(...)`. **Atomic replace** — delete the old complexity-only function in the same commit (it has no other callers; verify with a grep) OR have `buildDispatchModelHint` delegate to the new resolver. Prefer deletion per the repo's "ideal code, no back-compat" rule.

**Acceptance / tests** (add to `tests/dispatch-features.test.mjs` or a new `tests/tier-routing.test.mjs`):
- A packet whose tasks are all low-risk and small → `"small"`.
- A mid-risk packet → `"standard"`.
- A high-`routing_risk` packet → `"deep"`.
- A low-risk packet that is an `isolated_large_file` / `critical_flow` → escalated to `"deep"` (escalator floor works).
- `routing_risk` survives `buildReviewPacketsFromPartition` (a packet built from a high-risk task carries the right number).
- Threshold override via `sessionConfig.dispatch.routing_tiers` changes the boundary.

**Atomic-replace boundary:** routing_risk threading + tier resolver + old-function deletion + tests in one commit. Green build+check+test before commit.

---

## F2 — multi-model roster handshake (single window → ordered roster)

**Goal.** Let the host report an **ordered list of available models** (relative rank + per-model window), so the backend can (a) know how many real ranks exist to map tiers onto, and (b) size each packet's partition against the window of the model its tier will run on. Today the handshake is scalar — one `(context, output)` pair for a single active model.

**Today's single-window path (the thing being generalized).**
- Flags: `--host-context-tokens` / `--host-output-tokens` — [args.ts:282](../packages/audit-code/src/cli/args.ts), read at [nextStepCommand.ts:721](../packages/audit-code/src/cli/nextStepCommand.ts).
- `buildDispatchPool` builds ONE `hostCapabilityLimits` and ONE `hostPool: CapacityPool` — [dispatch.ts:660–686](../packages/audit-code/src/cli/dispatch.ts). The single window sizes `contextBudgetTokens`, which `partitionTaskGraph` uses as its one ceiling.
- Skill prompt instructs the single-window report — [audit-code.prompt.md:28–49](../packages/audit-code/skills/audit-code/audit-code.prompt.md).

**Implementation (audit-code; mirror to remediate in the same node or a paired F2b).**
1. **New flag** `--host-models <json>` accepting an ordered array, lowest rank first, e.g.
   `[{"rank":"small","context_tokens":32000,"output_tokens":8000},{"rank":"standard","context_tokens":200000,"output_tokens":32000},{"rank":"deep","context_tokens":200000,"output_tokens":64000}]`.
   - `rank` values reuse the existing `DispatchModelTier` union (`small`/`standard`/`deep`) so they line up with `model_hint.tier`. The host still never names a model — `rank` is relative, windows are discovered. Keep `--host-context-tokens`/`--host-output-tokens` as the single-model shorthand (a 1-entry roster); when both are given, the roster wins.
   - Parse in `args.ts` (new `getHostModelRoster(argv)` returning a validated array or null) + thread through `nextStepCommand` like the scalar flags.
2. **Shared types.** Add a roster type to shared (alongside `DiscoveredRateLimitsInput`): `HostModelRosterEntry { rank: DispatchModelTier; context_tokens; output_tokens }`. `CapacityPool` already takes `discoveredLimits` per pool, so a roster becomes **multiple `CapacityPool`s** (one per rank), each with its own window.
3. **`buildDispatchPool` → build a pool per roster entry.** Return `{ pools: CapacityPool[]; tierBudgets: Record<DispatchModelTier, number>; ... }` where `tierBudgets[rank] = context − output` for that rank. When no roster, fall back to the single pool exactly as today (one tier, the conservative floor).
4. **Partition per tier.** Two viable designs — pick the simpler that passes tests:
   - **(a) Partition-then-validate (recommended):** partition once under the *largest* available window (so coherent clusters aren't over-split), assign tiers via F1's `routing_risk`, then for any packet whose `token_estimate` exceeds *its assigned tier's* `tierBudgets[tier]`, re-split that packet (call `partitionTaskGraph` on just its subgraph under the smaller ceiling) — risk-routing may send a big packet to a small-window rank.
   - **(b) Partition-per-tier:** bucket tasks by their would-be tier first, then partition each bucket under that tier's window. Cleaner separation but loses cross-tier affinity coherence.
   Document the choice in the spec.
5. **Emit tier→window in the plan** so the host/quota can reason about per-tier concurrency. `dispatch-quota.json` already summarizes pools (`capacity_pools`); extend it to carry the roster. `finalizeDispatchQuota` ([dispatch.ts:705](../packages/audit-code/src/cli/dispatch.ts)) computes capacity over `pools` — feed it the multi-pool array.
6. **Skill prompt.** Replace the single-window paragraph with roster guidance + keep the scalar shorthand. Show the JSON example. Make clear: report ranks you can actually dispatch to *now*; omit ⇒ conservative single floor.

**Acceptance / tests:**
- Roster of 3 → 3 `CapacityPool`s with distinct windows; `tierBudgets` correct.
- A high-risk packet routed to `deep` that exceeds the `small` window is NOT mis-sized (design (a): a big low-risk packet sent to `small` re-splits to fit).
- Scalar `--host-context-tokens` still works (1-entry roster path).
- No roster, no scalar → single conservative-floor pool (unchanged behavior; existing tests stay green).

**Atomic-replace boundary:** flag + shared roster type + multi-pool `buildDispatchPool` + partition sizing + quota/plan emission + skill prompt + tests, one commit per orchestrator. **Depends on F1** (needs tier assignment to bucket/route).

---

## F3 — model identity on `model: null` (quota key)

**Goal.** When `resolveHostModel` returns null (no explicit/config/env signal), let the handshake supply an **opaque** model id so quota learning keys on `provider/<id>` instead of `provider/*`, and the roster entries can carry ids for multi-pool quota.

**Where.** `resolveHostModel` lives in [shared/src/quota/limits.ts](../packages/shared/src/quota/limits.ts) (returns null after N5c removed the hardcoded default). Quota keys are built via `buildProviderModelKey(providerName, hostModel)` — used in `buildDispatchPool` ([dispatch.ts:642](../packages/audit-code/src/cli/dispatch.ts)) and remediate `scheduleWave`.

**Implementation.** Add an optional `--host-model-id <opaque>` flag (and per-roster-entry `model_id` in F2's JSON) — an opaque string the backend treats as a quota-key segment ONLY (never a window authority, never compared to a name table; the no-hardcoded-models rule still holds). Thread it into `buildProviderModelKey`'s second arg when present. If absent, `provider/*` as today. Small, independent of F1/F2 but composes with F2's roster (each rank can carry its own id for per-rank quota).

**Acceptance:** with `--host-model-id x`, the dispatch-quota `capacity_pools[].pool_id` / quota state key becomes `provider/x`; without it, `provider/*`. One test each.

---

## F4 — conceptual fan-out carries a tier

**Goal.** The N7 deep-conceptual perspectives (divergent generation) and the judge (synthesis) currently dispatch as bare subagents with no `model_hint` — [conceptualDispatch.ts:65–150](../packages/audit-code/src/cli/conceptualDispatch.ts). Give them tiers so the host can route them like packets.

**Implementation.** In `prepareConceptualDispatch`, attach a `model_hint` to each emitted instruction:
- Perspectives → `"standard"` by default (divergent ideation doesn't need top rank), overridable via `sessionConfig.design_review` (mirror how `perspectives`/`conceptual_depth` were threaded in N7).
- Judge → `"deep"` (it merges/dedup/ranks across all perspective outputs — the hardest reasoning step).
- Render the tier in the `instructionLines` that go into the step prompt (same `entry.model_hint.tier` vocabulary the host already maps), guarded by `hostCanSelectSubagentModel` like the packet path.

**Acceptance:** deep dispatch artifacts/instructions include a `standard` tier on perspectives and `deep` on the judge; shallow path unchanged. Extend `tests/conceptual-fanout.test.mjs`.

**Depends on:** nothing hard, but do it after F1 so the tier vocabulary/rendering is settled.

---

## F5 — stop persisting `review_packets.json`

**Goal.** Remove the dead artifact. Dispatch rebuilds packets JIT via `buildReviewPacketsFromPartition`; the only reader of the persisted file is the validator. Persisting it is staleness-DAG overhead with no consumer.

**Where written:** planning executor [planningExecutors.ts:250](../packages/audit-code/src/orchestrator/planningExecutors.ts) (and rebuilt in [ingestionExecutors.ts:66,197](../packages/audit-code/src/orchestrator/ingestionExecutors.ts) during selective deepening). **Readers:** declared as a bundle artifact in [io/artifacts.ts:206](../packages/audit-code/src/io/artifacts.ts); validated in [validation/artifacts.ts](../packages/audit-code/src/validation/artifacts.ts). Dispatch does NOT read `bundle.review_packets` (grep-confirmed).

**Implementation (atomic replace):**
1. Stop writing `review_packets.json` (remove from `artifacts_written` + the write call in planning & ingestion executors).
2. Remove it from the bundle loader ([io/artifacts.ts](../packages/audit-code/src/io/artifacts.ts)), the staleness/dependency DAG (`orchestrator/dependencyMap.ts`, `spec/dependency-map.md`), and `artifactMetadata.ts` if listed.
3. Remove the validator branch + `schemas/review_packet.schema.json` (and the schema-drift test entry).
4. Keep the in-memory `ReviewPacket` type + `buildReviewPacketsFromPartition` — only the *persistence* goes.
5. Grep for any remaining `review_packets` reference (tests, smoke, docs) and clean.

**Acceptance:** full audit-code suite green with no `review_packets.json` written during a run; a fresh `next-step` dispatch still produces packets. **Caution:** this touches the staleness DAG — re-run a faithful end-to-end dispatch (local dev wrapper, not the global bin) to confirm no convergence regression (see [[a1-finalization-converges]] history). Independent of F1–F4; can land first or last.

---

## Ordering & dependencies

```
F1 (routing_risk → tier)        ← core; do first
   └─ F2 (multi-model roster)   ← needs tier assignment to route/bucket
        └─ F3 (model id)        ← composes with roster (per-rank ids)
F4 (conceptual tiers)           ← after F1 (settled vocabulary)
F5 (strip review_packets.json)  ← independent; land any time
```

Each Fn is an independent atomic-replace commit and is **shippable on its own** — but the point of this handoff is to do the whole set. F1+F4 alone make routing real for the single-window case; F2+F3 unlock true multi-rank dispatch; F5 is cleanup. Mirror F1/F2/F3 reasoning into remediate-code where its dispatch differs (remediate already risk-tiers via `buildImplementModelHint`, so its F1 is mostly "confirm parity + adopt the roster in F2's `scheduleWave`").

## Definition of done (the whole set — don't stop partway)

- [ ] **F1** audit packet tier derives from `routing_risk` (complexity escalates only); old complexity-only `buildDispatchModelHint` deleted; tests green.
- [ ] **F2** `--host-models` roster → multiple `CapacityPool`s with per-rank windows; partition sized/validated per tier; skill prompt updated; scalar shorthand still works; remediate parity.
- [ ] **F3** opaque `--host-model-id` (and per-rank ids) feed the quota key; falls back to `provider/*`.
- [ ] **F4** conceptual perspectives (`standard`) + judge (`deep`) carry tiers.
- [ ] **F5** `review_packets.json` no longer persisted; DAG/validator/schema cleaned; e2e dispatch still converges.
- [ ] All three suites green with **CLAUDECODE unset** (shared / audit-code `node --test` / remediate vitest).
- [ ] Spec [capability-discovery-and-tiered-dispatch-design.md](capability-discovery-and-tiered-dispatch-design.md) Implementation-progress + Resolved-decisions updated per node.
- [ ] **Shipped** via the `/ship` skill: merge to `main`, publish changed packages (minor — these are features), verify live on npm, reinstall global bins + run deferred postinstall, smoke `--version`.

## Gotchas (same as the parent redesign)

- **Build order:** `npm run build -w @audit-tools/shared` first, then `npm run build`. Fresh worktree → root `npm install` (else fake "missing export"). See [[audit-tools-worktree-build-trap]].
- **Tests:** audit-code `node --test` (`tests/*.test.mjs`, subtests `await t.test`); remediate vitest. Run with `env -u CLAUDECODE` or one provider test fails ([[audit-code-claudecode-test-gotcha]]). EPERM/EBUSY on Windows = flake first, rerun alone.
- **Commit gate:** a PreToolUse hook blocks `git commit` until `npm run check` is green; an async PostToolUse hook typechecks the edited package after TS edits — trust it.
- **No hardcoded models — ever.** Ranks are relative; windows + ids are *discovered* from the handshake. `routing_risk` thresholds are relative cut points, not model tiers-by-name. This is the load-bearing invariant ([[model-provider-ide-agnostic]]); Ethan has flagged repeated violations.
- **Dogfood on the dev wrapper / test harness, never the stale global bin** ([[remediate-code-dogfooding-trap]], [[audit-code-global-bin-dangling-junction]]).
- **Ship the whole pipeline** — don't park at push/publish; `/ship` encodes the CLAUDECODE/CRLF/allow-scripts traps. Release CI is the real signal (local Windows-green ≠ Linux-CI-green).
