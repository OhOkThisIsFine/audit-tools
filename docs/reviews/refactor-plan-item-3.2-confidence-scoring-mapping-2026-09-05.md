# Refactoring Plan: Item 3.2 - Confidence Scoring Mapping

## Item Overview & Current State

- **Item:** 3.2 Confidence Scoring Mapping (Type 3 clone, 24 AST nodes matching)
- **Catalog Reference:** `docs/reviews/duplication-and-complexity-catalog-2026-09-05.md` §3.2
- **Files Involved:**
  - `src/audit/extractors/analyzers/merge.ts` (symbol: `confidenceOf`, lines ~49-53)
  - `src/audit/orchestrator/edgeReasoning.ts` (symbol: `confidenceOf`, lines ~51-55)
- **Key Symbols:** `confidenceOf`, `GraphEdge`, `DEFAULT_EDGE_CONFIDENCE_FLOOR`, `TS_*_EDGE_CONFIDENCE`
- **Prior Sweep & Verification Findings:**
  - Identical 5-line private helper in both files:
    `typeof edge.confidence === "number" && Number.isFinite(edge.confidence) ? edge.confidence : 0`.
  - The catalog's remediation ("unify into `src/shared/types/graph.ts` next to edge confidence definitions") is the **wrong landing zone**: that module holds only Zod schemas + inferred types (pure declarations, zero runtime logic). A runtime helper does not belong there.
  - The catalog's "Why Identified" text (mapping `"high" | "medium" | "low"` literals to probabilities) does **not** describe what the code does. Both helpers read a numeric `GraphEdge.confidence` with a `0` fallback for missing/non-finite values. There is no literal-to-probability mapping anywhere in these two files. The plan below corrects that description; no such mapping function is introduced.

---

## 1. Architectural Rationale & Boundary Analysis

### 1.1 What `confidenceOf` actually is

A total, pure read of the shared `GraphEdge` contract: "a stated confidence, or 0 for an edge that never stated one." Inputs are `GraphEdge` (declared in `src/shared/types/graph.ts`); semantics are language-neutral (no TS/Python/HTML knowledge); both call sites (analyzer merge, Phase 4B edge reasoning) are downstream consumers of the same contract. This is a **shared graph primitive**, not audit-orchestrator policy and not analyzer policy.

### 1.2 Why `src/shared/types/graph.ts` is wrong (catalog correction)

- `src/shared/types/graph.ts` contains **only** Zod schemas (`GraphEdgeSchema`, `RouteEdgeSchema`, `NodeMetricSchema`, `NodeMetricsSchema`, `GraphBundleSchema`) and `z.infer` types. Zero functions, zero runtime logic.
- Adding a runtime helper there breaks the module's single responsibility (schema declarations), couples every type-only import site to a behavior module, and sets the precedent that behavior accretes next to schemas. The existing codebase already respects this split: runtime graph logic lives in `src/shared/graph/` (`graphPaths.ts`, `directedCycles.ts`), while `src/shared/types/graph.ts` stays declarative.
- Correct landing zone: **`src/shared/graph/`** — the established home for "pure functions over the `GraphBundle`/`GraphEdge` contract," documented as such in the `graphPaths.ts` header ("operate purely on the shared `GraphBundle`/`GraphEdge` contract — so they live in `audit-tools/shared` where BOTH orchestrators … can single-source them").

### 1.3 New module vs. extending an existing one

- `graphPaths.ts` = path normalization + bundle flattening. `directedCycles.ts` = cycle primitives over id/dependency lists. Confidence reading is a third, orthogonal concern; bolting it onto either muddies both.
- **Decision: new file `src/shared/graph/edgeConfidence.ts`** exporting one function (name below). Single responsibility, discoverable, trivially unit-testable, and re-exported from `src/shared/index.ts` alongside `normalizeGraphPath`/`collectGraphEdges`/`findCyclicComponents`.

### 1.4 Naming the shared function

Both current definitions are private `confidenceOf`. Exported shared name should follow repo convention (`normalizeGraphPath`, `collectGraphEdges`, `findCyclicComponents` — verb-led, self-describing at the import site). Recommended: **`edgeConfidence(edge: GraphEdge): number`**. Note `src/audit/extractors/graph.ts` already has a private `edgeConfidence` with *weaker* semantics (missing the `Number.isFinite` guard — see §2.3); unifying on this name makes that latent inconsistency visible and forces a deliberate keep-or-fix decision rather than a silent second meaning.

### 1.5 Scoping the neighboring symbols (what is NOT unified)

- **`DEFAULT_EDGE_CONFIDENCE_FLOOR` (0.65, `edgeReasoning.ts`): stays put.** It is Phase 4B orchestrator policy — "edges strictly below this confidence are reason-rewrite candidates" — not a graph universal. The merge path, the regex floor (0.95 import / 0.72 reference / 0.82 relative-reference in `extractors/graph.ts`), the hidden-coupling floor (0.5 in `designAssessment.ts`), and `MAX_REASONED_EDGES` (200) are all consumer-side thresholds. Hoisting any of them into shared invites every consumer to depend on one orchestrator phase's tuning constant. Out of scope by design.
- **`TS_*_EDGE_CONFIDENCE` (5 constants, currently in `merge.ts`): relocate within the audit layer, NOT into shared.** They are TypeScript-analyzer-domain values (0.99 import/re-export, 0.97 extends/implements, 0.9 call), set above their regex-floor counterparts so group-aware merge prefers the compiler-derived edge. `shared/graph` must stay language-neutral; a `TS_CALL_*` constant there pollutes the shared API with per-language tuning. The actual defect is *placement inside the audit layer*: producer constants live in the consumer (`merge.ts`) while the producer (`analyzers/typescript.ts`) imports them from `merge.js` — a backwards layering (change the merge module and you risk touching analyzer tuning; read `typescript.ts` imports and the dependency points the wrong way). Correct home: **`src/audit/extractors/analyzers/types.ts`** (already the shared analyzer contract: imports `GraphEdge`/`RouteEdge`/`AnalyzerSetting` from shared, defines `AnalyzerContext`/`AnalyzerOutput`/`LanguageAnalyzer`) or a new `src/audit/extractors/analyzers/edgeConfidences.ts` if the team prefers constants out of the types module. Either keeps them audit-local and lets both `merge.ts` and `typescript.ts` import from a neutral sibling.
- **Sibling near-duplicates deliberately excluded** (documented so a future sweep does not re-expand this item):
  - `extractors/graph.ts` private `edgeConfidence` — same intent but **drops the `Number.isFinite` guard** (`typeof edge.confidence === "number" ? edge.confidence : 0`). A `NaN`/`Infinity` confidence would propagate. Out of scope for the mechanical dedupe, but flagged as a follow-up: after the shared helper lands, `graph.ts` should adopt it (behavior change: `NaN` → 0 instead of `NaN`; strictly a hardening).
  - `extractors/graph.ts` private `clampConfidence(value, fallback)` — clamping variant (min/max to [0,1]), different contract. Keep.
  - `shared/graph/graphPaths.ts` inline clamp inside `collectGraphEdges` and `shared/analyzers/normalizeExternal.ts` `clampUnitInterval` (returns `undefined` instead of a fallback) — normalization-time writers, not read-time readers. Keep; they serve ingestion, `edgeConfidence` serves comparison/filtering.

---

## 2. Blast Radius & Affected Files

### 2.1 In-scope (must change)

| File | Symbol(s) | Change |
|---|---|---|
| `src/shared/graph/edgeConfidence.ts` (**new**) | `edgeConfidence` | New shared primitive + doc comment |
| `src/shared/index.ts` | re-export block (~line 84-85) | Add `export { edgeConfidence } from "./graph/edgeConfidence.js";` next to the `graphPaths`/`directedCycles` re-exports |
| `src/audit/extractors/analyzers/merge.ts` | `confidenceOf` (private, ~line 49-53); `TS_*_EDGE_CONFIDENCE` (exported, lines 7-11); `mergeAnalyzerEdges` (consumer, line 92) | Delete private `confidenceOf`; import shared `edgeConfidence`; replace both call sites in the `>=` comparison; move the 5 `TS_*` constants out (re-export shim or update importers — see §4 step 3) |
| `src/audit/orchestrator/edgeReasoning.ts` | `confidenceOf` (private, ~lines 51-55); `collectLowConfidenceEdges`, `edgeReasoningContentHash`, `buildEdgeReasoningPrompt` (consumers) | Delete private `confidenceOf`; import shared `edgeConfidence`; replace 4 call sites (`< floor` filter, hash `confidence:` field, prompt `.toFixed(2)` rendering, and any 4th read) |
| `src/audit/extractors/analyzers/types.ts` (or new `edgeConfidences.ts`) | `TS_*` constants (relocated) | New home for the 5 constants |
| `src/audit/extractors/analyzers/typescript.ts` | `TS_*` imports (lines 9-15, from `./merge.js`) | Re-point import to the constants' new home |

### 2.2 Test / registry files (verify, may need import-path updates only)

- `tests/audit/analyzer-seam.test.ts` — covers `mergeAnalyzerEdges` (import-supersedes-floor; ungrouped-kinds-survive). Behavior-invariant under this refactor; no test logic change expected.
- `tests/audit/edge-reasoning.test.ts` — covers `collectLowConfidenceEdges` (0.65 floor), `applyEdgeReasoning` invariance/no-op/blank-reason, `buildEdgeReasoningPrompt`. Behavior-invariant; no test logic change expected.
- `tests/audit/tree-sitter-analyzers.test.ts` — imports `mergeAnalyzerEdges`; exercises py/html merge. Behavior-invariant.
- `tests/shared/promptContractRegistry.ts` (~line 295-298) — references `buildEdgeReasoningPrompt` builder + `edgeReasoning.ts` file path for manual guards. Unaffected unless the file is renamed (it is not).
- New unit test for the shared helper (see §5): `tests/shared/edge-confidence.test.ts` (naming follows `tests/shared/*.test.ts` convention).

### 2.3 Explicitly out of scope (no change this item)

- `src/audit/extractors/graph.ts` (`edgeConfidence` without `isFinite`, `clampConfidence`, `survivesDedupe`, `uniqueSortedEdges`) — flagged follow-up only.
- `src/shared/graph/graphPaths.ts` (`collectGraphEdges` clamp), `src/shared/analyzers/normalizeExternal.ts` (`clampUnitInterval`) — ingestion-time writers, different contract.
- `src/shared/types/graph.ts` — untouched (the whole point: no runtime logic added to the schema module).
- All per-extractor confidence literals (`IMPORT_EDGE_CONFIDENCE = 0.95`, `PY_IMPORT_EDGE_CONFIDENCE`, `HTML_RESOURCE_EDGE_CONFIDENCE`, `CSS_*`, `ROUTE_HANDLER_*`, suite/manifest constants) — producer-local tuning, not duplicated logic.

---

## 3. Specific Code Modifications (Symbol-Located)

### 3.1 NEW — `src/shared/graph/edgeConfidence.ts`

```ts
import type { GraphEdge } from "../types/graph.js";

/**
 * A stated confidence, or 0 for an edge that never stated one.
 *
 * Non-finite values (`NaN`/`Infinity`) read as 0: confidence participates in
 * `>=`/`<` comparisons (merge preference, low-confidence filtering) where a
 * `NaN` would poison every comparison it touches. Single-sourced here so the
 * analyzer merge (`extractors/analyzers/merge.ts`) and the Phase 4B edge
 * reasoning pass (`orchestrator/edgeReasoning.ts`) can never drift apart.
 */
export function edgeConfidence(edge: GraphEdge): number {
  return typeof edge.confidence === "number" && Number.isFinite(edge.confidence)
    ? edge.confidence
    : 0;
}
```

Import path `../types/graph.js` matches the existing `graphPaths.ts` convention (sibling import of the type-only module — types flow into runtime here, never the reverse).

### 3.2 EDIT — `src/shared/index.ts` (symbol: `normalizeGraphPath`/`collectGraphEdges` re-export block)

After the existing line `export { normalizeGraphPath, collectGraphEdges } from "./graph/graphPaths.js";`, add:

```ts
export { edgeConfidence } from "./graph/edgeConfidence.js";
```

### 3.3 EDIT — `src/audit/extractors/analyzers/merge.ts`

- **Delete** private `function confidenceOf(edge: GraphEdge)` (~lines 49-53).
- **Delete** the 5 `TS_*_EDGE_CONFIDENCE` constant definitions (lines 7-11) — relocated per §3.5. Keep the explanatory comment (lines 4-6) with the constants at their new home, since it documents *their* tuning rationale ("set above their regex-floor counterparts… Floor import kinds sit at 0.95").
- **Add** to the existing shared import: `import { edgeConfidence } from "audit-tools/shared";` (extends the current `import type { GraphEdge }` / `compareCodeUnits` lines following each file's established `audit-tools/shared` import style).
- **Replace** inside `mergeAnalyzerEdges` (line 92):
  - old: `if (!existing || confidenceOf(edge) >= confidenceOf(existing)) {`
  - new: `if (!existing || edgeConfidence(edge) >= edgeConfidence(existing)) {`
- The `GraphEdge` type import stays (still used by `edgeGroupOf`, `groupedKey`, `mergeAnalyzerEdges` signatures).

### 3.4 EDIT — `src/audit/orchestrator/edgeReasoning.ts`

- **Delete** private `function confidenceOf(edge: GraphEdge)` (~lines 51-55).
- **Add** shared import (`edgeConfidence` from `audit-tools/shared`; file already imports `hashContent, compareCodeUnits` from shared — extend that line).
- **Replace** all four reads:
  - `collectLowConfidenceEdges`: `if (confidenceOf(edge) < floor)` → `if (edgeConfidence(edge) < floor)`.
  - `edgeReasoningContentHash`: `confidence: confidenceOf(edge)` → `confidence: edgeConfidence(edge)`.
  - `buildEdgeReasoningPrompt`: `confidenceOf(edge).toFixed(2)` → `edgeConfidence(edge).toFixed(2)`.
- `DEFAULT_EDGE_CONFIDENCE_FLOOR`, `MAX_REASONED_EDGES`, `edgeSignature`, and all three exported functions are otherwise untouched.

### 3.5 MOVE — `TS_*_EDGE_CONFIDENCE` to the analyzer layer contract

- **New home:** `src/audit/extractors/analyzers/types.ts` (preferred — already the neutral analyzer contract module) or new `src/audit/extractors/analyzers/edgeConfidences.ts`. Carry the tuning comment with them.
- **Update** `src/audit/extractors/analyzers/typescript.ts` import source (lines 9-15): `from "./merge.js"` → new home. Imported names unchanged, so the five `confidence:` call sites (lines ~187, ~213-215, ~241, ~266, ~297, ~329) are untouched.
- **Backward-compat decision (pick one):** (a) clean break — `merge.ts` stops exporting `TS_*` entirely, grep verifies no other importer (known importers: `typescript.ts` only); or (b) one-release re-export shim in `merge.ts` (`export { … } from "./types.js"`) if any external/deep-import consumer exists. Default to (a); fall back to (b) only if the §4 step-0 grep finds another importer.

---

## 4. Step-by-Step Implementation Sequence

1. **Pre-flight grep.** Confirm the full importer set: `TS_*_EDGE_CONFIDENCE` importers (expect only `typescript.ts`), `confidenceOf` references (expect only the two private definitions + their in-file call sites), and no deep imports of `merge.js` constants from tests or other modules.
2. **Create `src/shared/graph/edgeConfidence.ts`** with `edgeConfidence` + doc comment (§3.1).
3. **Re-export from `src/shared/index.ts`** (§3.2). Typecheck the shared package alone so later edits fail loudly at their own step, not here.
4. **Relocate the `TS_*` constants** to `analyzers/types.ts` (or new `edgeConfidences.ts`) with their tuning comment; re-point `typescript.ts` imports; decide shim-vs-break per step 1. Run `tests/audit/tree-sitter-analyzers.test.ts` — proves the constants move is behavior-neutral before the helper swap muddies the water.
5. **Swap `merge.ts`**: delete private `confidenceOf`, import shared `edgeConfidence`, replace the line-92 comparison. Run `tests/audit/analyzer-seam.test.ts`.
6. **Swap `edgeReasoning.ts`**: delete private `confidenceOf`, extend the shared import, replace the four reads. Run `tests/audit/edge-reasoning.test.ts`.
7. **Add `tests/shared/edge-confidence.test.ts`**: missing→0, `undefined`→0, `NaN`→0, `Infinity`→0, `0`→0, `0.72`→0.72, `1`→1, negative passthrough (readers do not clamp — clamping is the writers' job; lock this with a case), and a compile-time assertion that both `merge.ts` and `edgeReasoning.ts` import it (or a grep-gate test asserting no local `function confidenceOf` remains in either file).
8. **Full verification** per §5. No `src/shared/types/graph.ts` diff should exist at the end — assert with `git diff --stat`.

---

## 5. Verification & Regression Test Plan

- **New unit test** (`tests/shared/edge-confidence.test.ts`): table-driven cases above, including the `NaN`/`Infinity`→0 cases that distinguish the shared helper from `extractors/graph.ts`'s weaker private twin (regression net for the exact guard that matters).
- **Existing suites (behavior-invariance proof):** `tests/audit/analyzer-seam.test.ts`, `tests/audit/edge-reasoning.test.ts`, `tests/audit/tree-sitter-analyzers.test.ts`, plus `tests/audit/next-step-helpers.test.ts` (edge-reasoning no-op regression coverage, ~line 849). All must pass unmodified — no test logic changes are part of this item; any failure is a refactor defect, not a stale expectation.
- **Static gates:** `tsc` typecheck, eslint on all touched files, and a final grep asserting zero remaining `function confidenceOf` definitions in `src/` and zero imports of `TS_*` from `merge.js`.
- **Diff-shape assertion:** the finished diff touches exactly: new `src/shared/graph/edgeConfidence.ts`, new test, `src/shared/index.ts` (+1 line), `merge.ts` (deletions + import + 1-line comparison), `edgeReasoning.ts` (deletion + import + read-site renames), constants' new home, `typescript.ts` import source. `src/shared/types/graph.ts` MUST NOT appear in the diff — its absence is the architectural acceptance criterion.
- **Documented non-change:** `extractors/graph.ts` `edgeConfidence`/`clampConfidence` behavior is byte-identical after this item. File a follow-up backlog entry to adopt the shared helper there (hardening: `NaN`→0), explicitly out of this item's scope so the behavior change gets its own review.
