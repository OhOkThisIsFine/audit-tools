# Refactoring Plan: Item 3.5 - Graph Signal Edge Extractors

## Item Overview & Current State

- **Item:** 3.5 Graph Signal Edge Extractors
- **Files Involved:**
  - src/audit/extractors/graphSignals.ts
- **Key Symbols:** allGraphEdges, structuralImportEdges, STRUCTURAL_EDGE_BUCKETS
- **Catalog Reference:** docs/reviews/duplication-and-complexity-catalog-2026-09-05.md § Item 3.5 (24 AST nodes matching, "near-identical edge iteration and filtering")
- **Prior Sweep & Verification Findings:**
  Both functions use an identical 3-line defensive type guard (`if (edge && typeof edge.from === "string" && typeof edge.to === "string") edges.push(edge)`).
  Selection logic is intentionally differentiated. Verification concluded this is benign defensive repetition unless a third consumer emerges. Plan should specify exact conditions or helper if extracted.

### Current code (symbol-located, abridged to the duplicated region)

`allGraphEdges` — iterates `Object.entries(graphBundle.graphs)`, skips the `routes` bucket and the `GIT_CO_CHANGE_CATEGORY` (`co_change`) bucket and any non-array value, then applies the guard per element:

```ts
export function allGraphEdges(graphBundle: GraphBundle): GraphEdge[] {
  const edges: GraphEdge[] = [];
  for (const [key, value] of Object.entries(graphBundle.graphs)) {
    if (key === "routes" || key === GIT_CO_CHANGE_CATEGORY || !Array.isArray(value)) {
      continue;
    }
    for (const edge of value) {
      if (edge && typeof edge.from === "string" && typeof edge.to === "string") {
        edges.push(edge);
      }
    }
  }
  return edges;
}
```

`structuralImportEdges` — iterates the module-private `STRUCTURAL_EDGE_BUCKETS` (`["imports", "calls"] as const`), skips non-array buckets, then applies the byte-identical guard:

```ts
const STRUCTURAL_EDGE_BUCKETS = ["imports", "calls"] as const;

export function structuralImportEdges(graphBundle: GraphBundle): GraphEdge[] {
  const edges: GraphEdge[] = [];
  for (const bucket of STRUCTURAL_EDGE_BUCKETS) {
    const value = graphBundle.graphs[bucket];
    if (!Array.isArray(value)) continue;
    for (const edge of value) {
      if (edge && typeof edge.from === "string" && typeof edge.to === "string") {
        edges.push(edge);
      }
    }
  }
  return edges;
}
```

That is the entire duplication: one 3-line (24-AST-node) guard predicate, twice. Everything around it is intentionally different (see §1).

---

## 1. Architectural Rationale & Boundary Analysis

### 1.1 Why the guard exists at all (it is load-bearing, not dead code)

`GraphEdge` (`src/shared/types/graph.ts`, `GraphEdgeSchema`) is a strict Zod object requiring string `from`/`to`. In a fully-validated world the guard would be unreachable. It is reachable in practice because:

1. `GraphBundleSchema.graphs` is `.catchall(z.unknown())` — open-ended by design so new analyzers can add edge sets. Unknown buckets arrive as `unknown` and are only narrowed by the `Array.isArray` + guard pair.
2. Bundles are re-read from persisted artifacts and merged across analyzer contributions (regex floor + language analyzers + git-history `co_change`), i.e. they do not always pass through `GraphEdgeSchema` at the point of consumption.
3. The test seam proves it: `tests/audit/graph-signals.test.ts` feeds `{ from: "d" }`, `null`, `{ to: "e" }`, `"nope"`, `"not-an-array"` buckets directly through `importSourceModule("src/extractors/graphSignals.ts")` and asserts they are dropped, never thrown.

Removing the guard (to "simplify") is therefore out of scope. Any refactor must preserve the drop-malformed-never-throw contract documented on both functions.

### 1.2 What is duplicated vs. what is differentiated

| Aspect | `allGraphEdges` | `structuralImportEdges` | Verdict |
|---|---|---|---|
| Malformed-entry guard | `edge && typeof edge.from === "string" && typeof edge.to === "string"` | byte-identical | **Accidental duplication — safe to extract** |
| Bucket selection | All buckets except `routes` + `co_change` (open-ended: picks up `references`, `heuristics`, and any future analyzer bucket) | ONLY `STRUCTURAL_EDGE_BUCKETS` (`imports`, `calls`), by declared bucket name | **Intentional contract difference — DO NOT unify** |
| Purpose | Merged-set degrees (`fanIn`/`fanOut`/`connected`), deletion candidacy, seam derivation | Load-order-only projection for cycle detection + hub derivation | Two different semantic projections; collapsing them into one parameterized collector would obscure the invariant that `references`/`heuristics` edges must never fabricate cycles/hubs |

The failure mode to avoid: a "clever" unification such as `collectEdges(bundle, buckets?)` where `allGraphEdges` passes "all keys except …" and `structuralImportEdges` passes `STRUCTURAL_EDGE_BUCKETS`. That trades 3 duplicated lines for a shared loop whose bucket-parameter semantics (allowlist vs. denylist) differ per caller — strictly harder to reason about, and it puts the cycle-fabrication invariant one default-argument away from breakage.

### 1.3 Decision: extract the predicate, preserve the loops

**Recommended: extract a module-private type-guard helper for the predicate only. Preserve both selection loops, `STRUCTURAL_EDGE_BUCKETS`, and both public signatures verbatim.**

Rationale:

- **For extraction (predicate only):** kills the 24-node clone and part of the `duplicate-line-count: 33` signal on this file (audit finding MNT-c66ed30f); gives a third future consumer a single home (the verification finding's stated trigger condition); creates one place to tighten validation later (e.g. rejecting empty-string endpoints) without editing N loops; zero behavioral delta today because the predicate is byte-identical.
- **Against unifying the collectors:** the two bucket-selection strategies are the load-bearing architectural seam of this module (documented on `GraphSignals`, `deriveGraphSignals`, and both selectors). Unification hides that seam.
- **Against doing nothing:** defensible (2 call sites × 1 line is idiomatic defensive repetition), but the file already carries a duplication finding and this is the cheapest possible targeted fix — a 5-line private helper with no signature churn. Cost/benefit favors the minimal extraction.
- **Against exporting the helper:** no external consumer needs it today. `detectHiddenCoupling` (`src/audit/extractors/designAssessment.ts`, symbol `detectHiddenCoupling`) re-checks `typeof edge.from/to === "string"` inline on the already-validated `co_change` edges plus a confidence floor — a different predicate (confidence-gated), so it must NOT be folded into this helper. Keep the helper module-private; export later only when a genuine third same-predicate consumer appears.

### 1.4 Boundary rules (normative)

1. The helper narrows `unknown` → `GraphEdge` and checks exactly today's condition: truthy value with string `from` and string `to`. No tightening (no empty-string rejection, no `kind`/`confidence` checks) in this change.
2. Both public functions keep their exact names, parameters, return types, and JSDoc contracts (including the `{@link}` cross-references and the "Malformed entries … are dropped" sentences).
3. `STRUCTURAL_EDGE_BUCKETS` stays a module-private `as const` tuple of `["imports", "calls"]`. No change to bucket membership (adding a bucket is a semantic decision about load order, not a refactor).
4. `routes` / `GIT_CO_CHANGE_CATEGORY` exclusions in `allGraphEdges` stay inline and untouched.
5. No new dependency, no new file, no change to `GraphEdge`/`GraphBundle` schemas.

---

## 2. Blast Radius & Affected Files

Direct change surface is **one file, two function bodies, one added helper**. No signature changes, so all callers are source-compatible.

### 2.1 Directly edited

- `src/audit/extractors/graphSignals.ts` — symbols `allGraphEdges`, `structuralImportEdges`; adds one module-private symbol (proposed name `isValidGraphEdge`, see §3).

### 2.2 Callers (behavior-preserving; no edits required, regression-covered)

| Consumer symbol | File | Uses | Note |
|---|---|---|---|
| `deriveGraphSignals` | `src/audit/extractors/graphSignals.ts` | both selectors | Sole in-module consumer; feeds cycles/hubs/seams/degrees. Behavior must be byte-identical. |
| `buildStructureSources` | `src/audit/decompose/sources.ts` | `allGraphEdges` | Maps edges to `{a, b, weight}` for the `call_import` weighted graph. Guard change is transparent. |
| `deriveDataStateCoupling` | `src/audit/extractors/dataStateCoupling.ts` | `allGraphEdges` | Builds `referrersByTarget`; already handles empty edge list. |
| `detectHiddenCoupling` (via `buildDesignAssessment`) | `src/audit/extractors/designAssessment.ts` | `allGraphEdges` | Builds undirected structural set; has its own separate confidence-gated inline check — explicitly out of scope. |
| `buildDesignAssessment` | `src/audit/extractors/designAssessment.ts` | `deriveGraphSignals` (transitive) | Cycle/hub/orphan/seam findings; covered by consumer tests. |
| `runStructureExecutor` (+ `runStructureDecompositionExecutor`, `runDesignAssessmentExecutor`, `structure_executor`) | `src/audit/orchestrator/structureExecutors.ts`, `src/audit/orchestrator/executorRunners.ts` | `deriveGraphSignals` (transitive) | Orchestrator wiring; no logic change. |

Inbound trace totals (graph evidence): `allGraphEdges` 10 transitive callers, `structuralImportEdges` 5 transitive callers, all funnelling through the rows above. Outbound from `deriveGraphSignals`: `allGraphEdges`, `structuralImportEdges`, `deriveSeams`, `detectCycles`/`dfsVisit`, `deduplicateCycles`/`canonicalCycleKey`, `readNodeMetricSignals`, `compareCodeUnits` — none touched.

### 2.3 Tests covering the blast radius

- `tests/audit/graph-signals.test.ts` — direct unit tests for both selectors (malformed-drop, bucket filtering) plus cycle/hub/deletion/seam behavior via `deriveGraphSignals`. **Must stay green unmodified.**
- `tests/audit/git-history-mining.test.ts` — `allGraphEdges excludes the co_change bucket` test. **Must stay green unmodified.**
- `tests/audit/graph-signal-consumers.test.ts`, `graph-signal-metrics.test.ts`, `graph-external-analyzers.test.ts`, `extractors-remediation.test.ts` — consumer-level coverage over `deriveGraphSignals`/`GraphSignals`. **Must stay green unmodified.**

Risk rating: **minimal**. The change is a pure predicate extraction with identical truth table; the only credible regression is a typo in the helper body, caught by the existing malformed-drop tests.

---

## 3. Specific Code Modifications (Symbol-Located)

All locations are given by symbol, not line number. One edit region per item.

### 3.1 Add module-private guard `isValidGraphEdge` (new symbol, placed adjacent to `STRUCTURAL_EDGE_BUCKETS`)

Insert immediately before the `allGraphEdges` JSDoc block (i.e. between the `GraphSignals` interface and `allGraphEdges`), so both consumers read top-down without forward references:

```ts
/**
 * Narrow an unknown graph-bucket entry to a usable edge. Buckets arrive as
 * `unknown` (the bundle schema is open-ended via `catchall(z.unknown())` and
 * bundles are merged/re-read across analyzer passes), so every selector drops
 * malformed entries — missing string endpoints — instead of throwing. Single
 * home for the predicate shared by {@link allGraphEdges} and
 * {@link structuralImportEdges}; the bucket-SELECTION logic stays per-function
 * (merged set vs. load-order projection) and must not be unified here.
 */
function isValidGraphEdge(edge: unknown): edge is GraphEdge {
  return (
    !!edge &&
    typeof (edge as GraphEdge).from === "string" &&
    typeof (edge as GraphEdge).to === "string"
  );
}
```

Keep it module-private (no `export`). Export only if/when a third same-predicate consumer emerges — that is the documented trigger for revisiting.

### 3.2 `allGraphEdges` — replace inline guard with helper call

Inside `allGraphEdges`, in the inner `for (const edge of value)` loop, replace:

```ts
      if (edge && typeof edge.from === "string" && typeof edge.to === "string") {
        edges.push(edge);
      }
```

with:

```ts
      if (isValidGraphEdge(edge)) {
        edges.push(edge);
      }
```

Nothing else in `allGraphEdges` changes: the `Object.entries` iteration, the `routes` / `GIT_CO_CHANGE_CATEGORY` / `!Array.isArray(value)` skip, the accumulator, and the JSDoc all stay verbatim.

### 3.3 `structuralImportEdges` — replace inline guard with helper call

Inside `structuralImportEdges`, in the inner `for (const edge of value)` loop over `STRUCTURAL_EDGE_BUCKETS`, apply the identical replacement:

```ts
      if (isValidGraphEdge(edge)) {
        edges.push(edge);
      }
```

Nothing else changes: `STRUCTURAL_EDGE_BUCKETS` membership, the `graphBundle.graphs[bucket]` lookup, the `!Array.isArray(value)` skip, and the JSDoc all stay verbatim.

### 3.4 Explicit non-changes (do not touch)

- `STRUCTURAL_EDGE_BUCKETS` — no membership change.
- `deriveGraphSignals`, `deriveSeams`, `dfsVisit`, `detectCycles`, `canonicalCycleKey`, `deduplicateCycles`, `readNodeMetricSignals`, `GraphSignals`, `SeamSignal`, `NodeMetricSignal` — untouched.
- `detectHiddenCoupling`'s inline `typeof edge.from/to === "string"` + confidence-floor filter — different predicate, untouched.
- `GraphEdgeSchema` / `GraphBundleSchema` (`src/shared/types/graph.ts`) — untouched.
- All test files — untouched (regression net only).

---

## 4. Step-by-Step Implementation Sequence

1. **Confirm scope.** Re-read `allGraphEdges`, `structuralImportEdges`, and `STRUCTURAL_EDGE_BUCKETS` in `src/audit/extractors/graphSignals.ts`; verify the two guard expressions are still byte-identical and no third copy has appeared (search: `typeof edge.from`).
2. **Add `isValidGraphEdge`.** Insert the module-private helper from §3.1 between the `GraphSignals` interface and `allGraphEdges`. No exports modified.
3. **Rewire `allGraphEdges`.** Apply §3.2 — guard call only.
4. **Rewire `structuralImportEdges`.** Apply §3.3 — guard call only.
5. **Typecheck.** Run the repo typecheck (per `CLAUDE.md`/CI convention) — expect zero errors; the `edge is GraphEdge` narrowing must satisfy both `edges.push(edge)` call sites without casts at the call site.
6. **Lint the touched file.** Expect no new findings; confirm no unused-import or JSDoc-link breakage (`{@link allGraphEdges}` / `{@link structuralImportEdges}` references unaffected).
7. **Run the targeted regression net** (§5, step 1). All green, unmodified.
8. **Run the full suite.** Per repo closeout convention, full suite green on the touched tree before commit.
9. **Self-review the diff.** Expected diff shape: +12 lines (helper + JSDoc), −2/+2 lines (two guard call sites). Any hunk outside `src/audit/extractors/graphSignals.ts` is out of scope — revert it.

Estimated size: ~15 lines changed in one file. No migration, no flag, no staged rollout.

---

## 5. Verification & Regression Test Plan

No new tests are required — the existing net already pins the exact behavior being preserved (drop-malformed-never-throw + bucket selection). The plan is deliberately regression-only:

1. **Targeted tests (must pass unmodified):**
   - `tests/audit/graph-signals.test.ts` — covers both selectors directly:
     - `allGraphEdges flattens every edge bucket but skips routes and malformed edges`
     - `structuralImportEdges returns only the imports and calls buckets, dropping malformed edges`
     - load-order cycle/hub tests (references/heuristic exclusion, imports+calls genuine cycle, hub threshold) — prove the preserved selection semantics.
   - `tests/audit/git-history-mining.test.ts` — `allGraphEdges excludes the co_change bucket`.
2. **Consumer tests (must pass unmodified):** `graph-signal-consumers.test.ts`, `graph-signal-metrics.test.ts`, `graph-external-analyzers.test.ts`, `extractors-remediation.test.ts`.
3. **Typecheck + lint clean** on the touched file (see steps 5–6 above).
4. **Full suite green** before commit (repo closeout convention).
5. **Negative check:** `grep "typeof edge.from" src/audit/extractors/graphSignals.ts` must return exactly one hit (inside `isValidGraphEdge`); `grep "isValidGraphEdge" src` must return exactly three hits (definition + two call sites) — proving no leftover inline copy and no unintended adoption.
6. **Rollback:** single-file revert of `src/audit/extractors/graphSignals.ts` restores prior behavior exactly (no schema, test, or caller changes to unwind).

**Future trigger (not this change):** if a third selector needing the same predicate appears, or if validation needs tightening (e.g. empty-string endpoints), do it inside `isValidGraphEdge` — that is the payoff this extraction buys. If instead a new *bucket selection* appears, write a third explicit selector reusing the helper; do not parameterize the existing two into one collector.

---

## Appendix: Evidence & Traceability

- Index coverage (`check_index_coverage`, generation 2026-09-05): `src/audit/extractors/graphSignals.ts` and this plan file — no recorded issue (best-effort signal; source re-read directly for all claims).
- Graph evidence (project `C-Code-audit-tools`): `allGraphEdges` 10 transitive inbound callers; `structuralImportEdges` 5 transitive inbound callers; `deriveGraphSignals` outbound to both selectors + `deriveSeams`, `detectCycles`/`dfsVisit`, `deduplicateCycles`/`canonicalCycleKey`, `readNodeMetricSignals`, `compareCodeUnits`.
- Source evidence: `src/shared/types/graph.ts` (`GraphEdgeSchema`, open-ended `GraphBundleSchema.graphs` catchall); `src/audit/extractors/designAssessment.ts` (`detectHiddenCoupling`, `buildDesignAssessment`); `src/audit/decompose/sources.ts` (`buildStructureSources`); `src/audit/extractors/dataStateCoupling.ts` (`deriveDataStateCoupling`); `src/audit/orchestrator/structureExecutors.ts` (`runStructureExecutor`).
