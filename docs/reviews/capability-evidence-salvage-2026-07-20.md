# Capability-evidence salvage onto current main (2026-07-20)

Salvage of `wip/capability-evidence` (review-blocked across 4 rounds, last touched 2026-07-19) onto
current `main` (v0.34.3). Branch: `salvage/capability-evidence`. **Green, NOT landed** — the landing
gate below is unmet.

## Why the raw branch could not merge
- Forked at `a8bee5da` (2026-07-18); **main moved 64 commits since** — backend-identity stages 1–2
  (`transport`/`service` rename + `identity.ts` leaf-module), multi-constraint account metering
  (v0.34.2/3), memory consolidation, backlog reclassification.
- Merging raw would REVERT shipped files (`identity.ts`, `windowConstraints.ts`,
  `backend-identity-axes.md`) and re-introduce a superseded account-metering rework (branch tip
  `e500672f`).
- The 5 branch commits bundle TWO workstreams: (1) the **capability-evidence obligation** (the
  deliverable — pins unevidenced pools instead of fail-opening at the admission floor) and (2) an
  **R3-4 cooldown/rpm spill rework** built on the OLD metering API, which main superseded with
  multi-constraint windows + the v0.34.3 cooldown-partition unify.

## What was salvaged (scoped to commits `22bf5668` + `a477f2dd`; `e500672f` excluded)
- **Source:** 3-way applied `git diff a8bee5da..a477f2dd` source slice — **23/24 files clean**, one
  import-list conflict resolved (merged lists; dropped dead `buildProviderModelKey` import, which is
  main's `quotaPoolKey`, byte-identical, moved into `identity.ts` by the rename).
- **`admissionLoop.ts` surgery:** kept ONLY the capability additions (`CapabilityFailOpenInfo`,
  `buildObservedCapabilityFloorCapable` dedup wrapper); dropped ALL cooldown/rpm hunks
  (`requestsPerMinute`/`cooldownUntilMs` fields, `deriveSustainedThroughput`/`deriveRateCap`/`minCap`/
  `parseCooldownMs`, the summaries mapping, the rate-aware `admitBatch` cap). Hunks classified via NIM
  offload, each verified against source. The capability FLOOR itself was already on main; the branch
  only added the obligation + the dedup wrapper. Dedup key changed from a raw-NUL separator to
  `JSON.stringify([poolId, packetId])` — unambiguous, and no binary source byte.
- **Tests:** applied the cap-evidence test slice (2 new files + 3 edited). Reset `admission-loop.test.mjs`
  to HEAD — its branch additions were the dropped cooldown/rpm axis. Translated the identity rename in
  source/persisted fixtures (`provider:` → `transport:`, 38 sites) while keeping SessionConfig/host
  `provider:` (claude-code / codex / agy host configs); one mis-rename caught + fixed.

## Verified landed (the round-3 core fixes)
- **NEW-1 / R3-1:** `marshal.ts` now passes `capabilityRanks` to `scheduleWave` — remediate's implement
  dispatch no longer fails open silently. `waveScheduling` `capabilityRanks` is a REQUIRED param (D2).
- `nextStepCommand` wires `resolveUnevidencedCapabilityPools` (the delta).
- End-to-end capability_order → capability_rank → `readConfirmedCapabilityRanks` round-trips (was the
  break — stale `provider:` fixtures, now `transport:`).

## Green
`npm run check` ✓ · full suite ✓ (only failure is the backlog-documented `linux-cycle-regression`
load-flake, passes alone in ~31s; run-to-run variance 3→1→0 confirms flake) · the 5 changed test
files 205/205.

## Landing gate — MET 2026-07-21 (`c0cf7e9b`)
1. **R3-3 — SHIPPED as a host-LLM ranker step, not an auto-ranker.** Autonomous + capability delta
   now emits the ranking prompt to the host LLM (autonomous = no human operator, never no LLM); the
   answer rides the existing `capability_order` submission machinery with TOOL-DERIVED authorship
   (autonomous ⇒ LLM-authored): sanitized to `capability_order` alone, never able to confirm reach
   or lift an exclusion, never able to reorder previously-ranked models (the total-replacement
   escape is operator-only), provenance-recorded in `policy.capability_order_llm_ranked` with
   operator supersession. The hostless `advanceAudit` entrypoint keeps the loud unranked-promotion
   fallback (no LLM exists there).
2. `scheduleWave`/`buildConfirmedPools` rank-stamping tests — shipped; first draft's conditional
   assertions were vacuous (fixture models never matched the map) and were made unconditional
   against the real `CapacityPool` field names (`hostModel`/`declaredCapabilityRank`).
3. Producer-seam tests (`admissionPoolsFromSummaries` capabilityScore flow; emission-branch +
   prompt-variant + anchor-marker tests) — shipped.
4. Independent review + loop-core attestation — a glm-5.2 refute pass (clear) plus an independent
   agent review (verdict: concerns) whose HIGH finding — LLM-authored `include`/`exclude` flowing
   unguarded through `retainAutoExclusions`, able to re-admit a fail-closed backend two rounds
   after the write — was fixed (executor sanitize) and pinned by a regression test replaying the
   exact exploit. Attestation (attester_class: agent) bound to the landed tree.

> **History:** this gate was falsely marked MET on 2026-07-20 by a deterministic `context_tokens`
> sort that self-certified items 2–4 (reverted 2026-07-21; record:
> [`antigravity-agent-commits-2026-07-21.md`](antigravity-agent-commits-2026-07-21.md)), then
> genuinely met on 2026-07-21 by `c0cf7e9b` as described above.

Supersedes the round-2 record [`capability-evidence-implementation-review-2026-07-18.md`](capability-evidence-implementation-review-2026-07-18.md).
