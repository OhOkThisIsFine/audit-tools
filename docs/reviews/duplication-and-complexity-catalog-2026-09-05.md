# Duplication & Complexity Catalog: Comprehensive Evidence Record

**Date:** 2026-09-05  
**Sweep Scope:** 404 TypeScript modules in `src/`, 82 `.mjs` scripts/wrappers/bins, 126,231 lines of source code.  
**Execution Context:** Isolated Git worktree `.claude/worktrees/analysis-sweep` (zero modification to `main`).  
**Prior Art Context:** Extends [`analysis-tools-plan-2026-08-07.md`](file:///c:/Code/audit-tools/docs/reviews/analysis-tools-plan-2026-08-07.md), [`shared-helper-adoption-2026-08-25.md`](file:///c:/Code/audit-tools/docs/reviews/shared-helper-adoption-2026-08-25.md), and [`ceremony-complexity-review-2026-08-29.md`](file:///c:/Code/audit-tools/docs/reviews/ceremony-complexity-review-2026-08-29.md).

---

## 1. Executive Summary

A multi-tool sweep was executed across the codebase covering four tiers of duplication and three dimensions of complexity. Every lead was verified against current source.

```
Total Duplication Rate (src + scripts): 0.81% lines (1,022 lines / 80 clones)
Exact AST Function Twins (Type 2):       2 pairs verified
Structural Overlap Regions (Type 3):     470 pairs (top 15 verified)
Semantic Single-Source Gates (Type 4):   404 files clean (0 pattern violations)
Functions with Cognitive Complexity ≥20: 91 functions (peak CC: 104)
Primary Refactoring Hotspot:             src/remediate/steps/nextStep.ts (Score: 3,915)
```

---

## 2. Category: Type 2 Parameterized / Renamed Clones

Type 2 clones share identical AST grammar and statement sequencing, differing only by identifier names, literal values, or type annotations.

### Item 2.1: `deriveObligationState` Function Twin
* **Files:**
  * [`src/audit/cli/nextStepHelpers.ts:2582-2615`](file:///c:/Code/audit-tools/src/audit/cli/nextStepHelpers.ts#L2582-L2615)
  * [`src/audit/orchestrator/advance.ts:601-624`](file:///c:/Code/audit-tools/src/audit/orchestrator/advance.ts#L601-L624)
* **Similarity:** **1.00 (Exact AST Match)** — 24 lines, 25 tokens.
* **Code Structure:**
  ```typescript
  // In both files independently:
  function deriveObligationState(runArtifacts: RunArtifactBundle, ...): ObligationState {
    const satisfied = new Set<string>();
    for (const obligation of obligations) {
      if (isObligationFulfilled(obligation, runArtifacts)) {
        satisfied.add(obligation.id);
      }
    }
    return { satisfied, pending: obligations.filter(o => !satisfied.has(o.id)) };
  }
  ```
* **Why Identified:**
  Classic drift hazard ("extract, don't drift-test"). `advance.ts` is the orchestrator engine, while `nextStepHelpers.ts` is the CLI step driver. Both independently evaluate whether step obligations have been satisfied using the same loop and predicate.
* **Remediation:** Extract `deriveObligationState` into [`src/shared/engine/obligationEngine.ts`](file:///c:/Code/audit-tools/src/shared/engine/obligationEngine.ts) (which already houses shared obligation logic).

---

### Item 2.2: CLI Step Execution Scaffolding
* **Files:**
  * [`src/audit/cli/forceSynthesisCommand.ts:9-29`](file:///c:/Code/audit-tools/src/audit/cli/forceSynthesisCommand.ts#L9-L29) (`cmdForceSynthesis`)
  * [`src/audit/cli/intakeCommand.ts:4-24`](file:///c:/Code/audit-tools/src/audit/cli/intakeCommand.ts#L4-L24) (`cmdIntake`)
* **Similarity:** **0.93** — 21 lines.
* **Code Structure:**
  Both functions extract `--artifacts-dir` and `--root` from `argv`, construct an identical step execution options bundle, call `runAuditStep({ ... })`, and print the JSON result envelope to `stdout`.
* **Why Identified:**
  Boilerplate command wrapper copied across subcommands.
* **Remediation:** A shared CLI command helper `executeAuditCommandEnvelope(argv, preferredExecutor)` would eliminate this scaffolding across all 8 audit CLI subcommands.

---

### Item 2.3: Intra-File Gate Validation Iteration
* **Files:**
  * [`src/remediate/validation/contractPipelineGates.ts:336-361`](file:///c:/Code/audit-tools/src/remediate/validation/contractPipelineGates.ts#L336-L361)
  * [`src/remediate/validation/contractPipelineGates.ts:676-701`](file:///c:/Code/audit-tools/src/remediate/validation/contractPipelineGates.ts#L676-L701)
* **Similarity:** **0.89** — 21 lines.
* **Code Structure:**
  Both blocks iterate over `repairState.acceptedIds`, lookup the artifact in `artifactStore`, verify checksum grounding, and append to an issue accumulator.
* **Why Identified:**
  Intra-file duplicate logic contributing directly to this file's extreme cognitive complexity score (374).
* **Remediation:** Consolidate into a local helper `verifyRepairStateGrounding(artifactStore, ids, issues)`.

---

### Item 2.4: Dispatch Execution Envelopes
* **Files:**
  * [`src/audit/cli/nextStepCommand.ts:1400-1417`](file:///c:/Code/audit-tools/src/audit/cli/nextStepCommand.ts#L1400-L1417)
  * [`src/audit/cli/nextStepCommand.ts:1468-1485`](file:///c:/Code/audit-tools/src/audit/cli/nextStepCommand.ts#L1468-L1485)
* **Similarity:** **0.86** — 17 lines.
* **Why Identified:**
  Twin dispatch payload builders constructing identical execution envelopes for lane workers.

---

### Item 2.5: Code Generator File Headers & Status Scaffolding
* **Files:**
  * [`scripts/shared/generate-ingestion-checks.mjs:48`](file:///c:/Code/audit-tools/scripts/shared/generate-ingestion-checks.mjs#L48)
  * [`scripts/shared/generate-spec-mirrors.mjs:90`](file:///c:/Code/audit-tools/scripts/shared/generate-spec-mirrors.mjs#L90)
* **Similarity:** **0.88** — 25 lines.
* **Why Identified:**
  Both generator scripts re-roll the same 25 lines of banner formatting, dry-run checking, and git status comparison.

---

## 3. Category: Type 3 Structural / Near-Miss / Gapped Clones

Type 3 clones perform identical tasks where statements have been inserted, deleted, reordered, or control flow altered.

### Item 3.1: Manifest String Array Extractors
* **Files:**
  * [`src/audit/extractors/graphManifestEdges/toml.ts:49-54`](file:///c:/Code/audit-tools/src/audit/extractors/graphManifestEdges/toml.ts#L49-L54) (`tomlStringArray`)
  * [`src/audit/extractors/graphManifestEdges/yaml.ts:33-38`](file:///c:/Code/audit-tools/src/audit/extractors/graphManifestEdges/yaml.ts#L33-L38) (`yamlStringArray`)
* **AST Nodes:** 27 nodes matching.
* **Why Identified:**
  Both functions extract a string array from parsed AST structures (one from `smol-toml` AST, one from `yaml` AST). The traversal, error filtering, and empty-array fallback logic are structurally identical.
* **Remediation:** Extract `extractStringArray(node)` into a shared manifest extraction utility.

---

### Item 3.2: Confidence Scoring Mapping
* **Files:**
  * [`src/audit/extractors/analyzers/merge.ts:49-53`](file:///c:/Code/audit-tools/src/audit/extractors/analyzers/merge.ts#L49-L53) (`confidenceOf`)
  * [`src/audit/orchestrator/edgeReasoning.ts:51-55`](file:///c:/Code/audit-tools/src/audit/orchestrator/edgeReasoning.ts#L51-L55) (`confidenceOf`)
* **AST Nodes:** 24 nodes matching.
* **Why Identified:**
  Both define private helper functions mapping analyzer confidence literals (`"high" | "medium" | "low"`) to numerical probabilities.
* **Remediation:** Unify into [`src/shared/types/graph.ts`](file:///c:/Code/audit-tools/src/shared/types/graph.ts) next to edge confidence definitions.

---

### Item 3.3: Gate Runner Construction Twins
* **Files:**
  * [`src/remediate/steps/nextStep.ts:1768-1774`](file:///c:/Code/audit-tools/src/remediate/steps/nextStep.ts#L1768-L1774) (`runReviewApprovalGate`)
  * [`src/remediate/steps/nextStep.ts:2612-2618`](file:///c:/Code/audit-tools/src/remediate/steps/nextStep.ts#L2612-L2618) (`runPlanningReviewGate`)
* **AST Nodes:** 28 nodes matching.
* **Why Identified:**
  Both construct gate arguments, verify prerequisites, invoke the gate runner harness, and map the exit status into a next-step instruction.

---

### Item 3.4: Comment Decomposition Tokenizers
* **Files:**
  * [`src/audit/extractors/commentDecomposition.ts:420-425`](file:///c:/Code/audit-tools/src/audit/extractors/commentDecomposition.ts#L420-L425) (`deriveCommentDecomposition`)
  * [`src/audit/extractors/commentDecomposition.ts:498-503`](file:///c:/Code/audit-tools/src/audit/extractors/commentDecomposition.ts#L498-L503) (`deriveDocGroups`)
* **AST Nodes:** 28 nodes matching.
* **Why Identified:**
  Identical token grouping loops scanning AST comment blocks.

---

### Item 3.5: Graph Signal Edge Extractors
* **Files:**
  * [`src/audit/extractors/graphSignals.ts:126-130`](file:///c:/Code/audit-tools/src/audit/extractors/graphSignals.ts#L126-L130) (`allGraphEdges`)
  * [`src/audit/extractors/graphSignals.ts:161-165`](file:///c:/Code/audit-tools/src/audit/extractors/graphSignals.ts#L161-L165) (`structuralImportEdges`)
* **AST Nodes:** 24 nodes matching.
* **Why Identified:**
  Near-identical edge iteration and filtering over extracted graph structures.

---

## 4. Category: Type 4 Semantic Clones & Shared Helper Adoption Debt

Type 4 clones share identical business logic and algorithmic intent while being written using different syntax, variable names, or control structures.

### Item 4.1: Source Line Counting Twins
* **Files:**
  * [`src/audit/orchestrator/reviewPacketShared.ts:27`](file:///c:/Code/audit-tools/src/audit/orchestrator/reviewPacketShared.ts#L27) (`lineCountForPath`)
  * [`src/audit/orchestrator/selectiveDeepening/shared.ts:96`](file:///c:/Code/audit-tools/src/audit/orchestrator/selectiveDeepening/shared.ts#L96) (`lineCountForPath`)
* **Why Identified:**
  Both read file text and compute line counts by splitting on newline boundaries (`/\r?\n/`). Located in separate packages because one was authored for review packets and the other for selective deepening.
* **Remediation:** Single-source in [`src/shared/paths.ts`](file:///c:/Code/audit-tools/src/shared/paths.ts).

---

### Item 4.2: Store Scaffolding Duplication
* **Files:**
  * `src/audit/orchestrator/claimRegistry.ts`
  * `src/remediate/state/reservationLedger.ts`
* **Why Identified:**
  Documented in [`analysis-tools-plan-2026-08-07.md`](file:///c:/Code/audit-tools/docs/reviews/analysis-tools-plan-2026-08-07.md#L116): *"mint-token/read/write/type-guard substrate byte-copied ('the ClaimRegistry pattern generalized'); collapse the I/O scaffolding, keep the claim-vs-lease semantics distinct."*
* **Remediation:** Consolidate the underlying JSON I/O store pattern into `src/shared/io/storeScaffold.ts`.

---

### Item 4.3: Historical Precedents (Now Enforced by Single-Source Gates)
1. **The Root-Containment Fork (F1):**
   * *Problem:* Path containment checks regrew 4 separate times across `audit`, `remediate`, and `shared`.
   * *Resolution:* Consolidated into [`src/shared/io/pathContainment.ts`](file:///c:/Code/audit-tools/src/shared/io/pathContainment.ts) (`resolveWithinRoot`, `assertWithinRoot`). Enforced by `check:shared-primitives`.
2. **Directed Cycle Detection (CX-01):**
   * *Problem:* 4 separate graph cycle algorithms existed simultaneously (two Kahn-based, Tarjan SCC, custom DFS). The two Kahn variants had subtle bugs that over-reported acyclic tails.
   * *Resolution:* Consolidated into [`src/shared/graph/directedCycles.ts`](file:///c:/Code/audit-tools/src/shared/graph/directedCycles.ts).
3. **Metric Predicate Inversion:**
   * *Problem:* `scoreAudit.ts` and `scoreTokens.ts` re-implemented identical metrics calculations, drifting until one copy inverted its regression predicate.
   * *Resolution:* Consolidated into [`src/audit/reporting/scoreShared.ts`](file:///c:/Code/audit-tools/src/audit/reporting/scoreShared.ts).

---

## 5. Category: Code Complexity & Technical Debt Hotspots

High complexity alone in static, untouched code carries low operational risk. The true technical debt drivers are **Hotspots** where **high Cognitive Complexity intersects with high Git Churn (modification frequency)**.

### Top 15 Technical Debt Hotspots (Ranked by Churn $\times$ Complexity)

| Rank | File Path | 90-Day Churn | Max Function CC | Total File CC | Hotspot Score | Primary Monolith / Risk Driver |
|---|---|---|---|---|---|---|
| **1** | [`src/remediate/steps/nextStep.ts`](file:///c:/Code/audit-tools/src/remediate/steps/nextStep.ts) | **135 commits** | 29 | 29 | **3,915** | Primary remediation state machine. Extremely high modification velocity. |
| **2** | [`src/remediate/validation/contractPipelineGates.ts`](file:///c:/Code/audit-tools/src/remediate/validation/contractPipelineGates.ts) | **26 commits** | **104** | **374** | **2,704** | `validateImplementationDAGIntegrity` (CC 104) and `validateEvidenceThreaded` (CC 72). |
| **3** | [`src/remediate/steps/contractPipeline.ts`](file:///c:/Code/audit-tools/src/remediate/steps/contractPipeline.ts) | **59 commits** | 42 | 42 | **2,478** | Monolith contract execution pipeline. High churn. |
| **4** | [`src/audit/cli/nextStepHelpers.ts`](file:///c:/Code/audit-tools/src/audit/cli/nextStepHelpers.ts) | **91 commits** | 24 | 24 | **2,184** | CLI driver containing exact twin functions with `advance.ts`. |
| **5** | [`src/remediate/phases/close.ts`](file:///c:/Code/audit-tools/src/remediate/phases/close.ts) | **29 commits** | 70 | 272 | **2,030** | Closeout synthesis loops (`buildRemediationOutcomesReport` CC 70, CC 66, CC 60). |
| **6** | [`src/audit/reporting/synthesis.ts`](file:///c:/Code/audit-tools/src/audit/reporting/synthesis.ts) | **28 commits** | 60 | 60 | **1,680** | Multi-lens finding aggregation and markdown synthesis. |
| **7** | [`src/remediate/steps/dispatch/hostHandoff.ts`](file:///c:/Code/audit-tools/src/remediate/steps/dispatch/hostHandoff.ts) | **19 commits** | 80 | 125 | **1,520** | `ingestRemediationHostResults` (500 lines, CC 80) mixing test reruns, status marks, mutation. |
| **8** | [`src/audit/orchestrator/state.ts`](file:///c:/Code/audit-tools/src/audit/orchestrator/state.ts) | **21 commits** | 53 | 53 | **1,113** | Audit state transitions and ledger reconciliation. |
| **9** | [`src/remediate/validation/contractPipeline.ts`](file:///c:/Code/audit-tools/src/remediate/validation/contractPipeline.ts) | **16 commits** | 58 | 79 | **928** | Phase verification gates. |
| **10** | [`src/audit/io/artifacts.ts`](file:///c:/Code/audit-tools/src/audit/io/artifacts.ts) | **28 commits** | 32 | 32 | **896** | Core artifact serializing and path resolution. |
| **11** | [`src/audit/orchestrator/staleness.ts`](file:///c:/Code/audit-tools/src/audit/orchestrator/staleness.ts) | 8 commits | **104** | 104 | **832** | `computeStaleArtifacts` (CC 104). Complex, but rarely modified. |
| **12** | [`src/remediate/phases/triage.ts`](file:///c:/Code/audit-tools/src/remediate/phases/triage.ts) | **13 commits** | 61 | 61 | **793** | Multi-phase triage resolution logic. |
| **13** | [`src/remediate/steps/intakeResolver.ts`](file:///c:/Code/audit-tools/src/remediate/steps/intakeResolver.ts) | 7 commits | 99 | 99 | **693** | Deeply nested intake parameter normalization. |
| **14** | [`src/audit/cli/auditStep.ts`](file:///c:/Code/audit-tools/src/audit/cli/auditStep.ts) | **23 commits** | 29 | 29 | **667** | CLI execution wrapper. |
| **15** | [`src/shared/validation/findingsReport.ts`](file:///c:/Code/audit-tools/src/shared/validation/findingsReport.ts) | 10 commits | 65 | 65 | **650** | Findings report parser and validation traversal. |

---

## 6. Category: Verified Benign Duplication (Accepted Shapes)

These items were detected during analysis sweeps but were verified as **intentional architecture**. They are recorded here so future audits do not re-litigate them:

1. **Barrel Re-Exports ([`src/shared/index.ts`](file:///c:/Code/audit-tools/src/shared/index.ts)):**
   * *Flagged by:* `jscpd`, `similarity-ts`.
   * *Verdict:* **Accept.** Re-exporting modules through a central barrel is the deliberate public API design (`audit-tools/shared`).
2. **Generated Worker Schemas ([`schemas/*.json`](file:///c:/Code/audit-tools/schemas)):**
   * *Flagged by:* `jscpd` (~540 duplicate lines).
   * *Verdict:* **Accept.** Schemas are generated by [`scripts/audit/generate-schemas.mjs`](file:///c:/Code/audit-tools/scripts/audit/generate-schemas.mjs) using `$refStrategy: "none"`. They are deliberately self-contained so external workers do not need to resolve `$ref` links across network boundaries.
3. **Execution Flag Lookup Tables ([`allowlistedExec.ts`](file:///c:/Code/audit-tools/src/shared/tooling/exec.ts)):**
   * *Flagged by:* `jscpd` (19 duplicate lines).
   * *Verdict:* **Accept.** Static parameter mapping tables for ripgrep and git flag validation.
4. **Test Fixture Boilerplate ([`tests/**/*.ts`](file:///c:/Code/audit-tools/tests)):**
   * *Flagged by:* `jscpd` and `similarity-ts`.
   * *Verdict:* **Accept.** Test oracles must remain decoupled from production code and from other suites; fixture setup duplication is preferred over coupling test suites together.

---

## 7. Actionable Refactoring Roadmap

### Phase 1: High-Confidence Deduplication (Immediate Wins)
* [ ] **Extract `deriveObligationState`:** Single-source between [`nextStepHelpers.ts`](file:///c:/Code/audit-tools/src/audit/cli/nextStepHelpers.ts#L2582) and [`advance.ts`](file:///c:/Code/audit-tools/src/audit/orchestrator/advance.ts#L601) into `src/shared/engine/obligationEngine.ts`.
* [ ] **Unify `confidenceOf` and `lineCountForPath`:** Single-source into `src/shared/paths.ts` and `src/shared/types/graph.ts`.
* [ ] **Unify Manifest Array Parsing:** Extract `tomlStringArray` and `yamlStringArray` into a shared helper.

### Phase 2: High-Risk Hotspot Decomposition
* [ ] **Decompose `contractPipelineGates.ts` (Hotspot #2, Score: 2,704):**
  Split the 104-complexity `validateImplementationDAGIntegrity` into distinct sub-validators: `validateNodeTraceability`, `validateCycleWitnesses`, and `validateEvidenceGrounding`.
* [ ] **Decompose `hostHandoff.ts` (Hotspot #7, Score: 1,520):**
  Break down `ingestRemediationHostResults` (500 lines, CC 80) into three sequential functions: `validateHostResultBundle`, `executeHostVerificationReruns`, and `commitRemediationStateUpdates`.
