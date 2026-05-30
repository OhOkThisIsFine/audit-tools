# audit-tools refactor — sprint handoff

**Date:** 2026-05-30
**Scope this sprint:** the **final three phases** of the frozen plan — **Phase 4** (decorator routing + LLM edge-reasoning), **Phase 5 (Py/HTML/CSS)** (tree-sitter analyzers), and **Phase 7** (remediator: consume `audit-findings.json`, theme hints, outcome capture).
**Status:** implemented and green on `master` (committed — see _Git state_). **The frozen build order `0 → 1A + .tmp → 2 → 6 → 5.0 + 5(TS/JS) → 3 → 4 → 5(Py/HTML/CSS) → 7` is now complete.** One follow-up remains: **4B has no producing turn** — see _Next pickup_ below.

---

## Verification status (all green)

```
shared          28 tests   pass   (node --test packages/shared/tests/*.test.mjs)
audit-code     530 tests   pass   (node --test)
remediate-code 363 tests   pass   (vitest)
```

`npm run build` (shared → both dependents) and `npm run check` are clean in every workspace.

---

## Next pickup — wire 4B's producing turn (subagent dispatch + one-step fallback)

**The gap.** 4B (edge reasoning) is only half-wired. The *apply* half is done and tested: `applyEdgeReasoning` rewrites low-confidence edge `reason`s from host-supplied results, the `graph.llm_edge_reasoning` gate flows config → CLI → `advanceAudit` → `runGraphEnrichmentExecutor`, and `buildEdgeReasoningPrompt` / `edgeReasoningContentHash` are exported. **What's missing is the *produce* half** — nothing in the `next-step` / `run-to-completion` flow ever asks a host or subagent to generate the rewrites. So in the normal flow 4B is **inert**; it only fires if `edgeReasoningResults` is passed through the programmatic `advanceAudit` API. This violates the project's dispatch rule ("subagents for scoped tasks where advantageous; else the orchestrator does it one step at a time") — 4B currently does *neither*.

**Why it happened.** The obligation it attaches to, `graph_enrichment_current`, is a **deterministic inline executor** (runs in-process, no host/subagent turn). The two existing precedents for an LLM turn are different shapes:
- **Fan-out scoped work → subagent dispatch:** audit review packets (one per unit × lens) go out as a dispatch plan; the host spawns subagents (or the `cmdRunToCompletion` wave scheduler `launch`es them), results return as files → ingestion.
- **Single one-shot pass → one host step:** the Phase 6 narrative (and design review) emit a single step prompt; the host writes a result file (`synthesis-narrative.json`) and re-runs `next-step`. See the `synthesis_narrative` handling in [cli.ts](packages/audit-code/src/cli.ts) (~`runDeterministicForNextStep` / `cmdNextStep`, the `synthesis_narrative` step kind) — this is the closest template.

Edge reasoning is a **single scoped pass** (the "single-call" invariant), so it fits either shape.

**The work (recommended: dual-mode, mirroring the audit work).**
1. Give edge reasoning its own turn. Cleanest is a new obligation, e.g. `graph_edge_reasoning_current`, downstream of `graph_enrichment_current` and upstream of `planning_artifacts` — add to the chain in [nextStep.ts](packages/audit-code/src/orchestrator/nextStep.ts), the executor catalog in [executors.ts](packages/audit-code/src/orchestrator/executors.ts), and the staleness DAG (`dependencyMap.ts` / `spec/dependency-map.md`: depends on `graph_bundle.json`, gated on `graph.llm_edge_reasoning`). Satisfied/omitted when the flag is off or there are no `< 0.65` edges. Emit a marker artifact (e.g. `edge_reasoning.json`) so it doesn't perpetually re-fire.
2. **Dispatch path (preferred when `hostCanDispatchSubagents`):** emit a one-item dispatch task — prompt = `buildEdgeReasoningPrompt(collectLowConfidenceEdges(bundle))`, result → `edge-reasoning.json` — through the same dispatch-plan machinery the packets use. Keeps the (potentially large) edge-list prompt isolated and parallelizable. An ingestion step reads the file and calls `applyEdgeReasoning`.
3. **One-step fallback (when dispatch isn't available):** mirror the narrative step — `next-step` returns the prompt + a results path, host writes `edge-reasoning.json`, re-runs `next-step`, orchestrator applies it. Reuse the `narrativeResults` plumbing shape: add an `edgeReasoningResults` results-file read in the CLI (the `advanceAudit` option already exists).
4. Cache by content hash host-side via `edgeReasoningContentHash` (skip the call when the edge set is unchanged).

**Tests to add:** with `hostCanDispatchSubagents: true` → a dispatch task is emitted with the edge-reasoning prompt; with it false (or no provider) → a single host step is emitted; round-trip (write `edge-reasoning.json` → re-run → reasons rewritten, edge set invariant); flag off or zero low-confidence edges → obligation omits and the graph is byte-identical.

**Reusable pieces already in place:** [edgeReasoning.ts](packages/audit-code/src/orchestrator/edgeReasoning.ts) (`applyEdgeReasoning`, `buildEdgeReasoningPrompt`, `edgeReasoningContentHash`, `collectLowConfidenceEdges`, `EdgeReasoningResults`), the `graphLlmEdgeReasoning` / `edgeReasoningResults` options on `AdvanceAuditOptions` + `ExecuteObligationOptions`, and the `graph.llm_edge_reasoning` session key.

---

## Phase 4 — decorator routing + edge reasoning ✅  (`1835645`)

- **4A (deterministic):** NestJS / FastAPI / Flask / Angular route detection added to [graph.ts](packages/audit-code/src/extractors/graph.ts) (`extractFrameworkRouteEvidence`). Emits only the existing `RouteEdge` / `route-handler-link` shapes — no new planning-topology edge kinds. Each branch is gated on a framework marker (`@Controller`, Python `@x.get`/`@x.route`, an Angular `RouterModule`/`Routes` file) so the patterns never fire on unrelated decorators or object literals. Co-located handlers resolve to the file itself; Angular components resolve through import bindings.
- **4B (optional, bounded):** [edgeReasoning.ts](packages/audit-code/src/orchestrator/edgeReasoning.ts) `applyEdgeReasoning` rewrites only the `reason` of low-confidence (`< 0.65`) edges; the edge set (from/to/kind/confidence/direction) is invariant. Rewrites are **host-supplied** (the same conversation-first pattern Phase 6's narrative actually uses — the orchestrator makes no in-process LLM call), gated on the new session-config key `graph.llm_edge_reasoning` (default off) and a no-op without rewrites. `buildEdgeReasoningPrompt` / `edgeReasoningContentHash` are exposed for a host to produce and cache the single call. Wired into `runGraphEnrichmentExecutor` (runs whether or not analyzers contributed, since the floor's heuristic edges exist regardless), threaded through `advanceAudit` / `executeObligation` / the next-step CLI gate.
- **Config:** `graph: GraphConfig { llm_edge_reasoning?, model? }` added to shared `SessionConfig`.
- **Tests:** [graph-framework-routes.test.mjs](packages/audit-code/tests/graph-framework-routes.test.mjs), [edge-reasoning.test.mjs](packages/audit-code/tests/edge-reasoning.test.mjs) (golden edge-set equality — only `reason` changes; high-confidence edges untouched; no-op without rewrites; executor bucket routing).

## Phase 5 (Py/HTML/CSS) — tree-sitter analyzers ✅  (`c33f018`)

- Pure-WASM **web-tree-sitter** analyzers behind the existing seam, each loading its grammar from **tree-sitter-wasms** and degrading to the regex floor when the dependency cannot be resolved ([treeSitter.ts](packages/audit-code/src/extractors/analyzers/treeSitter.ts) loader; [resourceUrl.ts](packages/audit-code/src/extractors/analyzers/resourceUrl.ts) shared URL resolver):
  - **[python.ts](packages/audit-code/src/extractors/analyzers/python.ts):** `py-import` / `py-from-import`. Resolution is **shared with the regex floor** (`resolvePythonImportTarget` / `resolvePythonFromImportTargets` exported from [graphPythonImports.ts](packages/audit-code/src/extractors/graphPythonImports.ts)) so AST edges resolve to identical targets and merely supersede the floor by confidence.
  - **[html.ts](packages/audit-code/src/extractors/analyzers/html.ts):** `<script src>` / `<link href>` / `<img src>` → `html-resource`.
  - **[css.ts](packages/audit-code/src/extractors/analyzers/css.ts):** `@import` and `url()` → `css-import` / `css-url`.
  - **[sql.ts](packages/audit-code/src/extractors/analyzers/sql.ts):** registry stub (recognises `.sql`, emits no edges).
- **Wiring:** registry order seam → TS → Python → HTML → CSS (+ SQL stub); `EDGE_GROUP` collapses `py-*`/`python-*` and `html-resource`/`html-resource-link` so analyzer edges win for the same (from,to); `BUCKET_BY_KIND` routes the new kinds. `web-tree-sitter` + `tree-sitter-wasms` are **devDependencies** (optional at runtime; production degrades to the floor).
- **Tests:** [tree-sitter-analyzers.test.mjs](packages/audit-code/tests/tree-sitter-analyzers.test.mjs) — per-language golden edges, external-URL skip, SQL stub, merge supersession, executor bucket routing, graceful skip without the dep.

## Phase 7 — remediator integration ✅  (`8c60e4a`)

- **Input contract:** the remediator now consumes the auditor's canonical `audit-findings.json` directly (`parseAuditFindingsReport` / `isAuditFindingsReport` in [plan.ts](packages/remediate-code/src/phases/plan.ts)); **`parseAuditReport` / `isAuditorAuditReport` (the markdown parse path) are deleted.** The free-form LLM extraction path stays for non-auditor input. The next-step fast-path and [intakeResolver.ts](packages/remediate-code/src/steps/intakeResolver.ts) detect a `.json` findings report. Synthesis `themes[]` ride along on `RemediationPlan`.
- **7A prompts:** shared `detectRepoConventions(root)` / `formatRepoConventions` ([repoConventions.ts](packages/shared/src/tooling/repoConventions.ts)) inject formatter/linter/test-framework/module-style + a sampled house-style snippet ("match the surrounding code") into the document worker prompt ([document.ts](packages/remediate-code/src/phases/document.ts)); when a finding carries `theme_id`, its `suggested_fix_pattern` is included too (reuses Phase 6 — no new LLM pass).
- **7B outcomes:** shared `RemediationOutcome` ([remediationOutcome.ts](packages/shared/src/types/remediationOutcome.ts)); [close.ts](packages/remediate-code/src/phases/close.ts) emits `remediation-outcomes.json` (`finding_id, lens, file_exts[], outcome, rework_count, closing_status`) + a report section ("of N findings: X resolved, … by lens"). Capture/surface only — no auto-calibration. `rework_count` is tracked via triage retries.
- **Fixtures:** migrated to JSON (`audit-findings-simple.json`, `auditor-contract-audit-findings.json`); the generator now emits JSON and no longer needs a built auditor.
- **Tests:** [phase-plan-parse.test.ts](packages/remediate-code/tests/phase-plan-parse.test.ts) (rewritten for the JSON contract), [phase-plan.test.ts](packages/remediate-code/tests/phase-plan.test.ts) (rewritten to JSON inputs), [remediation-outcomes.test.ts](packages/remediate-code/tests/remediation-outcomes.test.ts), [repoConventions.test.mjs](packages/shared/tests/repoConventions.test.mjs).

---

## Decisions & deviations this sprint

- **4B is host-supplied, not an in-process provider call.** The audit-code orchestrator makes no in-process LLM calls (the Phase 6 narrative is also host-supplied via a results option, despite the plan's "single cached call via FreshSessionProvider" wording — `FreshSessionProvider` is a fresh-session *launcher*, not a `runTask`). 4B mirrors that: the pure transform applies host-supplied rewrites; `buildEdgeReasoningPrompt`/`edgeReasoningContentHash` are exposed for the host's cached call. The deterministic graph-enrichment step has no host turn in the next-step CLI, so the gate flows through but rewrites arrive via the programmatic API. **Wiring the producing turn (subagent dispatch + one-step fallback) is the next pickup — see _Next pickup_ above.**
- **MCP adapter ([executors.ts](packages/audit-code/src/orchestrator/executors.ts)) carries the 4B option** but, like the rest of the legacy adapter, is not the canonical path.
- **Phase 5 uses web-tree-sitter (WASM), not native node-tree-sitter** — no native compilation, identical cross-platform parsing, and it degrades cleanly. Grammars come from `tree-sitter-wasms` (hyphenated `tree-sitter-<lang>.wasm`).
- **Python analyzer reuses the floor's resolver** rather than reimplementing module resolution, guaranteeing the analyzer edge and the floor edge share `(from,to)` and the merge collapses them (analyzer confidence `0.97` > floor `0.95`).
- **Markdown audit reports are no longer a structured remediator input.** `audit-report.md` is human-facing; the machine hand-off is `audit-findings.json`. A markdown file passed to the remediator now flows through the free-form LLM extractor.

## Carried-over deviations (still true)
- `Finding.lens` stays `string` in the wire contract, narrowed to `Lens` only in the auditor via `Omit`.
- `runShellCommand` retained in the remediator.
- Token estimates are prefer-bytes / fall-back-to-lines (Phase 2).

## Git state
This sprint on `master`: Phase 4 `1835645`, Phase 5(Py/HTML/CSS) `c33f018`, Phase 7 `8c60e4a`. Prior: Phase 3 `de41b68`, Phase 5.0+5(TS/JS) `9019ce3`, Phase 6 `5fc32b4`, Phase 2 `a1b3cce`, Phases 0/1A `23af936`.

## How to verify
```bash
npm install
npm run build -w @audit-tools/shared && npm run build   # build order matters
npm test -w @audit-tools/shared                          # 28
npm test -w packages/audit-code                          # 530
npm test -w packages/remediate-code                      # 363
```
