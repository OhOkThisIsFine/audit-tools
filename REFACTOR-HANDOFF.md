# audit-tools refactor — sprint handoff

**Date:** 2026-05-29
**Scope this sprint:** **Phase 6 — synthesis narrative + canonical JSON hand-off** (auditor). Adds the `synthesis_narrative_current` obligation, emits the canonical `audit-findings.json` machine contract, and renders the optional LLM narrative (themes / executive summary / top risks) into both the JSON and `audit-report.md`.
**Status:** committed on `master` (see _Git state_ below).

The frozen build order is: **0 → 1A + `.tmp` fix → 2 → 6 → 5.0 + 5(TS/JS) → 3 → 4 → 5(Py/HTML/CSS) → 7.** Everything through **Phase 6 is now done**. The next pickup is **Phase 5.0 + 5(TS/JS)** (compiler/parser graph seam + the TypeScript analyzer).

---

## Verification status (all green)

```
shared          24 tests   pass   (node --test packages/shared/tests/*.test.mjs)
audit-code     487 tests   pass   (node --test, +10 new vs. 477 baseline)
remediate-code 360 tests   pass   (vitest)
```

`npm run build` (shared → both dependents) and `npm run check` are clean in every workspace. The 10 new tests are [synthesis-narrative.test.mjs](packages/audit-code/tests/synthesis-narrative.test.mjs) (8: canonical report build, base vs. narrative render, `applyNarrative` tagging + unknown-id drop, JSON↔markdown parity, both executors, forced `advanceAudit`) and [next-step-narrative.test.mjs](packages/audit-code/tests/next-step-narrative.test.mjs) (2: conversation-first pause→ingest→complete, and config-disabled omit).

Recommended pre-release gate (not run this sprint, involves packaging smoke): `npm run verify:release` in each package.

---

## Phase 6 — synthesis narrative + canonical JSON hand-off ✅

### What it does
The synthesis step now emits the canonical **`audit-findings.json`** (shared `AuditFindingsReport`) alongside `audit-report.md` — the markdown is a render of that report model. A new downstream obligation **`synthesis_narrative_current`** optionally enriches the findings report with an LLM narrative:

- **Deterministic path** (run-to-completion, MCP, programmatic `advanceAudit`): the narrative auto-**omits** — one extra bounded step writes a `synthesis-narrative.json` marker (`status: "omitted"`) and the deterministic report stands unchanged.
- **Conversation-first path** (`next-step`, `synthesis.narrative !== false`): the orchestrator **pauses** with a new `synthesis_narrative` step prompt; the host writes a `SynthesisNarrative` JSON to `incoming/synthesis-narrative.json`, re-runs `next-step`, and the narrative is merged — `themes[]` + `executive_summary` + `top_risks[]` appended to `audit-findings.json`, findings tagged with `theme_id`, and `audit-report.md` re-rendered with the narrative sections.

On completion both `audit-report.md` **and** `audit-findings.json` are promoted to the repo root (the latter is the Phase 7 remediator hand-off).

### Where it lives
- **Shared:** `SynthesisConfig` (`synthesis.narrative`) on `SessionConfig` ([sessionConfig.ts](packages/shared/src/types/sessionConfig.ts)); `SynthesisNarrative` input type next to `FindingTheme` ([finding.ts](packages/shared/src/types/finding.ts)). Both re-exported from [index.ts](packages/shared/src/index.ts). `AuditFindingsReport`/`FindingTheme` were already defined (Phase 0).
- **Reporting** ([synthesis.ts](packages/audit-code/src/reporting/synthesis.ts)): `buildAuditFindingsReport(model)` wraps the deterministic `AuditReportModel` in the canonical contract (`AUDIT_FINDINGS_CONTRACT_VERSION`); `applyNarrative(report, narrative)` keeps only themes referencing real findings, tags findings (first-claiming theme wins), attaches summary/risks; `renderAuditReportMarkdown` now takes a `RenderableAuditReport` (widened to the shared `Finding`) and renders Executive Summary / Top Risks / Themes / per-finding `Theme:` lines only when present. New narrative prompt: [synthesisNarrativePrompt.ts](packages/audit-code/src/reporting/synthesisNarrativePrompt.ts).
- **Executors** ([internalExecutors.ts](packages/audit-code/src/orchestrator/internalExecutors.ts)): `runSynthesisExecutor` now writes `audit-findings.json` **and** `audit-report.md`; new `runSynthesisNarrativeExecutor(bundle, narrative?)` applies or omits. Registered in [executors.ts](packages/audit-code/src/orchestrator/executors.ts) (`synthesis_narrative_executor` → `synthesis_narrative_current`), wired into [advance.ts](packages/audit-code/src/orchestrator/advance.ts) (`narrativeResults` option + switch case).
- **State / chain:** obligation added to [state.ts](packages/audit-code/src/orchestrator/state.ts) (keyed on `synthesis-narrative.json`) and the `PRIORITY` chain in [nextStep.ts](packages/audit-code/src/orchestrator/nextStep.ts), after `synthesis_current`.
- **Artifacts / staleness:** `audit_findings` (`audit-findings.json`) and `synthesis_narrative` (`synthesis-narrative.json`) registered in [io/artifacts.ts](packages/audit-code/src/io/artifacts.ts); DAG edge `audit-findings.json → synthesis-narrative.json` in [dependencyMap.ts](packages/audit-code/src/orchestrator/dependencyMap.ts) + [spec/dependency-map.md](packages/audit-code/spec/dependency-map.md). `promoteFinalAuditReport` promotes `audit-findings.json` best-effort. `SynthesisNarrativeRecord` marker type: [types/synthesisNarrative.ts](packages/audit-code/src/types/synthesisNarrative.ts).
- **CLI** ([cli.ts](packages/audit-code/src/cli.ts)): `runAuditStep` gains `narrativeResultsPath`; `runDeterministicForNextStep` gains `narrativeEnabled` + the `synthesis_narrative_executor` interception (ingest `incoming/synthesis-narrative.json` if present, else pause when enabled, else fall through to the deterministic omit); `cmdNextStep` passes `narrativeEnabled` from config and emits the new `synthesis_narrative` step. New `StepKind` in [cli/steps.ts](packages/audit-code/src/cli/steps.ts).
- **Schema / validation:** [schemas/audit_findings.schema.json](packages/audit-code/schemas/audit_findings.schema.json) (new); `theme_id` added to [schemas/finding.schema.json](packages/audit-code/schemas/finding.schema.json); `synthesis.narrative` boolean validated in [validation/sessionConfig.ts](packages/audit-code/src/validation/sessionConfig.ts).

### Decisions & deviations this sprint
- **Narrative is a real obligation/step (Approach A), not folded into synthesis.** This adds exactly **one** bounded deterministic run (the omit marker). Default `--max-runs` is 1000 so only the explicit `--max-runs 2` completion test needed bumping to `3` (legitimate — the pipeline gained a step); all other completion paths were unaffected. The conversation-first pause is gated on `synthesis.narrative !== false` (default on), mirroring `design_review`.
- **`synthesis_current` stays keyed on `audit-report.md`** (minimal change); `audit-findings.json` is co-produced by `synthesis_executor`. The narrative marker tracks `audit-findings.json`'s revision via a single DAG edge — when synthesis re-runs (upstream change), the base `audit-findings.json` is rewritten, bumping its revision and re-staling `synthesis-narrative.json` so the narrative regenerates. No staleness cycle: the marker records the post-enrichment revision in the same `advanceAudit` call.
- **`renderAuditReportMarkdown` signature widened** to `RenderableAuditReport` (findings typed as the shared `Finding`, `lens: string`) so both `AuditReportModel` (lens narrowed) and `AuditFindingsReport` render through one path. Existing section layout is unchanged when no narrative is present, keeping the report goldens stable.
- **`audit-findings.json` promoted to repo root** on completion as the durable machine contract (Phase 7 input). The completion test only asserts `audit-report.md` + `.audit-artifacts` removal, so this is additive.

---

## Remaining phases (not started)

Pick up in frozen order. The shared building blocks they need already exist (see parentheticals).

- **Phase 5.0 + 5(TS/JS) — compiler/parser graph seam** *(next)*. `src/extractors/analyzers/` with `LanguageAnalyzer { supports; analyze }` + registry. New obligation `graph_enrichment_current` between `structure_artifacts` and `planning_artifacts`; regex floor always emitted, analyzer edges merged higher-confidence-kind-wins in `uniqueSortedEdges`; `graph_bundle.json` gains `analyzers_used[]`. Resolve deps with `resolveAnalyzerDep` (**already built**, [tooling/analyzerDeps.ts](packages/shared/src/tooling/analyzerDeps.ts)) → propose-install as a bounded step persisted to `session-config.json → analyzers.<id>`; unanswered = skip → regex. First analyzer: the `typescript` compiler API (module resolution → `ts-import`/`ts-reexport`; checker → `ts-call`/`ts-extends`/`ts-implements`). Add the `analyzers.<id>` config key (validation mirrors the `synthesis` block just added).
- **Phase 3 — `--since` delta mode.** `advanceAudit({since})`, CLI `--since <ref>`; new `scope.json` + schema; deterministic priority-frontier BFS using `changedFiles` (**already built**, [git.ts](packages/shared/src/git.ts)) + the degree index (`buildGraphDegreeIndex`/`HIGH_FAN_DEGREE_THRESHOLD` in [reviewPackets.ts](packages/audit-code/src/orchestrator/reviewPackets.ts)). Only in-scope coverage entries go `pending`.
- **Phase 4 — decorator routing + LLM edge-reasoning.** 4A: extend route patterns ([graph.ts](packages/audit-code/src/extractors/graph.ts)) for NestJS/FastAPI/Flask/Angular, emitting existing `RouteEdge` shapes. 4B: optional cached LLM post-pass that only rewrites `reason` on existing low-confidence edges. Config `graph.llm_edge_reasoning` (default off).
- **Phase 5(Py/HTML/CSS) — tree-sitter analyzers.** Python imports/decorators, HTML `<script>/<link>`, CSS `@import`/`url()`. SQL = registry stub only.
- **Phase 7 — remediator prompts, theme hints, outcome capture.** Consume `audit-findings.json` directly (now emitted at repo root) including `theme_id`/`suggested_fix_pattern`; **delete `parseAuditReport`/`isAuditorAuditReport`** ([plan.ts](packages/remediate-code/src/phases/plan.ts)) — keep the free-form LLM extraction path for non-auditor input. Inject `detectRepoConventions(root)` into worker prompts. Emit `remediation-outcomes.json` from [close.ts](packages/remediate-code/src/phases/close.ts).

### New session-config keys still to add
`analyzers.<id>` (Phase 5), `graph.llm_edge_reasoning` (Phase 4). (`observability.run_log` **done** Phase 1A; `synthesis.narrative` **done** this sprint; `--since` is a CLI flag.)

---

## Carried-over deviations (still true from prior sprints)
- `Finding.lens` stays `string` in the wire contract, narrowed to `Lens` only in the auditor via `Omit`.
- `runShellCommand` retained in the remediator (fully removing it needs `test_command`/`e2e_command` as argv).
- `collectFileCommits` not moved to shared `git.ts` (its `runCommand` injection point is relied on by co-commit tests).
- Token estimates are prefer-bytes / fall-back-to-lines (Phase 2); line-based goldens stay byte-for-byte stable.

## Git state
This sprint's Phase 6 work is committed on `master`. The prior sprint (auditor Phase 2 byte-switch) is in commit `a1b3cce`; Phases 0/1A/remediator-2 are in `23af936`.

## How to verify
```bash
npm install
npm run build -w @audit-tools/shared && npm run build   # build order matters
npm test -w @audit-tools/shared                          # 24
npm test -w packages/audit-code                          # 487
npm test -w packages/remediate-code                      # 360
```
