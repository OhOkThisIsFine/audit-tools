# Refactoring Plan: Hotspot #2 - Decomposing contractPipelineGates.ts

## Hotspot Overview & Current State

- **Hotspot:** `src/remediate/validation/contractPipelineGates.ts` (Hotspot Rank #2, Score: 2,704, 1,929 lines, File CC: 374, Max CC: 104)
- **Primary Function Hotspots:**
  - `validateImplementationDAGIntegrity` — graph reports cyclomatic 37 / cognitive 101 over ~140 lines (catalog labels this "CC: 104"; the 104 is the cognitive/combined figure, not raw cyclomatic — treat the catalog number as cognitive complexity). Highest-complexity function in the file.
  - `validateEvidenceThreaded` — graph reports cyclomatic 20 / cognitive 48 over ~92 lines (catalog: "CC: 72", same cognitive-vs-cyclomatic naming gap).
  - Next-nearest: `validateDesignSpecGates` (23/48), `validateWorkBlockSeamPreparation` (17/32), `validatePairedObligations` (16/31). Nothing else in the file is within 2x of the primary hotspot.
- **Key Symbols:** `validateImplementationDAGIntegrity`, `validateEvidenceThreaded`, `pushValidationIssue`, `evaluateContractPipelineCrossGateOutcomes` (the single cross-gate entry point; the prompt's `validateContractPipeline` is not an existing symbol — the actual aggregator is `evaluateContractPipelineCrossGateOutcomes` in the same file, consumed by `validateArtifacts` in `src/remediate/validation/artifacts.ts`)
- **Prior Sweep & Verification Findings:**
  - The function has clear internal phases: referential integrity across nodes/edges, node type checks, and bidirectional obligation/counterexample coverage.
  - The catalog (Phase 2, `docs/reviews/duplication-and-complexity-catalog-2026-09-05.md`) proposed extracting `validateCycleWitnesses`, but verification proved **there is no cycle detection logic in this function**. There is no cycle witness to extract. That catalog bullet is wrong and must be corrected, not implemented (see §1.4).
  - The plan extracts the shared `acceptedCounterexampleIds` helper (Item 2.3, specified in `docs/reviews/refactor-plan-item-2.3-intra-file-gate-validation-2026-09-05.md`) and splits the remaining logic into referential integrity and coverage verification.
- **Status of this document:** Complete refactoring plan. Sections 1–5 below are the implementation specification. No code has been changed yet.
- **Evidence tier:** Verify (Tier 2). Graph project `C-Code-audit-tools`, generation `2026-09-05T21:14:07Z`. `check_index_coverage` on `src/remediate/validation/contractPipelineGates.ts`, `src/shared/validation/basic.ts`, `src/remediate/validation/artifacts.ts` reports `no_recorded_issue` (freshness `metadata_changed` — source reads in this plan are ground truth regardless). Inbound/outbound traces below are transitive totals from `trace_path`.

---

## 1. Architectural Rationale & Boundary Analysis

### 1.1 What the hotspot actually is

`validateImplementationDAGIntegrity` (signature: `(dagPayload, obligationLedgerPayload, counterexamplePayload, judgeReportPayload, waivedCounterexampleIds?) → ValidationIssue[]`) does four logically distinct jobs in one body, sharing only two accumulator sets (`coveredObligationIds`, `coveredCounterexampleIds`) and the `issues` array:

| Phase | Symbol-region (inside `validateImplementationDAGIntegrity`) | What it does | Outbound deps |
|---|---|---|---|
| 0. Reference-set construction | Obligation-id set build; counterexample-id set build; accepted-counterexample set build | Defensive `unknown` reads over three sibling artifacts into `Set<string>` | `isRecord` only |
| 1a. Referential integrity: `satisfies_obligations` → ledger | Node-loop branch on `node.satisfies_obligations` | Every referenced obligation id must exist in `obligationIds`; hits mark `coveredObligationIds` | `pushValidationIssue` |
| 1b. Referential integrity: `verification_obligation_ids` → ledger | Node-loop branch on `node.verification_obligation_ids` | Same shape as 1a, different field/path string | `pushValidationIssue` |
| 1c. Referential integrity: `addresses_counterexamples` → counterexample artifact | Node-loop branch on `node.addresses_counterexamples` | Every referenced CE id must exist in `counterexampleIds`; accepted hits mark `coveredCounterexampleIds` | `pushValidationIssue` |
| 2a. Bidirectional coverage: obligations | Post-loop sweep over `obligationIds` vs `coveredObligationIds` | Every ledger obligation must be addressed by ≥1 node (`implementation_dag.coverage`) | `pushValidationIssue` |
| 2b. Bidirectional coverage: accepted counterexamples | Post-loop sweep over `acceptedCounterexampleIds` vs `coveredCounterexampleIds` | Every accepted CE must be addressed by ≥1 node (`implementation_dag.coverage`) | `pushValidationIssue` |

`validateEvidenceThreaded` (signature: `(assessmentReportPayload, judgeReportPayload, dagPayload, waivedCounterexampleIds?) → ValidationIssue[]`) does three jobs that are independent except for sharing the `issues` array — no shared accumulator sets at all:

| Check | Symbol-region (inside `validateEvidenceThreaded`) | What it does |
|---|---|---|
| 1. Violated-findings evidence | `assessmentReportPayload.findings` loop | A `status === "violated"` finding with empty `evidence` is an error (`findings[i].evidence`) |
| 2. Accepted-CE threading | Accepted-set build + `threaded`-set build + uncovered sweep | Every accepted CE must appear in some node's `addresses_counterexamples` (`implementation_dag.evidence_threading`); fail-closed when the DAG is missing but accepted ids exist |
| 3. Non-empty node descriptions | DAG node loop over `satisfies_obligations` + `description` | A node that satisfies obligations but has a blank `description` is an error (`nodes[i].description`) |

The complexity is therefore **sequential-phase complexity**, not intertwined-state complexity: each phase reads shared inputs and appends to `issues`. That is the ideal shape for extract-function decomposition — the phases can become pure helpers taking typed inputs and returning `ValidationIssue[]`, concatenated by a thin orchestrator that keeps the exported signature byte-identical.

### 1.2 Decomposition boundaries

Three extraction boundaries, ordered by dependency:

**Boundary A — shared counterexample helper (Item 2.3, prerequisite).**
Both hotspot functions contain a character-for-character identical ~15-line block building `acceptedCounterexampleIds: Set<string>` from `judgeReportPayload.classifications` (conjuncts: `classification === "accepted"`, string-typed id, `length > 0`, `!waivedCounterexampleIds?.has(id)`). Full specification already exists in `docs/reviews/refactor-plan-item-2.3-intra-file-gate-validation-2026-09-05.md` §3.1: private helper `collectUnwaivedAcceptedCounterexampleIds(judgeReportPayload, waivedCounterexampleIds?) → Set<string>` placed adjacent to `escapeRegExp`, both call sites reduced to a one-line call keeping the local variable name. **This hotspot plan assumes Item 2.3 lands first** (or as Step 0 of the same diff — see §4). It removes ~24 net lines and one divergence risk before the larger split begins. Do not re-specify it here; reference that document.

Why intra-file, not reuse: `src/remediate/contractPipeline/derive.ts: acceptedCounterexampleIds` has a different contract (returns possibly-duplicated `string[]`, no waiver or empty-string filter) and a value-import would create a `derive ↔ contractPipelineGates` module cycle (`derive.ts` already imports `isTestablePhaseObligation` from the gates file). The third inline copy (`acceptedCeIdsOf` in `src/remediate/steps/contractPipeline.ts`, typed over `JudgeReport`, no waiver filter) is likewise out of scope. All three are explicitly deferred to a future cross-module item.

**Boundary B — referential integrity vs. coverage validation (inside `validateImplementationDAGIntegrity`).**
Split along the existing phase seam:

- `validateDAGReferentialIntegrity(nodes, obligationIds, counterexampleIds, acceptedCounterexampleIds) → { issues, coveredObligationIds, coveredCounterexampleIds }` — owns phases 1a/1b/1c (the whole node loop). Returns both the issues AND the two covered-sets, which are its only outputs consumed downstream.
- `validateDAGCouvertureGaps(obligationIds, acceptedCounterexampleIds, coveredObligationIds, coveredCounterexampleIds) → ValidationIssue[]` — owns phases 2a/2b (the two post-loop sweeps). Pure function of four sets; no payload access at all, trivially unit-testable.
- `validateImplementationDAGIntegrity` itself becomes a thin orchestrator: guard (`canEvaluateImplementationDagIntegrity`), build reference sets (Phase 0, using the Item 2.3 helper for the accepted set), delegate to the two helpers, concatenate. Exported signature unchanged.

Why this seam and not per-field (1a vs 1b vs 1c): 1a and 1b differ only in field name and path string — splitting them triples the helper surface for zero complexity gain. The real cognitive load is loop-vs-sweep (referential vs. coverage), which is also the seam the issue `path` namespaces already reflect (`nodes[i].*` vs. `implementation_dag.coverage`).

**Boundary C — evidence-threading checks (inside `validateEvidenceThreaded`).**
Split into three independent helpers, each owning one check:

- `validateViolatedFindingsEvidence(assessmentReportPayload) → ValidationIssue[]` — check 1 verbatim.
- `validateCounterexampleThreading(judgeReportPayload-or-acceptedSet, dagPayload, waivedCounterexampleIds?) → ValidationIssue[]` — check 2 verbatim (takes the Item 2.3 helper's output or calls it internally; prefer passing the already-built set from the orchestrator so the helper stays a pure set-diff).
- `validateSatisfyingNodeDescriptions(dagPayload) → ValidationIssue[]` — check 3 verbatim.
- `validateEvidenceThreaded` becomes concatenation of the three. No shared accumulators exist, so no return-shape design is needed — each helper returns `ValidationIssue[]`.

### 1.3 Why `pushValidationIssue` is NOT part of this refactor

`pushValidationIssue(issues, path, message, severity = "error")` lives in `src/shared/validation/basic.ts` (with `createValidationIssue`), has 57 graph-recorded callers, and is a zero-value pass-through over `issues.push(createValidationIssue(...))`. It is already the single source for issue construction. The hotspot's problem is not issue construction — it is phase accumulation inside two gates. This plan makes **no changes** to `src/shared/validation/basic.ts`. Helpers in Boundaries B/C continue to call `pushValidationIssue` exactly as today.

### 1.4 Catalog correction: there is no `validateCycleWitnesses` here

The catalog's Phase 2 bullet proposes splitting `validateImplementationDAGIntegrity` into `validateNodeTraceability`, `validateCycleWitnesses`, and `validateEvidenceGrounding`. Verified against source: **this function contains no cycle detection** — no SCC, no Kahn drain, no DFS, no `depends_on`/`edges` traversal at all. Cycle detection in this pipeline lives in `validateDesignSpecGates` (Gate 6, via the shared `findCyclicComponents` core over obligation `depends_on`) and in `derive.ts`/`phaseCut.ts` ordering logic — not here. Implementing `validateCycleWitnesses` as specified would invent behavior or extract nothing. Correct the catalog bullet to:

> Split `validateImplementationDAGIntegrity` into `validateDAGReferentialIntegrity` (node-loop phases 1a/1b/1c) and `validateDAGCouvertureGaps` (coverage sweeps 2a/2b), on top of the Item 2.3 `collectUnwaivedAcceptedCounterexampleIds` helper; split `validateEvidenceThreaded` into its three independent checks (§1.2 Boundary C). Drop `validateCycleWitnesses` — no cycle logic exists in this function (cycle detection is Gate 6 of `validateDesignSpecGates` via `findCyclicComponents`).

Similarly, "node type checks" in the prompt's prior-findings summary has no corresponding block in the current source (non-record nodes are skipped via `if (!isRecord(node)) continue`, not type-checked) — there is nothing to extract there either. The `edges` array is never read by this gate.

### 1.5 Design invariants the refactor must preserve

1. **Exported signatures byte-identical.** Both gates keep positional args, optionality, and return types. All 9 inbound callers per gate (see §2.2) are unaffected.
2. **Fail-closed waiver semantics (`open-bugs.md:108`).** Waived ids are excluded inside the Item 2.3 helper; Boundaries B/C must never re-add coverage demand for a waived id. Coverage helpers take the already-waiver-filtered sets — they must not accept an unfiltered set and filter locally.
3. **Defensive-read posture.** All helpers accept `unknown` payloads and return `[]`/empty sets on absent/malformed input — never throw. The orchestrators keep the existing `canEvaluateImplementationDagIntegrity` guard; `validateEvidenceThreaded` keeps its per-check `isRecord`/`Array.isArray` gating (note: it has no top-level guard — `canEvaluateEvidenceThreaded` is only used for `GateOutcome` classification, not as an early return — and the decomposition must not introduce one).
4. **Issue fidelity.** Every `path` string (`implementation_dag.nodes[i].*`, `implementation_dag.coverage`, `contract_assessment_report.findings[i].evidence`, `implementation_dag.evidence_threading`, `implementation_dag.nodes[i].description`), message text, severity, and emission order is unchanged. Helpers append in the same order the inline phases run today (1a→1b→1c→2a→2b; evidence checks 1→2→3).
5. **`GateOutcome` wiring untouched.** `canEvaluate*` predicates, `gateOutcome`, and `evaluateContractPipelineCrossGateOutcomes` argument wiring are not edited.

---

## 2. Blast Radius & Affected Files

### 2.1 Primary (edited)

- **`src/remediate/validation/contractPipelineGates.ts`** — the ONLY source file edited:
  - Step 0: add `collectUnwaivedAcceptedCounterexampleIds` (Item 2.3) adjacent to `escapeRegExp`; two one-line call-site substitutions.
  - Steps 1–2: add ~5 module-private helpers (2 for Boundary B, 3 for Boundary C); reduce the two exported gates to orchestrators.
  - Net effect estimate: +~90 lines of helpers (mostly moved code + JSDoc), −~180 lines of inline phase bodies from the two gates; file total roughly unchanged, but max-function cognitive drops from ~101 to ~15–20 per helper and no exported gate exceeds cyclomatic ~5.

### 2.2 Callers — no changes required (verified via graph trace)

Inbound `trace_path` (calls mode, depth 4) for each gate returns **9 transitive callers**, both gates sharing the identical caller set, funnelling through one entry point:

- `evaluateContractPipelineCrossGateOutcomes` (same file, hop 1) — wires `inputs.waivedCounterexampleIds` positionally into `validateEvidenceThreaded(assessment, judge, dag, …)` and `validateImplementationDAGIntegrity(dag, obligationLedger, counterexample, judge, …)`. Calls the exported gates only; internal decomposition is invisible.
- `src/remediate/validation/artifacts.ts: validateArtifacts` (hop 2) — plural sweep consumer; passes `waivedCounterexampleIds: waivedJudgeAcceptedIds(…)` through. Consumes `GateOutcome[]`, not gate internals.
- `src/remediate/steps/contractPipeline.ts` — `evaluateContractObligationsPromotionGate`, `evaluatePreCriticStructuralGate`, `finalizedModuleSetGate`, `implementationPlanPromotionGate`, `preCriticStructuralGate` (all hop 2). Consume outcomes/counts.
- `src/remediate/index.ts: runValidateArtifactAction` + `src/remediate/index.ts` re-export surface (hop 3).
- Barrel re-export `src/remediate/validation/contractPipeline.ts` (`export { … validateImplementationDAGIntegrity, validateEvidenceThreaded … } from "./contractPipelineGates.js"` — backward-compat surface; no import-path changes needed anywhere).

Outbound from each gate: `pushValidationIssue` + `isRecord` (+ `canEvaluateImplementationDagIntegrity` for the DAG gate) only. No new imports are introduced by the refactor (helpers use already-imported `isRecord`/`pushValidationIssue`/`ValidationIssue`); cycle risk is zero by construction.

### 2.3 Tests — read, not edited (except additive cases in §5)

- `tests/remediate/validation.test.ts → describe("validateImplementationDAGIntegrity")` — 12 cases (valid DAG; empty DAG coverage errors; ghost `satisfies_obligations` / `verification_obligation_ids` / `addresses_counterexamples`; both bidirectional-coverage directions; absent-ledger skip; absent-counterexample skip; `verification_obligation_ids` counting toward coverage; non-record DAG `[]`; non-accepted classification). None pass `waivedCounterexampleIds`.
- `tests/remediate/contract-obligations-and-gates.test.ts → describe("validateEvidenceThreaded")` — 5 cases (violated-without-evidence; unthreaded accepted CE; threaded CE; fail-closed missing DAG; empty description). None pass `waivedCounterexampleIds`.
- `tests/remediate/contract-pipeline-derive-obligations.test.ts` — covers `derive.ts: acceptedCounterexampleIds` only; unaffected.
- **Known gap (found during Item 2.3 mapping):** zero existing tests exercise `waivedCounterexampleIds` on either gate. Item 2.3's §5.2 already specifies the waiver/parity cases — this plan reuses them as the regression floor (see §5.2) rather than re-specifying.

### 2.4 Explicitly out of scope

- `derive.ts: acceptedCounterexampleIds`, `steps/contractPipeline.ts: acceptedCeIdsOf`, and the steps-file DAG traceability validator's inline set — different contracts/owners; unifying them is a separate cross-module item requiring cycle-safe placement.
- `OBS-cca3801c-2` (ledger-absent silent skip), `TST-ce56e47b` (misnamed empty-DAG test), `validateDesignSpecGates` / `validatePairedObligations` / `validateWorkBlockSeamPreparation` complexity — real adjacent items, separate diffs.
- `src/shared/validation/basic.ts`, `src/remediate/validation/artifacts.ts`, `src/remediate/validation/contractPipeline.ts` (barrel), `src/remediate/steps/contractPipeline.ts`, `src/remediate/index.ts` — not touched.
- No `export` line is added, removed, or modified (helpers are module-private; verify by `git diff` showing no `export` hunk).

---

## 3. Specific Code Modifications (Symbol-Located)

All locations are identified by enclosing symbol name, not line numbers. Helpers live in the private-helper region near `escapeRegExp` / the `canEvaluate*` predicates, keeping exported gates above and shared privates below per existing file layout.

### 3.1 STEP 0 (Item 2.3 prerequisite) — ADD `collectUnwaivedAcceptedCounterexampleIds` adjacent to `escapeRegExp`

Per `docs/reviews/refactor-plan-item-2.3-intra-file-gate-validation-2026-09-05.md` §3.1–§3.3 (authoritative spec — follow it verbatim, including the name-avoidance rule: must NOT be named `acceptedCounterexampleIds`). Replace the two inline accepted-set construction blocks — the block beginning `const acceptedCounterexampleIds = new Set<string>();` guarded by `isRecord(judgeReportPayload) && Array.isArray(judgeReportPayload.classifications)` inside `validateImplementationDAGIntegrity`, and the same-shaped block inside `validateEvidenceThreaded` — with:

```ts
const acceptedCounterexampleIds = collectUnwaivedAcceptedCounterexampleIds(
  judgeReportPayload,
  waivedCounterexampleIds,
);
```

Keep the local name so all downstream references are untouched. If Item 2.3 has already landed, skip this step and start at §3.2 against the helper-call baseline.

### 3.2 ADD — `validateDAGReferentialIntegrity` (Boundary B, node loop)

New module-private helper owning phases 1a/1b/1c verbatim (the entire `for (const [i, node] of nodes.entries())` loop with its three branches, including the `obligationIds.size > 0` / `counterexampleIds.size > 0` absent-artifact degradations and the `coveredObligationIds` / `coveredCounterexampleIds` accumulation):

```ts
interface DAGReferentialResult {
  issues: ValidationIssue[];
  coveredObligationIds: Set<string>;
  coveredCounterexampleIds: Set<string>;
}

function validateDAGReferentialIntegrity(
  nodes: unknown[],
  obligationIds: ReadonlySet<string>,
  counterexampleIds: ReadonlySet<string>,
  acceptedCounterexampleIds: ReadonlySet<string>,
): DAGReferentialResult { /* moved loop body, unchanged */ }
```

Design notes: takes already-built sets (not payloads) so it is payload-agnostic and directly unit-testable with hand-built sets; the `node.id` interpolation in messages (`Node "${node.id}" …`) moves with the loop unchanged. Returns the two covered-sets because they are the loop's only downstream outputs.

### 3.3 ADD — `validateDAGCouvertureGaps` (Boundary B, coverage sweeps)

New module-private helper owning phases 2a/2b verbatim (the two `if (….size > 0)` sweeps emitting `implementation_dag.coverage` issues):

```ts
function validateDAGCouvertureGaps(
  obligationIds: ReadonlySet<string>,
  acceptedCounterexampleIds: ReadonlySet<string>,
  coveredObligationIds: ReadonlySet<string>,
  coveredCounterexampleIds: ReadonlySet<string>,
): ValidationIssue[] { /* moved sweep bodies, unchanged */ }
```

Pure set-diff; no `isRecord`, no payload access. The name deliberately avoids `Coverage` (overloaded in `validatePairedObligations`'s local `Coverage` interface) — alternatives `validateDAGBidirectionalCoverage` / `findUncoveredObligationsAndCounterexamples` are acceptable.

### 3.4 EDIT — reduce `validateImplementationDAGIntegrity` to orchestrator

After §§3.2–3.3, the body of `validateImplementationDAGIntegrity` is: `canEvaluateImplementationDagIntegrity` guard → Phase-0 reference-set construction (obligation set, counterexample set, Item 2.3 helper call) → one call to `validateDAGReferentialIntegrity` → one call to `validateDAGCouvertureGaps` with the returned covered-sets → `return [...refIssues, ...gapIssues]`. No branch logic remains beyond the guard and the set-build guards that already exist in Phase 0.

### 3.5 ADD — three evidence-threading helpers (Boundary C)

Each is a verbatim move of one check out of `validateEvidenceThreaded`:

```ts
function validateViolatedFindingsEvidence(
  assessmentReportPayload: unknown,
): ValidationIssue[] { /* check 1: findings loop, unchanged */ }

function validateCounterexampleThreading(
  acceptedCounterexampleIds: ReadonlySet<string>,
  dagPayload: unknown,
): ValidationIssue[] { /* check 2: threaded-set build + uncovered sweep, unchanged */ }

function validateSatisfyingNodeDescriptions(
  dagPayload: unknown,
): ValidationIssue[] { /* check 3: node description loop, unchanged */ }
```

Note the parameter choice for `validateCounterexampleThreading`: it takes the already-built accepted set (from the Item 2.3 helper called in the orchestrator), NOT `judgeReportPayload` + waivers. This keeps waiver semantics single-sourced in the Item 2.3 helper and makes the threading check a pure set-diff over an `unknown` DAG payload (preserving its fail-closed-on-missing-DAG behavior: non-empty accepted set + absent nodes → issues).

### 3.6 EDIT — reduce `validateEvidenceThreaded` to orchestrator

Body becomes: call Item 2.3 helper → `validateViolatedFindingsEvidence(assessmentReportPayload)` → `validateCounterexampleThreading(acceptedCounterexampleIds, dagPayload)` → `validateSatisfyingNodeDescriptions(dagPayload)` → concatenate. The three calls run unconditionally in today's check order (each helper self-guards on malformed input, preserving the no-top-level-guard contract).

### 3.7 What does NOT change

- Exported signatures of `validateImplementationDAGIntegrity`, `validateEvidenceThreaded`; `evaluateContractPipelineCrossGateOutcomes` wiring; `canEvaluate*` predicates; `GateOutcome` construction.
- All issue `path`/`message`/severity strings and emission order.
- `pushValidationIssue` / `src/shared/validation/basic.ts`; `derive.ts`; `steps/contractPipeline.ts`; barrel re-exports; any `export` line.

---

## 4. Step-by-Step Implementation Sequence

1. **Confirm baseline green.** Run the covering suites (§5.4) before editing so a post-edit failure is attributable to the diff.
2. **Step 0 — land Item 2.3** (skip if already merged: verify `collectUnwaivedAcceptedCounterexampleIds` — or its agreed name — exists adjacent to `escapeRegExp` and both gates call it). Follow `item-2.3-intra-file-gate-validation.md` §4 steps 2–4 verbatim; run its §5.4 suites.
3. **Add Boundary B helpers (§§3.2–3.3).** Insert `validateDAGReferentialIntegrity` + `validateDAGCouvertureGaps` (with `DAGReferentialResult`) in the private region. No other edit in this step — the file must compile with unused-function allowance, or fold into step 4 as one commit.
4. **Rewire the DAG gate (§3.4).** Replace the node loop and the two sweeps inside `validateImplementationDAGIntegrity` with the three-call orchestrator. Re-read the function: guard → set builds → two delegations → concat. Confirm the `else if` absent-ledger branches moved into the helper (not dropped — they are the OBS-cca3801c-2 behavior).
5. **Add Boundary C helpers (§3.5) and rewire the threading gate (§3.6).** Move each check verbatim; confirm check 2's fail-closed shape (accepted set non-empty + `dagPayload` absent → issues) survived the parameter change.
6. **Typecheck + lint.** Repo `typecheck` script and eslint on the touched file; fix only what the diff introduced.
7. **Run the covering suites (§5.4).** All pre-existing gate tests must pass **unmodified** — this is the behavioural-equivalence proof. Then add the Item 2.3 §5.2 waiver/parity cases if they do not yet exist.
8. **Final diff review.** `git diff` must show exactly one source file (`contractPipelineGates.ts`) plus test files; no `export` hunk; no new import in the diff header; issue strings byte-identical (spot-check with `git diff -U0 | grep '^[+-].*implementation_dag'` returning nothing).

---

## 5. Verification & Regression Test Plan

### 5.1 Behavioural-equivalence proof (must pass unmodified)

- `tests/remediate/validation.test.ts → describe("validateImplementationDAGIntegrity")` (12 cases): valid DAG clean; empty DAG errors naming `O-1`; ghost `satisfies_obligations` / `verification_obligation_ids` / `addresses_counterexamples` error with the right `path` substring; both bidirectional-coverage directions error on path exactly `implementation_dag.coverage`; absent ledger skips referential checks (zero errors); absent counterexample artifact skips CE referential but keeps coverage semantics; `verification_obligation_ids` counts toward coverage; non-record DAG returns `[]`; non-accepted classification needs no coverage.
- `tests/remediate/contract-obligations-and-gates.test.ts → describe("validateEvidenceThreaded")` (5 cases): violated-without-evidence flagged on `evidence` path; unthreaded accepted `CE-1` flagged; threaded `CE-1` yields zero issues; accepted CE + missing DAG is fail-closed; blank-description satisfying node flagged on `description` path.
- Rationale: the refactor is a pure code motion — same predicates, same order, same `Set` semantics. A post-edit failure localizes by suite: DAG-suite failure → Boundary B regression (prime suspect: dropped `else if` absent-ledger branch or covered-set not threaded through); threading-suite failure → Boundary C regression (prime suspect: reordered checks or accepted-set passed by value-copy instead of reference).

### 5.2 New tests to add (reuse Item 2.3 §5.2 — close the waiver gap)

Add to `tests/remediate/validation.test.ts` (DAG gate) and `tests/remediate/contract-obligations-and-gates.test.ts` (threading gate) **iff Item 2.3 has not already added them**:

1. Waiver suppresses coverage demand (both gates): judge accepts `CE-1`, waived `{"CE-1"}`, DAG addresses nothing → zero `implementation_dag.coverage` / `implementation_dag.evidence_threading` issues for `CE-1`.
2. Partial waiver: accept `CE-1` + `CE-2`, waive only `CE-1` → exactly one coverage issue, naming `CE-2` not `CE-1`, from both gates.
3. Empty-string id ignored: `{ counterexample_id: "", classification: "accepted" }` → no coverage demand in either gate.
4. Cross-gate parity: a DAG threading exactly the unwaived ids yields zero coverage issues from BOTH gates simultaneously.
5. Malformed judge payload (`null` / `{}` / `{ classifications: "nope" }`) with and without waivers → no coverage issues, no throw.

Plus one decomposition-specific case (new in this plan, not Item 2.3): **helper-level unit tests** for `validateDAGCouvertureGaps` and `validateCounterexampleThreading` with hand-built sets (they take sets, not payloads, by design) — e.g. empty accepted set + empty covered sets → `[]`; covered sets missing one id → exactly one issue naming that id. These pin the extracted units independently of payload fixtures.

### 5.3 Negative / out-of-scope checks

- `derive.ts: acceptedCounterexampleIds` tests (`tests/remediate/contract-pipeline-derive-obligations.test.ts`) pass untouched.
- No new import in `contractPipelineGates.ts` (cycle risk zero by construction; verify via diff header).
- No `export` line modified; barrel `contractPipeline.ts` untouched; `validateArtifacts` sweep and all five `steps/contractPipeline.ts` promotion gates green without changes.
- Catalog correction applied: Phase 2 bullet for Hotspot #2 rewritten per §1.4 (no `validateCycleWitnesses`).

### 5.4 Commands

```powershell
# Baseline (before edit) and regression (after edit):
npx vitest run tests/remediate/validation.test.ts tests/remediate/contract-obligations-and-gates.test.ts tests/remediate/contract-pipeline-derive-obligations.test.ts
# Typecheck + lint (repo scripts — prefer these over bare tsc/eslint):
npm run typecheck
npx eslint src/remediate/validation/contractPipelineGates.ts tests/remediate/validation.test.ts tests/remediate/contract-obligations-and-gates.test.ts
```

Acceptance: all three suites green, typecheck clean, eslint clean on touched files, `git status --porcelain` shows exactly the one source file plus the two test files modified, the new §5.2 cases fail if the waiver filter is deleted (mutation-check by temporarily commenting the `!waivedCounterexampleIds?.has(…)` conjunct), and the helper-level set-diff cases fail if either sweep's membership test is inverted.
