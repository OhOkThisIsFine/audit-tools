# Refactoring Plan: Item 2.1 - deriveObligationState Function Twin

## Item Overview & Current State

- **Item:** 2.1 deriveObligationState Function Twin
- **Files Involved:**
  - src/audit/cli/nextStepHelpers.ts (symbol: `deriveObligationState`, private)
  - src/audit/orchestrator/advance.ts (symbol: `deriveObligationState`, exported)
- **Key Symbols:** `deriveObligationState`, `deriveAuditState`, `ArtifactBundle`, `AuditState`, `PRIORITY`
- **Prior Sweep & Verification Findings:**
  `(id: string, cache: WeakMap<ArtifactBundle, AuditState>) => (bundle: ArtifactBundle) => "missing" | "stale" | "satisfied"`.
  The function memoizes `deriveAuditState(bundle, { emitStaleness: false })` per bundle identity.
  Both files contain a byte-identical higher-order closure:

- **Confirmed by inspection (this plan):**
  - `advance.ts` owns the **plan draw**: `buildPlanDrawObligations` builds one `ObligationDef` per `PRIORITY` id with `derive: deriveObligationState(id, cache)` and a classify-then-dispatch `execute` (`runPlanDrawStep`). Consumed by `advanceAudit` / `advanceAuditInner` (the deterministic-only draw behind `audit-code plan`). Its per-call memo (`deriveCache`) is created fresh in `advanceAuditInner`.
  - `nextStepHelpers.ts` owns the **full next-step fold**: `buildAuditObligations` builds the same PRIORITY-derived registry skeleton but with 13 bespoke consuming `execute` bodies plus `runDeterministicExecutor` / `runHostDelegationObligation` fallbacks. Consumed by the fold driver (`runDeterministicForNextStep`). Its per-registry memo (`cache`) is created fresh in `buildAuditObligations`.
  - The two `deriveObligationState` bodies are logically identical (complete-gate short-circuit → WeakMap memo on bundle identity → find-by-id → absent/pruned means satisfied → `missing`/`stale` pass through, everything else collapses to satisfied). Only the doc comments differ (each names the other as its "namesake").
  - `deriveAuditState` lives in `src/audit/orchestrator/state.ts` and is audit-specific: it runs the holistic content-hash staleness pass (`computeStaleArtifacts`) plus audit-domain derivations (intent equivalence, pending-task partition, design-review pass states). Both twin sites already import it from there.
  - Repo-wide grep shows **no other importers** of either twin: only the two definition sites, their two registry builders, and one test (`tests/audit/advance-drain-loop.test.ts`, which imports `deriveObligationState` from `advance.ts` for the memo-identity test).

---

## 1. Architectural Rationale & Boundary Analysis

### 1.1 What the twin is and why it exists

`deriveObligationState` is a per-obligation-id **projection** of the holistic `deriveAuditState` scan. `deriveAuditState` computes EVERY obligation's state in one pass (including the expensive `computeStaleArtifacts` content-hash walk), but the shared engine's `findNextObligation` selects by calling **every** registered def's `derive` on each scan. Without memoization the fold would run the full staleness pass once per obligation per scan (~25 passes to answer one selection question) - the regression commit `6145a1a3` measured and memoized away. The `WeakMap<ArtifactBundle, AuditState>` keyed on bundle **identity** is safe because every transition builds a fresh bundle object, and the `complete` gate above the memo can only flip via a transition - so a cache entry can never outlive the state it was derived under. All in-fold derivations run `emitStaleness: false`; the single consolidated staleness record is emitted once at the drain boundary by the driver.

### 1.2 Why the catalog's proposed home (`src/shared/engine/obligationEngine.ts`) is wrong

`obligationEngine.ts` owns only the **generic selection vocabulary**: `ObligationStateSchema` / `isActionableObligationState`, `findFirstActionableObligation`, `ObligationDef`, `findNextObligation`, `advance`, `deriveEngineBound`, `describeStoppedFold`. Its module header states the boundary explicitly: each orchestrator derives its own obligation states - audit-code from the artifact-staleness DAG, remediate-code from persisted status plus sidecar files. The engine module imports only `zod`; it is deliberately free of audit-domain concepts.

`deriveObligationState` is audit-specific all the way down: it calls `deriveAuditState`, which imports `computeStaleArtifacts`, `intentEquivalenceExecutor`, `pendingTasks`, `intentInterpreter`, and `designReviewSnapshot`. Moving the twin into `shared/` would either (a) drag `deriveAuditState` and its whole audit-domain import closure into `shared/`, inverting the layering (`shared/` depending on `audit/`), or (b) parameterize the derive over an injected audit function, adding indirection to a two-call-site helper for no consumer benefit - remediate-code derives from persisted status plus sidecars and would never call it. Either outcome violates the A3 engine-unification boundary the module header documents. **Do not move this to `shared/`.**

### 1.3 Correct home: `src/audit/orchestrator/state.ts` (owns `deriveAuditState`)
The helper is a memoized per-id projection of `deriveAuditState`; the module that owns the scan should own its projection. Both consumers already import `deriveAuditState` from `state.ts`, so relocating the twin there introduces **no new import edge and no cycle risk** (`state.ts` imports only artifact IO, types, staleness, and executor-domain derivations - never the CLI fold or the advance drain). Alternatives considered and rejected:


- **New module `src/audit/orchestrator/obligationDerive.ts`** - justified only if `state.ts` growth is a concern; it currently holds one focused derivation plus small helpers, so a new file adds a seam without a second consumer to justify it. Acceptable fallback if review prefers it; the rest of this plan is unchanged apart from the import path.
- **`src/audit/orchestrator/nextStep.ts`** (owns `PRIORITY`, `decideNextStep`, `findObligation`) - owns *selection*, not *derivation*; placing the derive there mixes the two responsibilities this refactor is trying to keep separated.
- **Keep one copy and import across** (e.g. CLI imports from `advance.ts`) - wrong direction: `nextStepHelpers.ts` (CLI layer) must not depend on `advance.ts` (orchestrator drain internals like `runSingleAdvanceStep`, heartbeat, `MAX_DRAIN_STEPS`) for a derivation helper. The dependency must point at the lower layer (`state.ts`), which both already use.
### 1.4 Semantics that must be preserved verbatim


- Signature stays byte-identical: `(id: string, cache: WeakMap<ArtifactBundle, AuditState>) => (bundle: ArtifactBundle) => "missing" | "stale" | "satisfied"`. The narrowed return (a subset of the shared 6-member `ObligationState`) is intentional and remains assignable to `ObligationDef<S, Ctx, Step>["derive"]`: non-actionable states (`present`, `blocked`, `not_applicable`, plus any satisfied-family value) collapse to `"satisfied"`, which is exactly the `isActionableObligationState` partition (only `missing`/`stale` are actionable). Do **not** widen the return to `ObligationState` - that would require deciding a mapping for states the audit scan never needs per-id, expanding the contract for no behavioral gain.
- Pruned/absent obligation ids (e.g. `friction_capture_current`, which `deriveAuditState` never emits) stay `satisfied`, preserving today's "unreachable" behavior that `buildPlanDrawObligations` / `buildAuditObligations` document.
- The `bundle.audit_state?.status === "complete"` short-circuit stays **above** the memo (it must not populate the cache with a state derived under a stale gate).
- Per-call `WeakMap` ownership is unchanged: each registry construction creates its own cache (fresh per `advanceAudit` call / per `buildAuditObligations()` call), never module-level.

---

## 2. Blast Radius & Affected Files

| File | Role in this refactor | Change class |
|---|---|---|
| `src/audit/orchestrator/state.ts` | New single home of `deriveObligationState` (moved here with merged jsdoc) | **Additive** (one exported function; optionally one cache-factory helper) |
| `src/audit/cli/nextStepHelpers.ts` | Delete private twin; import from `../orchestrator/state.js` (already imports `deriveAuditState` from there); `buildAuditObligations` keeps calling it unchanged | **Delete + import** |
| `tests/audit/advance-drain-loop.test.ts` | Imports `deriveObligationState` from `advance.ts` (memo-identity test) - repoint import to new home | **Test-only import path** |

- **No other importers.** Verified by repo-wide grep for `deriveObligationState`: only the two definition sites, the two registry builders (`buildPlanDrawObligations`, `buildAuditObligations`), and the one test. No other file references the symbol.
- **Comment-only references to fix:** the PRIORITY-ordering guarantee comment in `advance.ts` (cites `deriveObligationState` memo keyed on bundle identity - still true, but reword to point at the new home), and each twin's jsdoc paragraph naming the other file as its "namesake" (merge into one jsdoc at the new home; delete both originals with the bodies).
- **No runtime behavior change is intended or expected.** This is a pure relocation: same signature, same body, same memo discipline, same call sites. The existing suite is the regression net; no new behavior needs coverage.
- **Risks (all low):** (1) import-cycle regression - mitigated: `state.ts` gains no imports (the body needs only `deriveAuditState`, `ArtifactBundle`, `AuditState`, all already there); (2) export-visibility change breaking the test - handled by repointing the one test import, no compat shim (repo convention: no shims for internal test-only imports); (3) jsdoc drift - handled by merging both comment blocks into the single new jsdoc rather than copying one.

---

## 3. Specific Code Modifications (Symbol-Located)

### 3.1 `src/audit/orchestrator/state.ts` - add the single definition

- Add an exported `deriveObligationState` with the **identical signature** `(id: string, cache: WeakMap<ArtifactBundle, AuditState>) => (bundle: ArtifactBundle) => "missing" | "stale" | "satisfied"` and the **identical body** (complete-gate → memo lookup → `deriveAuditState(bundle, { emitStaleness: false })` on miss → find-by-id → absent means satisfied → `missing`/`stale` passthrough, else satisfied).
- Write one merged jsdoc from the two existing blocks: what the projection is (holistic-scan narrowing), why it is memoized (per-scan `|PRIORITY|` derivation fan-out, regression `6145a1a3`), why the identity key is safe (fresh bundle per transition; gate flips only via transition), why derivations are emit-off (driver emits the one consolidated staleness record), and the pruned-id convention (`friction_capture_current` stays inert by absence).
- No new imports needed: `deriveAuditState`, `ArtifactBundle`, and `AuditState` are all already in scope in this module.
- Optional, recommended: export a `createObligationDeriveCache()` factory returning `new WeakMap<ArtifactBundle, AuditState>()` so the "fresh per-registry, never module-level" discipline is single-sourced instead of spelled as a bare `new WeakMap` at two call sites. If adopted, both builders use it; if review prefers minimal diff, skip without affecting correctness.

### 3.2 `src/audit/orchestrator/advance.ts` - delete twin, import

- Delete the exported `deriveObligationState` definition (including its jsdoc block describing the plan-draw memo).
- Extend the existing `state.js` import (currently `deriveAuditState`) to also import `deriveObligationState` (and `createObligationDeriveCache` if adopted).
- `buildPlanDrawObligations` is otherwise untouched: it keeps `derive: deriveObligationState(id, cache)` per `PRIORITY` id, and `advanceAuditInner` keeps creating the per-call `deriveCache` (via the factory if adopted).
- Reword the PRIORITY-ordering guarantee comment that cites `deriveObligationState` so it points at the new home (`state.ts`) instead of implying a local definition. Comment-only; no logic change.

### 3.3 `src/audit/cli/nextStepHelpers.ts` - delete twin, import

- Delete the private `deriveObligationState` definition (including its jsdoc block describing the fold memo and the `6145a1a3` regression).
- Extend the existing `../orchestrator/state.js` import (currently `deriveAuditState`) with `deriveObligationState` (and the factory if adopted).
- `buildAuditObligations` is otherwise untouched: same per-registry `cache`, same `derive: deriveObligationState(id, cache)` in the `PRIORITY.map`, same bespoke-id coverage assertion.

### 3.4 `tests/audit/advance-drain-loop.test.ts` - repoint one import

- The memo-identity test ("the drain re-derives obligation state at every transition") imports `deriveObligationState` from the orchestrator `advance` module. Repoint that import to the new home (`state.ts`). The test body is unchanged - it exercises the exact contract the relocation must preserve (same-object memo hit; fresh-bundle re-derivation).
- Do **not** add a compat re-export in `advance.ts`: the symbol's only external consumer is this test, and a shim would recreate the two-homes problem being removed.

  The catalog proposed moving this directly to `src/shared/engine/obligationEngine.ts`. However, verification revealed that `obligationEngine.ts` explicitly owns only generic selection vocabulary ("each orchestrator derives its own obligation states"). Moving audit-specific `deriveAuditState` into `shared/` violates architectural layering.
### 3.5 Explicitly out of scope

- No change to `deriveAuditState`, `decideNextStep`, `PRIORITY`, `findObligation`, `obligationPolicy.ts`, the 13 bespoke fold bodies, `runPlanDrawStep`, `runSingleAdvanceStep`, or `src/shared/engine/obligationEngine.ts`.
- No signature change, no return-type widening, no memo-ownership change, no new runtime behavior.


## 4. Step-by-Step Implementation Sequence

1. **Add the single definition.** In `src/audit/orchestrator/state.ts`, append the exported `deriveObligationState` (merged jsdoc, identical signature and body). Optionally add `createObligationDeriveCache`. Typecheck this file in isolation - it must compile with zero new imports.
2. **Convert `advance.ts`.** Delete its `deriveObligationState` block; extend its `state.js` import. Confirm `buildPlanDrawObligations` and `advanceAuditInner` still resolve the symbol from the import. Reword the ordering-guarantee comment's pointer.
3. **Convert `nextStepHelpers.ts`.** Delete its private `deriveObligationState` block; extend its `../orchestrator/state.js` import. Confirm `buildAuditObligations` still resolves the symbol from the import.
4. **Repoint the test import** in `tests/audit/advance-drain-loop.test.ts` to the new home. No test-body changes.
5. **Sweep for residue.** Grep for `deriveObligationState` across `src/` and `tests/`: expect exactly one definition (in `state.ts`), two call sites (the two registry builders), one test import, and the engine import in each converted file. Grep for `namesake` in both converted files and remove or repoint any leftover cross-reference prose.
6. **Verify** per Section 5, then commit as a single pure-relocation commit (no behavior mixed in).


## 5. Verification & Regression Test Plan

- **Typecheck + lint.** Full `tsc` (or repo typecheck script) and eslint over the touched files. This catches the highest-risk failure mode of a relocation: a missed import or a stale reference. Must be clean.
- **Targeted test.** Run `tests/audit/advance-drain-loop.test.ts` - it directly exercises the moved symbol's contract (memo hit on same identity; re-derivation on fresh bundle; ordering-violation reporting). Must pass unmodified apart from the import path.
- **Regression suites.** Run the full audit suites covering both draws: the `advanceAudit` / plan-draw tests and the `next-step` fold tests (`runDeterministicForNextStep`, `buildAuditObligations` consumers). Because the change is behavior-preserving by construction, the existing suites are the regression net - any failure here means the relocation was not pure and must be investigated as a moved-body discrepancy, not a test update.
- **Structural assertions (manual, cheap).**
  - `grep deriveObligationState`: exactly one `export function` (in `state.ts`), zero definitions remaining in `advance.ts` / `nextStepHelpers.ts`.
  - `grep namesake`: no remaining prose claiming a twin in the other file.
  - Confirm `src/shared/engine/obligationEngine.ts` is untouched (`git status` / diff shows no shared-layer changes) - the layering invariant this plan defends.
  - Confirm no new dependency edge into `state.ts` beyond what both consumers already imported (its import block should be diff-identical).
- **No new tests required.** The relocation adds no behavior; the pre-existing memo-identity test plus the two draws' suites cover the contract. Optionally, a future hardening test could assert both registry builders resolve the same `deriveObligationState` reference (import-equality), making a re-twinning a test failure rather than a review catch - recommended as a follow-up, not a gate for this item.
- **Acceptance.** Single commit, pure relocation (reviewer can verify by diffing each deleted body against the added body - they must be token-identical apart from jsdoc), all suites green, structural greps as above.
