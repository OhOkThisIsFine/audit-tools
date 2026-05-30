# audit-tools refactor — sprint handoff

**Date:** 2026-05-30
**Scope this sprint:** **Phase 5.0 (analyzer seam) + Phase 5(TS/JS)** (auditor). Adds the pluggable `LanguageAnalyzer` registry, the `graph_enrichment_current` obligation with its `analyzer_capability.json` marker, the **TypeScript compiler-API analyzer** (the first real call graph), and the conversation-first `analyzer_install` bounded step.
**Status:** implemented and green on `master` working tree (not yet committed — see _Git state_ below).

The frozen build order is: **0 → 1A + `.tmp` fix → 2 → 6 → 5.0 + 5(TS/JS) → 3 → 4 → 5(Py/HTML/CSS) → 7.** Everything through **Phase 5.0 + 5(TS/JS) is now done**. The next pickup is **Phase 3 — `--since` delta mode**, which rides on the new TS call graph.

---

## Verification status (all green)

```
shared          24 tests   pass   (node --test packages/shared/tests/*.test.mjs)
audit-code     497 tests   pass   (node --test, +10 new vs. 487 baseline)
remediate-code 360 tests   pass   (vitest)
```

`npm run build` (shared → both dependents) and `npm run check` are clean in every workspace. The 10 new tests: [analyzer-seam.test.mjs](packages/audit-code/tests/analyzer-seam.test.mjs) (6: merge precedence, ungrouped-survival, executor apply+provenance, graceful-skip byte-identical floor, not_applicable, `resolveAnalyzerPlan` install-decision gating), [typescript-analyzer.test.mjs](packages/audit-code/tests/typescript-analyzer.test.mjs) (2: golden import/reexport/extends/implements/call edge set + empty-set), and one each added to [validation-remediation.test.mjs](packages/audit-code/tests/validation-remediation.test.mjs) (analyzers config validation) and [next-step.test.mjs](packages/audit-code/tests/next-step.test.mjs) (install prompt → skip decision → proceed + session-config persisted).

End-to-end sanity confirmed: enrichment against real repo files resolves `typescript` via `repo`, sets `analyzers_used: ["typescript"]`, and emits `ts-*` edges (incl. `.js`→`.ts` re-export resolution).

---

## Phase 5.0 + 5(TS/JS) — compiler-graph seam + TypeScript analyzer ✅

### What it does
A new bounded obligation **`graph_enrichment_current`** runs between `structure_artifacts` and `design_assessment_current`. The structure executor always emits the **regex floor**; enrichment layers language-analyzer edges onto `graph_bundle.json` with **higher-confidence-kind-wins** precedence and records provenance in `analyzer_capability.json` (+ `graph_bundle.analyzers_used[]`). The first analyzer is the **TypeScript compiler API**: module resolution → `ts-import`/`ts-reexport` (honours tsconfig paths/barrels/`.js`→`.ts`), heritage → `ts-extends`/`ts-implements`, checker → cross-file `ts-call`.

Per-analyzer resolution (`session-config.json → analyzers.<id>`): repo `node_modules` → version-keyed `analyzer-cache` → (for `ephemeral`/`permanent`) install into the cache → else regex floor. `auto`/unset with an absent dep **and** in-scope files is the only case that pauses: the conversation-first `next-step` emits an **`analyzer_install`** step proposing `{ephemeral|permanent|skip}`; the host writes `incoming/analyzer-decisions.json`, the choice persists to session config, and the run continues. Non-interactive paths (`advance-audit`, run-to-completion) never prompt — unanswered `auto`+absent → skip → floor. An analyzer with 0 supported in-scope files is `not_applicable` (no prompt, no noise).

### Where it lives
- **Shared:** `analyzers_used?: string[]` on `GraphBundle` ([graph.ts](packages/shared/src/types/graph.ts)); `ANALYZER_SETTINGS`/`AnalyzerSetting` + `SessionConfig.analyzers` ([sessionConfig.ts](packages/shared/src/types/sessionConfig.ts)); both re-exported from [index.ts](packages/shared/src/index.ts). `resolveAnalyzerDep`/`installToCache` ([analyzerDeps.ts](packages/shared/src/tooling/analyzerDeps.ts)) were already built (Phase 0).
- **Seam:** [`src/extractors/analyzers/`](packages/audit-code/src/extractors/analyzers) — `types.ts` (`LanguageAnalyzer`/`AnalyzerContext`/`AnalyzerPlanEntry`), `registry.ts` (`ANALYZER_REGISTRY`, `resolveAnalyzerPlan`, `needsInstallDecision`), `merge.ts` (`mergeAnalyzerEdges` group-aware precedence + analyzer confidences), `typescript.ts` (the analyzer; dynamically loads the resolved `typescript`, scopes a `ts.Program` to included files). `buildPathLookup` exported from [graph.ts](packages/audit-code/src/extractors/graph.ts).
- **Executor:** [graphEnrichmentExecutor.ts](packages/audit-code/src/orchestrator/graphEnrichmentExecutor.ts) (`runGraphEnrichmentExecutor`; injectable `registry`/`cacheRoot` for tests). Marker type [analyzerCapability.ts](packages/audit-code/src/types/analyzerCapability.ts).
- **State / chain:** obligation in [state.ts](packages/audit-code/src/orchestrator/state.ts) (keyed on `analyzer_capability.json`) + `PRIORITY` in [nextStep.ts](packages/audit-code/src/orchestrator/nextStep.ts) after `structure_artifacts`; executor registered in [executors.ts](packages/audit-code/src/orchestrator/executors.ts); dispatched in [advance.ts](packages/audit-code/src/orchestrator/advance.ts) (`analyzers` option + switch case).
- **Artifacts / staleness:** `analyzer_capability` registered in [io/artifacts.ts](packages/audit-code/src/io/artifacts.ts); DAG edge `graph_bundle.json → analyzer_capability.json` in [dependencyMap.ts](packages/audit-code/src/orchestrator/dependencyMap.ts) + [spec/dependency-map.md](packages/audit-code/spec/dependency-map.md). Schemas: new [analyzer_capability.schema.json](packages/audit-code/schemas/analyzer_capability.schema.json); `analyzers_used` added to [graph_bundle.schema.json](packages/audit-code/schemas/graph_bundle.schema.json).
- **CLI:** `analyzer_install` `StepKind` ([cli/steps.ts](packages/audit-code/src/cli/steps.ts)); `renderAnalyzerInstallPrompt` ([cli/prompts.ts](packages/audit-code/src/cli/prompts.ts)); interception + new result arm in `runDeterministicForNextStep`, step emission in `cmdNextStep`, and `analyzers` threaded through `runAuditStep`→`advanceAudit` at the generic-advance call sites ([cli.ts](packages/audit-code/src/cli.ts)). `persistAnalyzerSettings` writeback ([supervisor/sessionConfig.ts](packages/audit-code/src/supervisor/sessionConfig.ts)). `analyzers` config validation ([validation/sessionConfig.ts](packages/audit-code/src/validation/sessionConfig.ts)).

### Decisions & deviations this sprint
- **Obligation placed before `design_assessment_current`** (not just "before planning") so the deterministic design assessment, which reads `graph_bundle`, sees enriched edges.
- **Group-aware merge, not blanket `(from,to)` collapse.** `mergeAnalyzerEdges` collapses only within a relation group (import / inheritance / call); ungrouped floor kinds (container, auth-session, route-handler, …) are untouched, so every existing floor golden stays byte-stable when no analyzer runs.
- **No-cycle marker pattern reused from Phase 6.** Enrichment writes `graph_bundle.json` **and** `analyzer_capability.json` in one `advanceAudit` call; dependency-first metadata records the post-enrichment graph revision. Re-running structure re-stales the marker so enrichment regenerates.
- **TS module loading** prefers the dependency resolved from the audited repo/cache (`loadTypescript(dependencyPath)` via `pathToFileURL` on the package `main`), falling back to the bundled `typescript`; any compiler failure degrades to the regex floor.
- **Test-harness note (not a product change):** the existing in-process narrative tests build the pipeline from `{}` without a `tooling_manifest`, which makes `next-step` re-derive on resume; with the new enrichment step that surfaces as an `analyzer_install` pause. Fixed by pinning `analyzers: { typescript: "skip" }` in those tests (real CLI runs persist incrementally and don't hit this). The orchestration/lifecycle/MCP tests gained the one extra enrichment step in their asserted sequences.

---

## Remaining phases (not started)

Pick up in frozen order. Shared building blocks they need already exist (parentheticals).

- **Phase 3 — `--since` delta mode** *(next)*. `advanceAudit({since})`, CLI `--since <ref>`; new `scope.json` + schema; deterministic priority-frontier BFS using `changedFiles` (**already built**, [git.ts](packages/shared/src/git.ts)) + the degree index (`buildGraphDegreeIndex`/`HIGH_FAN_DEGREE_THRESHOLD` in [reviewPackets.ts](packages/audit-code/src/orchestrator/reviewPackets.ts)). Only in-scope coverage entries go `pending`. The new TS call/import graph strengthens neighbor expansion automatically.
- **Phase 4 — decorator routing + LLM edge-reasoning.** 4A: extend route patterns ([graph.ts](packages/audit-code/src/extractors/graph.ts)) for NestJS/FastAPI/Flask/Angular, emitting existing `RouteEdge` shapes (the analyzer seam now exists for an AST-based version). 4B: optional cached LLM post-pass that only rewrites `reason` on existing low-confidence edges. Config `graph.llm_edge_reasoning` (default off).
- **Phase 5(Py/HTML/CSS) — tree-sitter analyzers.** Register into the **existing seam** ([registry.ts](packages/audit-code/src/extractors/analyzers/registry.ts)): Python imports/decorators, HTML `<script>/<link>`, CSS `@import`/`url()`. SQL = registry stub only.
- **Phase 7 — remediator prompts, theme hints, outcome capture.** Consume `audit-findings.json` directly (incl. `theme_id`/`suggested_fix_pattern`); **delete `parseAuditReport`/`isAuditorAuditReport`** ([plan.ts](packages/remediate-code/src/phases/plan.ts)) — keep the free-form LLM path. Inject `detectRepoConventions(root)` into worker prompts; emit `remediation-outcomes.json` from [close.ts](packages/remediate-code/src/phases/close.ts).

### New session-config keys still to add
`graph.llm_edge_reasoning` (Phase 4). (`analyzers.<id>` **done** this sprint; `observability.run_log`, `synthesis.narrative` done earlier; `--since` is a CLI flag.)

---

## Carried-over deviations (still true from prior sprints)
- `Finding.lens` stays `string` in the wire contract, narrowed to `Lens` only in the auditor via `Omit`.
- `runShellCommand` retained in the remediator (fully removing it needs `test_command`/`e2e_command` as argv).
- `collectFileCommits` not moved to shared `git.ts` (its `runCommand` injection point is relied on by co-commit tests).
- Token estimates are prefer-bytes / fall-back-to-lines (Phase 2); line-based goldens stay byte-for-byte stable.

## Git state
This sprint's Phase 5.0 + 5(TS/JS) work is on the `master` working tree, not yet committed. Prior sprints: Phase 6 in `5fc32b4`, Phase 2 byte-switch in `a1b3cce`, Phases 0/1A/remediator-2 in `23af936`.

## How to verify
```bash
npm install
npm run build -w @audit-tools/shared && npm run build   # build order matters
npm test -w @audit-tools/shared                          # 24
npm test -w packages/audit-code                          # 497
npm test -w packages/remediate-code                      # 360
```
