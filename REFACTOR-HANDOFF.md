# audit-tools refactor — sprint handoff

**Date:** 2026-05-30
**Scope this sprint:** the **final three phases** of the frozen plan — **Phase 4** (decorator routing + LLM edge-reasoning), **Phase 5 (Py/HTML/CSS)** (tree-sitter analyzers), and **Phase 7** (remediator: consume `audit-findings.json`, theme hints, outcome capture).
**Status:** implemented and green on `master` (committed — see _Git state_). The frozen build order `0 → 1A + .tmp → 2 → 6 → 5.0 + 5(TS/JS) → 3 → 4 → 5(Py/HTML/CSS) → 7` is complete and 4B's producing turn is wired (see _Phase 4B producing turn — wired_ below).
**Correction (2026-05-30):** an earlier pass declared "the entire refactor plan is complete, no open follow-ups." A deeper audit against the plan found **three Phase 7 gaps the prior handoff had silently narrowed** — all now closed (see _Phase 7 gaps found & closed_ below). Lesson: "all tests green" only covered the code that existed; the gaps were untested features applied to a dead code path and an artifact/log that was never wired.

---

## Verification status (all green)

```
shared          28 tests   pass   (node --test packages/shared/tests/*.test.mjs)
audit-code     534 tests   pass   (node --test)   # +4 next-step edge-reasoning
remediate-code 371 tests   pass   (vitest)        # +8 Phase 7 gap-closure tests
```

`npm run build` (shared → both dependents) and `npm run check` are clean in every workspace.

---

## Phase 7 gaps found & closed ✅  (this pass)

A line-by-line re-audit of Phase 7 against the frozen plan turned up three deliverables the earlier handoff had quietly narrowed in its prose. All three are now implemented with tests.

### Gap A — Phase 7A house-style + theme hints landed on a dead code path (the big one)
Plan line 95: `detectRepoConventions` + theme hints go "into the document **and implement prompts**." The prior work added them **only** to `phases/document.ts` — but `phases/*` is reached solely through `runOrchestrator`, which is **exported yet never called anywhere in `src`** (test-only). The path users actually run — `next-step` → [dispatch.ts](packages/remediate-code/src/steps/dispatch.ts) `findingPrompt`/`implementPrompt` — injected **neither**. So Phase 7A's headline feature ("match the surrounding code" + theme reuse) was inert in production.
- **Fix:** `prepareDocumentDispatch`/`prepareImplementDispatch` now compute `formatRepoConventions(detectRepoConventions(root))` once per dispatch and inject it into both worker prompts; `findingPrompt` also gets the synthesis theme hint (mirrors `phases/document.ts` wording exactly) for findings carrying a `theme_id`. The legacy in-process [implement.ts](packages/remediate-code/src/phases/implement.ts) refactor prompt gained conventions too, for parity (its sibling `document.ts` already had them).
- **Test:** [dispatch-conventions.test.ts](packages/remediate-code/tests/dispatch-conventions.test.ts) — conventions block in both canonical prompts; theme hint present only for the themed finding.

### Gap B — `remediation_outcomes.schema.json` was never written
Plan line 110 lists `remediation-outcomes.json` as shipping with a `schemas/*.schema.json` like every other new artifact (`scope`, `analyzer_capability`, `audit_findings` all have theirs). It was missing, and it wasn't in the `EXPECTED_SCHEMAS` list either, so nothing flagged it.
- **Fix:** added [remediation_outcomes.schema.json](packages/remediate-code/schemas/remediation_outcomes.schema.json) matching `RemediationOutcomesReport`/`RemediationOutcome`; added it to `EXPECTED_SCHEMAS` + a field-level contract check in [schema-contracts.test.ts](packages/remediate-code/tests/schema-contracts.test.ts).

### Gap C — outcomes emitted no run-log line
Plan line 96: `close.ts` emits `remediation-outcomes.json` "+ a run-log line each." It wrote the JSON and a report section but logged nothing.
- **Fix:** `runClosePhase` takes an optional `RunLogger` (threaded from the `next-step` close call site; the legacy path omits it); emits one `kind:"outcome"` event per finding plus a `kind:"artifact_write"` summary line.
- **Test:** [phase-close.test.ts](packages/remediate-code/tests/phase-close.test.ts) — one outcome line per finding + the artifact-write line; logger arg is optional.
- **Caveat (pre-existing, not Phase 7):** the run-log lives in `.remediation-artifacts/` and `runClosePhase` deletes that dir as its final cleanup step, so these lines are observable while the run is live (a host tailing the log between steps) but are not a persisted artifact. The durable outcome record is `remediation-outcomes.json` (written to repo root). Redesigning run-log persistence was out of scope for finishing Phase 7.

---

## Phase 4B producing turn — wired ✅  (dual-mode dispatch + one-step fallback)

**The gap (closed).** 4B's *apply* half was done; the *produce* half was missing — nothing in the `next-step` flow asked a host/subagent to generate the rewrites, so 4B was inert outside the programmatic `advanceAudit` API. It now has a producing turn in both modes.

**Shape chosen — producing turn at the CLI, keyed to `graph_enrichment_executor` (no new obligation).** This mirrors the Phase 6 narrative exactly: the narrative is also satisfied by a deterministic inline executor (`synthesis_narrative_executor`) whose *producing* turn lives in the `next-step` CLI, not in a separate obligation. The flow:
- In [cli.ts](packages/audit-code/src/cli.ts) `runDeterministicForNextStep`, once analyzer-install decisions are resolved, if `graph.llm_edge_reasoning` is on **and** the floor carries `< 0.65` edges, the loop emits a single bounded producing turn (returns a new `edge_reasoning` result kind). On re-run, if `incoming/edge-reasoning.json` is present it calls `runAuditStep({ edgeReasoningResultsPath })` and the **enrichment executor applies the rewrites in the same `advanceAudit` call that merges analyzer edges and writes `analyzer_capability`** — so `graph_bundle.json` and its marker stay revision-consistent.
- `cmdNextStep` branches on `hostCanDispatch`: true → step kind **`edge_reasoning_dispatch`** (writes the edge-list prompt to `incoming/edge-reasoning-prompt.md`, tells the host to fan it out to one subagent); false → step kind **`edge_reasoning`** (the host produces the rewrites itself in one shot, narrative-style). Both write to `incoming/edge-reasoning.json` and re-run `next-step`. The content hash (`edgeReasoningContentHash`) is surfaced as a host-side cache key.

**Why not the handoff's "new `graph_edge_reasoning_current` obligation".** A separate downstream obligation would have edge reasoning rewrite `graph_bundle.json` in its *own* `advanceAudit` call, bumping the graph's revision *after* `analyzer_capability.json` (which depends on `graph_bundle.json`) already recorded the prior revision — re-staling `analyzer_capability` and forcing a wasteful extra `graph_enrichment` re-run every time reasoning fires. Co-locating the apply with enrichment (one call writes graph + marker) sidesteps that loop entirely, needs no new obligation / marker / dependency-DAG edits, and reuses the proven narrative-producing-turn template. The deterministic floor and the `graph.llm_edge_reasoning`-off path are byte-identical to before.

**New surface:** `edge_reasoning` / `edge_reasoning_dispatch` step kinds ([steps.ts](packages/audit-code/src/cli/steps.ts)); `renderEdgeReasoningStepPrompt` / `renderEdgeReasoningDispatchPrompt` ([prompts.ts](packages/audit-code/src/cli/prompts.ts)); `edgeReasoningResultsPath` on `runAuditStep` (reads `incoming/edge-reasoning.json` → the existing `edgeReasoningResults` `advanceAudit` option).

**Tests:** [next-step-edge-reasoning.test.mjs](packages/audit-code/tests/next-step-edge-reasoning.test.mjs) — one-step host turn + round-trip (reason rewritten, edge identity invariant, `analyzer_capability` written); dispatch task carries the edge-reasoning prompt when the host can dispatch; flag off → no pause and graph unchanged; zero low-confidence edges → no pause.

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
- **7A prompts:** shared `detectRepoConventions(root)` / `formatRepoConventions` ([repoConventions.ts](packages/shared/src/tooling/repoConventions.ts)) inject formatter/linter/test-framework/module-style + a sampled house-style snippet ("match the surrounding code"), plus the synthesis theme hint when a finding carries `theme_id` (reuses Phase 6 — no new LLM pass). **Now injected into the canonical `next-step` wave prompts** (`findingPrompt`/`implementPrompt` in [dispatch.ts](packages/remediate-code/src/steps/dispatch.ts)) **and** the in-process [document.ts](packages/remediate-code/src/phases/document.ts)/[implement.ts](packages/remediate-code/src/phases/implement.ts). ⚠️ Originally only `document.ts` got this; see _Phase 7 gaps found & closed → Gap A_ for why that path is dead.
- **7B outcomes:** shared `RemediationOutcome` ([remediationOutcome.ts](packages/shared/src/types/remediationOutcome.ts)); [close.ts](packages/remediate-code/src/phases/close.ts) emits `remediation-outcomes.json` (`finding_id, lens, file_exts[], outcome, rework_count, closing_status`) — schema [remediation_outcomes.schema.json](packages/remediate-code/schemas/remediation_outcomes.schema.json) — a report section ("of N findings: X resolved, … by lens"), and a run-log line per outcome. Capture/surface only — no auto-calibration. `rework_count` is tracked via triage retries. ⚠️ The schema and run-log lines were missing originally; see _Gap B / Gap C_.
- **Fixtures:** migrated to JSON (`audit-findings-simple.json`, `auditor-contract-audit-findings.json`); the generator now emits JSON and no longer needs a built auditor.
- **Tests:** [phase-plan-parse.test.ts](packages/remediate-code/tests/phase-plan-parse.test.ts) (rewritten for the JSON contract), [phase-plan.test.ts](packages/remediate-code/tests/phase-plan.test.ts) (rewritten to JSON inputs), [remediation-outcomes.test.ts](packages/remediate-code/tests/remediation-outcomes.test.ts), [repoConventions.test.mjs](packages/shared/tests/repoConventions.test.mjs).

---

## Decisions & deviations this sprint

- **4B is host-supplied, not an in-process provider call.** The audit-code orchestrator makes no in-process LLM calls (the Phase 6 narrative is also host-supplied via a results option, despite the plan's "single cached call via FreshSessionProvider" wording — `FreshSessionProvider` is a fresh-session *launcher*, not a `runTask`). 4B mirrors that: the pure transform applies host-supplied rewrites; `buildEdgeReasoningPrompt`/`edgeReasoningContentHash` are exposed for the host's cached call. **The producing turn is now wired** (dual-mode dispatch + one-step fallback) as a CLI-level turn keyed to `graph_enrichment_executor`, rather than as a new obligation — see _Phase 4B producing turn — wired_ above for the shape and the rationale (avoids an `analyzer_capability` ↔ `graph_bundle` re-stale loop).
- **MCP adapter ([executors.ts](packages/audit-code/src/orchestrator/executors.ts)) carries the 4B option** but, like the rest of the legacy adapter, is not the canonical path.
- **Phase 5 uses web-tree-sitter (WASM), not native node-tree-sitter** — no native compilation, identical cross-platform parsing, and it degrades cleanly. Grammars come from `tree-sitter-wasms` (hyphenated `tree-sitter-<lang>.wasm`).
- **Python analyzer reuses the floor's resolver** rather than reimplementing module resolution, guaranteeing the analyzer edge and the floor edge share `(from,to)` and the merge collapses them (analyzer confidence `0.97` > floor `0.95`).
- **Markdown audit reports are no longer a structured remediator input.** `audit-report.md` is human-facing; the machine hand-off is `audit-findings.json`. A markdown file passed to the remediator now flows through the free-form LLM extractor.

## Carried-over deviations (still true)
- `Finding.lens` stays `string` in the wire contract, narrowed to `Lens` only in the auditor via `Omit`.
- `runShellCommand` retained in the remediator.
- Token estimates are prefer-bytes / fall-back-to-lines (Phase 2).

## Git state
Latest on `master`: **Phase 7 gap closure** (Gaps A/B/C above) + this handoff update — the most recent commit. Before that: doc reconcile `c871bc3`, the **4B producing turn `f6f04fd`**, docs `f98bf39`/`3743b9b`, Phase 7 `8c60e4a`, Phase 5(Py/HTML/CSS) `c33f018`, Phase 4 `1835645`. Prior: Phase 3 `de41b68`, Phase 5.0+5(TS/JS) `9019ce3`, Phase 6 `5fc32b4`, Phase 2 `a1b3cce`, Phases 0/1A `23af936`.

## How to verify
```bash
npm install
npm run build -w @audit-tools/shared && npm run build   # build order matters
npm test -w @audit-tools/shared                          # 28
npm test -w packages/audit-code                          # 534
npm test -w packages/remediate-code                      # 371
```
