# Refactoring Plan: Item 2.3 - Intra-File Gate Validation Iteration

## Item Overview & Current State

- **Item:** 2.3 Intra-File Gate Validation Iteration
- **Files Involved:**
  - `src/remediate/validation/contractPipelineGates.ts` (primary — the only file this item edits)
- **Key Symbols:** `validateImplementationDAGIntegrity`, `validateEvidenceThreaded`, `judgeReportPayload`, `waivedCounterexampleIds`
- **Prior Sweep & Verification Findings:**
  The catalog misdescribed this item as iterating repairState.acceptedIds and checking artifact checksums.
  The actual duplicate across both functions is the ~15-line extraction of acceptedCounterexampleIds from judgeReportPayload.classifications (filtering for classification === "accepted" and excluding waivedCounterexampleIds).
- **Status of this document:** Complete refactoring plan (Muse Spark lane). Sections 1–5 below are the implementation specification. No code has been changed yet.

---

## 1. Architectural Rationale & Boundary Analysis

### 1.1 What is duplicated, exactly

Both `validateImplementationDAGIntegrity` and `validateEvidenceThreaded` in `src/remediate/validation/contractPipelineGates.ts` contain a near-identical block that builds a `Set<string>` of judge-accepted, non-waived counterexample ids:

```
const acceptedCounterexampleIds = new Set<string>();
if (isRecord(judgeReportPayload) && Array.isArray(judgeReportPayload.classifications)) {
  for (const cls of judgeReportPayload.classifications as unknown[]) {
    if (
      isRecord(cls) &&
      cls.classification === "accepted" &&
      typeof cls.counterexample_id === "string" &&
      cls.counterexample_id.length > 0 &&
      !waivedCounterexampleIds?.has(cls.counterexample_id)
    ) {
      acceptedCounterexampleIds.add(cls.counterexample_id);
    }
  }
}
```

The two copies differ only in the local variable's downstream use:

- In `validateImplementationDAGIntegrity`, the set feeds referential check 1c (`addresses_counterexamples` membership → `coveredCounterexampleIds`) and bidirectional coverage check 2b (`implementation_dag.coverage` per uncovered accepted id).
- In `validateEvidenceThreaded`, the set feeds check 2 (accepted counterexamples must be threaded into `addresses_counterexamples` of some DAG node; fail-closed when the DAG is missing but accepted ids exist).

Everything else — the `isRecord` guard on the payload, the `Array.isArray` guard on `classifications`, the four conjuncts (`classification === "accepted"`, string-typed id, non-empty id, not waived) — is character-for-character the same logic. A change to acceptance semantics (e.g. a new classification value, a waiver-key change per `open-bugs.md:108`) must currently be made twice in one file, with silent divergence as the failure mode.

### 1.2 Why the helper must live in this file (import-cycle boundary)

There is an existing single-source helper with a confusingly similar name: `acceptedCounterexampleIds(judgeReport)` in `src/remediate/contractPipeline/derive.ts`. It is tempting to reuse it. **Do not value-import it into `contractPipelineGates.ts`.** The dependency runs the wrong way:

- `src/remediate/contractPipeline/derive.ts` already value-imports `isTestablePhaseObligation` from `../validation/contractPipelineGates.js`.
- A value import of `acceptedCounterexampleIds` from `derive.js` back into `contractPipelineGates.ts` would therefore create a **module cycle** (`derive ↔ contractPipelineGates`). ESM cycles resolve, but they make initialization order fragile and this repo deliberately keeps the validation layer importable without pulling the derivation layer (the gates file currently imports only `type` + leaf helpers from `contractPipeline/`: `ContractPipelineArtifactName` as `import type`, and `TESTABLE_OBLIGATION_KINDS` from the leaf module `obligationKinds.ts`, which itself imports nothing from validation).

Additionally, the two helpers have **different contracts** (verified against source, not assumed):

| Behaviour | `derive.ts: acceptedCounterexampleIds` | Gate-local blocks (both) |
|---|---|---|
| Return type | `string[]` (ordered, may contain duplicates) | `Set<string>` (deduped) |
| Empty-string id (`""`) | Included (no length guard) | Excluded (`length > 0`) |
| `waivedCounterexampleIds` filter | Absent (no such parameter) | Applied (`!waived?.has(id)`) |
| Non-record / missing `classifications` | Returns `[]` (defensive default `{}`) | Returns empty set (guard fails) |
| Consumers | `steps/contractPipeline.ts` scaffold builder (needs a list, waivers irrelevant at scaffold time) | Coverage/threading gates (need a deduped, waiver-aware set) |

So reusing the derive helper would require post-filtering for waivers and empty strings plus `new Set(...)` wrapping at both call sites — which reintroduces per-site logic and saves almost nothing, while adding the cycle. The correct scope for Item 2.3 is therefore an **intra-file private helper** in `contractPipelineGates.ts`. Unifying with `derive.ts` (and the third inline copy at `steps/contractPipeline.ts` inside the DAG traceability validator, which also lacks the waiver filter) is a separate, cross-module item and is explicitly out of scope here (see §2.4).

### 1.3 Design invariants the refactor must preserve

1. **Fail-closed waiver semantics (open-bugs.md:108).** A waived counterexample is resolved by recorded owner decision; neither gate may demand DAG coverage for it. The helper must take `waivedCounterexampleIds?: ReadonlySet<string>` and apply the exclusion itself — callers must not be trusted to filter afterwards.
2. **Defensive-read posture.** Both gates accept `unknown` payloads and skip when the judge report is absent/malformed. The helper must accept `unknown` and return an empty set in those cases — never throw, never return `undefined`.
3. **Empty-string exclusion.** Both current blocks reject `counterexample_id === ""`. The helper keeps the `length > 0` conjunct.
4. **No signature changes.** Both exported gate signatures stay byte-identical (positional args, optional trailing `waivedCounterexampleIds`). All 9 inbound callers per gate (via `evaluateContractPipelineCrossGateOutcomes` and the `validateArtifacts` sweep) are unaffected.
5. **Error-path fidelity.** Issue `path` strings (`implementation_dag.coverage`, `implementation_dag.evidence_threading`) and messages are produced downstream of the set and are untouched by this refactor.

---

## 2. Blast Radius & Affected Files

### 2.1 Primary (edited)

- **`src/remediate/validation/contractPipelineGates.ts`** — the ONLY file edited:
  - Add one module-private helper (see §3.1).
  - Replace the two inline extraction blocks with one-line calls (see §3.2, §3.3).
  - Net effect: −~24 lines, one definition of acceptance+waiver semantics instead of two.

### 2.2 Callers — no changes required (verified via graph trace)

Inbound trace (`trace_path`, inbound) for each gate returns 9 callers; both gates share the same caller set, funnelling through one entry point:

- `evaluateContractPipelineCrossGateOutcomes` (same file) — the single cross-gate entry point; wires `inputs.waivedCounterexampleIds` positionally into both `validateEvidenceThreaded(assessment, judge, dag, inputs.waivedCounterexampleIds)` and `validateImplementationDAGIntegrity(dag, obligationLedger, counterexample, judge, inputs.waivedCounterexampleIds)`. Unaffected (helper is internal; signatures unchanged).
- `src/remediate/validation/artifacts.ts: validateArtifacts` — plural sweep consumer; passes `waivedCounterexampleIds: waivedJudgeAcceptedIds(...)` through. Unaffected.
- `src/remediate/steps/contractPipeline.ts` — `evaluateContractObligationsPromotionGate`, `evaluatePreCriticStructuralGate`, `finalizedModuleSetGate`, `implementationPlanPromotionGate`, `preCriticStructuralGate`. Unaffected (they consume `GateOutcome[]`, not the extraction logic).
- `src/remediate/index.ts: runValidateArtifactAction` + re-export surface `src/remediate/validation/contractPipeline.ts` (barrel re-export of both gates). Unaffected.
- Coverage check (`check_index_coverage`) on all three evidence paths reports `no_recorded_issue` (freshness: `metadata_changed` — source reads above are ground truth regardless).

### 2.3 Tests — read, not edited (except additive cases in §5)

- `tests/remediate/validation.test.ts: describe("validateImplementationDAGIntegrity")` — 12 cases covering valid DAG, empty DAG, ghost obligation/verification/counterexample references, both bidirectional-coverage directions, absent-ledger skip, absent-counterexample skip, `verification_obligation_ids` counting toward coverage, non-record DAG, non-accepted classification. None pass `waivedCounterexampleIds`; none assert on the extraction itself.
- `tests/remediate/contract-obligations-and-gates.test.ts: describe("validateEvidenceThreaded")` — 5 cases (violated-without-evidence, unthreaded accepted CE, threaded CE, fail-closed missing DAG, empty description). None pass `waivedCounterexampleIds`.
- `tests/remediate/contract-pipeline-derive-obligations.test.ts` — covers `derive.ts: acceptedCounterexampleIds` only; unaffected.
- **Gap found during mapping:** zero existing tests exercise the `waivedCounterexampleIds` parameter of either gate. The refactor must add them (§5.2); today a waiver-filter regression would be invisible.

### 2.4 Explicitly out of scope

- `src/remediate/contractPipeline/derive.ts: acceptedCounterexampleIds` — different contract (§1.2 table); unifying it is a cross-module item requiring cycle-safe placement (new leaf module or moving the helper to `shared`/a new `judgeAcceptedIds.ts` leaf both gates and derive import). Not this item.
- `src/remediate/steps/contractPipeline.ts` inline `new Set((judge?.classifications ?? []).filter(...))` in the DAG traceability validator — third copy, no waiver filter; same follow-up item, not this one.
- `OBS-cca3801c-2` (ledger-absent silent skip inside `validateImplementationDAGIntegrity`) and `TST-ce56e47b` (misnamed empty-DAG test) — real adjacent findings, separate items; do not fix in this diff.
- No changes to `canEvaluateEvidenceThreaded`, `canEvaluateImplementationDagIntegrity`, `GateOutcome` wiring, or any issue message/path.

---

## 3. Specific Code Modifications (Symbol-Located)

All locations are identified by enclosing symbol name, not line numbers. The file has one natural home for the helper: the private-helper region near `escapeRegExp` / the `canEvaluate*` predicates at the bottom of `contractPipelineGates.ts`, keeping exported gates above and shared privates below per existing file layout.

### 3.1 ADD — private helper adjacent to `escapeRegExp`

Add a module-private function (name proposal: `collectUnwaivedAcceptedCounterexampleIds`; alternatives `acceptedCounterexampleIdsOf` / `unwaivedAcceptedIds` — any is fine, but it must NOT be named `acceptedCounterexampleIds`, which would collide conceptually with the `derive.ts` export and invite the cross-import this plan rejects):

```ts
/**
 * Judge-accepted, non-waived counterexample ids from a judge_report payload
 * (defensive read — returns an empty set when the payload is absent or
 * malformed). Single source for the extraction previously duplicated in
 * `validateImplementationDAGIntegrity` and `validateEvidenceThreaded` (Item
 * 2.3): classification === "accepted", non-empty string id, excluding any id
 * present in `waivedCounterexampleIds` (a waived counterexample is resolved by
 * recorded owner decision — open-bugs.md:108 — so no gate may demand DAG
 * coverage for it). Returns a Set (deduped): both consumers test membership.
 *
 * Deliberately NOT `derive.ts`'s `acceptedCounterexampleIds` (which returns a
 * possibly-duplicated array with no waiver/length filtering, and which cannot
 * be value-imported here without a derive ↔ gates module cycle — derive.ts
 * already imports `isTestablePhaseObligation` from this module).
 */
function collectUnwaivedAcceptedCounterexampleIds(
  judgeReportPayload: unknown,
  waivedCounterexampleIds?: ReadonlySet<string>,
): Set<string> {
  const accepted = new Set<string>();
  if (isRecord(judgeReportPayload) && Array.isArray(judgeReportPayload.classifications)) {
    for (const cls of judgeReportPayload.classifications as unknown[]) {
      if (
        isRecord(cls) &&
        cls.classification === "accepted" &&
        typeof cls.counterexample_id === "string" &&
        cls.counterexample_id.length > 0 &&
        !waivedCounterexampleIds?.has(cls.counterexample_id)
      ) {
        accepted.add(cls.counterexample_id);
      }
    }
  }
  return accepted;
}
```

Placement: immediately above or below `escapeRegExp` in `contractPipelineGates.ts` (both are private pure helpers; grouping them keeps the diff local). The helper uses only `isRecord`, already imported at the top of the file — no new imports.

### 3.2 EDIT — inside `validateImplementationDAGIntegrity` (accepted-set construction block)

Replace the inline ~15-line `acceptedCounterexampleIds` construction block (the block beginning `const acceptedCounterexampleIds = new Set<string>();` guarded by `isRecord(judgeReportPayload) && Array.isArray(judgeReportPayload.classifications)`) with:

```ts
const acceptedCounterexampleIds = collectUnwaivedAcceptedCounterexampleIds(
  judgeReportPayload,
  waivedCounterexampleIds,
);
```

Keep the local variable name `acceptedCounterexampleIds` so every downstream reference — the `addresses_counterexamples` membership test inside the node loop (`if (acceptedCounterexampleIds.has(ceId))`) and the bidirectional-coverage sweep (`if (acceptedCounterexampleIds.size > 0) ...`) — is untouched. The inline comment about waivers (`A waived counterexample is resolved by a recorded owner decision ...`) moves into the helper's JSDoc (it already appears there); leave at most a one-line pointer comment at the call site if desired, not the full paragraph.

### 3.3 EDIT — inside `validateEvidenceThreaded` (accepted-set construction block)

Replace the inline ~15-line `acceptedCounterexampleIds` construction block (same shape, guarded identically, followed by the `if (acceptedCounterexampleIds.size > 0)` threading check) with the identical one-line call:

```ts
const acceptedCounterexampleIds = collectUnwaivedAcceptedCounterexampleIds(
  judgeReportPayload,
  waivedCounterexampleIds,
);
```

Same local-name preservation: the downstream `threaded`-set build and the `implementation_dag.evidence_threading` issue loop are untouched.

### 3.4 What does NOT change

- Exported signatures of `validateImplementationDAGIntegrity` and `validateEvidenceThreaded` (parameter order, optionality, return type).
- `evaluateContractPipelineCrossGateOutcomes` wiring, `canEvaluate*` predicates, `GateOutcome` construction.
- All issue `path`/`message` strings, severities, and fail-closed-on-missing-DAG behaviour of `validateEvidenceThreaded` check 2.
- `derive.ts` and `steps/contractPipeline.ts` — not touched.

---

## 4. Step-by-Step Implementation Sequence

1. **Confirm baseline green.** Run the two covering suites before editing (commands in §5.4) so a post-edit failure is attributable to the diff.
2. **Add the helper (§3.1).** Insert `collectUnwaivedAcceptedCounterexampleIds` next to `escapeRegExp` in `src/remediate/validation/contractPipelineGates.ts`, with the full JSDoc including the cycle warning. No other edit in this step — the file must still compile with an unused-function lint allowance (or mark step 3 as the same commit; prefer a single commit for steps 2–3 since an unused private function may trip `no-unused-vars`-style rules).
3. **Replace call site 1 (§3.2).** Inside `validateImplementationDAGIntegrity`, delete the inline extraction block and substitute the helper call, keeping the local name. Re-read the function to confirm the waiver comment moved (not duplicated) and downstream references still resolve.
4. **Replace call site 2 (§3.3).** Same substitution inside `validateEvidenceThreaded`.
5. **Typecheck + lint the file.** `tsc --noEmit` (repo script) and eslint on the touched file; fix only what the diff introduced.
6. **Run the covering suites (§5.4).** All pre-existing gate tests must pass unmodified — this is the behavioural-equivalence proof.
7. **Add the new waiver/parity tests (§5.2).** Prove the previously-untested parameter now has coverage and that both gates agree on identical inputs.
8. **Final full-file review.** `git diff` the one file: expected shape is +1 helper (~30 lines with JSDoc), −2 inline blocks (~15 lines each), +tests. No other file in the diff.

---

## 5. Verification & Regression Test Plan

### 5.1 Behavioural-equivalence proof (must pass unmodified)

- `tests/remediate/validation.test.ts → describe("validateImplementationDAGIntegrity")` (12 cases): valid DAG clean; empty DAG errors on uncovered `O-1`; ghost `satisfies_obligations` / `verification_obligation_ids` / `addresses_counterexamples` references error with the right `path`; both bidirectional-coverage directions error on `implementation_dag.coverage`; absent ledger skips referential checks; absent counterexample artifact skips CE referential; `verification_obligation_ids` counts toward coverage; non-record DAG returns `[]`; non-accepted classification needs no coverage.
- `tests/remediate/contract-obligations-and-gates.test.ts → describe("validateEvidenceThreaded")` (5 cases): violated-without-evidence flagged; unthreaded accepted CE flagged; threaded CE passes; accepted CE + missing DAG is fail-closed; empty description on satisfying node flagged.
- Rationale: the refactor is a pure extraction — same predicates, same order, same `Set` semantics. If any of these fail post-edit, the extraction changed semantics (most likely suspect: dropped `length > 0` guard or mishandled `undefined` waivers via `?.`).

### 5.2 New tests to add (close the waiver gap found in §2.3)

Add to `tests/remediate/validation.test.ts` (DAG gate) and `tests/remediate/contract-obligations-and-gates.test.ts` (threading gate):

1. **Waiver suppresses coverage demand (both gates).** Judge accepts `CE-1`; `waivedCounterexampleIds = new Set(["CE-1"])`; DAG addresses nothing. Expect: zero `implementation_dag.coverage` / `implementation_dag.evidence_threading` issues for `CE-1` from both `validateImplementationDAGIntegrity(dag, ledger, counterexample, judge, waived)` and `validateEvidenceThreaded(undefined, judge, dag, waived)`.
2. **Partial waiver.** Judge accepts `CE-1`, `CE-2`; waive only `CE-1`. Expect: exactly one coverage issue, naming `CE-2` and not `CE-1`, from both gates.
3. **Empty-string id ignored.** Classification `{ counterexample_id: "", classification: "accepted" }` produces no coverage demand in either gate (guards the `length > 0` conjunct surviving extraction).
4. **Cross-gate parity.** Same `(judge, waived)` inputs fed to both gates' extraction path produce the same accepted set — assert indirectly: a DAG threading exactly the unwaived ids yields zero coverage issues from BOTH gates simultaneously.
5. **Malformed judge payload.** `judgeReportPayload = null / {} / { classifications: "nope" }` with and without waivers returns no coverage issues and does not throw (guards the defensive-read contract).

### 5.3 Negative / out-of-scope checks

- Confirm `derive.ts: acceptedCounterexampleIds` tests still pass untouched (no shared code was modified).
- Confirm no new import was added to `contractPipelineGates.ts` (cycle risk = zero by construction; verify by inspection of the diff header).
- Confirm exported API surface unchanged: `git diff` shows no `export` line modified.

### 5.4 Commands

```powershell
# Baseline (before edit) and regression (after edit):
npx vitest run tests/remediate/validation.test.ts tests/remediate/contract-obligations-and-gates.test.ts tests/remediate/contract-pipeline-derive-obligations.test.ts
# Typecheck + lint (repo scripts — prefer these over bare tsc/eslint):
npm run typecheck
npx eslint src/remediate/validation/contractPipelineGates.ts tests/remediate/validation.test.ts tests/remediate/contract-obligations-and-gates.test.ts
```

Acceptance: all three suites green, typecheck clean, eslint clean on touched files, `git status --porcelain` shows exactly the one source file plus the two test files modified, and the new §5.2 cases fail if the waiver filter is deleted (mutation-check by temporarily commenting the `!waivedCounterexampleIds?.has(...)` conjunct — proves the tests actually guard the semantics).
