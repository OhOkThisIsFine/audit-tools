# audit-tools refactor — sprint handoff

**Date:** 2026-05-30
**Scope this sprint:** the **final three phases** of the frozen plan — **Phase 4** (decorator routing + LLM edge-reasoning), **Phase 5 (Py/HTML/CSS)** (tree-sitter analyzers), and **Phase 7** (remediator: consume `audit-findings.json`, theme hints, outcome capture).
**Status:** implemented and green on `master` (committed — see _Git state_). **The frozen build order `0 → 1A + .tmp → 2 → 6 → 5.0 + 5(TS/JS) → 3 → 4 → 5(Py/HTML/CSS) → 7` is now complete.**

---

## Verification status (all green)

```
shared          28 tests   pass   (node --test packages/shared/tests/*.test.mjs)
audit-code     530 tests   pass   (node --test)
remediate-code 363 tests   pass   (vitest)
```

`npm run build` (shared → both dependents) and `npm run check` are clean in every workspace.

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

- **4B is host-supplied, not an in-process provider call.** The audit-code orchestrator makes no in-process LLM calls (the Phase 6 narrative is also host-supplied via a results option, despite the plan's "single cached call via FreshSessionProvider" wording — `FreshSessionProvider` is a fresh-session *launcher*, not a `runTask`). 4B mirrors that: the pure transform applies host-supplied rewrites; `buildEdgeReasoningPrompt`/`edgeReasoningContentHash` are exposed for the host's cached call. The deterministic graph-enrichment step has no host turn in the next-step CLI, so the gate flows through but rewrites arrive via the programmatic API.
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
