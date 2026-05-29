# audit-tools refactor — sprint handoff

**Date:** 2026-05-29
**Scope this sprint:** Phase 0 (shared foundations), Phase 1A (structured logging + `.tmp` disposition fix), and the **remediator half** of Phase 2 (token estimates via `size_bytes`).
**Status:** All changes are **uncommitted** in the working tree (the sprint did not commit; see _Git state_ below).

The frozen build order is: **0 → 1A + `.tmp` fix → 2 → 6 → 5.0 + 5(TS/JS) → 3 → 4 → 5(Py/HTML/CSS) → 7.** This sprint completed everything through Phase 2 except the auditor `reviewPackets` byte-switch, which is documented as the first remaining task.

---

## Verification status (all green)

```
shared          24 tests   pass   (node --test packages/shared/tests/*.test.mjs)
audit-code     475 tests   pass   (node --test, +2 new vs. 473 baseline)
remediate-code 360 tests   pass   (vitest, +3 new vs. 357 baseline)
```

`npm run build` (shared → both dependents) and `npm run check` are clean in every workspace. Baseline before the sprint was audit 473 / remediate 357; the deltas are the new tests listed per phase below.

Recommended pre-release gate (not run this sprint, involves packaging smoke): `npm run verify:release` in each package.

---

## Phase 0 — shared foundations ✅

Seven new/relocated modules in `@audit-tools/shared`, with both orchestrators migrated onto them and the divergent duplicate copies deleted. **No behavior change except Go/Python test discovery now reaching the remediator** (as the plan intended).

### New shared modules
| File | Exports | Notes |
|---|---|---|
| [tokens.ts](packages/shared/src/tokens.ts) | `estimateTokensFromBytes`, `KNOWN_MODEL_LIMITS`, `lookupModelLimits`, `resolveContextBudget`, `BLOCK_SAFETY_MARGIN`, `BYTES_PER_TOKEN`, `ESTIMATED_TOKENS_PER_LINE`, `DEFAULT_CONTEXT_TOKENS`, `DEFAULT_OUTPUT_TOKENS`, `ModelTokenLimits` | Canonical model-limit table. `quota/limits.ts` now imports `lookupModelLimits` from here (the in-shared duplicate table was removed). |
| [tooling/exec.ts](packages/shared/src/tooling/exec.ts) | `runTracked`, `resolveExecArgv`, `quoteForCmd`, `platformCommand`, `RunTrackedOptions`, `RunTrackedResult` | One Windows `.cmd`/`.bat` wrap + `opentoken wrap` impl; argv-only (`shell:false`). `runTracked` reports the resolved argv it executed. `stdio` is passed through for callers that need it. |
| [tooling/testCommand.ts](packages/shared/src/tooling/testCommand.ts) | `discoverProjectCommands`, `ProjectCommands` | Node (`npm`) → Go → Python fall-through for the test command; e2e/build/lint from npm scripts. Returns argv arrays. |
| [tooling/analyzerDeps.ts](packages/shared/src/tooling/analyzerDeps.ts) | `resolveAnalyzerDep`, `installToCache`, `analyzerCacheRoot`, `parseAnalyzerSpec` | Phase 5 resolver (repo `node_modules` → `~/.audit-tools/analyzer-cache/<pkg>@<ver>` → absent). **Built + unit-tested now, not yet wired** (Phase 5 consumes it). `cacheRoot` is injectable for tests. |
| [git.ts](packages/shared/src/git.ts) | `isGitRepo`, `changedFiles`, `fileCommits`, `stagedAndUntracked` | All run through `runTracked`; degrade to empty/false (never throw). `changedFiles` backs Phase 3 `--since`. |
| [observability/runLog.ts](packages/shared/src/observability/runLog.ts) | `RunLogger`, `RunLogEvent`, `RunLoggerOptions` | Append-only JSONL, atomic per line, no-op when disabled. `RunLogger.disabled()` and an injectable `now` clock. |
| [types/finding.ts](packages/shared/src/types/finding.ts) | `Finding`, `WorkBlock`, `FindingTheme`, `AuditFindingsReport`, `AuditFindingsSummary`, `FindingLocation`, `FindingSeverity`, `FindingConfidence` | **Canonical machine contract.** Includes `theme_id?` (Phase 6) and `affected_files[].hash_at_plan_time?`. |

All re-exported from [index.ts](packages/shared/src/index.ts); new subpath exports (`./tooling/*`, `./observability/*`, `./tokens`, `./git`) added to [package.json](packages/shared/package.json). A `test` script was added to shared (`npm run build && node --test tests/*.test.mjs`).

### Migrations performed
- **`Finding` unified.** Remediator [state/types.ts](packages/remediate-code/src/state/types.ts) now imports + re-exports the shared `Finding` (was a divergent local copy). Auditor [types.ts](packages/audit-code/src/types.ts) narrows it: `interface Finding extends Omit<SharedFinding, "lens"> { lens: Lens }` — keeps its strong `Lens` union while inheriting the shared field set. Auditor [workBlocks.ts](packages/audit-code/src/reporting/workBlocks.ts) re-exports the shared `WorkBlock`.
  - The canonical `Finding.evidence` is **optional** (the auditor may emit findings without it). Two remediator call sites that assumed it was always present were guarded: [dispatch.ts](packages/remediate-code/src/steps/dispatch.ts), [document.ts](packages/remediate-code/src/phases/document.ts), and an assignment in [nextStep.ts](packages/remediate-code/src/steps/nextStep.ts) (`finding.evidence ?? []`).
- **Command exec consolidated.** Remediator [utils/commands.ts](packages/remediate-code/src/utils/commands.ts) re-exports `quoteForCmd`/`platformCommand` from shared and delegates `runCommand` to `runTracked`. Auditor [localCommands.ts](packages/audit-code/src/orchestrator/localCommands.ts) `toSpawnTuple` now calls `resolveExecArgv` (its private `quoteForCmd`/wrap deleted).
  - **Deferred:** the remediator's `runShellCommand` (shell:true) is kept for running stored single-string commands (`test_command`/`e2e_command`) in [close.ts](packages/remediate-code/src/phases/close.ts). The plan's "argv-only, delete runShellCommand" goal needs `RemediationPlan.test_command`/`e2e_command` changed from `string` to `string[]` first (ripples to state types, validation, close.ts). Low-risk but out of this sprint's scope.
- **Test-command discovery.** Auditor `discoverRuntimeValidationCommand` ([runtimeValidation.ts](packages/audit-code/src/orchestrator/runtimeValidation.ts)) now returns `discoverProjectCommands(root).test`. Remediator [plan.ts](packages/remediate-code/src/phases/plan.ts) uses `discoverProjectCommands` (now gets Go/Python test commands and sets `project_type` to `go`/`python` accordingly).
- **Token table/budget.** Remediator [plan.ts](packages/remediate-code/src/phases/plan.ts) dropped its copied `KNOWN_MODEL_LIMITS` and budget math; uses shared `resolveContextBudget`. Kept remediator-specific `ESTIMATED_BLOCK_BASE_TOKENS`/`ESTIMATED_FINDING_OVERHEAD_TOKENS` (still imported by dispatch.ts).
- **Git calls.** Remediator [close.ts](packages/remediate-code/src/phases/close.ts) `collectStagingFiles` uses shared `stagedAndUntracked`. (`collectFileCommits` in plan.ts intentionally still uses the injectable `runCommand` dep so the existing co-commit tests keep their mock injection point.)

### Tests added (Phase 0)
`packages/shared/tests/`: `tokens` (byte→token monotonicity, model lookup, budget), `exec` (win32 wrapping + opentoken, via `platform` override so they run cross-platform), `testCommand` (node/go/python/empty matrix), `analyzerDeps` (repo → version-keyed cache → newest-unpinned → absent), `runLog` (JSONL append + disabled no-op), `git` (in-repo true / temp false + graceful degradation).

---

## Phase 1A — structured logging + `.tmp` fix ✅

### Structured run log
- `observability.run_log` added to `SessionConfig` ([sessionConfig.ts](packages/shared/src/types/sessionConfig.ts)), default `true`.
- **Auditor:** `RunLogger` threaded through [advance.ts](packages/audit-code/src/orchestrator/advance.ts) via `AdvanceAuditOptions.runLogger`. Emits `obligation` → `executor_start` → `executor_end` (+`duration_ms`) → one `artifact_write` per artifact. Constructed in `runAuditStep` ([cli.ts](packages/audit-code/src/cli.ts)) writing to `.audit-artifacts/run.log.jsonl`; enabled flag wired from `sessionConfig.observability?.run_log` at the main call site.
- **Remediator:** `decideNextStep` ([nextStep.ts](packages/remediate-code/src/steps/nextStep.ts)) split into a thin logging wrapper + `decideNextStepInner`. Per invocation it logs the loaded `state`, wraps the triage/close executor calls with start/end+duration, and logs the resulting `step` (+`duration_ms`) — to `.remediation-artifacts/run.log.jsonl`. No-op when disabled.
- Line shape: `{ts, phase, obligation, kind, artifact?, provider?, tokens_est?, duration_ms?, note?}`.

### `.tmp` / vendored-copy disposition fix
- New `isTmpPath` heuristic in [pathPatterns.ts](packages/audit-code/src/extractors/pathPatterns.ts); [disposition.ts](packages/audit-code/src/extractors/disposition.ts) marks any `.tmp/` path `excluded` (stops the self-audit from auditing bundled `.tmp/opentoken`).

### Tests added (Phase 1A)
- Auditor [orchestration.test.mjs](packages/audit-code/tests/orchestration.test.mjs): drives `advanceAudit` with a real `RunLogger` and asserts the obligation sequence (`repo_manifest` → `structure_artifacts`), `executor_start/end` with numeric `duration_ms`, and `artifact_write` for `repo_manifest.json`.
- Auditor [extractors-remediation.test.mjs](packages/audit-code/tests/extractors-remediation.test.mjs): `.tmp/opentoken/*` excluded, real source still included.
- Remediator [next-step.test.ts](packages/remediate-code/tests/next-step.test.ts): run log records `state` + `step` (+duration); disabled config writes no log.

---

## Phase 2 — token estimates via `size_bytes` 🟡 (remediator done, auditor deferred)

### Done — remediator
[plan.ts](packages/remediate-code/src/phases/plan.ts): `countFileLines` (full-file read) → `fileSizeBytes` (`statSync().size`, no read); `estimateGroupTokens` now uses shared `estimateTokensFromBytes(totalBytes)`; `splitBlocksByContextBudget` builds a byte-count map. Test added in [phase-plan.test.ts](packages/remediate-code/tests/phase-plan.test.ts): one block with two findings on ~50KB files splits under a byte-derived budget, with an empty-file control proving the split is size-driven.

### Remaining — auditor `reviewPackets` byte-switch
This is the next task to pick up. [reviewPackets.ts](packages/audit-code/src/orchestrator/reviewPackets.ts) is pervasively line-based and has golden token tests, so it's a multi-step change:
1. Add `sizeIndex?: Record<string, number>` to `BuildReviewPacketOptions`; add a `taskByteCount` analogous to `taskLineCount`.
2. Switch `estimateTaskGroupTokens` to `estimateTokensFromBytes` of the task group's total bytes; reframe `targetPacketLines`/`maxContextTokens` capping in token terms.
3. Plumb a `sizeIndex` built from `repo_manifest.files[].size_bytes` (already present on `FileRecord`) from [cli.ts](packages/audit-code/src/cli.ts) `runAuditStep` → `advanceAudit` (new option) → `runPlanningExecutor` ([internalExecutors.ts](packages/audit-code/src/orchestrator/internalExecutors.ts)) → `buildReviewPackets`. Mirror how `lineIndex` already flows (`buildLineIndex(root, repo_manifest)`).
4. Update golden expectations in [review-packets.test.mjs](packages/audit-code/tests/review-packets.test.mjs) and [quota-packets.test.mjs](packages/audit-code/tests/quota-packets.test.mjs); add an assertion that no packet exceeds `maxContextTokens`.

---

## Remaining phases (not started)

Pick up in frozen order. The shared building blocks they need already exist (see parentheticals).

- **Phase 6 — synthesis narrative + canonical JSON hand-off.** New obligation `synthesis_narrative_current` downstream of `synthesis_current` ([nextStep.ts](packages/audit-code/src/orchestrator/nextStep.ts), [executors.ts](packages/audit-code/src/orchestrator/executors.ts), staleness DAG). Emit canonical `audit-findings.json` (shared `AuditFindingsReport` **already defined**, with `theme_id`/`themes`/`executive_summary`/`top_risks`); `audit-report.md` becomes a pure render of it. Single cached `FreshSessionProvider` call; omit narrative when no provider. Config `synthesis.narrative`.
- **Phase 5.0 + 5(TS/JS) — compiler/parser graph seam.** `src/extractors/analyzers/` with `LanguageAnalyzer { supports; analyze }` + registry. New obligation `graph_enrichment_current` between `structure_artifacts` and `planning_artifacts`; regex floor always emitted, analyzer edges merged higher-confidence-kind-wins. Resolve deps with `resolveAnalyzerDep` (**already built**) → propose-install as a bounded step persisted to `session-config.json → analyzers.<id>`; unanswered = skip. First analyzer: `typescript` compiler API.
- **Phase 3 — `--since` delta mode.** `advanceAudit({since})`, CLI `--since <ref>`; new `scope.json` + schema; deterministic priority-frontier BFS using `changedFiles` (**already built**) + existing degree index. Only in-scope coverage entries go `pending`.
- **Phase 4 — decorator routing + LLM edge-reasoning.** 4A: extend route patterns ([graph.ts](packages/audit-code/src/extractors/graph.ts)) for NestJS/FastAPI/Flask/Angular, emitting existing `RouteEdge` shapes. 4B: optional cached LLM post-pass that only rewrites `reason` on existing low-confidence edges. Config `graph.llm_edge_reasoning` (default off).
- **Phase 5(Py/HTML/CSS) — tree-sitter analyzers.** Python imports/decorators, HTML `<script>/<link>`, CSS `@import`/`url()`. SQL = registry stub only.
- **Phase 7 — remediator prompts, theme hints, outcome capture.** Consume `audit-findings.json` directly; **delete `parseAuditReport`/`isAuditorAuditReport`** ([plan.ts](packages/remediate-code/src/phases/plan.ts)) — keep the free-form LLM extraction path for non-auditor input. Inject `detectRepoConventions(root)` into worker prompts; surface `theme_id`/`suggested_fix_pattern`. Emit `remediation-outcomes.json` from [close.ts](packages/remediate-code/src/phases/close.ts).

### New session-config keys still to add
`analyzers.<id>` (Phase 5), `synthesis.narrative` (Phase 6), `graph.llm_edge_reasoning` (Phase 4). (`observability.run_log` is **done**; `--since` is a CLI flag.)

---

## Decisions & deviations this sprint

- **`Finding.lens` stays `string` in the wire contract**, narrowed to `Lens` only in the auditor via `Omit`. This keeps the auditor's strong typing without forcing `string` everywhere.
- **`runShellCommand` retained** in the remediator (see Phase 0 _Deferred_). Fully removing it requires changing `test_command`/`e2e_command` to argv; deferred to keep this sprint behavior-neutral.
- **`collectFileCommits` not moved to shared `git.ts`** — its `runCommand` injection point is relied on by the co-commit tests. Shared `fileCommits` exists for Phase 3/future use.
- **Auditor Phase 2 deferred** rather than half-implemented, because it touches golden token tests and needs multi-layer `sizeIndex` plumbing (details above).

## Git state
All work is **uncommitted** on `master`. No commit was made (the sprint was not asked to commit). 24 files modified, 6 new files/dirs under `packages/shared/src` + `packages/shared/tests`. Two files — `packages/audit-code/audit-code.mjs` and `packages/remediate-code/remediate-code.mjs` — show as modified in `git status` but have **no content diff** (Windows CRLF normalization only); they can be ignored or `git checkout`-ed. Suggested commit split: one commit for Phase 0 (shared + migrations), one for Phase 1A, one for the remediator Phase 2.

## How to verify
```bash
npm install
npm run build -w @audit-tools/shared && npm run build   # build order matters
npm test -w @audit-tools/shared                          # 24
npm test -w packages/audit-code                          # 475
npm test -w packages/remediate-code                      # 360
```
