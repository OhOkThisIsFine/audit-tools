# Capability-evidence obligation — implementation review record (2026-07-18)

Status: **implemented, green, NOT signed off, NOT committed.** Two independent adversarial review
rounds. Round 1 found 5 defects (D1–D5); the fixes closed the named instances but missed their
siblings, and round 2 refused sign-off with 6 further issues. Plan of record:
[`capability-evidence-obligation-plan-2026-07-18.md`](capability-evidence-obligation-plan-2026-07-18.md)
(read its v3 delta first — it carries the owner decisions).

## What is implemented and CONFIRMED correct

The core mechanism, end to end: operator input file → `parseProviderConfirmationInput` →
`annotateConfirmedPool` (index ⇒ `capability_rank`) → persisted on all three confirmation lists →
`readConfirmedCapabilityRanks` (model-keyed) → `resolveDeclaredCapabilityRank` at BOTH `CapacityPool`
constructors → `buildCapabilityFloorCapable`. Confirmed safe across both rounds:

- **Sign convention** LOWER = more capable, unbroken end to end (`scoreBand` sorts ascending,
  `FLOOR_MAX_BAND.deep = 0`, `capabilityScoreCmp` unchanged). Pinned by an end-to-end test.
- **Precedence** external evidence first, confirmed map fills gaps — agrees at all three sites.
- **Schema additive** — `1.0.0` unchanged, legacy artifacts parse and still yield cost order + λ, and
  the `?: never` reach brands still keep reach off disk.
- **Keyspace** is the MODEL id at every hop (delta, prompt, annotate, read, pool join).
- **By-reference gate discipline** — the capability delta is read live and cleared on promotion.
- **First-time confirmation** does not fire the capability gate (that case already pauses).
- **No per-step I/O in the drain** — computed once, threaded by reference; `deriveAuditState` stays pure.

## Round 1 defects (D1–D5) — all fixed

- **D1 (CRITICAL, fixed + red-green validated).** `parseProviderConfirmationInput` reconstructs
  field-by-field and never read `capability_order`, so the operator's answer was silently dropped:
  no rank written, delta recomputes identical, `PRIORITY[0]` re-prompts forever — strictly worse than
  the fail-open it replaced. **All round-1 tests missed it because every one of them handed a raw JS
  object to `buildSharedProviderConfirmation`, bypassing the parser — the one broken link was the one
  link never exercised.** Now pinned by a test that writes the real input file to disk.
- **D2 (fixed at the named site; sibling remains — see NEW-1).** `buildAuditSourcePools` had
  `capabilityRanks` optional on a false justification ("preview callers have no root"); its sole
  production caller is the headless rolling drive with `root` in scope. Now required — and making it
  required is what made the compiler point at the unwired site.
- **D3 (partially fixed).** The autonomous branch claimed "the executor records the LLM's ordering";
  the executor is deterministic and recorded nothing. Now captures `unrankedOnPromotion` before
  clearing and reports it. **Still missing a friction event** for parity with the reach delta.
- **D4 (partially fixed).** A capability-only submission rebuilt `host_model_cost_order` as empty,
  destroying host cost orders and dropping host models out of the delta permanently. Carry-forward
  added — but only on the `input !== null` branch, and only for `host_models` (see NEW-2, NEW-3).
- **D5 (partially fixed).** Parser seam now genuinely pinned; three test gaps remain (below).

## OPEN — blocks sign-off. Most severe first.

1. **NEW-1 (high) — remediate's implement dispatch still fails open.** `marshal.ts:371` calls
   `scheduleWave` with no `capabilityRanks` (optional at `waveScheduling.ts:81`); its
   `schedule.capacity_pools` feed `buildDispatchQuota` → `buildCapabilityFloorCapable`, so every pool
   bands `null` and every `deep` packet admits everywhere. `options.root` is in scope and used two
   lines later. **This is the exact defect the change exists to fix, live on one of the two draws**,
   while the type signature and the `waveScheduling.ts:76-80` comment assert it cannot happen. Silent:
   remediate passes no `onFailOpen`.
2. **NEW-2 (high) — the carry-forward misses the autonomous/headless branch.** `effectiveInput`
   short-circuits on `input &&`, so with `input === null` the whole `host_model_cost_order` list —
   ids, cost orders, and the `capability_rank`s just written — is wiped. The capability delta is a
   BRAND-NEW trigger for the stale→auto-complete path, so this change makes the wipe far more
   reachable. The gate then reports convergence having deleted the evidence.
3. **NEW-3 (high) — a capability-only submission reverts the confirmed COST order.**
   `resolveFinalCostOrder(candidates, undefined)` falls back to the price-ascending suggestion;
   nothing reads the prior `cost_order` back. D4 carried `host_models` forward but not `cost_order`,
   and the prompt's example contains only `capability_order`, so an operator answering exactly what
   was asked hits this every time.
4. **NEW-4 (high) — the capability prompt's JSON fragment omits `schema_version`**, and it renders
   FIRST. A host writing it verbatim produces a file the parser rejects outright → treated as "no
   submission" → identical prompt re-emits: the D1 livelock reintroduced one layer up. Compounding
   it, the canonical shape block does not list `capability_order` at all, so a host using the
   authoritative shape has no field to answer with.
5. **NEW-5 (medium) — deliberate host-model removal is now unrepresentable.** `!input.host_models?.length`
   cannot distinguish an explicit `[]` from omission (the parser drops empty arrays), so the
   carry-forward resurrects a roster the operator removed. Also silently drops `tier`.
6. **NEW-6 (low) — indentation** at `advance.ts:168` (4 spaces inside a 6-space literal).

### Test gaps that let the above through
- `resolveUnevidencedCapabilityPools` has **zero** tests (module-private in `nextStepCommand.ts`).
- `effectiveInput` (D4) and `unrankedOnPromotion` (D3) — both loop-core behavior changes — shipped
  with **no direct coverage**.
- The submission-CLEARS-the-delta path is untested end-to-end; only the emit half is covered.
- No autonomous + capability-delta test (`nextStepHelpers.ts` `hasDelta` OR is untested).
- `provider-confirmation-reconciliation.test.mjs:552` "convergence" test is tautological — it feeds
  `[]` and asserts `satisfied`; it would pass unchanged if model-less pools were admitted to the delta.

## The durable lesson

**Fixing the named instance is not fixing the defect.** Every round-2 issue except NEW-4 is a sibling
of a round-1 defect on a branch the round-1 fix did not sweep: NEW-1 = D2 on the remediate draw,
NEW-2 = D4 on the `input === null` branch, NEW-3 = D4 on the `cost_order` field. When a review names a
defect, the fix must enumerate every site of that defect CLASS — for a fail-open mechanism especially,
where an unwired site is indistinguishable from a working one.

Corollary, and the reason D1 survived authoring: **a test that constructs the input object under test
is not a test of the seam that produces it.** The parser was the only unexercised link and the only
broken one.
