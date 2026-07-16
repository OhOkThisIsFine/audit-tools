# G3 plan — the confirmed pool: policy vs reach

Dated plan record. Durable design lives in [`spec/unified-dispatch-worker-model.md`](../../spec/unified-dispatch-worker-model.md)
→ Decomposition G3. One-off; not a timeless concept.

> **Two independent adversarial reviews both returned REWORK, and each refuted the *previous* premise.**
> Draft 1 proposed collapsing the Gate-0 artifact into `RepoSessionIntent` — refuted (the intent paths are
> disjoint; the artifact is the only cross-tool channel). Draft 2 proposed slimming the artifact to close an
> inheritance hole in `excluded` — refuted (**nothing reads `excluded`**; there is no hole). The refutations
> are recorded because they are the rationale for what survived. **Do not re-plan from a superseded draft.**

## Verified ground truth (re-verified directly at HEAD, not taken from either review)

| Claim | Status | Evidence |
|---|---|---|
| `confirmed_provider_pool` is an inert slot | ✅ | zero producers/consumers; `sessionConfig.ts:539,621-625`, stale comment `providerConfirmation.ts:243`, 2 type-only tests |
| `excluded` has **no** dispatch reader | ✅ | only reader is the in-memory Gate-0 renderer `providerConfirmationStep.ts:48` |
| dispatch reads the artifact via `model_id` + `cost_order` **only** | ✅ | `resolveConfirmedCostPositions`, `costRank.ts:299-315` |
| excluded entries still get a `cost_order` | ✅ | `annotateConfirmedPool`, `providerConfirmation.ts:394` maps **every** entry |
| ⇒ **the operator's `exclude` has no dispatch effect at all** | ✅ | composition of the three above |
| `roster` is persisted reach | ✅ | `sharedProviderConfirmation.ts:136`, written `:289` = `sortRoster(discovered.map(p => p.name))` |
| the artifact does **not** persist explicit `exclude`/`include` | ✅ | `buildSharedProviderConfirmation:275-290` — only the derived per-entry `excluded` |
| `provider_confirmation` obligation is presence-only, no staleness edges | ✅ | `state.ts:83-85`; `spec/audit/dependency-map.md:166` shows `—` |
| intent paths are disjoint | ✅ | audit `src/audit/supervisor/sessionConfig.ts:16`; remediate `src/remediate/steps/nextStep.ts:1794-1797` |
| `buildSourcePools` is the **shared routing chokepoint** | ✅ | audit `hybridDispatch.ts:67`; remediate `waveScheduling.ts:335` |
| `gatherDispatchableSources` feeds routing **and** the Gate-0 display | ✅ | Gate-0 `nextStepCommand.ts:865`, `intakeExecutors.ts:167` |
| `DispatchableSource.provider` carries provider identity into `CapacityPool.source` | ✅ | `apiPool.ts` `buildSourcePool` |
| `autonomous_mode` is remediate-only | ✅ | sole reader `resolveAutonomousMode`, `nextStep.ts:201-209` |
| `"?"` vs `"default"` tail drift | ⚠️ **cosmetic, NOT a live bug** | `sourceId()` keys only *unverified* `DroppedSource.id`; `dispatchSourceKey()` keys *verified* — disjoint by construction (`auditorSources.ts:264-268`) |
| load-bearing key grammar is `provider[#account]/model` | ✅ | `buildProviderModelKey`, `scheduler.ts:802-809`; the `apiPool.ts:22` doc comment claiming `provider:model` is itself stale |

## What G3 actually is (re-motivated from source)

**Not** "close an inheritance hole" — there is none; the reach half is *write-only*. G3 is:

1. **Wire the operator's exclusion for the first time** (a real, user-visible bug fix).
2. **Delete write-only reach** from the persisted shape (inert data that *looks* authoritative).
3. **Decide roster-staleness's fate** (see Deferred below).
4. Delete the inert `confirmed_provider_pool` slot + the tested-but-unwired `ConfirmedProviderPool` /
   `applyProviderConfirmationSelections` (`index.ts:890,896` — knip gate).

## Owner decisions (2026-07-16)

- **Sequencing: bugs first, then the split.** Ship the live bugs as their own commits against a tree whose
  behavior is then correct; do the policy/reach split after.
- **The artifact re-home folds into G3**, not G5 (superseded in part by the above — the *bugs* lead).
- **Roster-staleness: DEFERRED, not decided.** The owner's constraint: *"we also need the user to confirm
  model choices."* That is the load-bearing objection to simply deleting the check — a newly-reachable model
  must not route unconfirmed. But the reconciliation gate that would enforce that **is currently unreachable
  on resume** (presence-only obligation, no staleness edge — see table). **So the sequence is forced: make
  the gate reachable FIRST, then decide staleness.** Deleting the check while the gate can't fire would let
  new models route unconfirmed — exactly what the owner ruled out.

## The exclusion fix (bug 1) — design

**Seam:** filter at `buildSourcePools` (`apiPool.ts`), the shared routing chokepoint — **not** at
`gatherDispatchableSources`. A free-model recon suggested the gather; that is **wrong**, and the distinction
is load-bearing: the gather also feeds the **Gate-0 display**, where an excluded provider must remain
*visible and marked excluded* so the operator can see and re-include it. Display and routing must diverge
here, deliberately.

**Artifact change (additive, required):** persist the operator's **explicit, reach-free** decision —
`input.exclude` / `input.include` (`ProviderConfirmationInput`, `types/providerConfirmation.ts:65-93`) —
NOT the derived `excluded` boolean, which bakes in the *writing* auditor's `CLAUDECODE`/`CODEX` env via
`isSelfSpawnBlocked` (`providerConfirmation.ts:179`). Self-spawn-blocked is recomputed in the **reading**
process. This is the policy/reach cut applied at exactly the point the bug forces us to touch — so it is not
rework, it is the split's first honest increment.

**Keyspace caveat (known, accepted for this increment):** `exclude` is `ResolvedProviderName[]` — a provider
NAME. Excluding `openai-compatible` therefore excludes *every* NIM source. That coarseness is precisely why
the spec wants a `provider:model` exclusion grammar; pinning that grammar stays in the split, not the bug fix.

## Deferred to the split (explicitly NOT this increment)

- Roster-staleness decision + making the reconciliation gate reachable (needs a dependency edge or an
  identity check on `provider_confirmation` — `state.ts:83`).
- The `provider:model` exclusion-key grammar + extracting the key helper (reconciled against
  `buildProviderModelKey`, the load-bearing grammar; fix the stale `apiPool.ts:22` comment).
- Lifting `resolveAutonomousMode` to shared (rename the `REMEDIATE_*` env var; *ideal code over compatibility*).
- Deleting `ConfirmedPoolEntry`'s persisted reach from **both** artifacts (it is write-only in both; retain
  the type as the in-memory render DTO only).
- `schema_version` story: a bump makes `parseSharedProviderConfirmation:388` return `null` → silent degrade
  to ∅ positions + λ=0. Rejection must be **loud** (friction), not a silent degrade. Must be named before
  the shape changes.

## Loop-core

**Attestation required.** `LOOP_CORE_PATTERNS` (`loopCorePaths.ts:27-48`) hits: `src/audit/orchestrator/`
(:37), `src/shared/dispatch/` (:43), `src/audit/cli/dispatch.ts` (:32), `src/remediate/steps/dispatch/`
(:40), `src/remediate/steps/nextStep.ts` (:41), **`src/shared/quota/` (:45)** — which draft 1 omitted while
its own table named `apiPool.ts`. Verified free: `src/shared/types/`, `/validation/`, `/config/`,
`/providers/`, `/friction/`.

## Also in scope / red-green pivot

`tests/shared/provider-self-spawn-exclusion.test.mjs` (encodes the reach-derived `excluded` behavior),
`tests/shared/provider-confirmation-cost.test.mjs` (~10 round-trip tests),
`docs/audit-pkg/operator-guide.md:205-256`, `spec/cost-first-routing.md:87-95`,
`spec/dispatch-cost-speed-dial.md:123-128`, `src/shared/index.ts:1400-1401` (knip).
