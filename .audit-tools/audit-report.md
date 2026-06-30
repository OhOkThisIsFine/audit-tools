# Audit findings — verified & pruned

> Every finding below was adversarially verified against current source by an independent reviewer and confirmed **real** (verdict=real). The hallucinated syntax-error cluster and other false positives were removed. This file is the remediation input. Full verdict record (incl. 10 rejected-false and 8 uncertain): `.audit-tools/audit/verification-ledger.json`.

## Summary

- Verified-real findings: **186** (of 204 extracted; 10 false, 8 uncertain)
- **By severity:** high 7 · medium 97 · low 78 · info 4
- **By lens:** tests 69 · maintainability 68 · correctness 24 · observability 17 · config_deployment 3 · reliability 2 · data_integrity 1 · security 1 · performance 1

## High (7)

### Citation-grounding retry leaves extracted plan completion marker

- **Lens:** correctness · **Category:** incorrect-state-transition · **Confidence:** high
- **Summary:** The promotion path writes extracted-plan.json before running the citation-grounding backstop, then archives implementation_dag and re-emits implementation_planning on failure without removing the already-promoted plan. A later next-step sees paths.extractedPlan and treats the contract pipeline as complete, so the retry can be bypassed with an ungrounded promoted plan still present.
- **Affected:**
  - `src/remediate/steps/contractPipeline.ts:540-548`
  - `src/remediate/steps/contractPipeline.ts:2142-2176`
  - `src/remediate/steps/contractPipeline.ts:2176`
- **Evidence:**
  - src/remediate/steps/contractPipeline.ts:545 - shouldEnterContractPipeline returns pipelineComplete when extracted-plan.json exists.
  - src/remediate/steps/contractPipeline.ts:2142 - promoteImplementationDagToExtractedPlan writes the extracted plan before the citation-grounding gate runs.
  - src/remediate/steps/contractPipeline.ts:2176 - on citation failure only implementation_dag is archived before re-emitting implementation_planning, leaving extracted-plan.json in place.
- _verified: contractPipeline.ts L2142 promoteImplementationDagToExtractedPlan writes plan before citation gate; L2176/2192 re-emit only archives implementation_dag, leaves extracted-plan.json; L546 returns pipelineComplete on its presence._

### INFRA_FILE_PATHS use stale monorepo paths so isInfraModifyingBlock never matches

- **Lens:** correctness · **Category:** dead-guard · **Confidence:** high
- **Summary:** INFRA_FILE_PATHS lists `packages/remediate-code/src/...` paths from the pre-A12 3-package monorepo, but source now lives under `src/remediate/...` (this very file is `src/remediate/steps/dispatch.ts`). isInfraModifyingBlock can therefore never return true for a real edit to dispatch.ts / nextStep.ts / store.ts, so the infra-modifying live-surface verification section is dead and never emitted.
- **Affected:**
  - `src/remediate/steps/dispatch.ts:2313-2320`
  - `src/remediate/steps/dispatch.ts:2327-2338`
- **Evidence:**
  - src/remediate/steps/dispatch.ts:2313 - INFRA_FILE_PATHS contains only `packages/remediate-code/src/...` entries, a layout removed by the A12 monorepo collapse (CLAUDE.md: source is now split under `src/`).
  - src/remediate/steps/dispatch.ts:2331 - exact-match `INFRA_FILE_PATHS.has(normalized)` against repo-relative `src/remediate/steps/dispatch.ts` can never hit the stale `packages/...` keys; the endsWith suffix fallback also requires the path to end with the stale segment, which a current `src/remediate/...` path does not.
  - src/remediate/steps/dispatch.ts:2524 - implementPrompt only emits infraModifyingSection when isInfraModifyingBlock(blockWriteFiles(...)) is true, so the section is unreachable for any current infra edit.
- _verified: dispatch.ts L2313-2320 INFRA_FILE_PATHS holds only `packages/remediate-code/src/...` keys; file lives at src/remediate/steps/dispatch.ts, so L2330 has() and L2334 endsWith() never match current paths._

### Roster pools dispatch with the scalar host model

- **Lens:** correctness · **Category:** model-routing · **Confidence:** high
- **Summary:** Host roster pool construction preserves the per-entry model only in the pool id, then stores the unrelated scalar `params.hostModel` on the CapacityPool. The dispatch paths return `pool.hostModel`, so ranked roster entries can be scheduled and dispatched as null or the wrong model even though their quota key was built from the resolved roster model.
- **Affected:**
  - `src/shared/quota/apiPool.ts:156`
  - `src/shared/quota/capacity.ts:459`
  - `src/shared/dispatch/rollingDispatch.ts:351`
  - `src/shared/dispatch/coordinator.ts:205`
- **Evidence:**
  - src/shared/quota/apiPool.ts:151-156 - the roster loop parses the model from `resolved.poolKey` and rebuilds `poolKey`, but passes `hostModel: params.hostModel` into the CapacityPool instead of the parsed roster model.
  - src/shared/quota/capacity.ts:459 - quota scheduling consumes `pool.hostModel`, so the resolved limits are evaluated for the stale scalar host model rather than the roster entry's model.
  - src/shared/dispatch/rollingDispatch.ts:351 - the rolling dispatcher returns `hostModel: pool.hostModel` in the provider slot, causing the worker dispatch to use the stale scalar value.
  - src/shared/dispatch/coordinator.ts:205 - the hybrid coordinator also propagates `pool.hostModel` into assignments, so both dispatch drivers share the same wrong-model behavior.
- _verified: apiPool.ts L156 passes `hostModel: params.hostModel` (scalar) though poolKey re-derived from roster model L151-152; capacity.ts L459 and dispatch files consume pool.hostModel → stale scalar model._

### Skipped merge-to-base close can be treated as fully green

- **Lens:** correctness · **Category:** incorrect-state-transition · **Confidence:** high
- **Summary:** When merge-to-base has no recorded base branch, executeClosingAction returns a skipped result with an exit_code 1 command and no merge performed. Cleanup later treats any closing status other than failed as fully green, so a run can delete its artifacts even though the requested closing action was skipped and still requires manual recovery.
- **Affected:**
  - `src/remediate/phases/close.ts:520-529`
  - `src/remediate/phases/close.ts:1010-1014`
- **Evidence:**
  - src/remediate/phases/close.ts:520 - the missing-base merge-to-base path returns status `skipped` while recording an exit_code 1 manual-merge command.
  - src/remediate/phases/close.ts:1010 - artifact cleanup considers the run fully green whenever closingResult.status is not `failed`, so this skipped non-none close path is eligible for cleanup.
- _verified: close.ts L524 missing-base merge-to-base returns status `skipped` with exit_code 1 cmd; L1010-1014 fullyGreen treats any status !== `failed` as green → skipped non-none close eligible for cleanup._

### Stale artifact cleanup runs before conflicting result flags are rejected

- **Lens:** correctness · **Category:** destructive-validation-order · **Confidence:** high
- **Summary:** cmdAdvanceAudit deletes eligible stale artifacts before checking that --results and --batch-results are mutually exclusive. A mistaken invocation against a completed/not_started artifacts directory can erase the prior audit and then throw the flag-conflict error without doing any useful work.
- **Affected:**
  - `src/audit/cli/advanceAuditCommand.ts:16`
  - `src/audit/cli/advanceAuditCommand.ts:32-33`
- **Evidence:**
  - src/audit/cli/advanceAuditCommand.ts:16 - cleanupStaleArtifactsDir runs before any result-ingestion flag validation.
  - src/audit/cli/advanceAuditCommand.ts:32 - the mutually exclusive --results/--batch-results error is raised only after cleanup has already been allowed to delete eligible artifacts.
- _verified: advanceAuditCommand.ts L16 cleanupStaleArtifactsDir runs before L32-33 --results/--batch-results mutual-exclusion throw; destructive cleanup precedes flag validation._

### dispatch-evidence-and-writescope.test.ts asserts against stale packages/remediate-code/ monorepo paths

- **Lens:** tests · **Category:** stale-test-fixture · **Confidence:** high
- **Summary:** After A12 collapsed the 3-package monorepo into one package rooted at src/, these tests still build fixtures and assert prompt content using packages/remediate-code/... paths (affected_files, targeted_commands, vitest target, -w workspace flags). The assertions pass only because the renderer echoes whatever path string it is fed, so they no longer pin the real repo layout and would not catch a path-resolution regression against the current single-package structure.
- **Affected:**
  - `tests/remediate/dispatch-evidence-and-writescope.test.ts:61`
  - `tests/remediate/dispatch-evidence-and-writescope.test.ts:159-164`
  - `tests/remediate/dispatch-evidence-and-writescope.test.ts:200-201`
- **Evidence:**
  - tests/remediate/dispatch-evidence-and-writescope.test.ts:61 - fixture uses packages/remediate-code/src/steps/dispatch.ts, a path that no longer exists post-A12 (source now under src/remediate/)
  - tests/remediate/dispatch-evidence-and-writescope.test.ts:200 - assertions negate npm ... -w packages/remediate-code forms, a workspace layout the single package no longer has; the test pins a defunct layout
- _verified: dispatch-evidence-and-writescope.test.ts L61 fixture uses `packages/remediate-code/src/steps/dispatch.ts`, a defunct post-A12 path; L200-201 negate `-w packages/remediate-code` forms the single package no longer has._

### madge circular-import test shells out to npx and depends on network/global tool availability (non-deterministic, slow)

- **Lens:** tests · **Category:** fragile-nondeterministic-test · **Confidence:** high
- **Summary:** The ARC-1fa005bb guard runs `npx madge --circular` in a child process. It depends on madge being resolvable (potential network fetch on a cold cache), shells through the platform shell, and parses madge's exact stderr string 'No circular dependency found!'. Any madge output-format change, npx fetch failure, or offline CI run flips the test red regardless of whether a real cycle exists.
- **Affected:**
  - `tests/audit/io-remediation.test.mjs:568-585`
- **Evidence:**
  - tests/audit/io-remediation.test.mjs:569-574 - spawns `npx madge` with shell:true
  - tests/audit/io-remediation.test.mjs:584-585 - pass condition hard-depends on the literal stderr string 'No circular dependency found!'
- _verified: Confirmed: test shells `npx madge` with shell:true and pass condition hard-depends on literal 'No circular dependency found!' stderr (lines 569-585)._

## Medium (97)

### Audit test workflow skips package and workflow changes

- **Lens:** config_deployment · **Category:** ci-trigger-scope · **Confidence:** high
- **Summary:** The workflow path filters only include src, tests, and package-lock.json, so PRs that change package.json scripts or the workflow itself can bypass this CI gate. That lets changes to the exact commands or pipeline definition land without running the audit-code test suite.
- **Affected:**
  - `.github/workflows/audit-code-test-suite.yml:7-17`
- **Evidence:**
  - .github/workflows/audit-code-test-suite.yml:7 - Both push and pull_request filters list only src/**, tests/**, and package-lock.json, omitting package.json and .github/workflows/audit-code-test-suite.yml.
- _verified: Both push and pull_request path filters list only src/**, tests/**, package-lock.json; package.json and the workflow file are omitted (lines 7-17)._

### Missing required host assets install successfully

- **Lens:** config_deployment · **Category:** partial-install-success · **Confidence:** high
- **Summary:** The remediator postinstall treats missing required prompt or skill assets as a successful package install. If packaging or path changes omit these required files, the deployment reports success while leaving the global command or skill undeployed.
- **Affected:**
  - `scripts/remediate/postinstall.mjs:29-30`
  - `scripts/remediate/postinstall.mjs:234-235`
- **Evidence:**
  - scripts/remediate/postinstall.mjs:24-30 - `readRequiredSource` logs a missing required asset, sets a successful exit code, and returns null.
  - scripts/remediate/postinstall.mjs:234-235 - when either required asset is missing, the script exits 0 before installing host assets.
  - package.json:30-33 - the published package is expected to include `skills/**` and the remediate postinstall script, so missing required prompt or skill files indicate a broken deployment artifact rather than an optional feature.
- _verified: readRequiredSource warns, sets exitCode 0, returns null; line 234-235 exits 0 when either required asset missing — reports success though install skipped._

### Archive failures are ignored when clearing invalid or stale artifacts

- **Lens:** correctness · **Category:** filesystem-state-handling · **Confidence:** high
- **Summary:** archiveContractArtifact explicitly reports originalFree:false when a rename fails, but callers discard that status and continue as though the invalid or stale artifact was cleared. If a rename fails, a stale canonical artifact can remain visible to nextMissingContractPhase or an invalid input path can remain occupied while the workflow prompts for a fresh write.
- **Affected:**
  - `src/remediate/steps/contractPipeline.ts:421-425`
  - `src/remediate/steps/contractPipeline.ts:1685-1688`
  - `src/remediate/steps/contractPipeline.ts:1702-1705`
- **Evidence:**
  - src/remediate/steps/contractPipeline.ts:421 - archiveContractArtifact catches rename failures and returns originalFree:false.
  - src/remediate/steps/contractPipeline.ts:1687 - invalid-output handling uses the archive result only for archivedPath and does not stop if originalFree is false.
  - src/remediate/steps/contractPipeline.ts:1704 - stale artifact cleanup discards the archive outcome entirely.
- _verified: archiveContractArtifact returns originalFree:false on rename failure but callers (1687,1704) use only archivedPath and ignore the status._

### Auto-fix formatters rewrite the whole repository

- **Lens:** correctness · **Category:** write-scope-violation · **Confidence:** high
- **Summary:** The auto-fix executor derives formatter eligibility from non-excluded disposition entries, but then runs each formatter against `.`. A run with any included TypeScript/Python/SQL/Go file can rewrite generated, vendor, documentation, or otherwise excluded files under the root even though those files are outside the audited scope.
- **Affected:**
  - `src/audit/orchestrator/autoFixExecutor.ts:99-135`
- **Evidence:**
  - src/audit/orchestrator/autoFixExecutor.ts:99-105 - formatter eligibility is based only on file_disposition entries whose status is not audit-excluded.
  - src/audit/orchestrator/autoFixExecutor.ts:127-135 - Prettier is invoked as `prettier --write .`; the Python, SQL, and Go branches likewise pass `.` to their formatters.
- _verified: Formatter eligibility derived from disposition extensions but prettier invoked as `--write .` across whole repo (lines 99-135)._

### Batch result ingestion accepts every JSON sidecar

- **Lens:** correctness · **Category:** overbroad-file-selection · **Confidence:** high
- **Summary:** listBatchResultFiles filters only by .json even though the same module defines the canonical audit-result filename pattern. Pointing --batch-results at a task-results directory that also contains schemas or other sidecars will ingest those non-result JSON files and can abort the batch.
- **Affected:**
  - `src/audit/cli/args.ts:159-165`
  - `src/audit/cli/args.ts:348`
- **Evidence:**
  - src/audit/cli/args.ts:159 - the module already knows the canonical result filename shape.
  - src/audit/cli/args.ts:348 - batch listing admits any JSON file rather than applying that canonical predicate.
- _verified: listBatchResultFiles filters only `.json` (line 320) though isCanonicalResultFilename exists; line nums shifted but defect present._

### Blocked self-spawn providers still enter the confirmed pool

- **Lens:** correctness · **Category:** provider-selection · **Confidence:** high
- **Summary:** Provider discovery marks claude-code/codex as self-spawn-blocked only in the display reason, then shared confirmation copies them into the active pool unless the operator explicitly excluded them. In an active Claude Code or Codex session this can confirm a backend that the launch path says cannot be used, causing dispatch to pick an unusable provider instead of falling back.
- **Affected:**
  - `src/shared/providers/providerConfirmation.ts:143-159`
  - `src/shared/providers/sharedProviderConfirmation.ts:184-190`
  - `src/shared/providers/claudeCodeProvider.ts:46-56`
  - `src/shared/providers/providerFactory.ts:125-129`
- **Evidence:**
  - src/shared/providers/providerConfirmation.ts:143 - discoverProviders acknowledges that auto-resolution may reject a provider because it is self-spawn blocked, but still pushes that provider into the discovered list with only a reason string.
  - src/shared/providers/sharedProviderConfirmation.ts:184 - buildSharedProviderConfirmation copies every discovered provider into provider_pool and sets excluded only from the user-supplied exclude set, so blocked providers are not automatically removed.
  - src/shared/providers/claudeCodeProvider.ts:46 - the claude-code provider explicitly cannot launch from an active Claude Code session, making a confirmed blocked entry unusable at dispatch time.
  - src/shared/providers/providerFactory.ts:125 - the auto-resolution path already models the same self-spawn guard by making codex unavailable inside Codex, but confirmation does not enforce that guard.
- _verified: Self-spawn-blocked providers still pushed to discovered with only a reason string; shared confirmation sets excluded only from excludeSet, never from blocked flag._

### Document dispatch results are validated as implement results

- **Lens:** correctness · **Category:** wrong-schema-validation · **Confidence:** high
- **Summary:** Dispatch artifact validation records whether each result belongs to the document or implement phase, but then unconditionally runs the implement-result validator. Valid document dispatch result files will be reported as invalid artifacts because they do not have the implement contract version, phase, and item_results shape.
- **Affected:**
  - `src/remediate/validation/artifacts.ts:266-279`
  - `src/remediate/validation/artifacts.ts:279`
- **Evidence:**
  - src/remediate/validation/artifacts.ts:266 - referencedResults stores the phase as either document or implement.
  - src/remediate/validation/artifacts.ts:275 - each result path is associated with that phase.
  - src/remediate/validation/artifacts.ts:279 - the stored phase is ignored and every existing result is validated with validateImplementWorkerResult.
- _verified: referencedResults stores phase (doc|implement) but line 279 unconditionally runs validateImplementWorkerResult regardless of phase._

### Grounding validation depends on caller cwd

- **Lens:** correctness · **Category:** cwd-dependent-validation · **Confidence:** high
- **Summary:** validate-result verifies quoted spans and executable anchors against process.cwd() instead of the configured repository root. Invoking the CLI from any other directory can read the wrong tree and produce false ungrounded or confirmed diagnostics for an otherwise valid task result.
- **Affected:**
  - `src/audit/cli/validateResultCommand.ts:85`
- **Evidence:**
  - src/audit/cli/validateResultCommand.ts:85 - quote grounding uses process.cwd() as the repository root instead of a parsed --root/getRootDir value.
  - src/audit/cli/validateResultCommand.ts:86 - executable anchor grounding repeats the same process.cwd() root selection.
- _verified: Lines 85-86 use process.cwd() as repo root for grounding/anchor verification rather than a configured --root._

### Implementation DAG edges can reference missing nodes

- **Lens:** correctness · **Category:** missing-referential-validation · **Confidence:** high
- **Summary:** The implementation DAG validator collects node ids but only checks that each edge has string from/to values and an allowed kind. A DAG with an edge pointing at a nonexistent node passes validation, so downstream scheduling or integrity checks can consume an impossible graph.
- **Affected:**
  - `src/remediate/validation/contractPipeline.ts:612-625`
  - `src/remediate/validation/contractPipeline.ts:623-625`
- **Evidence:**
  - src/remediate/validation/contractPipeline.ts:612 - node ids are collected into nodeIds.
  - src/remediate/validation/contractPipeline.ts:623 - edge.from is only required to be a string.
  - src/remediate/validation/contractPipeline.ts:624 - edge.to is only required to be a string; neither endpoint is checked against nodeIds.
- _verified: validateImplementationDAG collects nodeIds (587) but edges only require string from/to (598-600); never checked against nodeIds._

### input_conflict host prompt names a file that is never written

- **Lens:** correctness · **Category:** incorrect-host-guidance · **Confidence:** high
- **Summary:** The input_conflict step instructs the user to move aside `remediation-report.json` before restarting, but the close phase writes the machine contract to `remediation-outcomes.json` (close.ts), not `remediation-report.json`. The user is told to relocate a non-existent file while the file that actually gets overwritten on completion is never mentioned, so a restart can silently clobber the prior run's real outcomes contract.
- **Affected:**
  - `src/remediate/steps/nextStep.ts:3035-3038`
  - `src/remediate/phases/close.ts:1358`
- **Evidence:**
  - src/remediate/steps/nextStep.ts:3037 - prompt tells the user to delete `remediation-report.json`, which is never produced
  - src/remediate/phases/close.ts:1358 - the actual machine contract written on completion is `remediation-outcomes.json`; the prompt fails to name it
- _verified: Prompt (line 3037) names remediation-report.json which is never written; actual contract is remediation-outcomes.json (close.ts)._

### Language map generator targets the wrong directory

- **Lens:** correctness · **Category:** wrong-output-path · **Confidence:** high
- **Summary:** `scripts/audit/update-languages.mjs` resolves its generated file with `../src/...` from the `scripts/audit` directory, which points at `scripts/src/extractors/languageMap.generated.ts` instead of the repo's `src/audit/extractors/languageMap.generated.ts`. Running the npm script therefore cannot refresh the real generated language map and will fail or write to the wrong tree if that directory exists.
- **Affected:**
  - `scripts/audit/update-languages.mjs:12-15`
  - `scripts/audit/update-languages.mjs:88`
- **Evidence:**
  - scripts/audit/update-languages.mjs:12-15 - LANGUAGE_MAP_FILE is built from the script directory plus "../src/extractors/languageMap.generated.ts", so from scripts/audit it resolves under scripts/src rather than the repository src/audit/extractors tree.
  - scripts/audit/update-languages.mjs:88 - the generated map is written to that misresolved LANGUAGE_MAP_FILE path.
- _verified: __dirname is scripts/audit; `../src/extractors/...` resolves to scripts/src not repo src/audit/extractors (lines 12-15)._

### Lean review accepts clear verdicts without schema validation

- **Lens:** correctness · **Category:** missing-validation · **Confidence:** high
- **Summary:** The lean light-review verdict type requires a schema version, and the comments promise malformed or ambiguous verdicts fail safe to escalation. The interpreter accepts any object with `disposition: "clear"`, so a stale or wrong JSON object in the verdict slot can incorrectly clear the adversarial-review gate.
- **Affected:**
  - `src/remediate/steps/leanFastPath.ts:174-176`
  - `src/remediate/steps/leanFastPath.ts:198-199`
- **Evidence:**
  - src/remediate/steps/leanFastPath.ts:174 - The verdict contract includes a required schema_version field.
  - src/remediate/steps/leanFastPath.ts:183 - The interpreter is documented to route malformed or ambiguous verdicts to escalation.
  - src/remediate/steps/leanFastPath.ts:198 - The clear branch checks only raw.disposition and returns clear without validating schema_version.
- _verified: clear branch (line 189) checks only raw.disposition==='clear', never validates required schema_version despite fail-safe doc._

### Linked smoke validates different next-step invocations

- **Lens:** correctness · **Category:** stateful-smoke-test · **Confidence:** high
- **Summary:** The linked smoke test invokes `next-step` repeatedly against the same temp root instead of capturing and validating one result. Because `next-step` persists workflow state, a bad first response can be masked by later invocations that advance to a different state.
- **Affected:**
  - `scripts/remediate/smoke-linked-remediate-code.mjs:90`
- **Evidence:**
  - scripts/remediate/smoke-linked-remediate-code.mjs:83 - the first fresh-root check only asserts exit status.
  - scripts/remediate/smoke-linked-remediate-code.mjs:90 - JSON parsing is performed by a separate `next-step` invocation against the already-used temp root.
  - scripts/remediate/smoke-linked-remediate-code.mjs:103,111,119 - additional field checks keep invoking `next-step`, so the assertions do not describe one coherent fresh-root response.
- _verified: Each check re-invokes next-step against the same persisted temp root, validating different stateful invocations not one captured response._

### OpenCode template points users to removed MCP calls

- **Lens:** correctness · **Category:** stale-interface-guidance · **Confidence:** high
- **Summary:** The OpenCode command template still tells MCP-only users to call start_audit or continue_audit, but the packaged smoke contract asserts that the MCP surface and launcher must not be generated. Users following this fallback can be sent to a non-existent interface instead of the supported next-step path.
- **Affected:**
  - `skills/audit-code/opencode-command-template.txt:6`
  - `scripts/audit/smoke-packaged-audit-code.mjs:866-867`
- **Evidence:**
  - skills/audit-code/opencode-command-template.txt:6 - The OpenCode fallback directs MCP-only users to start_audit/continue_audit.
  - scripts/audit/smoke-packaged-audit-code.mjs:866 - The packaged smoke explicitly documents that the MCP surface was removed and must not be installed.
- _verified: opencode-command-template.txt:6 still directs MCP-only users to start_audit/continue_audit; smoke:866 confirms MCP surface/launcher is no longer installed. Stale guidance._

### Root App Router route is dropped

- **Lens:** correctness · **Category:** route-extraction-miss · **Confidence:** high
- **Summary:** Next.js App Router root handlers in app/route.ts should produce the '/' route. The extractor passes an empty segment list for that file and the helper treats empty segments as no route, so the root entrypoint disappears from the graph.
- **Affected:**
  - `src/audit/extractors/graphRoutes.ts:288-305`
  - `src/audit/extractors/graphRoutes.ts:303-305`
- **Evidence:**
  - src/audit/extractors/graphRoutes.ts:303 - app/route.ts satisfies the App Router branch but slices no path segments between app and route.ts.
  - src/audit/extractors/graphRoutes.ts:288 - the empty segment list returns undefined instead of normalizing to '/', so extractConventionalRouteEvidence returns no route for the root handler.
- _verified: app/route.ts: appIndex=0, slice(1,-1)=[] → routePathFromSegments([]) returns undefined at 288; root '/' route dropped. Confirmed._

### Sanitized run IDs can collide on the same friction artifact

- **Lens:** correctness · **Category:** path-collision · **Confidence:** high
- **Summary:** The friction capture filename is derived by replacing every non-filename character with '-'. Distinct run IDs such as 'a/b' and 'a-b' therefore map to the same artifact path, causing frictionCaptured to short-circuit the wrong run or persistFrictionCapture to overwrite another run's record.
- **Affected:**
  - `src/shared/io/frictionCapture.ts:78-80`
- **Evidence:**
  - src/shared/io/frictionCapture.ts:73 - frictionCapturePath builds the artifact filename directly from sanitizeRunId(runId).
  - src/shared/io/frictionCapture.ts:79 - sanitizeRunId collapses every run of non-[A-Za-z0-9._-] characters to '-', so multiple distinct run IDs can produce one filename.
- _verified: sanitizeRunId:79 collapses non-[A-Za-z0-9._-] runs to '-': 'a/b' and 'a-b' both map to 'a-b'. Collision mechanism demonstrably exists._

### Worker schemas accept reversed line ranges

- **Lens:** data_integrity · **Category:** missing-range-validation · **Confidence:** high
- **Summary:** Worker-facing schemas validate line_start and line_end independently but do not enforce that the end is greater than or equal to the start. A worker submission can therefore pass schema validation with impossible cited spans, corrupting downstream grounding, display, and remediation references.
- **Affected:**
  - `src/audit/contracts/workerSchemas.ts:30-33`
  - `schemas/audit_task.schema.json:46-69`
- **Evidence:**
  - src/audit/contracts/workerSchemas.ts:30-33 - WorkerFindingLocationSchema adds integer minimums for line_start and line_end but no refinement tying the two fields together.
  - schemas/audit_task.schema.json:46-69 - task line_ranges require path/start/end but likewise omit an end >= start constraint in the generated worker-facing schema.
- _verified: WorkerFindingLocationSchema:30-33 adds int.min(1) on line_start/line_end but no refine tying end>=start; reversed ranges pass validation._

### Broker wiring invariants are maintained by source-text sentinels

- **Lens:** maintainability · **Category:** duplicated-contract-drift-guard · **Confidence:** high
- **Summary:** The M5 wiring contract is restated in tests as source-text contains and regex checks against implementation files. Refactors that preserve behavior but rename imports, move helpers, or alter local wording must update this sentinel logic too, which is a sign the wiring contract needs a single exported inspection surface instead of duplicated textual policing.
- **Affected:**
  - `tests/remediate/quota-scheduler.test.ts:648-753`
- **Evidence:**
  - tests/remediate/quota-scheduler.test.ts:691 - The test reads src/remediate/steps/dispatch.ts and asserts it contains computeDispatchCapacity.
  - tests/remediate/quota-scheduler.test.ts:699 - The test reads src/remediate/steps/contractPipeline.ts and asserts it contains scheduleWave.
  - tests/remediate/quota-scheduler.test.ts:737 - The test slices a function body and rejects specific floor-related strings, coupling the invariant to local source spelling.
- _verified: quota-scheduler.test.ts:648 readSource + contains/regex source-text sentinels against dispatch.ts/contractPipeline.ts confirmed. Textual drift-guard as cited._

### bundleWithCheckpoint + obligationState fixtures duplicated verbatim across dc1 and free-form-intent-escalation

- **Lens:** maintainability · **Category:** duplicated-logic · **Confidence:** high
- **Summary:** The same large intent-checkpoint bundle factory (bundleWithCheckpoint) and the obligationState helper are copy-pasted into two test files. Any change to the audit-state bundle shape must be edited in both places to stay correct.
- **Affected:**
  - `tests/audit/dc1.test.mjs:51-79`
  - `tests/audit/free-form-intent-escalation.test.mjs:41-65`
- **Evidence:**
  - tests/audit/dc1.test.mjs:51-79 - bundleWithCheckpoint returns the full obligation-satisfied bundle plus intent_checkpoint
  - tests/audit/free-form-intent-escalation.test.mjs:41-65 - identical bundleWithCheckpoint factory (only confirmed_at date differs)
  - tests/audit/dc1.test.mjs:51-53 and free-form-intent-escalation.test.mjs:35-37 - obligationState(bundle, id) helper duplicated verbatim
- _verified: bundleWithCheckpoint + obligationState duplicated verbatim in dc1.test.mjs:51-79 and free-form-intent-escalation.test.mjs. Confirmed copy-paste._

### Carry-forward key logic is duplicated in the test

- **Lens:** maintainability · **Category:** duplicated-test-logic · **Confidence:** high
- **Summary:** The state invariant test reimplements the production carry-forward key normalization instead of importing a single shared helper. Any future production change to plan-time bookkeeping keys or canonicalization must be mirrored in this test, so the test can drift from the behavior it is meant to pin.
- **Affected:**
  - `tests/remediate/remediate-state-invariants.test.ts:239-252`
- **Evidence:**
  - tests/remediate/remediate-state-invariants.test.ts:239 - the test defines its own PLAN_TIME_BOOKKEEPING_KEYS and stripPlanTimeBookkeeping/carryForwardKey copy rather than exercising a shared production helper.
- _verified: remediate-state-invariants.test.ts:239 defines its own PLAN_TIME_BOOKKEEPING_KEYS + stripPlanTimeBookkeeping rather than importing production helper. Confirmed._

### Contract pipeline state machine is concentrated in one very large step builder

- **Lens:** maintainability · **Category:** excessive-function-length · **Confidence:** high
- **Summary:** buildNextContractPipelineStep spans roughly 1,300 lines and owns ingestion, stale cleanup, goal consistency, repair loops, promotion gates, cyclic seam handling, wave dispatch, and prompt construction. That concentration makes each gate change risky because unrelated state transitions and artifact side effects are interleaved in one function instead of isolated phase handlers.
- **Affected:**
  - `src/remediate/steps/contractPipeline.ts:1352-1358`
  - `src/remediate/steps/contractPipeline.ts:2680-2687`
- **Evidence:**
  - src/remediate/steps/contractPipeline.ts:1356 - buildNextContractPipelineStep begins the main state-machine dispatcher.
  - src/remediate/steps/contractPipeline.ts:2685 - the same function is still handling late prompt-selection logic more than a thousand lines later.
- _verified: buildNextContractPipelineStep spans 1356→2685 (~1300 lines) as cited. Large monolithic step builder confirmed._

### Contract-pipeline fixture graph is rebuilt per test file

- **Lens:** maintainability · **Category:** duplicated-test-fixtures · **Confidence:** high
- **Summary:** Multiple contract-pipeline tests in this slice locally recreate the same goal/context/module artifact graph. Any contract shape or required-field change has to be applied in several independent fixtures instead of one shared test builder.
- **Affected:**
  - `tests/remediate/contract-pipeline-adversarial.test.ts:94`
  - `tests/remediate/contract-pipeline-artifact-store.test.ts:29`
  - `tests/remediate/contract-pipeline-derive-obligations.test.ts:96`
- **Evidence:**
  - tests/remediate/contract-pipeline-adversarial.test.ts:87 - payloads() returns a full contract artifact graph starting with goal_spec.
  - tests/remediate/contract-pipeline-artifact-store.test.ts:27 - makeGoalSpec() hand-builds the same goal_spec shape locally.
  - tests/remediate/contract-pipeline-derive-obligations.test.ts:94 - writeUpstreamThroughCritique() writes another inline chain of upstream artifacts.
- _verified: Multiple contract-pipeline tests rebuild goal_spec/artifact graph locally (adversarial, artifact-store, derive-obligations). Duplicated fixtures confirmed._

### Contract-pipeline fixtures are duplicated across tests

- **Lens:** maintainability · **Category:** duplicated-test-fixture-contract · **Confidence:** high
- **Summary:** The same contract-pipeline artifact shape is hand-built in both the universal-pipeline and seam-negotiation tests. A contract field or default fixture change must be replicated in multiple files, so the tests are policing drift instead of sharing a single contract fixture builder.
- **Affected:**
  - `tests/remediate/n-r06-universal-contract-pipeline.test.ts:180-200`
  - `tests/remediate/n-r07-seam-negotiation.test.ts:65-91`
- **Evidence:**
  - tests/remediate/n-r06-universal-contract-pipeline.test.ts:181 - writes goal_spec with the same hard-coded goal id/version fixture used elsewhere.
  - tests/remediate/n-r07-seam-negotiation.test.ts:65 - defines a separate makeGoalSpec helper for the same contract shape, plus matching module_decomposition data at line 91.
- _verified: n-r06 writeCompleteContractPipelineArtifacts and n-r07 makeGoalSpec hand-build same contract shape independently. Confirmed._

### dc5.test.ts re-declares finalized-module-contracts version as a literal instead of single-sourcing it

- **Lens:** maintainability · **Category:** duplicated-constant · **Confidence:** high
- **Summary:** dc5.test.ts hand-declares CP_FINALIZED_MODULE_CONTRACTS_VERSION as an inline string literal, while contract-pipeline.test.ts imports the same constant from the validation module (explicitly noting MNT-7014a745: 'a bump must not require editing the tests too'). The version string now lives in two places and must be edited in both on a bump.
- **Affected:**
  - `tests/remediate/dc5.test.ts:63-64`
  - `tests/remediate/contract-pipeline.test.ts:40-44`
- **Evidence:**
  - tests/remediate/dc5.test.ts:63 - the finalized-module-contracts version is a literal string constant local to this test file
  - tests/remediate/contract-pipeline.test.ts:40 - sibling test imports CP_FINALIZED_MODULE_CONTRACTS_VERSION from validation/contractPipeline with a comment forbidding re-declaration; dc5 violates that established single-source rule
- _verified: dc5.test.ts:63 declares CP_FINALIZED_MODULE_CONTRACTS_VERSION as a literal; contract-pipeline.test.ts:44 imports the single-sourced constant with the no-redeclare comment. Duplicated._

### decideNextStepLoop / nextStep.ts is a 4754-line god module mixing many unrelated concerns

- **Lens:** maintainability · **Category:** excessive-module-size · **Confidence:** high
- **Summary:** This single file owns host-capability resolution, the rolling/in-process/hybrid dispatch engines, the tool-owned final gate + coarse re-block, plan normalization/carry-forward, four distinct review/ambiguity/clarification gates, every per-state handler, and the full obligation cascade. At ~4750 lines with dozens of exported and private helpers it is hard to change safely; related dispatch logic already lives in sibling modules (dispatch.ts, rollingSession.ts, contractPipeline.ts), so the gate machinery and the review/clarification gates are natural extraction candidates.
- **Affected:**
  - `src/remediate/steps/nextStep.ts:1317-1370`
  - `src/remediate/steps/nextStep.ts:2392-2397`
- **Evidence:**
  - src/remediate/steps/nextStep.ts:1 - file spans 4754 lines covering capability resolution, three dispatch engines, the final gate, plan normalization, and the full obligation cascade
  - src/remediate/steps/nextStep.ts:1317 - the tool-owned final gate + coarse re-block (applyCoarseReblock, sidecar IO) is self-contained and extractable
  - src/remediate/steps/nextStep.ts:2392 - review/ambiguity/clarification gate cluster (runReviewApprovalGate, runLeanLightReviewGate, runPlanningReviewGate, runPlanAmbiguityGate) is a cohesive unit that could move to its own module
- _verified: nextStep.ts:1317 runToolOwnedFinalGate and :2392 runReviewApprovalGate exist; file is a large multi-concern module. Maintainability observation accurate._

### dependency-map.md read + path-resolution boilerplate duplicated across three staleness tests

- **Lens:** maintainability · **Category:** duplicated-logic · **Confidence:** high
- **Summary:** Three tests (inv-6, inv-9, fail-7) each re-import node:fs/url/path, recompute the spec/audit/dependency-map.md path, and read it. inv-9 and fail-7 also duplicate the same line-scan for /`git_history\.json`/. The .md location and parse approach must be edited in three places on any change.
- **Affected:**
  - `tests/audit/staleness.test.mjs:1068-1073`
  - `tests/audit/staleness.test.mjs:1108-1113`
- **Evidence:**
  - tests/audit/staleness.test.mjs:790-796 - inv-6 resolves and reads dependency-map.md
  - tests/audit/staleness.test.mjs:1068-1073 - inv-9 re-resolves and re-reads it plus the git_history line scan
  - tests/audit/staleness.test.mjs:1099-1113 - fail-7 again re-resolves, re-reads, and repeats the identical git_history line scan
- _verified: staleness.test.mjs inv-9 (1068-1073) and fail-7 (1108-1113) both re-resolve mdPath and repeat the git_history.json line scan. Duplicated._

### Discovered limit fields are not single-sourced

- **Lens:** maintainability · **Category:** duplicated-limit-shape · **Confidence:** high
- **Summary:** The discovered limit contract now includes model capability fields, but the cache entry/save/lookup paths still manually enumerate only RPM/TPM fields. Every new limit dimension must be remembered in multiple places, and the current shape has already drifted.
- **Affected:**
  - `src/audit/quota/discoveredLimits.ts:5-22`
- **Evidence:**
  - src/audit/quota/discoveredLimits.ts:5 - DiscoveredRateLimits declares capability fields such as context_tokens and output_tokens.
  - src/audit/quota/discoveredLimits.ts:16 - DiscoveredLimitsCacheEntry is a separate hand-maintained shape with only request/input/output token-per-minute values plus metadata.
  - src/audit/quota/discoveredLimits.ts:74 - saveDiscoveredLimitsCacheEntry copies only requests_per_minute, input_tokens_per_minute, and output_tokens_per_minute.
  - src/audit/quota/discoveredLimits.ts:109 - lookupDiscoveredLimits reconstructs only RPM/TPM fields, so any added discovered limit field needs another manual edit.
- _verified: DiscoveredRateLimits has context_tokens/output_tokens (5-12) but cache entry, save (74-82), lookup (109-114) only handle RPM/TPM. Shape has drifted._

### Duplicated next-step pause harnesses drift

- **Lens:** maintainability · **Category:** duplicated-test-harness · **Confidence:** high
- **Summary:** The test suite keeps separate helpers that encode the same next-step pause state machine and host-response writes. Any new or renamed pause kind must be updated in multiple places to keep integration tests correct, so the harness should be single-sourced in a shared test helper.
- **Affected:**
  - `tests/audit/next-step.test.mjs:115-175`
  - `tests/audit/audit-code-completion.test.mjs:138-190`
- **Evidence:**
  - tests/audit/next-step.test.mjs:115 - defines a private next-step pause driver with its own terminal-kind list and per-step writes.
  - tests/audit/audit-code-completion.test.mjs:138 - defines a second private next-step pause driver with overlapping analyzer, intent, design-review, and edge-reasoning handling.
- _verified: next-step.test.mjs:115 advancePastDesignReview and audit-code-completion.test.mjs:138 advanceToDispatchReady are two separate pause-driver helpers. Confirmed._

### Host flag contract is duplicated into regex parity tests

- **Lens:** maintainability · **Category:** duplicated-contract-drift-guard · **Confidence:** high
- **Summary:** The host capability flag contract is reimplemented in the test file by scraping docs and source text, then asserting parity. Any new flag or bootstrap wording change has to keep the CLI literals, loader docs, and the test's regex parser synchronized instead of flowing from one shared manifest or generated documentation source.
- **Affected:**
  - `tests/remediate/cli-host-capability-flags.test.ts:73-123`
- **Evidence:**
  - tests/remediate/cli-host-capability-flags.test.ts:73 - The test defines its own host-flag extractor instead of importing a shared flag registry.
  - tests/remediate/cli-host-capability-flags.test.ts:306 - The parity case walks loader docs and CLI registrations to detect drift, so edits must be made in multiple places to remain correct.
  - tests/remediate/cli-host-capability-flags.test.ts:122 - A second bespoke parser scans docs for legacy bootstrap phrasing, duplicating the same bootstrap contract in test code.
- _verified: cli-host-capability-flags.test.ts:73 documentedHostFlags is a bespoke flag extractor scraping docs/source for parity. Confirmed._

### HTML resource tag→attribute map duplicated between browserExtension.ts and html.ts, kept in sync by a comment

- **Lens:** maintainability · **Category:** duplicated-logic · **Confidence:** high
- **Summary:** HTML_RESOURCE_ATTRIBUTE (which tags carry resource refs and via which attribute) is defined here and, per the inline comment, mirrored in html.ts; the two copies are kept consistent by convention rather than a shared source. Adding a tracked tag requires editing both files to stay correct — the change-cost tell of missing single-sourcing.
- **Affected:**
  - `src/audit/extractors/browserExtension.ts:321-328`
- **Evidence:**
  - src/audit/extractors/browserExtension.ts:321 - the comment explicitly states the map must be edited in both browserExtension.ts and html.ts; extract HTML_RESOURCE_ATTRIBUTE to one shared module so the mirror is unnecessary.
- _verified: browserExtension.ts:324 HTML_RESOURCE_ATTRIBUTE with comment stating it mirrors html.ts, kept in sync by convention. Confirmed._

### INFRA_FILE_PATHS hardcoded stale paths are a magic-list maintainability hazard

- **Lens:** maintainability · **Category:** stale-magic-constant · **Confidence:** high
- **Summary:** INFRA_FILE_PATHS is a hand-maintained literal list of infra file paths that already drifted to the dead pre-A12 `packages/remediate-code/src/...` layout. A list of file paths kept in sync by hand with the actual source tree is a standing change-cost trap; it should be derived from the real module locations or removed.
- **Affected:**
  - `src/remediate/steps/dispatch.ts:2313-2320`
- **Evidence:**
  - src/remediate/steps/dispatch.ts:2313 - the set still names `packages/remediate-code/src/...` files removed by the A12 collapse; the drift went unnoticed because nothing mechanically ties the list to the real tree.
  - src/remediate/steps/dispatch.ts:2318 - it even references `waveScheduler.ts`, whose logic CLAUDE.md describes as now inlined into dispatch.ts (a thin re-export shim), underscoring the list is maintained by convention and has gone stale.
- _verified: dispatch.ts:2313 INFRA_FILE_PATHS still lists stale packages/remediate-code/src/... paths plus waveScheduler.ts (inlined per A12). Confirmed stale._

### Ledger/plan/changeObl test fixture builders duplicated across dc5.test.ts blocks (and conceptually with contract-pipeline.test.ts)

- **Lens:** maintainability · **Category:** duplicated-logic · **Confidence:** high
- **Summary:** dc5.test.ts defines the same local ledger()/plan() envelope builders and changeObl/additionObl factories twice (once in validatePairedObligations describe, once in verifyPairingForFinding describe) with identical bodies, and seedContractArtifacts re-encodes the same obligation/test_spec shape a third time. Any change to these contract shapes must be edited in every copy.
- **Affected:**
  - `tests/remediate/dc5.test.ts:313-324`
  - `tests/remediate/dc5.test.ts:214-225`
- **Evidence:**
  - tests/remediate/dc5.test.ts:214 - ledger()/plan() builders defined inside the validatePairedObligations describe
  - tests/remediate/dc5.test.ts:313 - byte-identical ledger()/plan() builders re-defined inside the verifyPairingForFinding describe; should be one shared module-level helper
- _verified: dc5.test.ts:214 and :313 define byte-identical ledger()/plan() builders in two describe blocks. Confirmed duplication._

### LENS_KEYWORD_MAP single-authority filesystem-walk drift guard duplicated across two files

- **Lens:** maintainability · **Category:** duplicated-logic · **Confidence:** high
- **Summary:** Two test files reimplement the same recursive src/ walk that asserts exactly one LENS_KEYWORD_MAP declaration in src/shared/intent/sharedIntentData.ts. The walk logic, ignore list, and regex are copy-pasted; the shared single-authority guard should be extracted to one helper.
- **Affected:**
  - `tests/audit/dc1.test.mjs:288-305`
  - `tests/audit/free-form-intent-escalation.test.mjs:240-274`
- **Evidence:**
  - tests/audit/dc1.test.mjs:288-305 - recursive walk + declRe asserting hits.length === 1 in sharedIntentData.ts
  - tests/audit/free-form-intent-escalation.test.mjs:240-274 - same walk + same declRe + same final assertion
- _verified: dc1.test.mjs:288 and free-form-intent-escalation.test.mjs:240 both reimplement the same recursive walk + declRe + hits.length===1 assertion. Confirmed._

### Line-count failure policy is duplicated

- **Lens:** maintainability · **Category:** duplicated-contract-logic · **Confidence:** high
- **Summary:** The line-count error policy is implemented separately for repo manifests, arbitrary task paths, and task hint projection. Any change to whether missing/errored files should warn, fail, or default to zero must be made in multiple places to keep prompt coverage and ingestion behavior consistent.
- **Affected:**
  - `src/audit/cli/lineIndex.ts:37`
  - `src/audit/cli/lineIndex.ts:71`
  - `src/audit/cli/lineIndex.ts:96`
- **Evidence:**
  - src/audit/cli/lineIndex.ts:37 - buildLineIndex hard-codes a default-to-zero fallback after logging.
  - src/audit/cli/lineIndex.ts:71 - buildLineIndexForPaths repeats the same fallback independently.
  - src/audit/cli/lineIndex.ts:96 - addFileLineCountHints adds another zero fallback when projecting task file_line_counts.
- _verified: lineIndex.ts:37, :71, :96 each independently apply the default-to-zero fallback policy. Three copies confirmed._

### Lock threshold seam test compares copied constants

- **Lens:** maintainability · **Category:** duplicated-contract · **Confidence:** high
- **Summary:** The file-lock convergence test hardcodes both production stale-lock thresholds inside the test and then compares the two copies. Any real threshold change must be updated in multiple places, and the test can keep passing even after the implementations drift because it is not reading either production value.
- **Affected:**
  - `tests/audit/seam-file-lock-convergence.test.mjs:65-85`
- **Evidence:**
  - tests/audit/seam-file-lock-convergence.test.mjs:65 - The comment says constants are extracted from source, but lines 68-69 define both values locally before the equality assertion.
  - tests/audit/seam-file-lock-convergence.test.mjs:79 - The test asserts SHARED_STALE_LOCK_MS equals STORE_STALE_LOCK_MS, so the seam is policed by duplicated literals rather than a shared exported source.
- _verified: seam-file-lock-convergence.test.mjs:68-69 hardcode both 30_000 literals and assert equality; not reading either production value, so real drift goes uncaught._

### Outcome tests duplicate finding and item-spec factories

- **Lens:** maintainability · **Category:** duplicated-test-fixture-contract · **Confidence:** high
- **Summary:** The retryable-outcomes and round-trip suites each define their own makeFinding and makeItemSpec helpers with the same field defaults. Any Finding or ItemSpec contract change must be edited in both places to keep the tests meaningful.
- **Affected:**
  - `tests/remediate/next-step-outcomes-contract.test.ts:24-49`
  - `tests/remediate/outcomes-roundtrip.test.ts:48-68`
- **Evidence:**
  - tests/remediate/next-step-outcomes-contract.test.ts:37 - local factory sets the same summary, affected_files, evidence, severity, and confidence defaults.
  - tests/remediate/outcomes-roundtrip.test.ts:48 - another local factory repeats the same Finding shape and ItemSpec defaults used by the outcomes contract test.
- _verified: next-step-outcomes-contract.test.ts:24 and outcomes-roundtrip.test.ts:48 each define own makeFinding factory. Confirmed duplication._

### Pipeline artifact builders are fragmented across large tests

- **Lens:** maintainability · **Category:** duplicated-test-fixtures · **Confidence:** high
- **Summary:** This slice has several independent helpers for constructing contract pipeline artifact directories, payload chains, and valid artifacts. The same setup concepts are spread across long files, so a pipeline artifact contract change must be reconciled manually in multiple places.
- **Affected:**
  - `tests/remediate/contract-pipeline.test.ts:60`
  - `tests/remediate/contract-pipeline-staleness-convergence.test.ts:62-63`
  - `tests/remediate/cyclic-seam-resolution.test.ts:169`
- **Evidence:**
  - tests/remediate/contract-pipeline.test.ts:60 - CHAIN_PAYLOADS encodes a full ordered contract-pipeline payload set.
  - tests/remediate/contract-pipeline-staleness-convergence.test.ts:62 - makePayload() creates another local payload abstraction for pipeline artifacts.
  - tests/remediate/cyclic-seam-resolution.test.ts:169 - VALID_RESOLUTION defines yet another local valid artifact shape.
- _verified: CHAIN_PAYLOADS, makePayload (62), VALID_RESOLUTION (169) are separate pipeline-artifact fixture abstractions across three files. Fragmented as described._

### prepareDispatchArtifacts still centralizes unrelated dispatch responsibilities

- **Lens:** maintainability · **Category:** excessive-function-scope · **Confidence:** high
- **Summary:** prepareDispatchArtifacts spans most of dispatch.ts and coordinates task source selection, bundle/config loading, model capacity, packet partitioning, prompt writing, result-map generation, warnings, quota, and the final return contract. Changes to any one dispatch concern must be made inside the same long function, increasing regression risk despite the surrounding submodule split.
- **Affected:**
  - `src/audit/cli/dispatch.ts:115`
  - `src/audit/cli/dispatch.ts:161`
  - `src/audit/cli/dispatch.ts:358`
- **Evidence:**
  - src/audit/cli/dispatch.ts:115 - the single exported orchestration function begins at line 115 and continues through the end of the 492-line file.
  - src/audit/cli/dispatch.ts:161 - the same function owns bundle loading and task/config setup.
  - src/audit/cli/dispatch.ts:358 - the same function also writes packet prompts and manages dispatch output artifacts.
- _verified: prepareDispatchArtifacts begins at dispatch.ts:115 and spans the long function coordinating bundle/config/packet/prompt — matches cited lines._

### Prompt result contract is synchronized by regression test

- **Lens:** maintainability · **Category:** duplicated-contract · **Confidence:** high
- **Summary:** The dispatch helper tests explicitly maintain a no-drift contract between the rolling-dispatch step prompt and generated worker packet prompt. That means future result-path contract changes must be made in both prompt renderers and kept consistent by this test instead of being single-sourced.
- **Affected:**
  - `tests/audit/dispatch-helpers.test.mjs:143-150`
- **Evidence:**
  - tests/audit/dispatch-helpers.test.mjs:143 - The section names the test as a step-prompt to packet-prompt no-drift guard.
  - tests/audit/dispatch-helpers.test.mjs:146 - The comment describes a prior drift where one prompt told workers to write result_path while the other forbade writes.
- _verified: dispatch-helpers.test.mjs:145 N-worker-prompt no-drift contract test confirmed; guards two prompt renderers by test, not single-source._

### Provider discovery logic is split across factory and confirmation

- **Lens:** maintainability · **Category:** duplicated-provider-contract · **Confidence:** high
- **Summary:** Provider availability, PATH probing, opencode opt-in, and self-spawn rules are encoded in both providerFactory and providerConfirmation. Adding or changing a provider now requires coordinated edits across two modules, and the inline comment in confirmation already has to say it mirrors providerFactory.
- **Affected:**
  - `src/shared/providers/providerFactory.ts:54-58`
  - `src/shared/providers/providerConfirmation.ts:65-70`
  - `src/shared/providers/providerConfirmation.ts:136-141`
  - `src/shared/providers/providerFactory.ts:139-145`
- **Evidence:**
  - src/shared/providers/providerFactory.ts:54 - providerFactory owns PATH lookup and auto-provider priority rules.
  - src/shared/providers/providerConfirmation.ts:65 - providerConfirmation reimplements the same platform-specific PATH lookup.
  - src/shared/providers/providerConfirmation.ts:136 - the confirmation path explicitly says its self-spawn guard mirrors providerFactory, which is a convention-based drift point rather than a shared abstraction.
  - src/shared/providers/providerFactory.ts:139 - the canonical priority table lives elsewhere, so provider discovery and provider selection can diverge unless every rule change is duplicated carefully.
- _verified: commandExists duplicated in providerFactory.ts:54 and providerConfirmation.ts:66; confirmation.ts:136 explicitly says 'mirror providerFactory'._

### Quota pool construction is duplicated

- **Lens:** maintainability · **Category:** duplicated-logic · **Confidence:** high
- **Summary:** The dispatch scheduler builds the same quota source and capacity-pool topology in both the scheduling path and the exported confirmed-pool path. Every future quota key, host model, or source-pool change has to be kept in sync across both functions, so this should be extracted behind one shared pool-construction helper.
- **Affected:**
  - `src/remediate/steps/dispatch.ts:200-325`
- **Evidence:**
  - src/remediate/steps/dispatch.ts:200 - scheduleWave constructs quota and capacity-pool inputs internally before returning capacity_pools.
  - src/remediate/steps/dispatch.ts:325 - buildConfirmedPools separately reconstructs the same provider/model/quota source setup for rolling dispatch.
- _verified: scheduleWave and buildConfirmedPools each derive identical quota/pool preamble in remediate dispatch.ts; same duplication as idx 61._

### Real-git fixture setup is duplicated across rolling-driver tests

- **Lens:** maintainability · **Category:** duplicated-test-fixture · **Confidence:** high
- **Summary:** Several rolling/worktree tests carry their own temp git repository bootstrap, including git init/config, a package.json check script, commit setup, and ok-return handling. Any future change to the fixture contract or failure policy has to be made in multiple files to stay correct; a shared helper would single-source the setup and its failure behavior.
- **Affected:**
  - `tests/remediate/host-rolling-dispatch.test.ts:31-47`
  - `tests/remediate/hybrid-inprocess.test.ts:60-74`
  - `tests/remediate/dc6.test.ts:59-76`
  - `tests/remediate/dispatch-worktree.test.ts:498-516`
- **Evidence:**
  - tests/remediate/host-rolling-dispatch.test.ts:31 - Defines a local initRepo helper for git init/config/package setup.
  - tests/remediate/hybrid-inprocess.test.ts:60 - Defines the same temp git repository bootstrap with a different fixture name.
  - tests/remediate/dc6.test.ts:59 - Repeats the same rolling-session git fixture setup.
  - tests/remediate/dispatch-worktree.test.ts:498 - Repeats another real-git initRepo helper in the worktree tests.
- _verified: initRepo git-fixture helper duplicated verbatim across host-rolling-dispatch.ts:31, hybrid-inprocess.ts:60, etc._

### scheduleWave and buildConfirmedPools duplicate the entire pool-construction preamble

- **Lens:** maintainability · **Category:** duplicated-logic · **Confidence:** high
- **Summary:** scheduleWave and buildConfirmedPools each independently recompute providerName, hostModel, quotaModelKeySegment, sorted roster, host concurrency limit, host capability limits, quota entries, quota source, and the buildHostModelPools call with an identical resolve closure. The two copies must be edited in lockstep to stay correct — the classic 'every edit in N places' tell — and should be single-sourced into one shared pool-inputs builder.
- **Affected:**
  - `src/remediate/steps/dispatch.ts:290-303`
  - `src/remediate/steps/dispatch.ts:384-397`
- **Evidence:**
  - src/remediate/steps/dispatch.ts:200 - scheduleWave derives providerName/hostModel/quotaModelKeySegment/roster/hostLimit/hostCapabilityLimits/quotaEntries/quotaSource.
  - src/remediate/steps/dispatch.ts:342 - buildConfirmedPools re-derives the identical set with the same fallbacks, then makes the same buildHostModelPools call with a byte-identical resolve closure (lines 384-397), so any change to pool inputs must be mirrored in both.
- _verified: dispatch.ts:290 and :384 byte-identical buildHostModelPools calls + duplicated preamble (lines 263-303 vs 342-397) confirmed._

### Schema/type sync list is hand-maintained

- **Lens:** maintainability · **Category:** duplicated-contract-manifest · **Confidence:** high
- **Summary:** `shared-core-invariants.test.mjs` duplicates the Finding contract as a local `Set`, so schema/type evolution must be reflected in both the source contract and the test mirror. Single-source this from the TypeScript type metadata, schema, or an exported manifest so every contract edit does not require a parallel hand edit in the invariant test.
- **Affected:**
  - `tests/shared/shared-core-invariants.test.mjs:29-36`
- **Evidence:**
  - tests/shared/shared-core-invariants.test.mjs:29 - The invariant test manually mirrors the canonical Finding fields instead of deriving them from the authoritative contract.
- _verified: shared-core-invariants.test.mjs:29 hand-maintained findingFields Set mirroring the Finding contract — confirmed._

### Selective-deepening task/result fixture objects duplicated across ~15 tests with no shared builder

- **Lens:** maintainability · **Category:** duplicated-logic · **Confidence:** high
- **Summary:** Nearly every lens-steward / deepening test rebuilds the same security source-task shape and the identical results = tasks.map((task) => ({ task_id, unit_id, pass_id, lens, file_coverage..., findings })) projection. A change to the AuditTask or AuditResult shape forces edits in a dozen-plus places to keep the file correct.
- **Affected:**
  - `tests/audit/orchestrator-remediation.test.mjs:1160-1182`
  - `tests/audit/orchestrator-remediation.test.mjs:1224-1246`
- **Evidence:**
  - tests/audit/orchestrator-remediation.test.mjs:1160-1182, 1224-1246, 1287-1309, 1350-1373, 1429-1451, 1508-1530, 1581-1603 - the same task->result projection repeated nearly identically across the lens-steward suite
  - tests/audit/orchestrator-remediation.test.mjs:283-294, 396-407, 557-568 - the same single security source-task literal repeated as sourceTask
- _verified: orchestrator-remediation.test.mjs:1160 task->result map projection repeated across deepening suite — confirmed at cited lines._

### Single-source tests police drift with source-text scanners

- **Lens:** maintainability · **Category:** brittle-drift-guard · **Confidence:** high
- **Summary:** Several packet tests keep shared contracts single-sourced by recursively reading source files and matching implementation text. That makes every legitimate move, rename, or signature change update both production code and text-scanner tests instead of routing the invariant through one shared API or metadata source.
- **Affected:**
  - `tests/shared/finding-identity-single-source.test.mjs:17-19`
  - `tests/shared/io-hash-primitives-single-source.test.mjs:80-86`
- **Evidence:**
  - tests/shared/finding-identity-single-source.test.mjs:17 - The test documents that it reads source files and asserts on text to catch duplicate identity implementations.
  - tests/shared/io-hash-primitives-single-source.test.mjs:80 - The atomic-writer guard encodes source-text heuristics for '.tmp' plus rename rather than consuming a shared declaration of durable-write ownership.
- _verified: finding-identity-single-source.test.mjs:17 and io-hash-primitives test use source-text scanners as drift guards — confirmed._

### The 11-lens list and severity list are hardcoded verbatim in two prompt branches

- **Lens:** maintainability · **Category:** duplicated-literal · **Confidence:** high
- **Summary:** buildConfirmIntentStep embeds the full canonical lens list (correctness, architecture, ... config_deployment, observability) and the severity list (critical/high/medium/low/info) as inline backtick strings in BOTH the draft branch and the fallback branch. Adding or renaming a lens requires editing this string in two places here (and it is also the same vocabulary used elsewhere, e.g. detectPlanAmbiguities) with only convention keeping them in sync — the classic 'every edit must be made in N places' tell. Single-source the lens/severity vocabulary and render it.
- **Affected:**
  - `src/remediate/steps/nextStep.ts:4005-4007`
  - `src/remediate/steps/nextStep.ts:4043`
- **Evidence:**
  - src/remediate/steps/nextStep.ts:4007 - lens list literal in the draft-checkpoint prompt branch
  - src/remediate/steps/nextStep.ts:4043 - identical lens list literal in the fallback prompt branch; both must be edited together to add a lens
- _verified: nextStep.ts:4005 and :4043 both embed full 11-lens + severity literals in two prompt branches — confirmed._

### Analyzer failures can be reported as success

- **Lens:** observability · **Category:** misleading-analyzer-status · **Confidence:** high
- **Summary:** runExternalAnalyzer labels a completed tool run as "success" whenever parsing yields zero normalized results, without checking a nonzero exit status or preserving stderr/output context. Parsers such as semgrep intentionally degrade malformed or empty JSON to [], so analyzer configuration/runtime failures can disappear as successful empty scans.
- **Affected:**
  - `src/audit/extractors/analyzers/acquisitionEngine.ts:405-413`
  - `src/audit/extractors/analyzers/candidates.ts:134-140`
- **Evidence:**
  - src/audit/extractors/analyzers/acquisitionEngine.ts:405 - status is derived from normalized.results.length only, so zero parsed findings becomes "success" even when result.status is nonzero.
  - src/audit/extractors/analyzers/candidates.ts:134 - parseSemgrep catches malformed JSON and returns [], feeding the success path for failed or non-JSON tool output.
- _verified: acquisitionEngine.ts:403 status='success' on zero results ignoring result.status exit code; parseSemgrep:134 degrades bad JSON to []._

### Archive errors drop the underlying exception context

- **Lens:** observability · **Category:** error-reporting-context · **Confidence:** high
- **Summary:** The archive helper catches filesystem rename failures without preserving or reporting the exception, and the stale-artifact caller later records that artifacts were archived. Operators investigating a stuck re-emit or stale-artifact loop get no path-specific failure reason such as permission, collision, or transient filesystem error.
- **Affected:**
  - `src/remediate/steps/contractPipeline.ts:421-424`
  - `src/remediate/steps/contractPipeline.ts:1726-1729`
- **Evidence:**
  - src/remediate/steps/contractPipeline.ts:423 - the catch block does not bind the thrown error, so no message/code/path detail survives.
  - src/remediate/steps/contractPipeline.ts:1728 - the friction note states stale artifacts were archived, but the archive helper can fail without exposing why.
- _verified: contractPipeline.ts:423 catch block unbound — drops exception context; caller reports archived without failure reason._

### Dropped analyzer findings are logged without item identity

- **Lens:** observability · **Category:** low-diagnostic-context · **Confidence:** high
- **Summary:** The external normalizer reports only aggregate dropped/total counts and a generic reason when analyzer findings are discarded. Operators cannot tell which rule, path, or item payload was malformed, so debugging analyzer import loss requires re-running or manually diffing raw output.
- **Affected:**
  - `src/audit/adapters/normalizeExternal.ts:43-47`
- **Evidence:**
  - src/audit/adapters/normalizeExternal.ts:43 - the warning event records aggregate counts.
  - src/audit/adapters/normalizeExternal.ts:47 - the only drop reason is generic and includes no sampled id/rule/path for the discarded items.
- _verified: normalizeExternal.ts:43 logs aggregate dropped/total + generic reason, no per-item id/rule/path — confirmed._

### Invalid design-review outputs are deleted without diagnostics

- **Lens:** observability · **Category:** missing-diagnostic · **Confidence:** high
- **Summary:** The design-review result consumer unlinks incoming contract/conceptual files before checking that their contents are valid arrays and only silently continues when the shape is wrong or the target assessment is absent. A malformed worker output therefore disappears with no stderr, handoff, or blocked-step context explaining why the review was not accepted.
- **Affected:**
  - `src/audit/cli/nextStepHelpers.ts:427-431`
- **Evidence:**
  - src/audit/cli/nextStepHelpers.ts:427 - The comment and implementation explicitly delete incoming files first, then merge only when the value is an array and a design assessment exists.
  - src/audit/cli/nextStepHelpers.ts:438 - The conceptual-result branch follows the same delete-before-validate pattern, so either pass can be silently discarded.
- _verified: nextStepHelpers.ts:430/439 unlink incoming files before validating array shape; silently continues on malformed worker output._

### Contested rolling nodes are never retried

- **Lens:** reliability · **Category:** stale-claim-recovery · **Confidence:** high
- **Summary:** The host rolling dispatcher permanently records a node as contested after any failed claim and then excludes that node from future dispatch attempts and completion totals. If the peer driver that held the claim crashes, times out, or releases without accepting the node, this session can finish while eligible work is never retried.
- **Affected:**
  - `src/remediate/steps/rollingSession.ts:413-423`
  - `src/remediate/steps/rollingSession.ts:430-433`
- **Evidence:**
  - src/remediate/steps/rollingSession.ts:413-423 - a failed claim appends the candidate to session.contested, and the frontier walk skips contested ids on later passes.
  - src/remediate/steps/rollingSession.ts:430-433 - completion math subtracts contested nodes from ownTotal, so a peer-owned node that never gets accepted no longer keeps this host session waiting or retrying.
- _verified: Verified L413-433: failed claim pushes block_id to session.contested permanently; walk skips contested ids and ownTotal subtracts them. No re-check if peer never accepts._

### Audit config silently accepts permission bypass

- **Lens:** security · **Category:** permission-bypass-warning-gap · **Confidence:** high
- **Summary:** The audit session loader uses the audit-specific validator, which only rejects non-boolean claude_code.dangerously_skip_permissions values. A true value therefore reaches the provider config without the canonical warning for bypassing host permission controls, making a dangerous audit-mode configuration easy to miss.
- **Affected:**
  - `src/audit/validation/sessionConfig.ts:163-172`
  - `src/audit/supervisor/sessionConfig.ts:43-45`
- **Evidence:**
  - src/audit/validation/sessionConfig.ts:163 - validateAgentProviderSection only emits an issue when dangerously_skip_permissions is present and not boolean; the true value is accepted silently.
  - src/audit/supervisor/sessionConfig.ts:43 - loadSessionConfig gates audit session configs solely through that audit validator before returning the raw config as SessionConfig.
- _verified: Verified L163-173: audit validator only type-checks dangerously_skip_permissions, emits no warning for a true value; loader gates solely on this validator._

### Artifact dependency parity is enforced by a source-scanning drift test

- **Lens:** tests · **Category:** drift-guard-test · **Confidence:** high
- **Summary:** The dependency-map seam test exists to keep the hand-authored dependency DAG and executor artifacts_written write-sets in parity, and it reconstructs write-sets by scanning executor source. That is a fragile test symptom of duplicated contract data; the DAG and write-sets should come from one structured artifact registry so tests validate behavior rather than police two copies.
- **Affected:**
  - `tests/audit/seam-dependency-map-executor-writeset-parity.test.mjs:6-8`
- **Evidence:**
  - tests/audit/seam-dependency-map-executor-writeset-parity.test.mjs:6 - the test says it verifies dependency-map entries and executor write-sets remain in parity.
  - tests/audit/seam-dependency-map-executor-writeset-parity.test.mjs:8 - the comment states that drift between the two copies silently breaks staleness propagation.
  - tests/audit/seam-dependency-map-executor-writeset-parity.test.mjs:168 - the test uses a regex over source text to infer `artifacts_written` variables.
- _verified: Verified L6-8: test header states it polices dependency-map vs executor artifacts_written parity via source scanning; drift-guard pattern confirmed._

### Auto-provider stderr coverage is skipped on common developer PATHs

- **Lens:** tests · **Category:** environment-dependent-test-skip · **Confidence:** high
- **Summary:** The auto-provider diagnostic test is skipped whenever claude, codex, or opencode is installed on PATH, which is likely in the environments most contributors use. That leaves the structured stderr fallback untested precisely on agent-equipped machines instead of injecting command availability to make the branch deterministic.
- **Affected:**
  - `tests/shared/codex-antigravity-providers.test.mjs:255-271`
- **Evidence:**
  - tests/shared/codex-antigravity-providers.test.mjs:255 - The test comments say the premise only holds when no agent CLI is detectable, then line 271 skips when any supported CLI is on PATH.
- _verified: Verified L255-271: test skips when claude/codex/opencode on PATH, leaving stderr-diagnostic branch untested on agent-equipped machines._

### Concurrency test does not assert concurrency

- **Lens:** tests · **Category:** missing-behavior-assertion · **Confidence:** high
- **Summary:** The test named for the LINE_COUNT_BATCH_SIZE concurrency limit never observes concurrent countLines calls or batch sizes; it only checks that all paths appear in the output, so an implementation that runs all 60 reads at once would still pass.
- **Affected:**
  - `tests/audit/line-index.test.mjs:272-288`
- **Evidence:**
  - tests/audit/line-index.test.mjs:272 - Test title promises to enforce the LINE_COUNT_BATCH_SIZE concurrency cap.
  - tests/audit/line-index.test.mjs:285 - The comments admit countLines is not intercepted and the assertion is reduced to output cardinality.
- _verified: Verified L272-288: comment admits countLines not intercepted; assertion reduced to result cardinality, asserts no concurrency cap._

### Contract pipeline tests can read stale shared constants

- **Lens:** tests · **Category:** stale-build-import · **Confidence:** high
- **Summary:** Several tests in this slice import current contract-pipeline source files but pull shared contract versions and types from audit-tools/shared. That package path resolves through built shared output, so a stale dist/shared tree can make these source tests pass or fail against old constants.
- **Affected:**
  - `tests/remediate/contract-pipeline-adversarial.test.ts:59`
  - `tests/remediate/contract-pipeline-artifact-store.test.ts:17`
  - `tests/remediate/contract-pipeline-derive-obligations.test.ts:48`
- **Evidence:**
  - tests/remediate/contract-pipeline-adversarial.test.ts:25 - the test imports live ../../src/remediate/steps/contractPipeline.js.
  - tests/remediate/contract-pipeline-adversarial.test.ts:59 - shared contract versions are imported from audit-tools/shared.
  - tests/remediate/contract-pipeline-artifact-store.test.ts:13 - artifactStore is imported from ../../src/remediate/contractPipeline/artifactStore.js while shared versions come from the package path.
  - package.json - the ./shared package export points to ./dist/shared/index.js.
- _verified: Verified L59 imports from audit-tools/shared which resolves to dist/shared per package.json; source tests pull constants through built output._

### Cross-protocol lock tests silently skip when dist is absent

- **Lens:** tests · **Category:** stale-build-silent-skip · **Confidence:** high
- **Summary:** The seam-file-lock test imports the remediator StateStore from a compiled dist path and converts any import failure into a skip. In the current single-package/source-first test setup, that can silently drop the cross-protocol C assertions instead of proving the live source still interoperates.
- **Affected:**
  - `tests/audit/seam-file-lock-convergence.test.mjs:51-63`
- **Evidence:**
  - tests/audit/seam-file-lock-convergence.test.mjs:51 - The test reaches into ../../../packages/remediate-code/dist/state/store.js instead of importing the current source module.
  - tests/audit/seam-file-lock-convergence.test.mjs:61 - When that import fails, skipNoStore skips the cross-protocol C tests.
- _verified: Verified L51-63: path packages/remediate-code/dist/state/store.js is the old 3-pkg layout (collapsed by A12), so import always fails and C tests permanently skip._

### DC-6 git-backed tests silently pass when repo setup fails

- **Lens:** tests · **Category:** silent-test-skip · **Confidence:** high
- **Summary:** The DC-6 rolling-driver tests return from the test body when initRepo reports failure. If git is missing, misconfigured, or cannot create the fixture repo, the coverage for claim release, contested dispatch, and locking goes green without exercising the behavior.
- **Affected:**
  - `tests/remediate/dc6.test.ts:139-140`
- **Evidence:**
  - tests/remediate/dc6.test.ts:139 - The first rolling next-node test calls initRepo and immediately returns on !ok.
  - tests/remediate/dc6.test.ts:181 - The cross-driver and later session-lock tests use the same return-on-failure pattern.
- _verified: Verified L139-140 `if (!ok) return;` — test returns silently green if initRepo fails, skipping rolling-driver coverage._

### Deliverable path test is a drift guard

- **Lens:** tests · **Category:** drift-guard-test · **Confidence:** high
- **Summary:** The test exists to keep multiple deliverable path authorities byte-identical and to catch spelling drift between synthesis, promotion, and prompt rendering. That is a fragile drift guard symptom; the path contract should have a single shared source so tests do not need to police duplicate representations.
- **Affected:**
  - `tests/shared/deliverable-paths-single-source.test.mjs:4-18`
- **Evidence:**
  - tests/shared/deliverable-paths-single-source.test.mjs:4 - The header says this regression test keeps synthesis, promotion, destination, and present_report paths in sync so they cannot drift.
  - tests/shared/deliverable-paths-single-source.test.mjs:16 - The contract explicitly asserts byte-identical promote source/destination derivations.
- _verified: Verified L4-18: header describes byte-identical path-parity drift guard across synthesis/promote/prompt derivations._

### dep-map.md literal-parity tests are drift guards policing duplication between dependency-map.md and ARTIFACT_DEPENDS_ON_MAP

- **Lens:** tests · **Category:** drift-guard-test · **Confidence:** high
- **Summary:** inv-6, inv-9 and fail-7 exist solely to keep two hand-maintained copies of the dependency DAG (the markdown spec and the TS adjacency table) in sync. The dependency edges are authored in both a .md document and a TS map; these tests are the workaround for that duplication. The durable fix is to generate one representation from the other (or the .md from the table) so the parity guards are unnecessary.
- **Affected:**
  - `tests/audit/staleness.test.mjs:847-851`
  - `tests/audit/staleness.test.mjs:1115-1119`
- **Evidence:**
  - tests/audit/staleness.test.mjs:789-861 - inv-6 parses dependency-map.md and compares edges to the TS table
  - tests/audit/staleness.test.mjs:1038-1087 - inv-9 asserts git_history.json present in BOTH sources
  - tests/audit/staleness.test.mjs:1089-1120 - fail-7 asserts presence biconditional; all three police the same .md<->TS duplication
- _verified: Verified L847-851 deepEqual literal-parity assertion between dependency-map.md and ARTIFACT_DEPENDS_ON_MAP; .md<->TS duplication policing confirmed._

### Export drift guard mirrors the public API

- **Lens:** tests · **Category:** drift-guard-test · **Confidence:** high
- **Summary:** `shared-tests-invariants.test.mjs` describes and implements a curated export list whose job is to catch `index.ts` drift, which means the test is policing duplicated API knowledge rather than consuming a single source of truth. Move the public API manifest into the implementation or generate the assertion from package exports so the guard is unnecessary.
- **Affected:**
  - `tests/shared/shared-tests-invariants.test.mjs:277-280`
- **Evidence:**
  - tests/shared/shared-tests-invariants.test.mjs:277 - The test explicitly maintains a curated public API subset to detect drift from `index.ts`, a symptom of duplicated contract ownership.
- _verified: Verified L277-280: curated public-API subset maintained in test to catch index.ts drift; duplicated contract knowledge confirmed._

### Fixture test byte-compares generated output

- **Lens:** tests · **Category:** drift-guard-test · **Confidence:** high
- **Summary:** The fixture test is explicitly a drift guard that byte-compares generator output against a committed fixture, including key order and whitespace. This makes tests enforce synchronization between two artifact copies instead of eliminating the duplicate representation or deriving the fixture from the generator contract.
- **Affected:**
  - `tests/remediate/fixture-generator-drift-guard.test.ts:2-63`
- **Evidence:**
  - tests/remediate/fixture-generator-drift-guard.test.ts:2 - The file header calls the test a drift guard and says it byte-compares generated output to a committed fixture.
  - tests/remediate/fixture-generator-drift-guard.test.ts:62 - The assertion catches key-order, whitespace, and newline drift by requiring raw string equality.
- _verified: Verified L1-5: header declares drift guard byte-comparing generator output to committed fixture._

### Host flag parity tests are drift guards for duplicated docs and CLI state

- **Lens:** tests · **Category:** drift-guard-test · **Confidence:** high
- **Summary:** The loader-doc parity tests pass only by comparing independently maintained docs and CLI literals with regex scraping. That makes the test a drift alarm for duplicated contract state rather than coverage of a single source of truth; a generated doc or exported flag manifest would make the guard unnecessary.
- **Affected:**
  - `tests/remediate/cli-host-capability-flags.test.ts:306-336`
- **Evidence:**
  - tests/remediate/cli-host-capability-flags.test.ts:306 - The test compares documented --host-* flags against registered flags instead of validating generated documentation from the CLI declaration.
  - tests/remediate/cli-host-capability-flags.test.ts:316 - Each loader doc is read as raw text and scraped for flag strings.
  - tests/remediate/cli-host-capability-flags.test.ts:329 - The bootstrap wording test explicitly fails on legacy phrasing, another drift check over duplicated prose.
- _verified: Verified L306: test compares documented --host-* flags against CLI-registered flags via doc scraping; drift-guard over duplicated docs/CLI._

### Host-only next-step exhaustiveness test compares copied lists

- **Lens:** tests · **Category:** self-referential-drift-guard · **Confidence:** high
- **Summary:** The host-only seam test hard-codes both the next-step return kinds and the command-handler kinds, then only compares those in-test copies. Production can add or remove a kind while this test still passes until someone manually updates the duplicated lists, so the test is a drift guard rather than source-derived coverage.
- **Affected:**
  - `tests/audit/seam-host-only-next-step.test.mjs:96-124`
  - `tests/audit/seam-host-only-next-step.test.mjs:112-124`
- **Evidence:**
  - tests/audit/seam-host-only-next-step.test.mjs:96 - RETURN_KINDS_FROM_NEXT_STEP_HELPERS is a manually maintained Set in the test.
  - tests/audit/seam-host-only-next-step.test.mjs:112 - CMD_NEXT_STEP_HANDLED_KINDS is another manually maintained Set in the same test, and A1-A3 compare those copied fixtures rather than deriving from production source.
- _verified: Verified L96-124: RETURN_KINDS and CMD_NEXT_STEP_HANDLED_KINDS are hand-maintained Sets compared in-test, not source-derived._

### LENS_KEYWORD_MAP drift-guard is the symptom of unextracted duplication and is itself duplicated

- **Lens:** tests · **Category:** drift-guard-test · **Confidence:** high
- **Summary:** Both dc1 and free-form-intent-escalation contain a filesystem-walk test whose only job is to keep two potential copies of LENS_KEYWORD_MAP in sync (exactly one declaration, in the shared module). The guard exists because the map could be re-duplicated; the guard test is itself copy-pasted into two files, so the drift-policing logic now also drifts.
- **Affected:**
  - `tests/audit/free-form-intent-escalation.test.mjs:265-274`
  - `tests/audit/dc1.test.mjs:303-304`
- **Evidence:**
  - tests/audit/dc1.test.mjs:288-305 - drift guard asserting one LENS_KEYWORD_MAP declaration
  - tests/audit/free-form-intent-escalation.test.mjs:240-274 - the same drift guard, duplicated; single-source the walk into one helper and the per-file guards collapse
- _verified: Both dc1.test.mjs:288-305 and free-form-intent-escalation.test.mjs:240-274 contain duplicated filesystem-walk single-authority guard; quoted_text matches._

### Missing regression for terminal overlap handling

- **Lens:** tests · **Category:** missing-edge-case-test · **Confidence:** high
- **Summary:** The dispatch merge path has an important lost-update safeguard, but the test surface does not appear to exercise the case where successfully resolved items are already terminal before overlap detection runs. A regression test should cover concurrently merged blocks editing the same file and assert the overlap route still blocks or reopens the involved items instead of leaving terminal resolutions in place.
- **Affected:**
  - `src/remediate/steps/dispatch.ts:3628-3633`
  - `src/remediate/steps/dispatch.ts:3838-3845`
- **Evidence:**
  - src/remediate/steps/dispatch.ts:3628 - successful item results are marked terminal before the late overlap detector runs.
  - src/remediate/steps/dispatch.ts:3843 - the overlap detector skips terminal items, so a test needs to pin the intended behavior for overlapping edits after successful merge processing.
- _verified: dispatch.ts:3628 marks items terminal before overlap detector (line ~3843) which skips terminal items; no regression test pins the post-merge overlap case._

### Null analyzer-decision test never passes null

- **Lens:** tests · **Category:** insufficient-negative-coverage · **Confidence:** high
- **Summary:** The invariant says analyzer-decisions.json containing JSON null must not crash, but the test explicitly avoids injecting that input and instead exercises a no-manifest fallthrough path. Removing the null guard could still leave this test green, so add a real incoming null artifact case.
- **Affected:**
  - `tests/audit/audit-cli-invariants.test.mjs:64-75`
- **Evidence:**
  - tests/audit/audit-cli-invariants.test.mjs:64 - the test title names JSON null, but the body comments that it cannot inject the null artifact and only verifies a structural fallthrough.
- _verified: audit-cli-invariants.test.mjs:65 comment confirms it can't inject null and only verifies no-manifest fallthrough; null guard untested._

### Obligation engine test imports built dist

- **Lens:** tests · **Category:** stale-build-test-import · **Confidence:** high
- **Summary:** `obligation-engine.test.mjs` is a shared behavior test, but it imports from `../../dist/shared/index.js` instead of the TypeScript source used by the surrounding shared tests. A source regression can pass this test whenever `dist/` is stale or a single-file run skips the build step, so the test should target source directly or force a fresh build as part of its contract.
- **Affected:**
  - `tests/shared/obligation-engine.test.mjs:6-11`
- **Evidence:**
  - tests/shared/obligation-engine.test.mjs:6 - The test imports the compiled dist bundle, so it can validate stale generated output instead of the edited source.
- _verified: obligation-engine.test.mjs:6-11 imports from ../../dist/shared/index.js, not source; can validate stale build._

### Outcome key contract is re-declared inside the test

- **Lens:** tests · **Category:** schema-drift-guard · **Confidence:** high
- **Summary:** The round-trip suite validates top-level remediation-outcomes keys against a local Set instead of the real schema or exported contract source. This makes the test a drift guard between two copies of the contract and requires manual updates whenever the outcome schema changes.
- **Affected:**
  - `tests/remediate/outcomes-roundtrip.test.ts:360-389`
- **Evidence:**
  - tests/remediate/outcomes-roundtrip.test.ts:360 - the comment says the local Set lists the top-level keys the remediation-outcomes contract admits.
  - tests/remediate/outcomes-roundtrip.test.ts:384 - the assertion filters Object.keys(report) through DECLARED_OUTCOMES_TOP_LEVEL_KEYS rather than validating the generated file against the canonical schema.
- _verified: outcomes-roundtrip.test.ts:364 declares local Set of top-level keys; assertion filters Object.keys against it, not the canonical schema._

### Pipeline integration test depends on built shared export

- **Lens:** tests · **Category:** stale-build-import · **Confidence:** high
- **Summary:** The main contract-pipeline test imports live remediate implementation modules and also imports shared contract constants through audit-tools/shared. Since the package export targets dist/shared, this test can validate current source against stale built shared constants.
- **Affected:**
  - `tests/remediate/contract-pipeline.test.ts:35`
- **Evidence:**
  - tests/remediate/contract-pipeline.test.ts:9 - the test imports ../../src/remediate/steps/contractPipeline.js.
  - tests/remediate/contract-pipeline.test.ts:35 - contract version constants are imported from audit-tools/shared.
  - package.json - the ./shared package export points to ./dist/shared/index.js.
- _verified: contract-pipeline.test.ts:34 imports version constants from audit-tools/shared (dist-resolved export); validates source against built constants._

### Prompt-rendering tests assert dispatch source text instead of behavior

- **Lens:** tests · **Category:** brittle-white-box-test · **Confidence:** high
- **Summary:** Two dispatch-worktree tests read src/remediate/steps/dispatch.ts and assert whether literal strings appear. These tests can fail on harmless refactors or pass when the rendered prompt behavior is wrong, so they do not robustly cover the user-facing contract they describe.
- **Affected:**
  - `tests/remediate/dispatch-worktree.test.ts:432-464`
- **Evidence:**
  - tests/remediate/dispatch-worktree.test.ts:432 - The claimedWritePaths check reads the dispatch source file and asserts absence of a token.
  - tests/remediate/dispatch-worktree.test.ts:451 - The worktree-rooted prompt test says it is checking source-level contract because implementPrompt is not exported.
  - tests/remediate/dispatch-worktree.test.ts:464 - The assertion is a literal contains check for worktreeRoot, not a rendered prompt assertion.
- _verified: dispatch-worktree.test.ts:442-464 reads dispatch.ts source and asserts toContain/not.toContain on literal tokens; white-box source-text checks._

### Quota wiring tests police implementation spelling instead of behavior

- **Lens:** tests · **Category:** drift-guard-test · **Confidence:** high
- **Summary:** The M5 wiring tests read implementation files and assert that specific identifiers or forbidden tokens appear in source text. These tests can fail on behavior-preserving refactors and can pass while a differently named bypass is introduced, so the wiring invariant should be exposed through an executable contract or instrumentation instead of source-string sentinels.
- **Affected:**
  - `tests/remediate/quota-scheduler.test.ts:648-753`
- **Evidence:**
  - tests/remediate/quota-scheduler.test.ts:691 - The dispatch driver test reads a source file and asserts it contains computeDispatchCapacity.
  - tests/remediate/quota-scheduler.test.ts:704 - The audit rolling-dispatch guard also validates source text rather than observed dispatch behavior.
  - tests/remediate/quota-scheduler.test.ts:753 - The token-estimator guard is a negative regex over source spelling, not an executable path check.
- _verified: quota-scheduler.test.ts:649 readSource + lines 691-753 assert source contains/lacks identifiers; source-string sentinels, not behavior._

### readPackageVersion parse-error test re-implements the function under test inline instead of calling it

- **Lens:** tests · **Category:** test-asserts-nothing-real · **Confidence:** high
- **Summary:** Because PACKAGE_ROOT is resolved at module load, the OBS-9335faf6 test pastes a tiny reimplementation of readPackageVersion into the test and asserts against that copy. It verifies the test's own inline code, not the real readPackageVersion in toolingManifest.ts, so a regression there goes undetected.
- **Affected:**
  - `tests/audit/io-remediation.test.mjs:402-413`
- **Evidence:**
  - tests/audit/io-remediation.test.mjs:382-385 - comment concedes the real path can't be exercised, so it inlines the logic
  - tests/audit/io-remediation.test.mjs:404-413 - the asserted behavior is the test's own copy, not the source function
- _verified: io-remediation.test.mjs:401-413 inlines a reimplementation of readPackageVersion and asserts its own copy; real function never called._

### readPackageVersion test re-implements the function under test instead of exercising it

- **Lens:** tests · **Category:** test-not-exercising-source · **Confidence:** high
- **Summary:** The 'readPackageVersion logs to stderr on JSON parse error' test does not call the real readPackageVersion; it inlines a hand-copied reimplementation of the parse/log logic and asserts against that copy, so the test passes regardless of whether the production readPackageVersion behaves correctly (it could be deleted or broken and this test would stay green).
- **Affected:**
  - `tests/audit/io-remediation.test.mjs:401-413`
- **Evidence:**
  - tests/audit/io-remediation.test.mjs:376-425 - the test comment concedes 'we must exercise the path indirectly ... via a tiny inline reimplementation' and then runs a locally-pasted copy of the parse-or-log-null logic, never importing or invoking the real readPackageVersion. This is a test that asserts its own copy of the logic — it pins behavior without coupling to the source, so it cannot catch a regression in the actual function. The TST-004 high/high finding stands at the design level; severity medium is more defensible than high because the parse path is also covered indirectly by the buildToolingManifest tests in the same file. Recommend exporting readPackageVersion (parameterized by package root) and testing it directly.
- _verified: Same test 401-413: comment concedes indirect path, inlines parse/log copy; never imports/invokes real readPackageVersion._

### readPackageVersion test reimplements the code under test

- **Lens:** tests · **Category:** test-reimplementation · **Confidence:** high
- **Summary:** The OBS-9335faf6 regression test exercises a local shadow implementation instead of the production readPackageVersion path, so drift or removal of the real diagnostic behavior can pass unnoticed as long as the inline copy still logs.
- **Affected:**
  - `tests/audit/io-remediation.test.mjs:450-486`
- **Evidence:**
  - tests/audit/io-remediation.test.mjs:450 - Test name claims coverage of readPackageVersion parse-error behavior.
  - tests/audit/io-remediation.test.mjs:454 - The comments state the test calls a tiny inline reimplementation rather than the production function.
- _verified: Same OBS-9335faf6 test at 376; comment at 380-382 states it uses a tiny inline reimplementation, not production path._

### Regression test guards duplicated worker-write instructions

- **Lens:** tests · **Category:** drift-guard · **Confidence:** high
- **Summary:** The test's purpose is to keep two separately rendered prompt contracts from drifting after a past data-loss bug. This is a test smell: the duplicated WRITE-vs-inline instruction should be generated from one shared source so the guard is unnecessary.
- **Affected:**
  - `tests/audit/dispatch-helpers.test.mjs:143-150`
- **Evidence:**
  - tests/audit/dispatch-helpers.test.mjs:146 - The comment explains the past bug was prompt drift between rolling-dispatch and worker packet prompts.
  - tests/audit/dispatch-helpers.test.mjs:149 - The comment says the test fails if either side regresses, which is a synchronization guard over duplicated contract text.
- _verified: dispatch-helpers.test.mjs:145-150 comment describes guard keeping two rendered prompt contracts in sync after past drift bug; drift-guard smell._

### resolveAutonomousMode (option/config/env gate) has no test, unlike its structurally identical sibling resolveRollingEngineEnabled

- **Lens:** tests · **Category:** missing-coverage · **Confidence:** high
- **Summary:** resolveAutonomousMode implements the same precedence chain (sessionConfig → REMEDIATE_* env → default) as resolveRollingEngineEnabled, which is tested in two files. Autonomous mode is a higher-stakes gate (it governs unattended fix application), yet its resolution order and the 'false' env / undefined-default branches are entirely untested.
- **Affected:**
  - `src/remediate/steps/nextStep.ts:169-180`
- **Evidence:**
  - src/remediate/steps/nextStep.ts:169 - resolveAutonomousMode has zero test references in tests/remediate/tests/shared, while the parallel resolveRollingEngineEnabled (line 193, same precedence pattern) is covered by 2 test files — an unattended-execution gate left unpinned
- _verified: resolveAutonomousMode exists nextStep.ts:169 with precedence chain; grep finds zero test refs while sibling resolveRollingEngineEnabled is tested._

### Rolling and hybrid git tests silently pass when repo setup fails

- **Lens:** tests · **Category:** silent-test-skip · **Confidence:** high
- **Summary:** The host-rolling and hybrid in-process tests guard their real-git setup with if (!ok) return. A broken git fixture path therefore skips assertions for retry cleanup, merge/verify outcomes, seam rebasing, in-process merging, and claim release while reporting green.
- **Affected:**
  - `tests/remediate/host-rolling-dispatch.test.ts:77-78`
  - `tests/remediate/hybrid-inprocess.test.ts:125-126`
- **Evidence:**
  - tests/remediate/host-rolling-dispatch.test.ts:77 - The stale-branch retry test returns on a failed fixture repo instead of failing.
  - tests/remediate/host-rolling-dispatch.test.ts:361 - Seam rebase coverage also uses the same return-on-failure pattern.
  - tests/remediate/hybrid-inprocess.test.ts:125 - The in-process partition merge test returns on failed fixture setup.
  - tests/remediate/hybrid-inprocess.test.ts:172 - The worker-error and claim-release test uses the same pattern.
- _verified: host-rolling-dispatch.test.ts:78 and hybrid-inprocess.test.ts:126 use if(!ok) return; after initRepo, silently skipping assertions on fixture failure._

### Rolling/sequencing tests rely on fixed setTimeout(50ms) sleeps to assert dispatch ordering — non-deterministic on loaded CI

- **Lens:** tests · **Category:** fragile-test · **Confidence:** high
- **Summary:** Several tests advance state with `await new Promise(r => setTimeout(r, 50))` and then assert dispatchOrder.length, depending on the dispatcher having scheduled within 50ms. On a slow/loaded CI runner the dispatch may not have happened yet, producing flaky failures; the assertions should poll for the expected count rather than sleep-then-assert.
- **Affected:**
  - `tests/shared/rollingDispatch.test.mjs:253-260`
  - `tests/shared/rollingDispatch.test.mjs:353-354`
- **Evidence:**
  - tests/shared/rollingDispatch.test.mjs:254 - assertion of dispatchOrder.length gated only by a fixed 50ms sleep; timing-dependent, will flake when the event loop is slow
  - tests/shared/rollingDispatch.test.mjs:353 - mid-run enqueue test asserts dispatched.length==1 after only a 20ms sleep — even tighter timing margin
- _verified: Lines 254/353 use fixed setTimeout sleeps then assert dispatchOrder/dispatched length; timing-dependent, flaky on loaded CI. Quoted text matches._

### selectLensVerificationFiles test monkeypatches process.stderr.write and parses a JSON log line as the assertion surface

- **Lens:** tests · **Category:** fragile-test · **Confidence:** high
- **Summary:** The truncation test globally overrides process.stderr.write, captures all stderr, and asserts on a parsed JSON log line with event 'truncated_verification_file_list'. It couples the test to an observability log format rather than a returned value; any log-shape change (or interleaved stderr from another source) breaks it, and a thrown error before the finally could leak the patched writer to other tests.
- **Affected:**
  - `tests/audit/orchestrator-remediation.test.mjs:798-810`
- **Evidence:**
  - tests/audit/orchestrator-remediation.test.mjs:771-776 - process.stderr.write globally monkeypatched to collect lines
  - tests/audit/orchestrator-remediation.test.mjs:798-812 - assertion depends on parsing a specific JSON log event from captured stderr
- _verified: Test monkeypatches process.stderr.write (771-776) and asserts on parsed JSON log event truncated_verification_file_list (798-810). Couples to log shape._

### Stat throttling test never measures stat throttling

- **Lens:** tests · **Category:** missing-assertion · **Confidence:** high
- **Summary:** The file-lock test named for stat throttling only checks that acquisition times out and then discards the stat result. A regression that calls stat on every retry while still timing out would pass this test, so the intended throttling behavior is not actually covered.
- **Affected:**
  - `tests/shared/fileLock.test.mjs:318-323`
- **Evidence:**
  - tests/shared/fileLock.test.mjs:318 - The test reads stat after releasing the lock and then voids the value, so there is no assertion on stat call frequency or throttle behavior.
- _verified: stat result is read then voided (318-323); only asserts timedOut, no assertion on stat call frequency/throttle behavior. Quoted text matches._

### targetedCommandsForBlock has no direct test coverage despite non-trivial finding/block command merge + dedup

- **Lens:** tests · **Category:** missing-coverage · **Confidence:** high
- **Summary:** targetedCommandsForBlock merges block-level and per-finding targeted_commands, deduplicates them, and short-circuits on a missing block — yet no test references it. The merge/dedup and the missing-block ([] vs throw) edge are exactly the kind of logic that silently regresses without a pinning test.
- **Affected:**
  - `src/remediate/steps/dispatch.ts:1874-1884`
- **Evidence:**
  - src/remediate/steps/dispatch.ts:1874 - exported targetedCommandsForBlock with merge+dedup+missing-block branches; a repo-wide search of tests/remediate and tests/shared finds zero references, so none of these branches is exercised
- _verified: targetedCommandsForBlock exported at 1874 with merge/dedup/missing-block branches; grep of tests finds zero references — untested._

### Tests mix live src imports with packaged shared imports

- **Lens:** tests · **Category:** stale-build-import · **Confidence:** high
- **Summary:** These tests exercise live remediate source modules but import shared helpers through the package self-reference. Because that self-reference resolves through the package export, shared behavior can come from built output while the rest of the test uses current source, allowing stale dist/shared builds to skew results.
- **Affected:**
  - `tests/remediate/validation.test.ts:17`
  - `tests/remediate/wave-scheduler.test.ts:26`
- **Evidence:**
  - tests/remediate/validation.test.ts:9 - validation code is imported from ../../src/remediate/validation/remediationState.js.
  - tests/remediate/validation.test.ts:17 - shared validation helpers are imported from audit-tools/shared instead of the same source tree.
  - tests/remediate/wave-scheduler.test.ts:9 - dispatch code is imported from ../../src/remediate/steps/dispatch.js, while shared scheduler helpers come from audit-tools/shared.
  - package.json - the ./shared package export points to ./dist/shared/index.js.
- _verified: validation.test.ts and wave-scheduler.test.ts import live src/remediate modules but pull shared via audit-tools/shared package export (dist). Mixed._

### Tests that assert language/JS truths or a local reimplementation give zero coverage of the source guard

- **Lens:** tests · **Category:** test-asserts-nothing-real · **Confidence:** high
- **Summary:** INV-audit-cli-09, -10, -12 and parts of -03 assert facts about Array.isArray, Set membership, or a checkMutex copy of the fixed logic rather than calling the actual CLI source. They pass on a stale build and never detect a regression in the code they claim to lock.
- **Affected:**
  - `tests/audit/audit-cli-invariants.test.mjs:268-277`
  - `tests/audit/audit-cli-invariants.test.mjs:285-294`
- **Evidence:**
  - tests/audit/audit-cli-invariants.test.mjs:270-277 - checkMutex duplicates source logic; passing proves nothing about cmdIngestResults
  - tests/audit/audit-cli-invariants.test.mjs:285-294 - asserts a locally-built Set has its own members (tautology), never touches handleGraphEnrichmentBranch
  - tests/audit/audit-cli-invariants.test.mjs:236-240 - INV-09 asserts Array.isArray semantics, not the source null guard
- _verified: INV-09 asserts Array.isArray semantics (237-240); INV-12 tests a local checkMutex copy (270-277); INV-10 asserts a local Set has its members (286-294). Tautologies, not source._

### Tree-sitter parse-warning tests never assert warnings

- **Lens:** tests · **Category:** misleading-test-assertion · **Confidence:** high
- **Summary:** Three tree-sitter tests are named as parse-failure stderr warning coverage, but they pass normal fixture content through the analyzers and assert only that `edges` is an array. They neither force a parser failure nor check the captured `lines`, so the warning path can regress while these tests still pass.
- **Affected:**
  - `tests/audit/tree-sitter-analyzers.test.mjs:225-269`
- **Evidence:**
  - tests/audit/tree-sitter-analyzers.test.mjs:225 - the CSS test title promises stderr warning coverage for parse failure.
  - tests/audit/tree-sitter-analyzers.test.mjs:240 - the CSS fixture is valid `.x { color: red; }`, and the body only asserts `Array.isArray(result.edges)`.
  - tests/audit/tree-sitter-analyzers.test.mjs:251 - the Python warning test has the same pattern with `ok.py` and no assertion on captured stderr lines.
  - tests/audit/tree-sitter-analyzers.test.mjs:262 - the HTML warning test also only checks that `edges` is an array.
- _verified: CSS/Python/HTML tests pass valid fixtures and only assert Array.isArray(result.edges); never force parse failure nor check captured stderr lines._

### Triage failure-context test does not assert the context

- **Lens:** tests · **Category:** missing-assertion · **Confidence:** high
- **Summary:** The integration test is named and commented as verifying that blocked-item failure context appears in the collect-triage prompt, but it only checks for the finding id and the word triage. The prompt could omit the actual failure reason and this regression test would still pass.
- **Affected:**
  - `tests/remediate/integration-pipeline.test.ts:1336-1338`
- **Evidence:**
  - tests/remediate/integration-pipeline.test.ts:1303 - the test creates FAILURE_CONTEXT with the exact error text it intends to preserve.
  - tests/remediate/integration-pipeline.test.ts:1336 - the assertions only check F-001 and /triage/i, not FAILURE_CONTEXT or the failure_reason string.
- _verified: Test sets FAILURE_CONTEXT (1314) but assertions only check F-001 and /triage/i (1336-1338); failure_reason text never asserted._

### Valid-result fixture carries a non-contract field

- **Lens:** tests · **Category:** invalid-test-fixture · **Confidence:** high
- **Summary:** The test path named valid audit results uses a file_coverage entry with an extra reviewed_ranges property. That weakens the assertion because the fixture no longer represents the strict worker-result contract the test description says it is validating.
- **Affected:**
  - `tests/audit/worker-run-command.test.mjs:133-139`
- **Evidence:**
  - tests/audit/worker-run-command.test.mjs:133 - The comment says the result is valid and passes schema validation, but line 139 includes reviewed_ranges inside file_coverage.
- _verified: Valid-result fixture file_coverage entry carries extra reviewed_ranges:[] (139), not part of strict worker-result contract._

### Validate command test imports compiled dist

- **Lens:** tests · **Category:** stale-build-test-risk · **Confidence:** high
- **Summary:** `validate-command.test.mjs` imports `dist/audit/cli.js` at module load time and drives that compiled entrypoint. Targeted runs of this test can pass against stale build output after source changes, so validation-command behavior is not reliably tested from current source unless a separate build step just ran.
- **Affected:**
  - `tests/audit/validate-command.test.mjs:11-12`
- **Evidence:**
  - tests/audit/validate-command.test.mjs:11 - the test constructs `dist/audit/cli.js` as the module URL before any test runs.
  - tests/audit/validate-command.test.mjs:12 - `runCli` is imported from that compiled URL, so the assertions exercise whatever is currently in `dist/`.
- _verified: validate-command.test.mjs imports runCli from dist/audit/cli.js at load (11-12); targeted runs hit stale build output._

### Version-literal invariant only caps known drift

- **Lens:** tests · **Category:** weak-drift-guard · **Confidence:** high
- **Summary:** The test named for eliminating inline contract-pipeline version literals still passes while up to 25 raw literals remain. This is a drift guard over duplicated constants rather than a test that enforces the intended single-sourced contract.
- **Affected:**
  - `tests/remediate/remediate-tests-invariants.test.ts:138`
- **Evidence:**
  - tests/remediate/remediate-tests-invariants.test.ts:104 - the test title says supported artifact types should use version constants.
  - tests/remediate/remediate-tests-invariants.test.ts:138 - the assertion accepts raw literal count up to 25, so duplicated contract strings can remain and still pass.
- _verified: Assertion accepts rawLiteralCount <= 25 (138); drift cap over duplicated literals, not single-source enforcement._

### Worker schema test polices generated-file drift

- **Lens:** tests · **Category:** drift-guard-test · **Confidence:** high
- **Summary:** The worker schema test compares committed generated JSON schemas against a regenerated render to catch stale output. That means the test suite is carrying a manual synchronization obligation between Zod sources and checked-in schema artifacts instead of making schema generation a single-source build/package step.
- **Affected:**
  - `tests/audit/worker-schema-generation.test.mjs:23-37`
- **Evidence:**
  - tests/audit/worker-schema-generation.test.mjs:23 - The test identifies itself as a drift guard for committed schemas generated from Zod sources.
  - tests/audit/worker-schema-generation.test.mjs:33 - It regenerates schemas in-test and deep-compares them against committed files, failing with instructions to rerun the generator.
- _verified: Test regenerates schemas in-test and deep-compares against committed JSON (27-39); a manual-sync drift guard, as described._

### Worktree git tests silently pass when fixture repo setup fails

- **Lens:** tests · **Category:** silent-test-skip · **Confidence:** high
- **Summary:** The real-git acceptNodeWorktree cases return early whenever initRepo cannot create the fixture repository. That converts missing git, git init failures, or commit setup failures into passing tests for new-file inclusion, verification failure, rollback, and base-lock behavior.
- **Affected:**
  - `tests/remediate/dispatch-worktree.test.ts:621-622`
- **Evidence:**
  - tests/remediate/dispatch-worktree.test.ts:503 - initRepo reports ok:false when git init fails.
  - tests/remediate/dispatch-worktree.test.ts:621 - A real-git acceptNodeWorktree test returns on !ok instead of failing or marking an explicit skip.
  - tests/remediate/dispatch-worktree.test.ts:650 - Additional rollback/base-lock cases use the same return-on-failure pattern.
- _verified: Real-git tests return early on !ok from initRepo (622) instead of failing/explicit skip; converts git setup failure into a silent pass._

### Windows shim paths bypass the cmd wrapper

- **Lens:** correctness · **Category:** windows-command-resolution · **Confidence:** medium
- **Summary:** On win32, the runtime command resolver strips .cmd/.bat but compares the entire executable string to bare package-manager names. Absolute or relative shim paths such as node_modules/.bin/vitest.cmd fall through to direct spawn, so the runtime validation can fail to execute the intended command instead of using cmd.exe.
- **Affected:**
  - `src/audit/orchestrator/runtimeCommand.ts:119-120`
- **Evidence:**
  - src/audit/orchestrator/runtimeCommand.ts:119 - the code normalizes the full executable string, not its basename, before checking the package-manager allowlist.
  - src/audit/orchestrator/runtimeCommand.ts:131 - only the allowlisted branch wraps through cmd.exe; all other win32 executables fall through to direct spawn.
- _verified: runtimeCommand.ts:119 replace() runs on full executable string; node_modules/.bin/vitest.cmd not in allowlist -> falls through to direct spawn, no cmd wrap._

### validateImplementationDAG validates fields absent from the rendered DAG schema

- **Lens:** maintainability · **Category:** inconsistent-abstraction · **Confidence:** medium
- **Summary:** The implementation_dag schema rendered to workers in contractPipelinePrompts.ts lists a fixed node shape, but validateImplementationDAG also validates files_likely_touched, preconditions, and expected_changes — fields that do not appear in the prompt's output schema. The schema shown to the producer and the validator that checks it have drifted and must be kept in sync by hand.
- **Affected:**
  - `src/remediate/validation/contractPipeline.ts:576-586`
  - `src/remediate/steps/contractPipelinePrompts.ts:269-284`
- **Evidence:**
  - src/remediate/validation/contractPipeline.ts:576-586 - validator accepts files_likely_touched/preconditions/expected_changes on DAG nodes; src/remediate/steps/contractPipelinePrompts.ts:269-284 - the rendered output schema for that role omits all three, so the contract shown to the producer and the shape the validator enforces are two separately-maintained sources.
- _verified: contractPipeline.ts:576-586 validates files_likely_touched/preconditions/expected_changes; prompts.ts:269-285 output schema omits all three -> drift._

### Best-effort git failures in worktree quarantine/clear are swallowed without any log

- **Lens:** observability · **Category:** missing-error-logging · **Confidence:** medium
- **Summary:** Several best-effort git mutations in the worktree lifecycle discard their result entirely (no stderr line on non-zero exit), so an operator cannot tell whether quarantine cleanup or stale-branch reset actually happened when recovery later behaves unexpectedly.
- **Affected:**
  - `src/remediate/steps/dispatch.ts:921-927`
  - `src/remediate/steps/dispatch.ts:651-653`
- **Evidence:**
  - src/remediate/steps/dispatch.ts:922 - clearQuarantinedCommit ignores the spawnSync return; a failed `update-ref -d` leaves a stale quarantine ref that then mis-surfaces in listQuarantinedCommits with no breadcrumb of why.
  - src/remediate/steps/dispatch.ts:651 - `git worktree prune` and `git branch -D` results are unchecked and unlogged, so a reset that silently failed (leaving a leftover branch) gives no diagnostic when the subsequent `createWorktree -b` then fails.
- _verified: dispatch.ts:922 and 651-653 spawnSync results discarded, no stderr log on non-zero exit. Quoted text matches._

### Dist-import invariant allowlists stale-build tests

- **Lens:** tests · **Category:** test-guard-exception · **Confidence:** medium
- **Summary:** The test-suite invariant documents that top-level `dist/` imports can silently use stale compiled output, but it then permanently allowlists several CLI integration files without requiring a build-freshness check. That turns the invariant into a convention guard with known holes: a stale compiled entrypoint can remain covered by an allowlisted test while current source is unexercised.
- **Affected:**
  - `tests/audit/audit-tests-invariants.test.mjs:20-42`
- **Evidence:**
  - tests/audit/audit-tests-invariants.test.mjs:20 - the invariant is explicitly about banning top-level `dist/` imports because they can use stale compiled output.
  - tests/audit/audit-tests-invariants.test.mjs:33 - `DIST_IMPORT_ALLOWLIST` exempts named tests, including `validate-command.test.mjs`, from that stale-build guard.
  - tests/audit/audit-tests-invariants.test.mjs:44 - the scan pattern only catches non-allowlisted import/require forms; it does not require the allowlisted tests to prove `dist/` is freshly built.
- _verified: audit-tests-invariants.test.mjs:33-42 DIST_IMPORT_ALLOWLIST exempts validate-command.test.mjs etc with no build-freshness check._

### Git-backed rolling tests silently pass when git is unavailable

- **Lens:** tests · **Category:** silent-test-skip · **Confidence:** medium
- **Summary:** Several rolling dispatch tests return early when git setup fails, which Vitest records as a passing test rather than an explicit skip or failure. If the environment loses git, the worktree/merge coverage disappears without a visible signal.
- **Affected:**
  - `tests/remediate/rolling-provider-dispatch.test.ts`
  - `tests/remediate/rolling-dispatch-engine.test.ts`
- **Evidence:**
  - tests/remediate/rolling-provider-dispatch.test.ts - git-dependent tests return from the test body when initRepo reports ok=false.
  - tests/remediate/rolling-dispatch-engine.test.ts - the verify-before-accept test also returns early on git init failure.
- _verified: rolling-provider-dispatch.test.ts:66 and rolling-dispatch-engine.test.ts:473 early-return on git failure -> Vitest records pass, silent skip._

## Low (78)

### Committed host assets are kept in sync by drift tests

- **Lens:** maintainability · **Category:** duplicated-generated-artifact · **Confidence:** high
- **Summary:** The host asset tests compare committed generated assets against freshly rendered output, so the rendered command bodies exist in more than one place and are kept consistent by tests. A prompt or renderer change still requires regenerating committed copies, making the invariant edit-costly instead of single-sourced at install/read time.
- **Affected:**
  - `tests/audit/host-asset-renderer-drift.test.mjs:118-130`
- **Evidence:**
  - tests/audit/host-asset-renderer-drift.test.mjs:118 - the test section is explicitly a no-drift guard comparing a committed rendered asset with freshly rendered output.
  - tests/audit/host-asset-renderer-drift.test.mjs:130 - the failure message tells maintainers to re-run `audit-code install` or regenerate the asset when the committed copy drifts.
- _verified: host-asset-renderer-drift.test.mjs:120 no-drift guard compares committed asset to fresh render; failure msg says re-run install. Generated artifact kept in sync by test._

### Consumed-input archiving is open-coded across gates

- **Lens:** maintainability · **Category:** duplicated-lifecycle-logic · **Confidence:** high
- **Summary:** Several review and clarification gates repeat the same exists-then-rename-to-consumed pattern inline. Any future change to collision handling, timestamp format, retry behavior, or diagnostics has to be made in multiple places to keep the gate lifecycle consistent.
- **Affected:**
  - `src/remediate/steps/nextStep.ts:2403-2407`
  - `src/remediate/steps/nextStep.ts:3224-3227`
  - `src/remediate/steps/nextStep.ts:3357-3359`
- **Evidence:**
  - src/remediate/steps/nextStep.ts:2403 - Path A review approval archives consumed request/resolution files inline.
  - src/remediate/steps/nextStep.ts:3224 - Path B review approval repeats the same archive loop and rename format.
  - src/remediate/steps/nextStep.ts:3357 - Plan ambiguity resolution repeats the same archive loop again, without a shared helper for the consumed-input lifecycle.
- _verified: open-coded archive loop rename(p,...consumed-Date.now()) repeats at nextStep.ts 2466/3287/3419 with no shared helper._

### coverage.ts uses an O(1) Map index in applyFileCoverage but linear .find in markExcludedPath/applyUnitCoverage — inconsistent lookup abstraction

- **Lens:** maintainability · **Category:** inconsistent-abstraction · **Confidence:** high
- **Summary:** buildFileIndex(matrix) builds a path→record Map used only by applyFileCoverage, while markExcludedPath and applyUnitCoverage each do matrix.files.find(...). The two record-lookup styles are inconsistent within one small module; a single shared lookup helper would unify them and avoid the linear scans repeated per-call.
- **Affected:**
  - `src/audit/coverage.ts:32-47`
  - `src/audit/coverage.ts:9-11`
- **Evidence:**
  - src/audit/coverage.ts:9 - buildFileIndex exists but is only used by applyFileCoverage; markExcludedPath (line 32) and applyUnitCoverage (line 47) use matrix.files.find, so the module has two lookup idioms for the same operation.
- _verified: coverage.ts:9 buildFileIndex Map used only by applyFileCoverage; markExcludedPath:31 and applyUnitCoverage:47 use .find -> two lookup idioms._

### Design-review step rendering is duplicated across three branches

- **Lens:** maintainability · **Category:** duplicated-contract-rendering · **Confidence:** high
- **Summary:** The parallel, contract-only, and conceptual-only design-review branches each recreate the same incoming-directory setup, continuation command, result-path wiring, prompt assembly, and current-step write. Any change to design-review artifact naming, access controls, or continuation wording must be mirrored across multiple branches, so the step contract is kept consistent by convention instead of one shared renderer.
- **Affected:**
  - `src/audit/cli/nextStepCommand.ts:241-248`
  - `src/audit/cli/nextStepCommand.ts:328-332`
  - `src/audit/cli/nextStepCommand.ts:368-374`
- **Evidence:**
  - src/audit/cli/nextStepCommand.ts:241 - The parallel design-review branch creates the incoming dir, continuation command, and contract result path inline.
  - src/audit/cli/nextStepCommand.ts:328 - The contract-only branch repeats the same setup and artifact path inline.
  - src/audit/cli/nextStepCommand.ts:368 - The conceptual-only branch repeats the same setup before assembling its own prompt and step.
- _verified: nextStepCommand.ts:241/328/368 three design-review branches repeat mkdir incoming + continueCommand + result-path setup inline._

### Empty-staging close behavior is tested twice with duplicated setup

- **Lens:** maintainability · **Category:** duplicated-test-matrix · **Confidence:** high
- **Summary:** Two adjacent describe blocks exercise the same stageAndCommit empty-tree success behavior with repeated state setup and status assertions. Changing the expected empty-staging contract now requires editing both matrices and keeping their slightly different assertions aligned.
- **Affected:**
  - `tests/remediate/phase-close.test.ts:428-504`
- **Evidence:**
  - tests/remediate/phase-close.test.ts:428 - First describe block covers empty-staging success for commit/push/open-pr/custom actions.
  - tests/remediate/phase-close.test.ts:483 - A second describe block repeats the same vacuous-success scenario under the MNT-a01af494 label.
  - tests/remediate/phase-close.test.ts:436 - Both blocks assert success status and empty commands after building equivalent closing_plan states.
- _verified: phase-close.test.ts:428 and 483 two adjacent describe blocks exercise same stageAndCommit empty-tree vacuous-success with duplicated setup._

### Executor dispatch metadata requires registry sync tests

- **Lens:** maintainability · **Category:** drift-guard-duplication · **Confidence:** high
- **Summary:** Executor dispatch facts are spread across the priority chain, executor registry, host-delegation list, and runner map, with this test enforcing that each obligation is claimed once and has the right runner shape. Adding or moving an obligation requires coordinated edits in multiple tables, so dispatch metadata should be single-sourced into one declarative registry.
- **Affected:**
  - `tests/audit/executor-registry-sync.test.mjs:9-18`
- **Evidence:**
  - tests/audit/executor-registry-sync.test.mjs:9 - The test loops over every PRIORITY entry and looks for exactly one matching EXECUTOR_REGISTRY owner.
  - tests/audit/executor-registry-sync.test.mjs:76 - The same file separately reconciles PRIORITY obligations with EXECUTOR_RUNNERS and a local host-delegated dispatch set.
- _verified: executor-registry-sync.test.mjs:9 loops PRIORITY against EXECUTOR_REGISTRY; dispatch metadata spread across multiple tables — drift guard confirmed._

### File-lock constants are kept in sync with docs by a test

- **Lens:** maintainability · **Category:** drift-guard-duplication · **Confidence:** high
- **Summary:** The file-lock backoff and stale-lock contract is duplicated between source constants and CLAUDE.md, then policed by a sync test. Any legitimate lock-timing change must update both the implementation and prose documentation to keep the suite green, so the durable description should be generated or rendered from the same source of truth.
- **Affected:**
  - `tests/audit/file-lock-doc-sync.test.mjs:7-14`
- **Evidence:**
  - tests/audit/file-lock-doc-sync.test.mjs:7 - The test explicitly describes itself as a lockstep guard between CLAUDE.md and fileLock.ts.
  - tests/audit/file-lock-doc-sync.test.mjs:55 - The assertions require the documentation line to include the exact numeric backoff and stale-lock constants.
- _verified: file-lock-doc-sync.test.mjs:7-14 explicitly a lockstep guard between CLAUDE.md prose and fileLock.ts constants._

### Fixture drift guard preserves a duplicate contract copy

- **Lens:** maintainability · **Category:** duplicated-contract-fixture · **Confidence:** high
- **Summary:** The fixture test explicitly byte-compares generator output against a committed JSON fixture, so the generator and checked-in artifact must be kept in sync by convention. That makes contract changes require coordinated edits in multiple places instead of deriving the fixture from one authoritative source.
- **Affected:**
  - `tests/remediate/fixture-generator-drift-guard.test.ts:1-9`
- **Evidence:**
  - tests/remediate/fixture-generator-drift-guard.test.ts:2 - the test is a named drift guard that byte-compares generated output with a committed fixture rather than eliminating the duplicate artifact.
  - tests/remediate/fixture-generator-drift-guard.test.ts:31 - the test invokes scripts/remediate/generate-auditor-contract-fixture.mjs, proving the generator and committed fixture are separate sources that must remain byte-identical.
- _verified: fixture-generator-drift-guard.test.ts:1-9 byte-compares generator output vs committed fixture; duplicate artifact confirmed._

### lens-selection test hardcodes the magic constant 11 for the canonical lens count instead of asserting against LENSES.length

- **Lens:** maintainability · **Category:** magic-constant · **Confidence:** high
- **Summary:** Multiple assertions pin `lenses.length === 11` with a comment '(from LENSES const)'. Adding/removing a canonical lens requires hand-editing these literals; asserting against the imported LENSES.length would single-source the count and avoid the drift.
- **Affected:**
  - `tests/audit/lens-selection.test.mjs:29`
- **Evidence:**
  - tests/audit/lens-selection.test.mjs:29 and :34 - the canonical lens count is duplicated as the literal 11; it should be derived from the LENSES registry the module re-exports so the test cannot drift from the source of truth.
- _verified: lens-selection.test.mjs:29 and :34 hardcode literal 11 with '(from LENSES const)' comment; not derived from LENSES.length._

### Module slugging is duplicated across pipeline modules

- **Lens:** maintainability · **Category:** duplicated-contract · **Confidence:** high
- **Summary:** The obligation-ledger ID slugger and the phase-cut reverse mapping slugger implement the same format in separate modules, with a comment saying they must stay in lockstep. Any future slug-format edit has to be made in both places to preserve node-to-phase decoding, so this should be single-sourced.
- **Affected:**
  - `src/remediate/contractPipeline/derive.ts:419-423`
  - `src/remediate/contractPipeline/phaseCut.ts:133-135`
- **Evidence:**
  - src/remediate/contractPipeline/derive.ts:419 - slug() lowercases, hyphenates, and trims module names for obligation IDs.
  - src/remediate/contractPipeline/phaseCut.ts:129 - The phase-cut helper says its moduleSlug must stay in lockstep with derive.ts.
  - src/remediate/contractPipeline/phaseCut.ts:133 - moduleSlug() repeats the same lower/hyphen/trim transformation instead of importing a shared helper.
- _verified: derive.ts:419 slug() and phaseCut.ts:133 moduleSlug() both lowercase/hyphen/trim; comment says must stay in lockstep — duplicated._

### Packet prompt contract is asserted in multiple test bodies

- **Lens:** maintainability · **Category:** duplicated-contract-assertions · **Confidence:** high
- **Summary:** The packet prompt write/inline-forbid contract is hand-spelled in more than one test suite. Any wording or contract change must be edited in multiple places to stay correct; move the prompt contract checks into one shared helper or fixture.
- **Affected:**
  - `tests/audit/review-packets.test.mjs:1148-1152`
  - `tests/audit/rolling-dispatch-executor.test.mjs:214-222`
- **Evidence:**
  - tests/audit/review-packets.test.mjs:1148-1152 - generated-prompt test asserts result_path, WRITE-array, no inline emission, and no submit-packet text directly.
  - tests/audit/rolling-dispatch-executor.test.mjs:214-222 - buildPacketPrompt test repeats the same WRITE-array and forbid-inline/no-write-file contract with separate regexes.
- _verified: review-packets.test.mjs:1149 and rolling-dispatch-executor.test.mjs:214-216 both assert same WRITE-array/result_path/forbid-inline regexes._

### Packet submission loop is duplicated

- **Lens:** maintainability · **Category:** duplicated-test-helper-logic · **Confidence:** high
- **Summary:** `audit-code-wrapper.test.mjs` has a shared `submitAllPackets` helper but later reimplements the same packet-result construction and `submit-packet` call inside `submitPlannedPackets`. Any change to packet submission shape, task lookup, or wrapper invocation must be edited in both places to keep the wrapper integration tests correct.
- **Affected:**
  - `tests/audit/audit-code-wrapper.test.mjs:393-403`
  - `tests/audit/audit-code-wrapper.test.mjs:786-805`
- **Evidence:**
  - tests/audit/audit-code-wrapper.test.mjs:393 - `submitAllPackets` builds packet results from `resultMap.entries`, maps them through `validAuditResultForTask`, and invokes `submit-packet`.
  - tests/audit/audit-code-wrapper.test.mjs:786 - nested `submitPlannedPackets` repeats the same result-map filtering, result construction, and `submit-packet` wrapper call instead of reusing the helper.
- _verified: audit-code-wrapper.test.mjs:393 submitAllPackets and :786 submitPlannedPackets repeat identical resultMap filter + submit-packet call._

### Path-risk pattern matching loop duplicated across two functions in riskSignal.ts

- **Lens:** maintainability · **Category:** duplicated-logic · **Confidence:** high
- **Summary:** The normalize-distinct-files + iterate-patterns + collect-matched-labels loop is implemented verbatim twice — in computeIntakeRiskSignal and in decompositionRiskEvidence. Any change to how path-risk families are matched must be edited in both places to stay correct.
- **Affected:**
  - `src/remediate/riskSignal.ts:202-207`
  - `src/remediate/riskSignal.ts:332-337`
- **Evidence:**
  - src/remediate/riskSignal.ts:197-207 and 329-337 - identical path-normalization + pattern-family matching loop in two functions; should be extracted to one shared `matchPathRiskFamilies(files, patterns)` helper.
- _verified: riskSignal.ts:202-207 and :332-337 identical pattern-family matching loop in two functions._

### Priority-chain documentation duplicates the runtime array

- **Lens:** maintainability · **Category:** drift-guard-duplication · **Confidence:** high
- **Summary:** The obligation priority chain exists as both an exported runtime array and a manually maintained CLAUDE.md sentence, with a test comparing the two. Reordering, adding, or renaming obligations now requires matching edits in implementation and docs; the documented chain should be generated from the exported priority data or embedded from a shared renderer.
- **Affected:**
  - `tests/audit/priority-chain-doc-sync.test.mjs:7-10`
- **Evidence:**
  - tests/audit/priority-chain-doc-sync.test.mjs:7 - The test calls out that CLAUDE.md must stay byte-for-byte aligned with the step PRIORITY array.
  - tests/audit/priority-chain-doc-sync.test.mjs:17 - The test reads CLAUDE.md and extracts the documented chain instead of generating it from the priority source.
- _verified: priority-chain-doc-sync.test.mjs:7-10 lockstep guard byte-aligning CLAUDE.md docs with PRIORITY array._

### SessionConfig provider is repeatedly read via ad-hoc inline casts instead of a typed accessor

- **Lens:** maintainability · **Category:** repeated-unsafe-cast · **Confidence:** high
- **Summary:** The configured provider is pulled out of SessionConfig with the same inline `(sessionConfig as { provider?: ResolvedProviderName } | ...)?.provider ?? "claude-code"` cast in multiple places (driveRollingImplementDispatch, buildImplementDispatchStep). The shape and the default fallback are duplicated by convention; a single typed helper (e.g. resolveProviderName(sessionConfig)) would prevent the default or the cast shape drifting between call sites.
- **Affected:**
  - `src/remediate/steps/nextStep.ts:959-961`
  - `src/remediate/steps/nextStep.ts:1970-1972`
- **Evidence:**
  - src/remediate/steps/nextStep.ts:959 - inline cast + "claude-code" default to read the provider
  - src/remediate/steps/nextStep.ts:1970 - the same inline cast + default duplicated; both must stay in sync by convention
- _verified: nextStep.ts:959-961 and :1970-1972 duplicate inline (sessionConfig as {provider?})?.provider ?? 'claude-code' cast._

### Temporary migration guards have become durable maintenance load

- **Lens:** maintainability · **Category:** stale-regression-guard · **Confidence:** high
- **Summary:** The no-opentoken guard says it is not a forever invariant and can be retired once the migration is trusted, but it remains as a repo-wide source scan. Keeping temporary migration enforcement in the normal shared suite adds a standing edit point for future unrelated source changes instead of encoding the durable contract in the removed API surface.
- **Affected:**
  - `tests/shared/no-opentoken-guard.test.mjs:9-11`
- **Evidence:**
  - tests/shared/no-opentoken-guard.test.mjs:9 - The test explicitly labels itself a non-permanent migration guard, but it still scans source as part of the shared test suite.
- _verified: no-opentoken-guard.test.mjs:9-11 self-labels as non-permanent migration/regression guard still scanning source in shared suite._

### Two near-identical structured-stderr emit blocks duplicated in handleResult

- **Lens:** maintainability · **Category:** duplicated-logic · **Confidence:** high
- **Summary:** The host-session-escalation strand and the rate_limited requeue each open-code the same try/JSON.stringify({ts,kind,packet_id,exhausted_pool_id})+stderr.write/catch pattern. The shape (ts, packet_id, exhausted_pool_id, swallowed catch) must be edited in two places to stay consistent; it should be a single emitDispatchEvent(kind, fields) helper.
- **Affected:**
  - `src/shared/dispatch/rollingDispatch.ts:543-555`
  - `src/shared/dispatch/rollingDispatch.ts:563-574`
- **Evidence:**
  - src/shared/dispatch/rollingDispatch.ts:543 - escalation-strand emit block: try { stderr.write(JSON.stringify({ts, kind, packet_id, exhausted_pool_id})) } catch {}
  - src/shared/dispatch/rollingDispatch.ts:563 - requeue emit block: byte-for-byte the same envelope and catch, differing only in `kind` — a single shared emitter would single-source the envelope
- _verified: rollingDispatch.ts:543-555 and :563-574 near-identical try/stderr.write(JSON.stringify({ts,kind,packet_id,exhausted_pool_id}))/catch blocks._

### Unused dead helper `dedupe` in changeClassification.ts

- **Lens:** maintainability · **Category:** dead-code · **Confidence:** high
- **Summary:** The `dedupe` helper at the bottom of changeClassification.ts is not exported and not referenced anywhere in the module; it is orphaned dead code that should be removed.
- **Affected:**
  - `src/remediate/contractPipeline/changeClassification.ts:427-429`
- **Evidence:**
  - src/remediate/contractPipeline/changeClassification.ts:427-429 - module-private `dedupe` defined under a '── Helpers ──' banner but never called within the file and not exported, so no consumer can reach it.
- _verified: changeClassification.ts:427 dedupe() defined once, never called, not exported — orphaned dead code confirmed via grep._

### validation.test.ts mid-file import statements scatter dependencies across the module

- **Lens:** maintainability · **Category:** code-organization · **Confidence:** high
- **Summary:** The file places import statements not only at the top but again at line 341 and line 891, interleaved with describe blocks. Imports buried mid-file make the module's true dependency surface hard to see at a glance and easy to miss when refactoring.
- **Affected:**
  - `tests/remediate/validation.test.ts:341-342`
  - `tests/remediate/validation.test.ts:891-894`
- **Evidence:**
  - tests/remediate/validation.test.ts:341 - a second import block appears 340 lines into the file
  - tests/remediate/validation.test.ts:891 - a third import block appears mid-file before the validateGoalIdConsistency describe
- _verified: validation.test.ts:341 and :891 mid-file import blocks interleaved with describe blocks, well past top-of-file._

### Dropped runtime results use unstructured warning output

- **Lens:** observability · **Category:** unstructured-diagnostic-logging · **Confidence:** high
- **Summary:** When runtime-validation updates drop stale task ids, the orchestrator emits a formatted console warning instead of the structured JSON diagnostic pattern used elsewhere. Operators and log consumers cannot reliably filter this event, count stale drops, or extract the task ids without parsing prose.
- **Affected:**
  - `src/audit/orchestrator/runtimeValidationUpdate.ts:57-62`
- **Evidence:**
  - src/audit/orchestrator/runtimeValidationUpdate.ts:57 - stale runtime validation ids are detected, but the emitted signal is a console.warn format string rather than a structured event.
  - src/audit/orchestrator/rollingDispatch.ts and src/audit/orchestrator/runtimeCommand.ts emit JSON diagnostics to stderr for comparable orchestrator events, so this warning is harder to monitor consistently.
- _verified: runtimeValidationUpdate.ts:57-62 uses console.warn format string, not structured JSON event; matches quoted_text._

### Grounding/lean/intent diagnostics go to raw process.stderr.write, bypassing RunLogger

- **Lens:** observability · **Category:** inconsistent-logging-channel · **Confidence:** high
- **Summary:** The module threads a structured RunLogger (run.log.jsonl) through the phase handlers, but several operationally significant decisions — findings dropped by grounding, lean fast-path routing, lean light-review escalation, corrupted extracted-plan recovery, and unencodable free_form_intent clauses — are reported only via unstructured `process.stderr.write`. These events never reach the structured run log, so a post-hoc run analysis cannot see why findings were dropped or why the run escalated.
- **Affected:**
  - `src/remediate/steps/nextStep.ts:2208-2211`
  - `src/remediate/steps/nextStep.ts:2825-2827`
- **Evidence:**
  - src/remediate/steps/nextStep.ts:2209 - dropped-findings diagnostic emitted to stderr, not the RunLogger event stream
  - src/remediate/steps/nextStep.ts:2826 - lean light-review escalation (a material routing decision) only on stderr
  - src/remediate/steps/nextStep.ts:2838 - lean fast-path routing decision only on stderr
  - src/remediate/steps/nextStep.ts:4133 - unencodable free_form_intent clauses only on stderr; absent from run.log.jsonl
- _verified: nextStep.ts:2209 and 2825 use process.stderr.write for grounding-drop and lean-escalation, bypassing RunLogger; quoted_text matches._

### OpenAI-compatible launches lack provider launch/done diagnostics

- **Lens:** observability · **Category:** missing-telemetry · **Confidence:** high
- **Summary:** The shared CLI providers emit structured provider_launch/provider_done JSON lines, but OpenAiCompatibleProvider only appends the raw completion and error messages to log files. Successful API-backed worker runs therefore lack the run-correlated start/end telemetry operators get for the other providers.
- **Affected:**
  - `src/shared/providers/openAiCompatibleProvider.ts:184-244`
  - `src/shared/providers/providerDiagnostics.ts:8-20`
  - `src/shared/providers/claudeCodeProvider.ts:111-116`
- **Evidence:**
  - src/shared/providers/openAiCompatibleProvider.ts:184 - the API provider records the raw completion, then parses/applies it and returns success without emitting provider_launch/provider_done diagnostics.
  - src/shared/providers/providerDiagnostics.ts:8 - the shared diagnostic helpers define run-correlated provider_launch/provider_done events for provider observability.
  - src/shared/providers/claudeCodeProvider.ts:111 - a sibling provider calls those diagnostics around launch, showing the intended telemetry contract that the API provider bypasses.
- _verified: openAiCompatibleProvider.ts:186 appendStdout only; no emitProviderLaunch/Done unlike claudeCodeProvider.ts:111,116._

### Structured audit intake failures are silently swallowed

- **Lens:** observability · **Category:** missing-error-reporting · **Confidence:** high
- **Summary:** When the structured audit source cannot be read or parsed while building the intake risk signal, the catch block records no run-log event, stderr diagnostic, or durable ledger note. Operators later see only the fallback risk signal and have no evidence that the source artifact was corrupt or unreadable.
- **Affected:**
  - `src/remediate/steps/nextStep.ts:2668-2674`
- **Evidence:**
  - src/remediate/steps/nextStep.ts:2668 - The structured audit source parse/read failure is caught with no error object binding and no logging or persisted diagnostic before falling back to summary-derived paths.
- _verified: Empty catch swallows audit-source read/parse failure at nextStep.ts:2731 (cited 2668 off, but defect present), no logging._

### Backoff test waits on real time

- **Lens:** performance · **Category:** slow-real-time-test · **Confidence:** high
- **Summary:** The exponential-backoff regression test measures wakeups by calling the real `setTimeout`, so this single assertion waits roughly 1.2 seconds on every run. Injecting or mocking the sleep primitive would preserve the performance contract without adding wall-clock latency to the shared unit suite.
- **Affected:**
  - `tests/shared/fileLock.test.mjs:585-588`
- **Evidence:**
  - tests/shared/fileLock.test.mjs:585 - The test sets a 1200 ms timeout and awaits the real acquireLock timeout path instead of advancing mocked timers.
- _verified: fileLock.test.mjs:585-588 uses real 1200ms acquireLock timeout path; quoted_text matches._

### 'timeout' outcome path is never tested (only success / rate_limited / error)

- **Lens:** tests · **Category:** missing-edge-case · **Confidence:** high
- **Summary:** RollingDispatchResult.outcome includes 'timeout', and handleResult maps it to a distinct quota outcome treated as terminal (not re-queued). The test suite exercises success, rate_limited, and error outcomes but never a 'timeout' result, leaving its terminal-completion and quota-recording branch unverified.
- **Affected:**
  - `src/shared/dispatch/rollingDispatch.ts:502-505`
- **Evidence:**
  - tests/shared/rollingDispatch.test.mjs:1 - no test in the file returns { outcome: 'timeout' }; the dispatchPacket stubs only emit success/rate_limited/error, so the timeout arm of the quotaOutcome map and its terminal handling are uncovered
- _verified: rollingDispatch.ts:502-505 timeout arm exists; no test emits outcome:'timeout' (grep 0 hits)._

### buildTestFileIndex / walkTestFiles bounded recursive scan untested (max-cap, skip-dirs, visited bound)

- **Lens:** tests · **Category:** missing-coverage · **Confidence:** high
- **Summary:** The exported buildTestFileIndex and its walkTestFiles helper implement a bounded filesystem walk with a result cap (max=400), a 20000-entry visited bound, and a WALK_SKIP_DIRS exclusion set. None of these bounds or skip rules has a test, so a regression (e.g. failing to skip node_modules, or an off-by-one on the cap) would pass CI silently.
- **Affected:**
  - `src/remediate/steps/dispatch.ts:2007-2016`
  - `src/remediate/steps/dispatch.ts:2038`
- **Evidence:**
  - src/remediate/steps/dispatch.ts:2038 - exported buildTestFileIndex has no test references in tests/remediate or tests/shared
  - src/remediate/steps/dispatch.ts:2007 - walkTestFiles bounds (max=400, visited>20000, WALK_SKIP_DIRS) are correctness-relevant scan limits with no edge-case test pinning them
- _verified: walkTestFiles bounds confirmed at dispatch.ts:2007; buildTestFileIndex:2038; zero test references._

### Executor registry sync test guards duplicated dispatch tables

- **Lens:** tests · **Category:** drift-guard-test · **Confidence:** high
- **Summary:** This test verifies consistency among PRIORITY, EXECUTOR_REGISTRY, EXECUTOR_RUNNERS, and a local host-delegated dispatch allowlist. That is a drift guard over repeated dispatch facts, so the test should become unnecessary by deriving runner and obligation ownership from a single executor definition.
- **Affected:**
  - `tests/audit/executor-registry-sync.test.mjs:9-18`
- **Evidence:**
  - tests/audit/executor-registry-sync.test.mjs:9 - The first test reconciles every priority obligation against registry ownership.
  - tests/audit/executor-registry-sync.test.mjs:76 - The later runner coverage check compares the same priority set to executor runners plus a local host-delegated exception set.
- _verified: executor-registry-sync.test.mjs reconciles PRIORITY vs EXECUTOR_REGISTRY; genuine drift guard as described._

### File-lock doc sync test is a drift guard

- **Lens:** tests · **Category:** drift-guard-test · **Confidence:** high
- **Summary:** The test's purpose is to detect drift between CLAUDE.md prose and fileLock.ts constants, which means the suite is compensating for duplicated contract text. Instead of testing that two manually maintained copies agree, expose the lock timing contract through one shared source and render the documentation from it.
- **Affected:**
  - `tests/audit/file-lock-doc-sync.test.mjs:7-14`
- **Evidence:**
  - tests/audit/file-lock-doc-sync.test.mjs:7 - The header describes the test as a lockstep guard between documentation and source constants.
  - tests/audit/file-lock-doc-sync.test.mjs:55 - Assertions compare exact numeric values from source to the documentation sentence.
- _verified: file-lock-doc-sync.test.mjs:7 lockstep guard between CLAUDE.md prose and fileLock constants; quoted_text matches._

### Host asset drift tests police generated copies

- **Lens:** tests · **Category:** drift-guard-test · **Confidence:** high
- **Summary:** The host asset test suite asserts committed IDE command assets equal fresh renders, which is a drift guard over duplicated generated output rather than direct behavior coverage. The generated assets should be derived from one source during install or packaging so the test does not need to keep committed copies synchronized.
- **Affected:**
  - `tests/audit/host-asset-renderer-drift.test.mjs:118-144`
- **Evidence:**
  - tests/audit/host-asset-renderer-drift.test.mjs:118 - the section labels the checks as no-drift guards for committed rendered assets.
  - tests/audit/host-asset-renderer-drift.test.mjs:120 - one test compares the committed Gemini TOML asset to a fresh render.
  - tests/audit/host-asset-renderer-drift.test.mjs:144 - another failure message instructs maintainers to regenerate the committed VS Code agent file when it drifts.
- _verified: host-asset-renderer-drift.test.mjs drift-guard message present; compares committed assets to fresh renders._

### Integration helpers duplicate the pause contract

- **Lens:** tests · **Category:** fragile-test-harness · **Confidence:** high
- **Summary:** The integration tests advance next-step by hand-maintaining local lists of pause kinds and synthetic responses. Because another test file carries a separate copy of the same contract, future pause kinds can be added to one helper and not the other, creating either false failures or untested paths.
- **Affected:**
  - `tests/audit/next-step.test.mjs:111-175`
  - `tests/audit/audit-code-completion.test.mjs:129-190`
- **Evidence:**
  - tests/audit/next-step.test.mjs:111 - lists the known pause kinds and writes matching host artifacts inside a local helper.
  - tests/audit/audit-code-completion.test.mjs:129 - repeats the same pause-kind contract and synthetic host responses in a second integration helper.
- _verified: next-step.test.mjs and audit-code-completion.test.mjs both carry local pause-kind lists/helpers; duplicated contract confirmed._

### OpenToken removal test is a stale broad-string guard

- **Lens:** tests · **Category:** stale-test-guard · **Confidence:** high
- **Summary:** The test suite still carries a repo-wide migration guard that the file itself says can be retired after confidence in the migration. As a long-lived test, it can fail on harmless future source mentions of the old term while duplicating the real durable guarantee that the removed option/type no longer exists.
- **Affected:**
  - `tests/shared/no-opentoken-guard.test.mjs:9-13`
- **Evidence:**
  - tests/shared/no-opentoken-guard.test.mjs:9 - The test describes itself as a temporary migration guard and says durable protection already comes from deleted plumbing.
- _verified: no-opentoken-guard.test.mjs:9 self-describes as retire-able migration guard; quoted_text matches._

### Priority-chain doc sync test is a drift guard

- **Lens:** tests · **Category:** drift-guard-test · **Confidence:** high
- **Summary:** The test exists solely to keep a manually written CLAUDE.md priority-chain sentence synchronized with the exported PRIORITY array. That makes the test suite police duplicated workflow metadata instead of removing the duplication; generate the documentation from the exported priority data or a shared renderer.
- **Affected:**
  - `tests/audit/priority-chain-doc-sync.test.mjs:7-10`
- **Evidence:**
  - tests/audit/priority-chain-doc-sync.test.mjs:7 - The header says the documented priority chain must stay byte-for-byte aligned with the orchestrator array.
  - tests/audit/priority-chain-doc-sync.test.mjs:20 - The test parses a single CLAUDE.md sentence and compares it to PRIORITY rather than consuming a shared generated source.
- _verified: priority-chain-doc-sync.test.mjs:7 lockstep guard CLAUDE.md sentence vs PRIORITY array; matches._

### Prompt contract drift guard is duplicated across tests

- **Lens:** tests · **Category:** drift-guard-duplication · **Confidence:** high
- **Summary:** Two test files police the same packet-prompt output contract with separate regex assertions. This is a drift guard symptom: prompt contract edits have to be synchronized across both tests instead of being single-sourced through one shared contract assertion.
- **Affected:**
  - `tests/audit/review-packets.test.mjs:1148-1154`
  - `tests/audit/rolling-dispatch-executor.test.mjs:196-222`
- **Evidence:**
  - tests/audit/review-packets.test.mjs:1148-1154 - prepare-dispatch test asserts the generated prompt contains result_path/WRITE/quoted_text and omits inline/submit-packet wording.
  - tests/audit/rolling-dispatch-executor.test.mjs:196-222 - buildPacketPrompt tests assert the same no-submit-packet and WRITE-result-path contract directly.
- _verified: review-packets.test.mjs and rolling-dispatch-executor.test.mjs both assert same packet-prompt contract; duplication confirmed._

### Release helper test depends on exact source syntax

- **Lens:** tests · **Category:** fragile-implementation-shape-test · **Confidence:** high
- **Summary:** The poll-log helper test parses implementation source with regexes for exact const/function declarations before evaluating the helper. A behavior-preserving refactor such as exporting an arrow function or moving the constant would fail the test even though the release contract still works.
- **Affected:**
  - `tests/audit/release-contract.test.mjs:131-140`
- **Evidence:**
  - tests/audit/release-contract.test.mjs:131-140 - the test locates shouldLogPollAttempt by matching a literal function declaration shape instead of importing a public helper contract.
- _verified: helperPattern regex matches literal function-declaration shape of source at line 132; behavior-preserving refactor would break it. Fragile test confirmed._

### Removed CLI commands are checked with fragile source text scans

- **Lens:** tests · **Category:** fragile-test-assertion · **Confidence:** high
- **Summary:** The document-phase removal test reads src/remediate/index.ts and asserts that command strings are absent. This can fail because of comments or docs and can miss a re-registration through a constant or alias, so the test should exercise the actual command registry/parser surface instead.
- **Affected:**
  - `tests/remediate/n-r13-document-phase-dissolved.test.ts:171-178`
- **Evidence:**
  - tests/remediate/n-r13-document-phase-dissolved.test.ts:172 - the test imports node:fs and reads the source file as text.
  - tests/remediate/n-r13-document-phase-dissolved.test.ts:177 - the command-removal assertion is a raw not.toContain string check rather than a CLI registry behavior check.
- _verified: Lines 173-178 read index.ts as text and assert not.toContain on command strings rather than exercising CLI registry. Fragile source-text scan confirmed._

### decompositionRiskEvidence ignores configured file-count thresholds for the medium tier

- **Lens:** correctness · **Category:** logic-error · **Confidence:** medium
- **Summary:** decompositionRiskEvidence raises only to 'medium' when moduleCount > 1, but never considers the breadth (fileScopes count) the way computeIntakeRiskSignal does, so a decomposition revealing a very broad (15+ file) but single-module change produces no escalation evidence even though the same breadth at intake would already be 'high'.
- **Affected:**
  - `src/remediate/riskSignal.ts:338-350`
- **Evidence:**
  - src/remediate/riskSignal.ts:325-351 - decompositionRiskEvidence escalates on path-risk match (high) or moduleCount>1 (medium) only; the union of fileScopes is computed but its cardinality is never compared to mediumFileCount/highFileCount, so a broad single-module decomposition yields undefined (no escalation), unlike computeIntakeRiskSignal which would bump on file count.
- _verified: decompositionRiskEvidence (344-350) escalates to medium only on moduleCount>1; fileScopes cardinality computed (329) but never compared to file-count thresholds. Confirmed._

### providerNodeDispatch treats a successfully-written but contractually-invalid result file as success

- **Lens:** correctness · **Category:** missing-validation · **Confidence:** medium
- **Summary:** After launch, the dispatcher only checks that a result file exists and parses as JSON (readOptionalJsonFile); it returns outcome:"success" without validating the ImplementWorkerResult shape. A worker that writes a syntactically-valid but semantically-wrong JSON (e.g. {} ) is reported success and adjudicated only later by mergeImplementResults, so an empty/garbage result is not caught at the dispatch seam.
- **Affected:**
  - `src/remediate/steps/providerNodeDispatch.ts:153-170`
- **Evidence:**
  - src/remediate/steps/providerNodeDispatch.ts:153 - result presence + parse is the only gate before returning outcome:"success"; the comment acknowledges contents are adjudicated downstream, so this is by design — recorded as a deferred-validation note, not a hard bug.
- _verified: Line 153-170: only presence+parse gate before outcome success; no ImplementWorkerResult shape validation. By-design deferred validation, accurately described._

### rekeyDriftedResults passes possibly-undefined task_id to maxRedispatchAttempt

- **Lens:** correctness · **Category:** missing-validation · **Confidence:** medium
- **Summary:** In rekeyDriftedResults the drift branch calls maxRedispatchAttempt(existingLedger, result.task_id) even though result.task_id is optional (string | undefined). Earlier in the same function task_id being undefined is guarded (the task lookup short-circuits), but only when there is no matching task; a result with a matching task whose task_id is nonetheless empty would feed an empty/undefined key into the attempt counter and into the re-keyed redispatch record.
- **Affected:**
  - `src/audit/orchestrator/resultBaseline.ts:322`
- **Evidence:**
  - src/audit/orchestrator/resultBaseline.ts:322 - result.task_id (typed optional in AuditResult) is passed to maxRedispatchAttempt whose parameter is a non-optional string; the only guard above (line 279) returns early when no task is found, not when task_id is empty.
  - src/audit/types.ts:202 - AuditResultSchema declares task_id but splitDiscriminatorFromTaskId(result.task_id, ...) elsewhere accepts undefined, confirming task_id is treated as possibly absent.
- _verified: Line 322 passes result.task_id (optional) to maxRedispatchAttempt; guard at 279-280 returns only when no task found, not when task_id empty. Confirmed._

### Stale header doc-comment lists commands the wrapper does not interpret

- **Lens:** correctness · **Category:** misleading-documentation · **Confidence:** medium
- **Summary:** The header comment claims the wrapper 'Supports: run, install, ensure, validate', but the wrapper is purely a pass-through that forwards argv verbatim to dist/remediate/index.js and interprets no subcommands itself. The comment does not cause wrong runtime behavior; the delegation logic is correct.
- **Affected:**
  - `remediate-code.mjs:2-3`
  - `remediate-code.mjs:108-110`
- **Evidence:**
  - remediate-code.mjs:3 - header comment asserts a fixed subcommand set (run, install, ensure, validate) that the wrapper never branches on
  - remediate-code.mjs:108 - main() spreads ...argv straight into the spawned dist entry, proving the wrapper does not parse or restrict subcommands; the listed commands are an artifact of the dist tool, not this file
  - remediate-code.mjs:31-45 - the only wrapper-owned logic is the dist staleness/rebuild decision (shouldBuildDist), which is correct: it rebuilds when dist is missing or older than src/tsconfig
- _verified: Header comment line 3 lists run/install/ensure/validate but wrapper spreads argv verbatim (line 108-ish). Stale misleading doc-comment confirmed; no runtime impact._

### ALL_PATHS / EXPECTED_ROLES in prompts test re-encode CONTRACT_PIPELINE_PHASE_ORDER knowledge

- **Lens:** maintainability · **Category:** duplicated-contract · **Confidence:** medium
- **Summary:** contract-pipeline-prompts.test.ts hand-maintains a full EXPECTED_ROLES list and an ALL_PATHS artifact-name map that mirror the role set already exported as CONTRACT_PIPELINE_PHASE_ORDER and the artifact-path keys the renderer knows. Adding a pipeline phase requires editing the production order, the prompt renderer, and these two hand-kept literals in lockstep.
- **Affected:**
  - `tests/remediate/contract-pipeline-prompts.test.ts:36-52`
  - `tests/remediate/contract-pipeline-prompts.test.ts:17-33`
- **Evidence:**
  - tests/remediate/contract-pipeline-prompts.test.ts:36 - EXPECTED_ROLES literal restates the exported CONTRACT_PIPELINE_PHASE_ORDER role set
  - tests/remediate/contract-pipeline-prompts.test.ts:17 - ALL_PATHS duplicates the renderer's artifact-name set; a new phase must be mirrored here by hand
- _verified: EXPECTED_ROLES + ALL_PATHS literals in test mirror exported CONTRACT_PIPELINE_PHASE_ORDER/renderer artifact set; hand-kept duplication confirmed._

### audit-cli-invariants 'structural' tests assert local reimplementations instead of source behavior

- **Lens:** maintainability · **Category:** inconsistent-abstractions · **Confidence:** medium
- **Summary:** Several INV tests assert JS language truths or a checkMutex reimplementation of the fixed logic rather than exercising the real source, so the test body must be kept in sync with the source by hand and gives a false sense of coverage.
- **Affected:**
  - `tests/audit/audit-cli-invariants.test.mjs:268-278`
  - `tests/audit/audit-cli-invariants.test.mjs:233-241`
- **Evidence:**
  - tests/audit/audit-cli-invariants.test.mjs:270-273 - checkMutex is a copy of the source logic, not the source
  - tests/audit/audit-cli-invariants.test.mjs:236-240 - asserts Array.isArray semantics, not cmdImportExternalAnalyzer behavior
- _verified: Lines 270-273 checkMutex is a copy of source logic ('mirrors the fixed logic'); 236+ asserts Array.isArray semantics not source behavior. Confirmed._

### Dead-code check flags diverge between knip.json config and the check:deadcode script

- **Lens:** maintainability · **Category:** duplicated-configuration · **Confidence:** medium
- **Summary:** Knip is configured in two places: the static knip.json file and inline flags in the check:deadcode npm script. The script overrides config-implied behavior with --include and --no-config-hints, so the effective dead-code policy is split across two files that must be kept consistent by hand.
- **Affected:**
  - `package.json:49`
  - `knip.json:1-12`
- **Evidence:**
  - package.json:49 - check:deadcode passes --include exports,types,nsExports,nsTypes and --no-config-hints on the CLI rather than encoding them in knip.json
  - knip.json:1-12 - the knip config file holds entry/project/ignore settings but not the include/hints policy, so the full knip behavior requires reading both files
- _verified: package.json:49 check:deadcode passes --include/--no-config-hints on CLI; knip.json holds entry/project only. Policy split across two files confirmed._

### Magic threshold constants (12, 2000, 3, 4, spread>=2) hard-coded in test bodies instead of imported

- **Lens:** maintainability · **Category:** magic-constants · **Confidence:** medium
- **Summary:** Tests pin MAX_LENS_VERIFICATION_FILES (12), the large_lens_surface line threshold (2000), source-count/file-count thresholds (3/4), and the conflict spread cutoff (2) as bare numbers in fixtures and assertions. If a source constant changes, every literal must be hunted down and re-tuned by hand.
- **Affected:**
  - `tests/audit/orchestrator-remediation.test.mjs:790-794`
  - `tests/audit/orchestrator-remediation.test.mjs:1541-1545`
- **Evidence:**
  - tests/audit/orchestrator-remediation.test.mjs:791 - literal 12 stands in for MAX_LENS_VERIFICATION_FILES
  - tests/audit/orchestrator-remediation.test.mjs:1541-1544 - literal 2000 threshold encoded only in a comment + fixture arithmetic
- _verified: Magic literals 12/2000 hard-coded in test assertions/comments instead of imported constants. Confirmed at cited lines._

### makeHandoffArtifactPaths and writeAuditCodeHandoffArtifacts payload built inline twice rather than via the factory

- **Lens:** maintainability · **Category:** duplicated-logic · **Confidence:** medium
- **Summary:** Two adjacent handoff-write tests build the full writeAuditCodeHandoffArtifacts argument object inline (status/repo_root/.../artifact_paths) verbatim instead of sharing one helper; the only difference is whether the result is awaited or caught. New required fields must be added in both literals.
- **Affected:**
  - `tests/audit/supervisor-remediation.test.mjs:114-126`
  - `tests/audit/supervisor-remediation.test.mjs:142-153`
- **Evidence:**
  - tests/audit/supervisor-remediation.test.mjs:114-126 - inline payload in the 'wraps filesystem failures' test
  - tests/audit/supervisor-remediation.test.mjs:142-153 - identical inline payload (minus artifact_paths arg shape) in the 'preserves original error as cause' test
- _verified: Two adjacent tests build writeAuditCodeHandoffArtifacts payload inline verbatim rather than sharing a helper. Duplicated test fixture confirmed._

### Parallel artifact-name lists: phase order vs validator registry kept in sync by convention

- **Lens:** maintainability · **Category:** duplicated-logic · **Confidence:** medium
- **Summary:** CONTRACT_PIPELINE_PHASE_ORDER (in contractPipelinePrompts.ts) and CONTRACT_PIPELINE_VALIDATORS (in validation/contractPipeline.ts) each enumerate the contract-pipeline artifacts independently. Adding or renaming a pipeline phase requires editing both lists in lockstep with no shared source enforcing parity.
- **Affected:**
  - `src/remediate/steps/contractPipelinePrompts.ts:500-516`
  - `src/remediate/validation/contractPipeline.ts:698-714`
- **Evidence:**
  - src/remediate/steps/contractPipelinePrompts.ts:500-516 enumerates phases; src/remediate/validation/contractPipeline.ts:695-714 enumerates the matching artifact validators — two hand-maintained lists over the same artifact set, kept consistent by convention rather than a single source.
- _verified: CONTRACT_PIPELINE_PHASE_ORDER (prompts.ts:500) and CONTRACT_PIPELINE_VALIDATORS (validation) each enumerate phases independently; parity by convention confirmed._

### quotaOutcome derivation mixes an `as const` assertion onto only the fallback arm of a chained ternary

- **Lens:** maintainability · **Category:** unclear-abstraction · **Confidence:** medium
- **Summary:** The quotaOutcome ternary already maps three explicit outcomes, then applies `as const` to only the trailing 'timeout' literal. The whole map of RollingDispatchResult.outcome → quota outcome would be clearer and safer as a small lookup object/exhaustive switch, since result.outcome and the quota outcome enum are the same four strings and the ternary is just an identity map with the lone `as const` reading as an afterthought.
- **Affected:**
  - `src/shared/dispatch/rollingDispatch.ts:502-505`
- **Evidence:**
  - src/shared/dispatch/rollingDispatch.ts:502 - a 4-way identity ternary mapping outcome→quotaOutcome with `as const` on only the last arm; an exhaustive switch over the shared union would be self-documenting and catch a future added outcome member
- _verified: Lines 502-505: 4-way identity ternary with `as const` only on trailing arm; switch/lookup would be clearer. Stylistic observation accurate._

### Rate-limit channel-detection branch duplicated for stderr and stdout in dispatcher

- **Lens:** maintainability · **Category:** duplicated-logic · **Confidence:** medium
- **Summary:** makeProviderNodeDispatcher repeats the read-channel-text → detectRateLimitFromChannel → return rate_limited block twice (once for stderr/error, once for stdout/status). The two near-identical branches should be a single small helper so the rate-limit-return shape is defined once.
- **Affected:**
  - `src/remediate/steps/providerNodeDispatch.ts:145-149`
  - `src/remediate/steps/providerNodeDispatch.ts:157-161`
- **Evidence:**
  - src/remediate/steps/providerNodeDispatch.ts:145-149 and 157-161 - the same read-text/detect/return-rate_limited pattern appears for two (path, channel) pairs; extracting a `checkChannelForRateLimit(path, channel)` helper would single-source the rate-limit return shape.
- _verified: providerNodeDispatch.ts:145-149 & 157-161 — two near-identical read-text/detect/return-rate_limited branches confirmed verbatim._

### Repeated await setupTmpQuotaDir() / setQuotaStateDir global mutation in every test instead of a shared beforeEach

- **Lens:** maintainability · **Category:** duplicated-logic · **Confidence:** medium
- **Summary:** Nearly every test opens with `await setupTmpQuotaDir();`, which mutates the process-global quota state dir via setQuotaStateDir. The setup is copy-pasted into ~20 test bodies; forgetting it in a new test silently shares the previous test's quota dir. A single beforeEach (node:test t.beforeEach / a wrapping helper) would single-source the per-test isolation contract.
- **Affected:**
  - `tests/shared/rollingDispatch.test.mjs:53-57`
  - `tests/shared/rollingDispatch.test.mjs:133-138`
- **Evidence:**
  - tests/shared/rollingDispatch.test.mjs:53 - setupTmpQuotaDir mutates a process-global (setQuotaStateDir) and must be remembered as the first line of each test
  - tests/shared/rollingDispatch.test.mjs:133 - representative of ~20 tests each repeating `await setupTmpQuotaDir();`; the isolation invariant lives in convention, not a shared beforeEach
- _verified: rollingDispatch.test.mjs:53 setupTmpQuotaDir mutates global via setQuotaStateDir; called as first line in tests (e.g. 134). Convention-based isolation._

### Repeated broker scenario setup in wave scheduler tests

- **Lens:** maintainability · **Category:** duplicated-test-fixtures · **Confidence:** medium
- **Summary:** The wave scheduler tests repeatedly hand-build broker cooldown scenarios inline instead of sharing a small fixture/scenario helper. Changes to broker inputs or quota snapshot shape now require editing many long test blocks that are meant to exercise the same setup pattern.
- **Affected:**
  - `tests/remediate/wave-scheduler.test.ts:498`
  - `tests/remediate/wave-scheduler.test.ts:713`
- **Evidence:**
  - tests/remediate/wave-scheduler.test.ts:498 - createBrokeredRepairDispatch() setup appears repeatedly across the same file.
  - tests/remediate/wave-scheduler.test.ts:691 - the inv-5 cooldown test hand-builds a critical snapshot scenario.
  - tests/remediate/wave-scheduler.test.ts:1363 - the fail-6 cooldown test repeats the same critical-snapshot/follow-up pattern with only capability-pressure differences.
- _verified: wave-scheduler.test.ts:498 createBrokeredRepairDispatch() inline setup confirmed; repeated broker/snapshot scaffolding across file._

### Repeated per-array isRecord-guard + field-validate boilerplate across all artifact validators

- **Lens:** maintainability · **Category:** duplicated-logic · **Confidence:** medium
- **Summary:** Nearly every validator in contractPipeline.ts repeats the same `if (!Array.isArray(v.X)) push; else for (const [i, item] of ... ) { if (!isRecord(item)) {push; continue} ... }` skeleton. The envelope guard was already extracted (validateEnvelope); the array-of-records iteration guard is the next obvious single-source extraction, currently duplicated ~10 times.
- **Affected:**
  - `src/remediate/validation/contractPipeline.ts:354-361`
- **Evidence:**
  - src/remediate/validation/contractPipeline.ts:147-159, 174-186, 210-220, 326-339, 354-368, 384-425, 439-452, 467-482, 513-525, 556-589 - the identical array-of-records iteration-guard skeleton recurs in every validator; a `forEachRecordInArray(v.X, path, issues, fn)` helper would single-source it.
- _verified: contractPipeline.ts:354-365 array-of-records isRecord-guard skeleton confirmed; pattern recurs across validators._

### Rolling default invariant is documented both ways

- **Lens:** maintainability · **Category:** contradictory-test-contract · **Confidence:** medium
- **Summary:** The rolling dispatch test file states that the wave fallback is the default while the actual test block asserts rolling is the default and wave is opt-out. That leaves the expected contract split across contradictory comments and test names, increasing change cost for future scheduler edits.
- **Affected:**
  - `tests/remediate/rolling-dispatch-engine.test.ts:16-17`
- **Evidence:**
  - tests/remediate/rolling-dispatch-engine.test.ts:16 - the file header says the host-wave fallback is the default.
  - tests/remediate/rolling-dispatch-engine.test.ts:519 - the describe block says rolling engine defaults ON and wave is opt-out.
- _verified: rolling-dispatch-engine.test.ts:16 header says wave fallback is DEFAULT/rolling opt-in-off; line 519-521 asserts rolling defaults ON, wave opt-out. Contradictory._

### Unused sanitizeField helper in taskBuilder.ts

- **Lens:** maintainability · **Category:** dead-code · **Confidence:** medium
- **Summary:** sanitizeField is defined at the bottom of taskBuilder.ts but is not referenced anywhere in the module; the rationale builders inline their own strings. Dead code adds maintenance surface and misleads readers into thinking task fields are sanitized when they are not.
- **Affected:**
  - `src/audit/orchestrator/taskBuilder.ts:483-486`
- **Evidence:**
  - src/audit/orchestrator/taskBuilder.ts:483 - sanitizeField is declared but has no call site within the file; rationale closures build strings directly (lines 436-441, 466-471) without calling it.
- _verified: taskBuilder.ts:484 sanitizeField declared; grep shows only the declaration, no call site. Dead code._

### Corrupted extracted-plan recovery loses the original parse error from durable telemetry

- **Lens:** observability · **Category:** lost-error-context · **Confidence:** medium
- **Summary:** When normalizeExtractedPlan throws, handlePendingExtractedPlan deletes extracted-plan.json and writes the error only to stderr before returning null. The triggering error message is not captured in the structured run log nor preserved alongside the removed artifact, so a recurring extraction-corruption loop leaves no durable record of why the plan kept failing.
- **Affected:**
  - `src/remediate/steps/nextStep.ts:2282-2284`
- **Evidence:**
  - src/remediate/steps/nextStep.ts:2276-2285 - catch block deletes the file and logs to stderr only; no RunLogger event and no preserved copy of the corrupted plan for diagnosis
- _verified: nextStep.ts:2276-2285 catch unlinks plan, writes only to stderr, returns null — no RunLogger event, no preserved copy._

### External analyzer engine defaults its logger to a no-op, so spawn/parse/gate failures vanish unless a logger is injected

- **Lens:** observability · **Category:** logging-gap · **Confidence:** medium
- **Summary:** runExternalAnalyzer/runSafetyGate degrade silently: the injectable `log` defaults to `() => {}`. Skips, not_resolved, spawn_error, and parse_error are captured in the returned status records (good), but the default no-op logger means an operator running without wiring a logger gets no live signal for why an analyzer was skipped or failed.
- **Affected:**
  - `src/audit/extractors/analyzers/acquisitionEngine.ts:273-274`
- **Evidence:**
  - src/audit/extractors/analyzers/acquisitionEngine.ts:273 - default logger is a no-op; failure context lives only in the ExternalAnalyzerToolStatus records returned to the caller, which must be surfaced elsewhere or the diagnostics are lost at runtime.
- _verified: acquisitionEngine.ts:274 log defaults to no-op `() => {}`; failures only in returned status records._

### Malformed clarification JSON is silently swallowed with no diagnostic

- **Lens:** observability · **Category:** missing-error-context · **Confidence:** medium
- **Summary:** readIntakeArtifacts catches a JSON parse error on the clarification file and returns undefined with only an inline comment; there is no log/warning emitted, so an operator whose intake-clarifications.json is corrupt sees the step silently re-emitted with no signal that their file was discarded as unreadable.
- **Affected:**
  - `src/remediate/intake.ts:413-421`
- **Evidence:**
  - src/remediate/intake.ts:413-421 - the catch block discards the parse error entirely (no captured error, no log), so a user-supplied but malformed clarification file produces no observable trace of why it was ignored.
- _verified: intake.ts:414-420 catch returns undefined with comment only, no log of parse error. Confirmed verbatim._

### providerNodeDispatch error outcomes carry no node/provider context in a log channel; failures only return an Error object

- **Lens:** observability · **Category:** error-reporting-context · **Confidence:** medium
- **Summary:** The dispatcher returns outcome:"error" with an Error wrapping a message, but emits no structured log event (block_id, provider name, resultPath, stderr tail) at the failure points. Unlike runArtifacts.writeWorkerTaskFiles which emits dispatch_io_error events, this dispatch path has no logger seam, so per-node launch failures are observable only via whatever the caller does with the returned Error.
- **Affected:**
  - `src/remediate/steps/providerNodeDispatch.ts:162-168`
- **Evidence:**
  - src/remediate/steps/providerNodeDispatch.ts:162 - no-result and rejected-launch paths return an Error but emit no structured telemetry; stderr/stdout text is read for rate-limit detection but not logged on the plain error path, losing diagnostic context.
- _verified: providerNodeDispatch.ts:165-167 no-result path returns Error, no structured telemetry/log seam. Confirmed._

### selectiveDeepening always writes a structured summary to stderr unconditionally

- **Lens:** observability · **Category:** logging-verbosity · **Confidence:** medium
- **Summary:** buildSelectiveDeepeningTasks unconditionally emits a JSON strategy_summary line to process.stderr on every invocation with no log-level gate or verbosity flag. While the line is structured (good), it is always-on noise for callers that do not want diagnostic output and cannot be silenced without an env/verbose toggle, unlike the rest of the orchestrator which has no per-module logging.
- **Affected:**
  - `src/audit/orchestrator/selectiveDeepening/index.ts:193-202`
- **Evidence:**
  - src/audit/orchestrator/selectiveDeepening/index.ts:193 - direct process.stderr.write of a JSON log line with level:info, fired on every call with no AUDIT_CODE_VERBOSE / log-level guard (contrast anchorGrounding which gates behavior on AUDIT_CODE_DISABLE_ANCHORS).
- _verified: selectiveDeepening/index.ts:193-202 unconditional process.stderr.write of JSON line, no verbose gate. Confirmed._

### Terminal completions (success/timeout/error) and stranding emit no structured observability line

- **Lens:** observability · **Category:** missing-logging · **Confidence:** medium
- **Summary:** The engine emits structured stderr lines only on the two rate_limited paths (requeue, host-session strand). Successful/timeout/error completions, the empty-pool strandPending() path, and quota-record failures are silent, so an operator cannot reconstruct a run's outcome timeline or see why work was stranded by pool exhaustion (as opposed to escalation).
- **Affected:**
  - `src/shared/dispatch/rollingDispatch.ts:578-582`
  - `src/shared/dispatch/rollingDispatch.ts:604-610`
  - `src/shared/dispatch/rollingDispatch.ts:517-519`
- **Evidence:**
  - src/shared/dispatch/rollingDispatch.ts:563 - only the rate_limited requeue path writes a structured stderr line (kind: rolling_dispatch_requeue_rate_limited); no equivalent exists for terminal outcomes
  - src/shared/dispatch/rollingDispatch.ts:604 - strandPending() (the all-pools-exhausted strand path) silently moves packets to strandedIds with no log, unlike the host-session-escalation strand at line 544 which does emit a line
  - src/shared/dispatch/rollingDispatch.ts:517 - quota recordWaveOutcome failures are swallowed with an empty catch and no warning, so silent quota-accounting drift is invisible to operators
- _verified: rollingDispatch.ts:578-581 terminal completion, 605-609 strandPending, 517-519 quota catch — all silent, no structured line. Confirmed._

### Schema generator has no error handling around per-file write loop

- **Lens:** reliability · **Category:** error-handling · **Confidence:** medium
- **Summary:** The generator iterates WORKER_SCHEMA_SOURCES and writes each schema with no try/catch; a render error or a failed write (permission/ENOSPC) aborts mid-loop, potentially leaving the committed schemas/ directory in a partially-regenerated, internally-inconsistent state until the script is rerun.
- **Affected:**
  - `scripts/audit/generate-schemas.mjs:20-28`
- **Evidence:**
  - scripts/audit/generate-schemas.mjs:20-28 - the for-loop calls renderWorkerJsonSchema then await writeFile with no try/catch; a throw on the Nth file leaves files 1..N-1 rewritten and N..end stale. The drift-guard test catches the inconsistency on the next run, so impact is bounded to a developer-time partial write, not a runtime hazard — hence low severity. The originating REL-001 'syntax-error: Schema generator cannot execute' could not be reproduced: the script parses and the loop body is well-formed.
- _verified: generate-schemas.mjs:20-27 for-loop renderWorkerJsonSchema+writeFile with no try/catch; partial-write on throw. Confirmed._

### ADVANCE_AUDIT_CONTRACT_VERSION exact-string assertion is a pure pinning/change-detector test

- **Lens:** tests · **Category:** brittle-pinning-test · **Confidence:** medium
- **Summary:** INV-audit-cli-06 asserts the contract version equals a hard-coded literal 'audit-code/v1alpha1'. It does not test any behavior; it only forces a test edit whenever the constant changes, adding maintenance churn without catching real defects.
- **Affected:**
  - `tests/audit/audit-cli-invariants.test.mjs:171-173`
- **Evidence:**
  - tests/audit/audit-cli-invariants.test.mjs:171-173 - asserts the constant equals its own literal value
- _verified: audit-cli-invariants.test.mjs:171-172 asserts ADVANCE_AUDIT_CONTRACT_VERSION equals literal; pure pinning/change-detector test._

### Build-free verify assertions rely on substring echo, not on resolving real test targets

- **Lens:** tests · **Category:** fragile-assertion · **Confidence:** medium
- **Summary:** The per-node verify test feeds targeted_commands and then asserts the rendered prompt contains/omits those exact strings. Because the renderer passes the command strings through, the test mostly verifies its own input is echoed rather than that the filtering logic resolves a genuine repo-relative test path; the build-free filtering is better unit-covered (and is) by isBuildFreeVerifyCommand directly.
- **Affected:**
  - `tests/remediate/dispatch-evidence-and-writescope.test.ts:174-176`
- **Evidence:**
  - tests/remediate/dispatch-evidence-and-writescope.test.ts:174 - assertion checks the exact input command string appears in output, a tautological echo rather than a path-resolution check
- _verified: Confirmed: test asserts the exact input command string is echoed in output (line 174-176); a substring-echo check, not path resolution. Valid test-hygiene observation._

### cli-args drift-guard test (count of '.audit-tools' literals) polices duplication that should be single-sourced

- **Lens:** tests · **Category:** drift-guard-test · **Confidence:** medium
- **Summary:** The test 'CLI args code has no .audit-tools path-join literal beyond the single default sentinel' asserts exactly one occurrence of the literal in args.ts. This is a drift guard: the real fix is that the default sentinel string itself is a re-spelling of a path the shared auditToolsPaths module owns. The guard works around the literal still living in DIRECT_CLI_DEFAULTS rather than being single-sourced.
- **Affected:**
  - `tests/audit/cli-args-utils.test.mjs:189-198`
- **Evidence:**
  - tests/audit/cli-args-utils.test.mjs:189 - the test counts literal occurrences to police accidental reintroduction of a path-join literal; the underlying duplication (the sentinel '.audit-tools/audit' in args.ts:23) is the symptom the guard exists to contain.
- _verified: Confirmed: test at line 189-198 counts '.audit-tools' literal occurrences as a drift guard; sentinel still lives in args.ts. Accurate drift-guard observation._

### COARSE_REBLOCK_BOUND / applyCoarseReblock convergence cap lacks a test at the bound boundary

- **Lens:** tests · **Category:** missing-coverage · **Confidence:** medium
- **Summary:** applyCoarseReblock enforces a convergence cap (COARSE_REBLOCK_BOUND = 2). Only one test references applyCoarseReblock; the boundary behavior (re-block allowed at attempt 1, refused at the bound) is the regression-prone part of a convergence guard and warrants an explicit at-the-bound negative test.
- **Affected:**
  - `src/remediate/steps/nextStep.ts:1378`
  - `src/remediate/steps/nextStep.ts:1443`
- **Evidence:**
  - src/remediate/steps/nextStep.ts:1378 - COARSE_REBLOCK_BOUND is a convergence cap; applyCoarseReblock (line 1443) has only a single test reference, so the at-bound refusal (the property that prevents infinite re-blocking) may not be exercised at its boundary
- _verified: COARSE_REBLOCK_BOUND=2 (line 1378), applyCoarseReblock (1443) confirmed. Missing-coverage at-bound claim plausible/accurate as low-sev gap._

### DC-5 paired-gate parity is asserted by a duplicated reimplementation rather than a shared single-source check

- **Lens:** tests · **Category:** drift-guard · **Confidence:** medium
- **Summary:** inv-7 asserts the test-plan gate (validatePairedObligations) and the verify gate (verifyPairingForFinding) agree on the same only-one-polarity case. This is a drift guard: the two gates re-derive the same pairing rule in separate functions and the test exists to keep them in sync. The underlying duplication (two evaluators of one pairing predicate) is the smell; the symptom test could be retired by single-sourcing the polarity evaluation (evaluatePairing already exists and should be the sole authority both gates call).
- **Affected:**
  - `tests/remediate/dc5.test.ts:377-386`
- **Evidence:**
  - tests/remediate/dc5.test.ts:377 - inv-7 is a parity guard policing that two gate functions implement the same pairing rule; the fix is to single-source the predicate (evaluatePairing) so both gates cannot diverge
- _verified: inv-7 at line 377 confirmed; it asserts two gates agree, a parity drift-guard. Accurate observation._

### Handoff-cause test relies on filesystem error-code (ENOTDIR/EEXIST) being one of an unasserted set, making the negative path platform-fragile

- **Lens:** tests · **Category:** fragile-test · **Confidence:** medium
- **Summary:** The OBS-3063e7e9 test induces a write failure by placing a file where a directory is expected and then asserts only that cause.code is a string. The comment names ENOTDIR/EEXIST, but the assertion accepts any code; on a platform where mkdir-over-a-file does not fail (or fails differently), the test could pass or fail for the wrong reason without surfacing it.
- **Affected:**
  - `tests/audit/supervisor-remediation.test.mjs:164-168`
- **Evidence:**
  - tests/audit/supervisor-remediation.test.mjs:136-138 - failure induced by writing a file at the incoming_dir path
  - tests/audit/supervisor-remediation.test.mjs:164-168 - asserts only that cause.code is a string, not the expected ENOTDIR/EEXIST named in the comment
- _verified: Confirmed: line 164-168 asserts only typeof cause.code==='string', comment names ENOTDIR/EEXIST but assertion accepts any code. Accurate fragility note._

### large_lens_surface threshold encoded only in fixture arithmetic + comments, so the trigger boundary is asserted implicitly

- **Lens:** tests · **Category:** magic-constant-in-test · **Confidence:** medium
- **Summary:** Tests prove the 2000-line large_lens_surface boundary by choosing line counts that sum to 2050 (fires) or 1900 (does not), with the threshold living only in a comment. If the source constant changes, these fixtures silently mis-test the boundary without any failure pointing at the real cause.
- **Affected:**
  - `tests/audit/orchestrator-remediation.test.mjs:1614-1619`
- **Evidence:**
  - tests/audit/orchestrator-remediation.test.mjs:1541 - 2050 >= 2000 boundary only in a comment
  - tests/audit/orchestrator-remediation.test.mjs:1614-1619 - 1900 < 2000 boundary only in a comment; threshold not imported
- _verified: Confirmed: 2000 boundary lives only in comments (line 1614-1619); threshold not imported. Accurate magic-constant observation._

### No test asserts non-negative wait-then-strand timing or that run() terminates under a fixed bound — strand tests rely on implicit pool-exhaustion only

- **Lens:** tests · **Category:** missing-edge-case · **Confidence:** medium
- **Summary:** The stranding tests reach the empty-pool terminal only via all-pools-rate-limited (exhaustedPoolIds). There is no test that run() still terminates (rather than spinning on the 50ms retry) when packets are blocked but pools are NOT marked exhausted — the exact gap behind COR-001/TST-006, so the suite cannot detect a future infinite-wait regression.
- **Affected:**
  - `tests/shared/rollingDispatch.test.mjs:408-436`
- **Evidence:**
  - tests/shared/rollingDispatch.test.mjs:408 - the only run()-must-resolve termination guarantee is asserted via pool exhaustion (rate_limited on every pool); no test covers termination when the blocker is the maxConcurrentPerPool cap with no pool exhausted
- _verified: Confirmed: only run()-terminates test is via all-pools-rate_limited exhaustion (line 408-436); no cap-blocked-without-exhaustion case. Accurate gap._

### Overlapping reproducibility/migration tests cover near-identical paths with high redundancy

- **Lens:** tests · **Category:** redundant-tests · **Confidence:** medium
- **Summary:** Multiple tests assert the same fail-safe and reproducibility behavior with slightly different framing: two all-stale migration fail-safe tests (inv-4 and the earlier old-shape test) and two persist/reload reproducibility tests (inv-8 and the earlier round-trip test) overlap substantially, increasing maintenance surface without proportional added coverage.
- **Affected:**
  - `tests/audit/staleness.test.mjs:622-652`
  - `tests/audit/staleness.test.mjs:730-776`
- **Evidence:**
  - tests/audit/staleness.test.mjs:622-652 and 730-776 - two old-shape-manifest all-stale fail-safe tests with the same assertions over the same artifact list
  - tests/audit/staleness.test.mjs:668-678 and 863-944 - two persist/reload reproducibility tests covering overlapping stale-set-identity claims
- _verified: Confirmed: two old-shape all-stale fail-safe tests at 622 and 730 with overlapping assertions. Accurate redundancy observation._

### quarantineUncommittedWorktreeEdits has no test, while quarantineFailedNodeCommit does — asymmetric coverage of the quarantine path

- **Lens:** tests · **Category:** missing-coverage · **Confidence:** medium
- **Summary:** quarantineFailedNodeCommit is tested but its sibling quarantineUncommittedWorktreeEdits (handling the uncommitted-edits failure variant of the same recovery seam) has zero test references, leaving half of the quarantine recovery contract unverified.
- **Affected:**
  - `src/remediate/steps/dispatch.ts:883`
- **Evidence:**
  - src/remediate/steps/dispatch.ts:883 - exported quarantineUncommittedWorktreeEdits has no references in tests/remediate or tests/shared, whereas quarantineFailedNodeCommit (line 839) is referenced by a test — an asymmetric gap in the worktree-quarantine recovery seam
- _verified: Confirmed via grep: only quarantineFailedNodeCommit is tested; quarantineUncommittedWorktreeEdits (line 883) has zero test refs. Asymmetric gap real._

### Renderer tests assert paths under packages/remediate-code/ that no longer exist post-A12 collapse

- **Lens:** tests · **Category:** stale-fixture-path · **Confidence:** medium
- **Summary:** The dispatch renderer tests build findings whose affected_files and write-scope use 'packages/remediate-code/src/steps/dispatch.ts' and assert build/test command forms scoped to '-w packages/remediate-code', but the repo is a single package (A12 collapsed the monorepo) with sources under src/remediate/. The tests still pass because they assert on rendered prompt text rather than real paths, so they pin an obsolete monorepo path convention as expected output.
- **Affected:**
  - `tests/remediate/dispatch-evidence-and-writescope.test.ts:61`
  - `tests/remediate/dispatch-evidence-and-writescope.test.ts:200-201`
- **Evidence:**
  - tests/remediate/dispatch-evidence-and-writescope.test.ts:61,160-203 - fixtures and assertions reference packages/remediate-code/* and '-w packages/remediate-code', a layout that no longer exists per the single-package A12 collapse (sources now under src/remediate/). The assertions are on rendered prompt strings so they remain green, but they validate against a stale path convention rather than the real workspace, weakening their value as a guard. Low severity: the renderer logic under test (build-free filtering, node-id substitution) is still meaningfully exercised; the path nouns are cosmetic-but-misleading. The originating TST-001 high/high rating overstates impact — this is a fixture-hygiene issue, not a coverage hole that hides a real bug.
- _verified: Confirmed: fixtures use 'packages/remediate-code/...' (line 61, 191) and '-w packages/remediate-code' (line 200-201), stale post-A12 single-package layout. Accurate fixture-hygiene note._

### run-artifacts-logging tests rely on an embedded NUL byte in paths to force mkdir/rm failure — platform-fragile

- **Lens:** tests · **Category:** fragile-test · **Confidence:** medium
- **Summary:** Two tests inject '\x00' into a path to make Node reject the operation and trigger the catch/log branch. NUL-in-path rejection is an implementation detail of the OS/Node layer; the technique is brittle across platforms/runtimes and couples the test to that quirk rather than to an injectable failure seam.
- **Affected:**
  - `tests/audit/run-artifacts-logging.test.mjs:31`
- **Evidence:**
  - tests/audit/run-artifacts-logging.test.mjs:31 and :76 - failure is forced via a NUL byte in the path; the comment itself notes rm({force:true}) won't throw on missing files so 'a null byte works'. This depends on OS/Node NUL handling rather than an injected fs error, making it fragile.
- _verified: Confirmed: line 31 injects '\x00' NUL byte into path to force mkdir failure; comment confirms OS-NUL-rejection technique. Accurate fragility observation._

### Step-writer single-source guard scans source text with broad regexes

- **Lens:** tests · **Category:** fragile-source-scan-test · **Confidence:** medium
- **Summary:** The single-source guard walks TypeScript files and flags any file containing two broad text patterns. It can false fail on unrelated code mentioning those tokens or miss a duplicate writer expressed differently, so the test is a brittle drift guard rather than a stable contract check.
- **Affected:**
  - `tests/audit/steps-write-current-step.test.mjs:381-395`
- **Evidence:**
  - tests/audit/steps-write-current-step.test.mjs:381-395 - the test recursively scans source text for a steps-dir token and current-step.json token rather than asserting the writer through a shared API boundary.
- _verified: Confirmed: line 388 scans source text with broad regexes (/["']steps["']\s*\)/ and /current-step\.json/). Accurate brittle-source-scan observation._

### validateImplementationDAGIntegrity empty-DAG test asserts only one of several expected coverage errors

- **Lens:** tests · **Category:** weak-assertion · **Confidence:** medium
- **Summary:** The empty-DAG case (nodes: []) leaves both O-1 and O-2 uncovered and CE-1 unaddressed, but the test only asserts an error mentioning O-1. It would still pass if O-2 or the accepted-counterexample coverage check silently regressed, so the negative case is under-specified.
- **Affected:**
  - `tests/remediate/validation.test.ts:1014-1020`
- **Evidence:**
  - tests/remediate/validation.test.ts:1014 - only O-1 coverage is asserted for an empty DAG; O-2 and the accepted CE-1 coverage paths are exercised but not asserted, weakening the regression net
- _verified: Confirmed: empty-DAG test (line 1014-1019) asserts only that some error mentions O-1; O-2/CE coverage not asserted. Accurate weak-assertion note._

### Near-duplicate rationale-builder closures across flow and remainder task blocks

- **Lens:** maintainability · **Category:** duplicated-logic · **Confidence:** low
- **Summary:** buildChunkedAuditTasks builds two almost-identical rationale callbacks (one for critical-flow blocks, one for remainder blocks) that each branch on splitKind large_file/budget/none and append the same external-analyzer-signal suffix; the shared structure is kept consistent only by convention, so a change to the rationale shape must be made in two places.
- **Affected:**
  - `src/audit/orchestrator/taskBuilder.ts:436-441`
  - `src/audit/orchestrator/taskBuilder.ts:466-471`
- **Evidence:**
  - src/audit/orchestrator/taskBuilder.ts:436-441 and 466-471 - two rationale closures share the same large_file/budget/none branch structure and the same hasExternalSignal suffix; only the noun ('critical flow {flow_id}' vs '{unit_id}') differs. Severity is low: the duplication is small and localized to one function. The change-cost tell ('every edit in N places') applies but N=2 and the variance is narrow — supporting keeping MNT-002 at low/low rather than downgrading away, with a recommendation to extract a single rationale helper parameterized by the scope noun.
- _verified: Confirmed: two near-identical rationale closures at 436-441 and 466-471 sharing large_file/budget/none + hasExternalSignal suffix. Accurate small duplication._

### Priority-tier elevation logic duplicated across taskBuilder and selectiveDeepening priorityRank usage

- **Lens:** maintainability · **Category:** duplicated-logic · **Confidence:** low
- **Summary:** The 'high|medium|low' priority tier ordering and elevation appear both inline in taskBuilder.taskPriority (the low->medium->high boost) and via priorityRank imported from auditTaskUtils used in both taskBuilder and selectiveDeepening. The tier ladder is expressed as ad-hoc string comparisons in taskPriority rather than reusing a single tier-ordering primitive, so a future tier change must be made in multiple shapes.
- **Affected:**
  - `src/audit/orchestrator/taskBuilder.ts:79-83`
- **Evidence:**
  - src/audit/orchestrator/taskBuilder.ts:79 - inline string-literal tier elevation ladder, separate from priorityRank (imported line 10) which encodes the same ordering numerically; the two representations must stay consistent by hand.
- _verified: taskBuilder.ts:79-82 has inline low->medium->high string ladder; priorityRank imported separately encodes same ordering numerically. Minor dup, accurate._

### Three parallel postinstall scripts but only the root one is wired to the npm postinstall hook

- **Lens:** maintainability · **Category:** duplicated-logic · **Confidence:** low
- **Summary:** package.json ships three per-area postinstall scripts (root, audit, remediate) in the files list, but only scripts/postinstall.mjs is bound to the npm 'postinstall' hook. The split into area-specific postinstall entry points must be kept in sync by convention rather than via one entry point, so an install-time concern can drift across the three files.
- **Affected:**
  - `package.json:30-33`
  - `package.json:39`
- **Evidence:**
  - package.json:31-33 - files array publishes three sibling postinstall scripts (root + audit + remediate)
  - package.json:39 - only scripts/postinstall.mjs is invoked by the lifecycle 'postinstall' hook; the audit/remediate variants are not referenced by any script field here, so their orchestration lives outside this manifest and is kept consistent by convention
  - Affected scope is narrow (one manifest, install-time only) and impact is low; the finding stands as a minor single-sourcing smell rather than a defect
- _verified: package.json:31-33 lists three postinstall scripts; line 39 wires only scripts/postinstall.mjs. Matches; low single-sourcing smell._

### Three postinstall script paths declared in files but only one is wired

- **Lens:** maintainability · **Category:** inconsistent-abstraction · **Confidence:** low
- **Summary:** The files array ships three separate postinstall scripts (root, audit, remediate) while only scripts/postinstall.mjs is referenced by the postinstall lifecycle hook, leaving the per-area scripts wired only by internal delegation that must stay in sync by convention.
- **Affected:**
  - `package.json:31-33`
  - `package.json:39`
- **Evidence:**
  - package.json:31-33 - three postinstall scripts listed in the published files array
  - package.json:39 - only scripts/postinstall.mjs is invoked by the postinstall hook; the audit/remediate ones rely on delegation that is not expressed in package.json
- _verified: Same as 197 — quoted text matches package.json:31-33 and :39. Duplicate finding but substantiated._

### Several validator tests assert error presence loosely via message substring rather than the issue path

- **Lens:** tests · **Category:** fragile-assertion · **Confidence:** low
- **Summary:** A number of cases assert errors only by errors.length > 0 or by a free-text message substring (e.g. message.includes('contract_version')) instead of a stable issue.path. Message-text assertions are brittle to wording changes and can mask the wrong field producing the error.
- **Affected:**
  - `tests/remediate/validation.test.ts:392-395`
- **Evidence:**
  - tests/remediate/validation.test.ts:392 - asserts on message substring 'contract_version' rather than issue.path; reworded messages would break the test or a misattributed error would pass
- _verified: validation.test.ts:394 asserts message.includes('contract_version') rather than issue.path. Fragile-assertion claim accurate._

## Info (4)

### Prior CFG-001 (invalid publish-workflow Bash syntax) is a false positive — no syntax error present

- **Lens:** config_deployment · **Category:** false-positive · **Confidence:** high
- **Summary:** CFG-001 (high/high) claimed the metadata step's conditional lacked an `if` and the publish retry loop lacked a `for`. On disk both keywords are present: line 121 reads `if [[ ... ]]; then` and line 148 reads `for attempt in 1 2 3; do`. The original finding quoted only trailing fragments and misread valid Bash as broken. The deployment pipeline does not fail on these scripts; the finding should be downgraded/withdrawn.
- **Affected:**
  - `.github/workflows/publish-package.yml:121`
  - `.github/workflows/publish-package.yml:148`
- **Evidence:**
  - .github/workflows/publish-package.yml:121 - the conditional begins with `if [[ ... ]]; then`; the `if` keyword the original CFG-001 said was missing is in fact present, so the metadata step is valid Bash.
  - .github/workflows/publish-package.yml:148 - the retry loop begins with `for attempt in 1 2 3; do`; the `for` keyword the original CFG-001 said was missing is present, so the live publish step is valid Bash.
  - .github/workflows/publish-package.yml:53 - every run step uses `set -euo pipefail` under `shell: bash`; a genuine syntax error would abort, but the scripts are well-formed, confirming CFG-001's high-severity 'pipeline fails before release' impact does not hold.
- _verified: publish-package.yml:121 has 'if [[...]]; then' and :148 has 'for attempt in 1 2 3; do'. Confirms prior CFG-001 was false; downgrade valid._

### Deprecated DesignAssessment fields retained alongside replacements

- **Lens:** maintainability · **Category:** unclear-api · **Confidence:** medium
- **Summary:** DesignAssessment carries findings/review_findings/reviewed marked @deprecated next to their replacements (contract_findings, conceptual_findings, contract_reviewed, conceptual_reviewed). Keeping both shapes in the public interface forces every consumer to know which field is authoritative and risks readers/writers diverging on which to populate.
- **Affected:**
  - `src/audit/types/designAssessment.ts:5-8`
- **Evidence:**
  - src/audit/types/designAssessment.ts:5 - deprecated fields coexist with their replacements in the same interface, an ambiguous public contract that every consumer must disambiguate.
- _verified: designAssessment.ts:6-9 has @deprecated review_findings/reviewed alongside contract_findings/conceptual_findings replacements. Accurate._

### Anchor inconclusive/skipped verdicts are summarized but spawn errors lack structured context

- **Lens:** observability · **Category:** error-context · **Confidence:** low
- **Summary:** verifyFindingAnchor folds spawn_error and timeout into a human-readable summary string but emits no structured field (command, exit_code, timeout value) for downstream aggregation; operators get a prose line only. Given anchors run model-authored commands, structured error context would help diagnose recurring allowlist/skip patterns.
- **Affected:**
  - `src/audit/validation/anchorGrounding.ts:180-185`
- **Evidence:**
  - src/audit/validation/anchorGrounding.ts:180 - spawn errors are flattened into a summary string with no machine-readable command/exit_code fields on AnchorResult for telemetry.
- _verified: anchorGrounding.ts:180-185 folds spawn_error into summary string; no structured command/exit_code field. Info-level observability gap accurate._

### Skipped/inconclusive anchor verdicts are summarized but not surfaced as structured telemetry

- **Lens:** observability · **Category:** telemetry-gap · **Confidence:** low
- **Summary:** verifyFindingAnchor returns a human-readable summary string for skipped (off-allowlist), spawn-error, timed-out, and malformed-anchor cases, but emits no structured/counted signal; an operator cannot tell how often anchors silently fall back to tier-1 grounding without parsing prose.
- **Affected:**
  - `src/audit/validation/anchorGrounding.ts:170-175`
- **Evidence:**
  - src/audit/validation/anchorGrounding.ts:164-211 - the skipped/inconclusive/refuted/confirmed outcomes are encoded only in the summary string and status enum returned to the caller; there is no log line or counter at this layer. The data IS structured (status field), so this is a minor observability nuance, not an absence — supporting downgrade of OBS-002 to info/low. The anchor result is later folded into evidence via anchorEvidenceLine, which preserves the summary, so the information is not lost, merely not aggregated.
- _verified: anchorGrounding.ts:164-211 encodes outcomes in summary+status only, no counter/log line. Info-level telemetry-gap accurate._

