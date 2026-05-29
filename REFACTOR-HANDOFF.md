# audit-tools refactor — sprint handoff

**Date:** 2026-05-29
**Scope this sprint:** the remaining half of **Phase 2** — the auditor `reviewPackets` byte-switch (token estimates via `size_bytes`). This **completes Phase 2 end-to-end** (the remediator half landed in the prior sprint).
**Status:** committed on `master` (see _Git state_ below).

The frozen build order is: **0 → 1A + `.tmp` fix → 2 → 6 → 5.0 + 5(TS/JS) → 3 → 4 → 5(Py/HTML/CSS) → 7.** Everything through **Phase 2 is now done**. The next pickup is **Phase 6** (synthesis narrative + canonical JSON hand-off).

---

## Verification status (all green)

```
shared          24 tests   pass   (node --test packages/shared/tests/*.test.mjs)
audit-code     477 tests   pass   (node --test, +2 new vs. 475 baseline)
remediate-code 360 tests   pass   (vitest)
```

`npm run build` (shared → both dependents) and `npm run check` are clean in every workspace. The two new tests are the byte-based packet-sizing cases added to [quota-packets.test.mjs](packages/audit-code/tests/quota-packets.test.mjs).

Recommended pre-release gate (not run this sprint, involves packaging smoke): `npm run verify:release` in each package.

---

## Phase 2 — token estimates via `size_bytes` ✅ (now complete)

### Prior sprint — remediator (already shipped)
[plan.ts](packages/remediate-code/src/phases/plan.ts): `countFileLines` → `fileSizeBytes` (`statSync().size`, no read); `estimateGroupTokens` uses shared `estimateTokensFromBytes`.

### This sprint — auditor `reviewPackets` byte-switch
The auditor now estimates review-packet tokens from `size_bytes` (read free from `repo_manifest`, no file reads) instead of from counted lines, and the per-packet budget cap is expressed directly in tokens.

**Design — prefer-bytes, fall back to lines.** A single content-token measure ([reviewPackets.ts](packages/audit-code/src/orchestrator/reviewPackets.ts) `pathContentTokens`) returns `estimateTokensFromBytes(size_bytes)` when a positive byte count is available, otherwise the legacy `lines × ESTIMATED_TOKENS_PER_LINE`. In real runs a `sizeIndex` (from `repo_manifest.files[].size_bytes`) is always present, so estimates and budgeting are byte-driven; manually-built tasks without bytes (tests, paths absent from the manifest) keep the identical line-based math. This kept nearly every golden stable — `DEFAULT_TARGET_PACKET_TOKENS = DEFAULT_TARGET_PACKET_LINES × ESTIMATED_TOKENS_PER_LINE` so the line-fallback thresholds are unchanged.

What changed in [reviewPackets.ts](packages/audit-code/src/orchestrator/reviewPackets.ts):
- New helpers `sizeIndexFromManifest`, `pathContentTokens`, `taskContentTokens`, `fileGroupContentTokens`; `estimateTaskGroupTokens(tasks, sizeIndex?, lineIndex?)` is now byte-aware.
- `BuildReviewPacketOptions` gains `sizeIndex?`; `targetPacketLines` → `targetPacketTokens` (budget is now in tokens). `maxContextTokens` capping is `min(default, maxContextTokens − ESTIMATED_PACKET_PROMPT_TOKENS)` — no more lines round-trip.
- Packet `estimated_tokens`, the chunk/split decisions (`chunkPacketTasks`), and the bounded-cluster-edge size guards (`buildBoundedClusterEdges` and the subsystem/package/module ownership builders + `buildPlanningGraphEdges`) all size by content tokens. `total_lines` / `file_line_counts` remain line-based informational outputs (unchanged).

**Plumbing — `sizeIndex` mirrors `lineIndex`.** Built from the manifest at every packet-building call site (cheap, synchronous, no reads):
- [cli.ts](packages/audit-code/src/cli.ts) `runAuditStep` builds `sizeIndex` and passes it to `advanceAudit`; `AdvanceAuditOptions.sizeIndex` ([advance.ts](packages/audit-code/src/orchestrator/advance.ts)) → `runPlanningExecutor` ([internalExecutors.ts](packages/audit-code/src/orchestrator/internalExecutors.ts), which also derives it from `bundle.repo_manifest` as a fallback) → `buildReviewPackets`/`buildAuditPlanMetrics`.
- `appendSelectiveDeepeningTasks` ([internalExecutors.ts](packages/audit-code/src/orchestrator/internalExecutors.ts)), `buildPendingAuditTasks` + `prepareDispatchArtifacts` ([dispatch.ts](packages/audit-code/src/cli/dispatch.ts)), and the worker-scheduling `estimateTaskGroupTokens` call ([cli.ts](packages/audit-code/src/cli.ts)) all build `sizeIndex` from their local bundle's manifest. The dispatch `oversized_packet` warning (`estimated_tokens > contextBudget`) is now byte-accurate.

### Tests added (Phase 2 auditor)
[quota-packets.test.mjs](packages/audit-code/tests/quota-packets.test.mjs): (1) `estimated_tokens` derives from `size_bytes` when a `sizeIndex` is supplied and falls back to lines without one; (2) a byte-driven budget splits graph-linked files across packets so **no packet's `estimated_tokens` exceeds `maxContextTokens`**, with full task coverage. Stale line-formula comments in the existing maxContextTokens tests were updated to token terms, and the budget assertion now reads `packet.estimated_tokens` directly.

---

## Remaining phases (not started)

Pick up in frozen order. The shared building blocks they need already exist (see parentheticals).

- **Phase 6 — synthesis narrative + canonical JSON hand-off** *(next)*. New obligation `synthesis_narrative_current` downstream of `synthesis_current` ([nextStep.ts](packages/audit-code/src/orchestrator/nextStep.ts), [executors.ts](packages/audit-code/src/orchestrator/executors.ts), staleness DAG in [staleness.ts](packages/audit-code/src/orchestrator/staleness.ts)/[artifactMetadata.ts](packages/audit-code/src/orchestrator/artifactMetadata.ts)/[spec/dependency-map.md](packages/audit-code/spec/dependency-map.md)). Emit canonical `audit-findings.json` (shared `AuditFindingsReport` **already defined** in [types/finding.ts](packages/shared/src/types/finding.ts), with `theme_id`/`themes`/`executive_summary`/`top_risks`); `audit-report.md` becomes a pure render of it. The narrative (themes + exec summary + top risks) is a single cached `FreshSessionProvider` call appended to the JSON; **omit the narrative when no provider exists** and the deterministic report is unchanged. Config `synthesis.narrative` (default on when a provider exists). Input is the deterministic `AuditReportModel` ([synthesis.ts](packages/audit-code/src/reporting/synthesis.ts)).
- **Phase 5.0 + 5(TS/JS) — compiler/parser graph seam.** `src/extractors/analyzers/` with `LanguageAnalyzer { supports; analyze }` + registry. New obligation `graph_enrichment_current` between `structure_artifacts` and `planning_artifacts`; regex floor always emitted, analyzer edges merged higher-confidence-kind-wins. Resolve deps with `resolveAnalyzerDep` (**already built**, [tooling/analyzerDeps.ts](packages/shared/src/tooling/analyzerDeps.ts)) → propose-install as a bounded step persisted to `session-config.json → analyzers.<id>`; unanswered = skip. First analyzer: `typescript` compiler API.
- **Phase 3 — `--since` delta mode.** `advanceAudit({since})`, CLI `--since <ref>`; new `scope.json` + schema; deterministic priority-frontier BFS using `changedFiles` (**already built**, [git.ts](packages/shared/src/git.ts)) + existing degree index (`buildGraphDegreeIndex`/`HIGH_FAN_DEGREE_THRESHOLD` in [reviewPackets.ts](packages/audit-code/src/orchestrator/reviewPackets.ts)). Only in-scope coverage entries go `pending`.
- **Phase 4 — decorator routing + LLM edge-reasoning.** 4A: extend route patterns ([graph.ts](packages/audit-code/src/extractors/graph.ts)) for NestJS/FastAPI/Flask/Angular, emitting existing `RouteEdge` shapes. 4B: optional cached LLM post-pass that only rewrites `reason` on existing low-confidence edges. Config `graph.llm_edge_reasoning` (default off).
- **Phase 5(Py/HTML/CSS) — tree-sitter analyzers.** Python imports/decorators, HTML `<script>/<link>`, CSS `@import`/`url()`. SQL = registry stub only.
- **Phase 7 — remediator prompts, theme hints, outcome capture.** Consume `audit-findings.json` directly; **delete `parseAuditReport`/`isAuditorAuditReport`** ([plan.ts](packages/remediate-code/src/phases/plan.ts)) — keep the free-form LLM extraction path for non-auditor input. Inject `detectRepoConventions(root)` into worker prompts; surface `theme_id`/`suggested_fix_pattern`. Emit `remediation-outcomes.json` from [close.ts](packages/remediate-code/src/phases/close.ts).

### New session-config keys still to add
`analyzers.<id>` (Phase 5), `synthesis.narrative` (Phase 6), `graph.llm_edge_reasoning` (Phase 4). (`observability.run_log` is **done**; `--since` is a CLI flag.)

---

## Decisions & deviations this sprint

- **Prefer-bytes / fall-back-to-lines** rather than a hard byte-only switch. Bytes drive sizing in production (manifest always present); the line estimate stays as the deterministic floor for byte-less tasks. This delivered the feature while keeping the line-based goldens (which never supply a `sizeIndex`) byte-for-byte stable — only the explicit `maxContextTokens` quota tests needed updating.
- **`total_lines` / `file_line_counts` stay line-based.** They are reported line-count outputs (and feed the `large_packet` dispatch warning's line threshold), distinct from the byte-derived token estimate. The auditor still counts lines via `buildLineIndex` for these and for anchor extraction; bytes are purely additive.
- **`sizeIndex` derived at each call site from the manifest**, not threaded as the sole source. It is still added to `AdvanceAuditOptions`/`runPlanningExecutor` to mirror `lineIndex`, but because `size_bytes` is free from `repo_manifest`, the dispatch/selective-deepening/scheduling sites build it locally rather than relying on a single upstream pass.

## Carried-over deviations (still true from prior sprints)
- `Finding.lens` stays `string` in the wire contract, narrowed to `Lens` only in the auditor via `Omit`.
- `runShellCommand` retained in the remediator (fully removing it needs `test_command`/`e2e_command` as argv).
- `collectFileCommits` not moved to shared `git.ts` (its `runCommand` injection point is relied on by co-commit tests).

## Git state
This sprint's auditor Phase 2 work is committed on `master`. Files touched: [reviewPackets.ts](packages/audit-code/src/orchestrator/reviewPackets.ts), [advance.ts](packages/audit-code/src/orchestrator/advance.ts), [internalExecutors.ts](packages/audit-code/src/orchestrator/internalExecutors.ts), [cli.ts](packages/audit-code/src/cli.ts), [cli/dispatch.ts](packages/audit-code/src/cli/dispatch.ts), and [tests/quota-packets.test.mjs](packages/audit-code/tests/quota-packets.test.mjs). The prior sprint (Phase 0 / 1A / remediator Phase 2) is in commit `23af936 Refactor phases 0, 1, and part of 2`.

## How to verify
```bash
npm install
npm run build -w @audit-tools/shared && npm run build   # build order matters
npm test -w @audit-tools/shared                          # 24
npm test -w packages/audit-code                          # 477
npm test -w packages/remediate-code                      # 360
```
