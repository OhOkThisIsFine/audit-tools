<!-- audit-tools/audit-report/v1 -->
# Audit Report

## Summary

- Findings: 404
- Work blocks: 3
- Severity breakdown: high: 27, medium: 127, low: 235, info: 15
- Fully audited files: 394
- Excluded non-auditable files: 95

## Work Blocks

### block-1

- Max severity: high
- Units: -github-workflows, file:packages/audit-code/src/extractors/languageMap.generated.ts, packages-audit-code, packages-remediate-code, packages-shared
- Owned files: .gemini/commands/audit-code.toml, .github/workflows/publish-package.yml, opencode.json, packages/audit-code/.gemini/commands/audit-code.toml, packages/audit-code/.github/workflows/ci.yml, packages/audit-code/.github/workflows/packaged-entrypoint.yml, packages/audit-code/.github/workflows/product-e2e.yml, packages/audit-code/.github/workflows/publish-package.yml, packages/audit-code/.github/workflows/test-suite.yml, packages/audit-code/.gitignore, packages/audit-code/audit-code-wrapper-lib.mjs, packages/audit-code/audit-code.mjs, packages/audit-code/dispatch/lens-definitions.json, packages/audit-code/dispatch/merge-results.mjs, packages/audit-code/dispatch/validate-result.mjs, packages/audit-code/dispatch/validate.mjs, packages/audit-code/opencode.json, packages/audit-code/schemas/audit_findings.schema.json, packages/audit-code/schemas/critical_flows.schema.json, packages/audit-code/schemas/dispatch_quota.schema.json, packages/audit-code/schemas/external_analyzer_results.schema.json, packages/audit-code/schemas/finding.schema.json, packages/audit-code/schemas/graph_bundle.schema.json, packages/audit-code/schemas/repo_manifest.schema.json, packages/audit-code/schemas/review_packets.schema.json, packages/audit-code/scripts/postinstall.mjs, packages/audit-code/scripts/release-and-publish.mjs, packages/audit-code/scripts/smoke-linked-audit-code.mjs, packages/audit-code/scripts/smoke-packaged-audit-code.mjs, packages/audit-code/scripts/update-languages.mjs, packages/audit-code/skills/audit-code/opencode-command-template.txt, packages/audit-code/src/adapters/coverageSummary.ts, packages/audit-code/src/adapters/normalizeExternal.ts, packages/audit-code/src/cli.ts, packages/audit-code/src/cli/auditStep.ts, packages/audit-code/src/cli/cleanup.ts, packages/audit-code/src/cli/dispatch.ts, packages/audit-code/src/cli/envelope.ts, packages/audit-code/src/cli/lineIndex.ts, packages/audit-code/src/cli/nextStepCommand.ts, packages/audit-code/src/cli/prompts.ts, packages/audit-code/src/cli/reviewRun.ts, packages/audit-code/src/cli/runToCompletion.ts, packages/audit-code/src/cli/semanticReviewStep.ts, packages/audit-code/src/cli/steps.ts, packages/audit-code/src/cli/waveManifest.ts, packages/audit-code/src/cli/workerResult.ts, packages/audit-code/src/coverage.ts, packages/audit-code/src/extractors/analyzers/css.ts, packages/audit-code/src/extractors/analyzers/html.ts, packages/audit-code/src/extractors/analyzers/python.ts, packages/audit-code/src/extractors/analyzers/sql.ts, packages/audit-code/src/extractors/analyzers/treeSitter.ts, packages/audit-code/src/extractors/analyzers/typescript.ts, packages/audit-code/src/extractors/browserExtension.ts, packages/audit-code/src/extractors/designAssessment.ts, packages/audit-code/src/extractors/fileInventory.ts, packages/audit-code/src/extractors/fsIntake.ts, packages/audit-code/src/extractors/graph.ts, packages/audit-code/src/extractors/graphManifestEdges.ts, packages/audit-code/src/extractors/graphPathUtils.ts, packages/audit-code/src/extractors/graphPythonImports.ts, packages/audit-code/src/extractors/graphRoutes.ts, packages/audit-code/src/extractors/graphSuites.ts, packages/audit-code/src/extractors/languageMap.generated.ts, packages/audit-code/src/extractors/pathPatterns.ts, packages/audit-code/src/index.ts, packages/audit-code/src/io/artifacts.ts, packages/audit-code/src/io/runArtifacts.ts, packages/audit-code/src/io/toolingManifest.ts, packages/audit-code/src/mcp/server.ts, packages/audit-code/src/orchestrator.ts, packages/audit-code/src/orchestrator/advance.ts, packages/audit-code/src/orchestrator/artifactFreshness.ts, packages/audit-code/src/orchestrator/auditTaskUtils.ts, packages/audit-code/src/orchestrator/autoFixExecutor.ts, packages/audit-code/src/orchestrator/chunking.ts, packages/audit-code/src/orchestrator/dependencyMap.ts, packages/audit-code/src/orchestrator/designReviewPrompt.ts, packages/audit-code/src/orchestrator/fileAnchors.ts, packages/audit-code/src/orchestrator/fileIntegrity.ts, packages/audit-code/src/orchestrator/flowCoverage.ts, packages/audit-code/src/orchestrator/flowPlanning.ts, packages/audit-code/src/orchestrator/flowRequeue.ts, packages/audit-code/src/orchestrator/graphEnrichmentExecutor.ts, packages/audit-code/src/orchestrator/internalExecutors.ts, packages/audit-code/src/orchestrator/localCommands.ts, packages/audit-code/src/orchestrator/nextStep.ts, packages/audit-code/src/orchestrator/requeue.ts, packages/audit-code/src/orchestrator/requeueCommand.ts, packages/audit-code/src/orchestrator/resultIngestion.ts, packages/audit-code/src/orchestrator/reviewPackets.ts, packages/audit-code/src/orchestrator/runtimeValidation.ts, packages/audit-code/src/orchestrator/runtimeValidationUpdate.ts, packages/audit-code/src/orchestrator/scope.ts, packages/audit-code/src/orchestrator/selectiveDeepening.ts, packages/audit-code/src/orchestrator/staleness.ts, packages/audit-code/src/orchestrator/state.ts, packages/audit-code/src/orchestrator/syntaxResolutionExecutor.ts, packages/audit-code/src/orchestrator/taskBuilder.ts, packages/audit-code/src/orchestrator/unionFind.ts, packages/audit-code/src/providers/claudeCodeProvider.ts, packages/audit-code/src/providers/index.ts, packages/audit-code/src/providers/subprocessTemplateProvider.ts, packages/audit-code/src/quota/discoveredLimits.ts, packages/audit-code/src/quota/headerExtraction.ts, packages/audit-code/src/quota/headerExtractors/index.ts, packages/audit-code/src/quota/index.ts, packages/audit-code/src/quota/probe.ts, packages/audit-code/src/reporting/mergeFindings.ts, packages/audit-code/src/reporting/synthesisNarrativePrompt.ts, packages/audit-code/src/reporting/workBlocks.ts, packages/audit-code/src/supervisor/runLedger.ts, packages/audit-code/src/supervisor/sessionConfig.ts, packages/audit-code/src/types/reviewPlanning.ts, packages/audit-code/src/types/workerSession.ts, packages/audit-code/src/validation/auditResults.ts, packages/audit-code/src/validation/sessionConfig.ts, packages/audit-code/tests/adapters-remediation.test.mjs, packages/audit-code/tests/analyzer-seam.test.mjs, packages/audit-code/tests/audit-code-completion.test.mjs, packages/audit-code/tests/audit-code-lifecycle.test.mjs, packages/audit-code/tests/audit-code-wrapper.test.mjs, packages/audit-code/tests/cli-remediation.test.mjs, packages/audit-code/tests/design-assessment.test.mjs, packages/audit-code/tests/discovered-limits.test.mjs, packages/audit-code/tests/edge-reasoning.test.mjs, packages/audit-code/tests/entrypoint-contract.test.mjs, packages/audit-code/tests/extractors-remediation.test.mjs, packages/audit-code/tests/field-trial-remediation.test.mjs, packages/audit-code/tests/fixture-repo.test.mjs, packages/audit-code/tests/graph-framework-routes.test.mjs, packages/audit-code/tests/graph-path-utils.test.mjs, packages/audit-code/tests/header-extraction.test.mjs, packages/audit-code/tests/helpers/jsonSchemaAssert.mjs, packages/audit-code/tests/helpers/provider-assisted-bridge.mjs, packages/audit-code/tests/io-remediation.test.mjs, packages/audit-code/tests/json-schema-assert.test.mjs, packages/audit-code/tests/mcp-server.test.mjs, packages/audit-code/tests/next-step-edge-reasoning.test.mjs, packages/audit-code/tests/next-step-narrative.test.mjs, packages/audit-code/tests/next-step.test.mjs, packages/audit-code/tests/orchestration.test.mjs, packages/audit-code/tests/orchestrator-remediation.test.mjs, packages/audit-code/tests/orchestrator.test.mjs, packages/audit-code/tests/prompt-invocation.test.mjs, packages/audit-code/tests/provider-assisted-bridge.test.mjs, packages/audit-code/tests/provider-assisted-continuation.test.mjs, packages/audit-code/tests/provider-auto-resolution.test.mjs, packages/audit-code/tests/providers-remediation.test.mjs, packages/audit-code/tests/quota-file-lock.test.mjs, packages/audit-code/tests/quota-packets.test.mjs, packages/audit-code/tests/quota-scheduler.test.mjs, packages/audit-code/tests/render-worker-prompt.test.mjs, packages/audit-code/tests/review-packets.test.mjs, packages/audit-code/tests/schema-contracts.test.mjs, packages/audit-code/tests/scope.test.mjs, packages/audit-code/tests/staleness.test.mjs, packages/audit-code/tests/status-command.test.mjs, packages/audit-code/tests/supervisor-remediation.test.mjs, packages/audit-code/tests/syntax-resolution.test.mjs, packages/audit-code/tests/synthesis-narrative.test.mjs, packages/audit-code/tests/tree-sitter-analyzers.test.mjs, packages/audit-code/tests/typescript-analyzer.test.mjs, packages/audit-code/tests/validate-command.test.mjs, packages/audit-code/tests/validation-remediation.test.mjs, packages/remediate-code/.github/workflows/publish-package.yml, packages/remediate-code/opencode.json, packages/remediate-code/remediate-code.mjs, packages/remediate-code/schemas/clarification_request.schema.json, packages/remediate-code/schemas/item_spec.schema.json, packages/remediate-code/schemas/remediation_outcomes.schema.json, packages/remediate-code/schemas/remediation_report.schema.json, packages/remediate-code/schemas/worker_result.schema.json, packages/remediate-code/scripts/postinstall.mjs, packages/remediate-code/scripts/release-and-publish.mjs, packages/remediate-code/scripts/run-mcp-server.mjs, packages/remediate-code/scripts/smoke-packaged-remediate-code.mjs, packages/remediate-code/src/index.ts, packages/remediate-code/src/intake.ts, packages/remediate-code/src/mcp/server.ts, packages/remediate-code/src/orchestrator.ts, packages/remediate-code/src/phases/close.ts, packages/remediate-code/src/phases/document.ts, packages/remediate-code/src/phases/implement.ts, packages/remediate-code/src/phases/plan.ts, packages/remediate-code/src/phases/triage.ts, packages/remediate-code/src/phases/workerTasks.ts, packages/remediate-code/src/providers/claudeCodeProvider.ts, packages/remediate-code/src/providers/index.ts, packages/remediate-code/src/providers/localSubprocessProvider.ts, packages/remediate-code/src/providers/workerTaskLaunch.ts, packages/remediate-code/src/quota/hostLimits.ts, packages/remediate-code/src/quota/index.ts, packages/remediate-code/src/quota/probe.ts, packages/remediate-code/src/state/store.ts, packages/remediate-code/src/steps/dispatch.ts, packages/remediate-code/src/steps/intakeResolver.ts, packages/remediate-code/src/steps/nextStep.ts, packages/remediate-code/src/steps/stepWriter.ts, packages/remediate-code/src/steps/waveScheduler.ts, packages/remediate-code/src/steps/worktreeIsolation.ts, packages/remediate-code/src/types/workerSession.ts, packages/remediate-code/src/utils/fileIntegrity.ts, packages/remediate-code/src/validation/artifacts.ts, packages/remediate-code/tests/cross-lens-dedup.test.ts, packages/remediate-code/tests/dispatch-reconciliation.test.ts, packages/remediate-code/tests/mcp-server.test.ts, packages/remediate-code/tests/model-hints.test.ts, packages/remediate-code/tests/phase-close.test.ts, packages/remediate-code/tests/phase-implement.test.ts, packages/remediate-code/tests/phase-plan.test.ts, packages/remediate-code/tests/postinstall.test.ts, packages/remediate-code/tests/providers.test.ts, packages/remediate-code/tests/quota-file-lock.test.ts, packages/remediate-code/tests/quota-scheduler.test.ts, packages/remediate-code/tests/store.test.ts, packages/remediate-code/tests/wave-scheduler.test.ts, packages/shared/scripts/release-and-publish.mjs, packages/shared/src/git.ts, packages/shared/src/observability/runLog.ts, packages/shared/src/providers/opencodeLaunch.ts, packages/shared/src/providers/spawnLoggedCommand.ts, packages/shared/src/providers/types.ts, packages/shared/src/providers/workerTaskLaunch.ts, packages/shared/src/quota/compositeQuotaSource.ts, packages/shared/src/quota/errorParsers/index.ts, packages/shared/src/quota/errorParsing.ts, packages/shared/src/quota/fileLock.ts, packages/shared/src/quota/hostLimits.ts, packages/shared/src/quota/learnedQuotaSource.ts, packages/shared/src/quota/limits.ts, packages/shared/src/quota/scheduler.ts, packages/shared/src/quota/slidingWindow.ts, packages/shared/src/quota/state.ts, packages/shared/src/tokens.ts, packages/shared/src/tooling/analyzerDeps.ts, packages/shared/src/tooling/exec.ts, packages/shared/src/tooling/repoConventions.ts, packages/shared/src/tooling/testCommand.ts, packages/shared/src/types/flows.ts, packages/shared/src/types/runLedger.ts, packages/shared/src/types/sessionConfig.ts, packages/shared/src/types/stepContract.ts, packages/shared/src/types/surfaces.ts, packages/shared/src/validation/basic.ts, packages/shared/tests/analyzerDeps.test.mjs, packages/shared/tests/exec.test.mjs, packages/shared/tests/git.test.mjs, packages/shared/tests/opencode-launch.test.mjs, packages/shared/tests/repoConventions.test.mjs, packages/shared/tests/runLog.test.mjs, packages/shared/tests/testCommand.test.mjs, packages/shared/tests/tokens.test.mjs, packages/shared/tests/worker-task-launch.test.mjs
- Findings: CD-001, COR-001, COR-001, COR-001, COR-001, COR-001, DA-002, DR-001, DR-002, DR-003, MNT-001, MNT-001, MNT-001, MNT-001, MNT-001, MNT-001, MNT-002, REL-001, TST-001, TST-001, TST-001, TST-001, TST-001, TST-001, TST-002, TST-002, TST-002, CD-001, CD-002, CFG-001, COR-001, COR-001, COR-001, COR-001, COR-001, COR-001, COR-001, COR-001, COR-001, COR-001, COR-002, COR-002, COR-002, COR-002, DA-005, DA-010, DA-012, DI-001, DI-002, DI-003, DI-003, DI-004, DR-004, DR-005, DR-006, DR-007, MNT-001, MNT-001, MNT-001, MNT-001, MNT-001, MNT-001, MNT-001, MNT-001, MNT-001, MNT-002, MNT-002, MNT-002, MNT-002, MNT-002, MNT-002, MNT-002, MNT-002, MNT-002, MNT-002, MNT-002, MNT-002, MNT-003, MNT-003, MNT-003, MNT-003, MNT-003, MNT-003, MNT-003, MNT-003, MNT-004, MNT-004, MNT-004, MNT-006, MNT-007, OBS-001, OBS-001, OBS-001, OBS-001, OBS-001, OBS-001, OBS-001, OBS-002, OBS-002, OBS-002, OBS-002, OBS-002, OPR-001, REL-002, SHD-001, TST-001, TST-001, TST-001, TST-001, TST-001, TST-001, TST-001, TST-001, TST-001, TST-001, TST-001, TST-001, TST-001, TST-001, TST-001, TST-001, TST-001, TST-001, TST-001, TST-002, TST-002, TST-002, TST-002, TST-002, TST-002, TST-002, TST-002, TST-002, TST-002, TST-002, TST-003, TST-003, TST-003, TST-003, TST-003, TST-003, TST-003, TST-003, TST-004, TST-004, TST-004, TST-004, TST-004, TST-005, TST-005, TST-005, TST-006, TST-006, TST-007, CD-002, CD-003, CD-004, COR-001, COR-001, COR-001, COR-002, COR-002, COR-002, COR-003, COR-003, COR-003, DI-001, DI-002, DI-004, DI-005, DI-005, DI-006, DI-006, DI-007, DI-008, DR-008, MNT-001, MNT-001, MNT-001, MNT-001, MNT-001, MNT-001, MNT-001, MNT-001, MNT-001, MNT-001, MNT-001, MNT-001, MNT-001, MNT-002, MNT-002, MNT-002, MNT-002, MNT-002, MNT-002, MNT-002, MNT-002, MNT-002, MNT-002, MNT-002, MNT-003, MNT-003, MNT-003, MNT-003, MNT-003, MNT-003, MNT-003, MNT-003, MNT-003, MNT-003, MNT-003, MNT-004, MNT-004, MNT-004, MNT-004, MNT-004, MNT-004, MNT-004, MNT-004, MNT-004, MNT-004, MNT-004, MNT-004, MNT-004, MNT-004, MNT-004, MNT-005, MNT-005, MNT-005, MNT-005, MNT-005, MNT-005, MNT-005, MNT-005, MNT-005, MNT-005, MNT-005, MNT-005, MNT-005, MNT-006, MNT-006, MNT-006, MNT-006, MNT-006, MNT-007, MNT-007, MNT-007, MNT-008, MNT-009, OBS-001, OBS-001, OBS-001, OBS-001, OBS-001, OBS-001, OBS-001, OBS-001, OBS-001, OBS-002, OBS-002, OBS-002, OBS-002, OBS-002, OBS-002, OBS-002, OBS-002, OBS-002, OBS-002, OBS-003, OBS-003, OBS-003, OBS-003, OBS-003, OBS-003, OBS-003, OBS-003, OBS-003, OBS-003, OBS-003, OBS-003, OBS-003, OBS-004, OBS-004, OBS-004, OBS-004, OBS-004, OBS-004, OBS-004, OBS-004, OBS-004, OBS-004, OBS-005, OBS-005, OBS-005, OBS-101, OBS-102, OPR-001, OPR-001, OPR-002, OPR-002, OPR-002, OPR-003, OPR-003, OPR-004, OPR-004, OPR-005, OPR-005, REL-001, REL-002, REL-003, SHD-002, SHD-003, SHD-004, SHD-005, TST-001, TST-001, TST-001, TST-001, TST-002, TST-002, TST-002, TST-002, TST-002, TST-002, TST-002, TST-002, TST-002, TST-002, TST-002, TST-002, TST-002, TST-002, TST-002, TST-003, TST-003, TST-003, TST-003, TST-003, TST-003, TST-003, TST-003, TST-003, TST-003, TST-003, TST-003, TST-003, TST-003, TST-003, TST-003, TST-003, TST-003, TST-003, TST-004, TST-004, TST-004, TST-004, TST-004, TST-004, TST-004, TST-004, TST-004, TST-004, TST-004, TST-004, TST-004, TST-004, TST-004, TST-005, TST-005, TST-005, TST-005, TST-005, TST-005, TST-005, TST-005, TST-005, TST-005, TST-005, TST-005, TST-005, TST-006, TST-006, TST-006, TST-006, TST-006, TST-007, MNT-002, MNT-003, MNT-003, MNT-004, MNT-004, MNT-005, MNT-006, MNT-006, OBS-003, OBS-003, OBS-004, OBS-005, OBS-005, OBS-103, TST-004
- Depends on: none
- Rationale: Findings share owned units transitively and should remain one non-overlapping remediation block.

### block-2

- Max severity: low
- Units: scripts
- Owned files: scripts/release-changed.mjs
- Findings: OPR-006, OPR-007
- Depends on: none
- Rationale: All findings map to the same owned unit and should be remediated together.

### block-3

- Max severity: low
- Units: -vscode
- Owned files: .vscode/mcp.json
- Findings: DA-011
- Depends on: none
- Rationale: All findings map to the same owned unit and should be remediated together.

## Findings

### TST-001 — autoFixExecutor has zero test coverage

- Severity: high
- Confidence: high
- Lens: tests
- Files: packages/audit-code/src/orchestrator/autoFixExecutor.ts
- Summary: runAutoFixExecutor (autoFixExecutor.ts) is the Phase 1 executor that conditionally runs code formatters but has no test coverage. Neither its returned artifact shape, nor its conditional formatter dispatch (Prettier only when config present, Black for Python, etc.), nor its behavior when file_disposition is absent are exercised by any test.
- Evidence:
  - packages/audit-code/src/orchestrator/autoFixExecutor.ts:54 - runAutoFixExecutor is the sole export; no test file in packages/audit-code/tests/ imports autoFixExecutor or references runAutoFixExecutor
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### COR-001 — Branch not cleaned up when git worktree add fails in runBlockInWorktree

- Severity: high
- Confidence: high
- Lens: correctness
- Files: packages/remediate-code/src/phases/implement.ts
- Summary: In runBlockInWorktree, git branch is created before git worktree add. If branch creation succeeds but worktree add fails, the function returns { ok: false } without deleting the dangling branch. On any subsequent invocation for the same block, git branch will fail (branch already exists), making both branchRes.status !== 0 and worktreeRes.status !== 0 true and permanently preventing worktree mode for that block ID without any diagnostic message about the root cause.
- Evidence:
  - packages/remediate-code/src/phases/implement.ts:418 - git branch blockBranch runs and can succeed
  - packages/remediate-code/src/phases/implement.ts:422 - git worktree add runs second; can fail independently
  - packages/remediate-code/src/phases/implement.ts:428 - guard checks branchRes.status !== 0 || worktreeRes.status !== 0 and returns { ok: false } without any cleanup of the already-created branch
  - packages/remediate-code/src/phases/implement.ts:510 - branch cleanup (git branch -D) only runs inside mergeWorktreeBlock, which is never reached when runBlockInWorktree returns { ok: false }
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-002 — cli.ts is a 1728-line mixed-concern file combining command implementations with re-export surface

- Severity: high
- Confidence: high
- Lens: maintainability
- Files: packages/audit-code/src/cli.ts
- Summary: cli.ts simultaneously acts as an aggregation/re-export module and as the direct implementation host for several large command functions (cmdWorkerRun ~100 lines, cmdMergeAndIngest ~237 lines, cmdSubmitPacket ~195 lines, cmdStatus ~130 lines), making it difficult to locate, read, or modify any individual command without navigating an unrelated 1700-line file.
- Evidence:
  - packages/audit-code/src/cli.ts:91-109 - module-level re-exports from ./cli/args.js alongside direct import of the same symbols at lines 112-134, creating a dual import pattern in a single file
  - packages/audit-code/src/cli.ts:371-471 - cmdWorkerRun implemented directly in cli.ts (~100 lines) rather than extracted to cli/workerRun.ts like other commands
  - packages/audit-code/src/cli.ts:495-690 - cmdSubmitPacket (~195 lines) and cmdMergeAndIngest lines 692-929 (~237 lines) both implemented inline in this file
  - packages/audit-code/src/cli.ts:1626-1708 - main() dispatch table references both extracted modules (cmdNextStep, cmdRunToCompletion) and inline functions (cmdWorkerRun, cmdSubmitPacket, cmdMergeAndIngest) with no consistent pattern
  - packages/audit-code/src/cli.ts:165-166 - cmdNextStep and cmdRunToCompletion are imported from extracted cli/ modules, confirming the inconsistency with the remaining inline commands
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-001 — cli.ts is a 1728-line monolithic command dispatcher

- Severity: high
- Confidence: high
- Lens: maintainability
- Files: packages/audit-code/src/cli.ts, packages/audit-code/src/cli.ts
- Summary: cli.ts contains full implementations of ~20 CLI commands inline, with individual functions like cmdMergeAndIngest (~237 lines, 692-929) and cmdSubmitPacket (~195 lines, 495-690) each embedding complex validation, file I/O, and business logic. The file is effectively a monolith that will require reading the entire file to locate or change any single command.
- Evidence:
  - packages/audit-code/src/cli.ts:692 - cmdMergeAndIngest begins; spans to line 929 (~237 lines) with nested task-result iteration, fallback path recovery, validation loops, and retry dispatch writing all inlined
  - packages/audit-code/src/cli.ts:495 - cmdSubmitPacket begins; spans to line 690 (~195 lines) covering packet resolution, task validation, duplicate-finding detection, and per-result file writes all inlined
  - packages/audit-code/src/cli.ts:1626 - main() switch lists 20+ cases, all delegating to co-located inline functions rather than imported command modules
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-001 — cmdRunToCompletion is a ~1000-line monolithic function with excessive cognitive complexity

- Severity: high
- Confidence: high
- Lens: maintainability
- Files: packages/audit-code/src/cli/runToCompletion.ts
- Summary: The single exported function cmdRunToCompletion spans lines 106–1115 (approximately 1009 lines) and handles at least seven distinct concerns: wave scheduling, parallel provider launch, result ingestion, quota state tracking, rate-limit header extraction, inline executor dispatch, and state persistence. Each concern is deeply interleaved with the others, making it hard to understand, test, or change any one of them safely.
- Evidence:
  - packages/audit-code/src/cli/runToCompletion.ts:106 - function signature; the entire file is this one function
  - packages/audit-code/src/cli/runToCompletion.ts:395-766 - parallel-wave block alone is ~370 lines covering slot construction, launch, result ingestion, quota recording, and header extraction
  - packages/audit-code/src/cli/runToCompletion.ts:451-457 - WorkerSlot interface declared inline inside the function body, a sign that sub-concerns have not been extracted
  - packages/audit-code/src/cli/runToCompletion.ts:671-708 - quota outcome recording and header extraction are inlined immediately after ingestion with no extracted helpers
  - packages/audit-code/src/cli/runToCompletion.ts:768-1087 - single-worker path duplicates the overall error/progress/state-persistence structure of lines 580-744 with no shared helper
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-001 — cmdRunToCompletion is excessively long and handles too many concerns

- Severity: high
- Confidence: high
- Lens: maintainability
- Files: packages/audit-code/src/cli/runToCompletion.ts
- Summary: The single function cmdRunToCompletion spans ~1000 lines and conflates wave recovery, parallel/sequential dispatch, result ingestion, quota management, rate-limit header extraction, error handling, and envelope emission. Any change to one concern risks breaking the others and the function is too large to reason about safely.
- Evidence:
  - packages/audit-code/src/cli/runToCompletion.ts:106 - function declaration begins; wave recovery at ~163, parallel branch at ~395, sequential inline at ~771, single-agent branch at ~896, exit at 1115 — roughly 1000 lines of mixed concerns in one function
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-001 — decideNextStepInner is a ~740-line monolithic function

- Severity: high
- Confidence: high
- Lens: maintainability
- Files: packages/remediate-code/src/steps/nextStep.ts
- Summary: The private function decideNextStepInner (lines 747-1487) spans ~740 lines and implements all 10+ state machine transitions as flat if-chains inside a single for-loop, with nesting depth reaching 6+ levels and local type aliases and helper closures defined mid-body. This makes individual transition logic hard to locate, test, or extend without risk of accidentally affecting adjacent branches.
- Evidence:
  - packages/remediate-code/src/steps/nextStep.ts:747 - function decideNextStepInner begins
  - packages/remediate-code/src/steps/nextStep.ts:1487 - function ends; ~740 lines of state-machine logic, inline prompt strings, and nested closures all in one function body
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test
  - packages/remediate-code/src/steps/nextStep.ts:747 - decideNextStepInner begins; function body runs to line 1487, ~740 lines total
  - packages/remediate-code/src/steps/nextStep.ts:762 - outer for-loop contains all state-machine branches with no sub-function extraction; each iteration handles a different status via sequential if-guards
  - packages/remediate-code/src/steps/nextStep.ts:1045-1048 - nesting reaches 5 levels: function > for-loop > if(documenting) > if(!previewAckPath) > if(!reviewedPath), then another inner for-loop at lines 1068-1092
  - packages/remediate-code/src/steps/nextStep.ts:1050-1065 - local type alias PreliminaryEntry defined inside a nested if-branch mid-function body; should be a module-level type
  - packages/remediate-code/src/steps/nextStep.ts:1176-1185 - two more local type aliases ReviewedEntry and PrelimEntry defined inside a second nested branch
  - packages/remediate-code/src/steps/nextStep.ts:1208-1237 - three closure functions (isNoOp, renderTierSection, renderNoOpSection) defined inside the loop body, duplicating rendering concerns that belong at module scope
  - packages/remediate-code/src/steps/nextStep.ts:909-914 and 1291-1296 - sessionConfig resolution duplicated verbatim in two different branches of the same function; the logic is identical but neither reuses the other's result

### DA-002 — Dependency cycle: 5 modules

- Severity: high
- Confidence: high
- Lens: architecture
- Files: packages/audit-code/src/cli.ts, packages/audit-code/src/cli/auditStep.ts, packages/audit-code/src/cli/dispatch.ts, packages/audit-code/src/cli/workerResult.ts, packages/audit-code/src/index.ts, packages/audit-code/src/io/runArtifacts.ts
- Summary: Circular dependency among packages/audit-code/src/cli.ts → packages/audit-code/src/cli/auditStep.ts → packages/audit-code/src/cli/workerResult.ts → packages/audit-code/src/io/runArtifacts.ts → packages/audit-code/src/index.ts → packages/audit-code/src/cli.ts. Cycles increase coupling, complicate testing, and can cause initialization-order bugs.
- Evidence:
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### REL-001 — Deprecated `skip_worker_command` no longer honoured in audit-code's `usesDeferredWorkerCommand`

- Severity: high
- Confidence: high
- Lens: reliability
- Files: packages/audit-code/src/types/workerSession.ts, packages/audit-code/src/types/workerSession.ts, packages/remediate-code/src/types/workerSession.ts
- Summary: The audit-code version of `usesDeferredWorkerCommand` (packages/audit-code/src/types/workerSession.ts:35-38) was updated to check only `worker_command_mode === 'deferred'` and silently drops the deprecated `skip_worker_command` flag, while the remediate-code version still honours both. Any task.json written by older audit-code versions (or cross-package code) that sets `skip_worker_command: true` without `worker_command_mode: 'deferred'` will not be treated as deferred by the audit-code path, causing the worker command to be executed unexpectedly instead of being skipped.
- Evidence:
  - packages/audit-code/src/types/workerSession.ts:35-38 - usesDeferredWorkerCommand returns `task.worker_command_mode === 'deferred'` only; skip_worker_command is NOT checked despite the field being declared on WorkerTask at line 29
  - packages/remediate-code/src/types/workerSession.ts:62-68 - usesDeferredWorkerCommand checks BOTH `worker_command_mode === 'deferred'` and `skip_worker_command === true`, the legacy field is still honoured
  - packages/audit-code/src/types/workerSession.ts:29 - `/** @deprecated Prefer worker_command_mode: 'deferred' for new task files. */ skip_worker_command?: boolean;` is declared but the guard function no longer reads it
  - packages/audit-code/tests/render-worker-prompt.test.mjs:73-81 - test explicitly asserts that `usesDeferredWorkerCommand({ skip_worker_command: true })` returns false, confirming the behavioural divergence is intentional but the interface still exposes the field creating a reliability trap for callers relying on the deprecated path
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test
  - packages/audit-code/src/types/workerSession.ts:35-39 - usesDeferredWorkerCommand returns task.worker_command_mode === 'deferred' only; skip_worker_command is never checked
  - packages/audit-code/src/types/workerSession.ts:29 - JSDoc marks skip_worker_command as @deprecated but the guard function does not fall back to it
  - packages/remediate-code/src/types/workerSession.ts:62-68 - the equivalent function returns task.worker_command_mode === 'deferred' || task.skip_worker_command === true, correctly handling legacy task files

### TST-001 — detectHostActiveSubagentLimit is tested with wrong argument — the env fixture is passed as envPrefix

- Severity: high
- Confidence: high
- Lens: tests
- Files: packages/shared/src/quota/hostLimits.ts
- Summary: The test exercises detectHostActiveSubagentLimit by passing the env object as the first positional argument (envPrefix: string). The actual env parameter defaults to process.env, so the assertion checks whatever happens to be in the real process environment. The test does not exercise the code path in hostLimits.ts that reads the fixture env; the intent is entirely defeated.
- Evidence:
  - packages/audit-code/tests/quota-scheduler.test.mjs:478-480 - detectHostActiveSubagentLimit({ CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "Codex Desktop" }) — env object passed as first arg (envPrefix), second arg (env) defaults to process.env
  - packages/shared/src/quota/hostLimits.ts:17 - function signature: detectHostActiveSubagentLimit(envPrefix: string, env: NodeJS.ProcessEnv = process.env)
  - packages/shared/src/quota/hostLimits.ts:33 - Codex Desktop branch: env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE === "Codex Desktop" — env is process.env, not the test fixture
  - runtime:unit:packages-shared: confirmed — Deterministic runtime command succeeded: npm test

### TST-001 — Entire quota subsystem has zero test coverage

- Severity: high
- Confidence: high
- Lens: tests
- Files: packages/shared/src/quota/hostLimits.ts, packages/shared/src/quota/learnedQuotaSource.ts, packages/shared/src/quota/limits.ts, packages/shared/src/quota/scheduler.ts, packages/shared/src/quota/slidingWindow.ts, packages/shared/src/quota/state.ts
- Summary: The quota subsystem (hostLimits.ts, learnedQuotaSource.ts, limits.ts, quotaSource.ts, scheduler.ts, slidingWindow.ts, state.ts) has no test files in packages/shared/tests. This is the core rate-limiting, concurrency, and backoff engine relied on by both orchestrators, but none of its logic is exercised by the test suite.
- Evidence:
  - packages/shared/tests/ - directory listing shows no quota-related test file (analyzerDeps.test.mjs, exec.test.mjs, git.test.mjs, opencode-launch.test.mjs, repoConventions.test.mjs, runLog.test.mjs, testCommand.test.mjs, tokens.test.mjs, worker-task-launch.test.mjs); none covers the quota/ subtree
  - packages/shared/src/quota/state.ts:90-130 - computeMaxSafeConcurrency, computeRampUpConcurrency, computeBackoffCooldownMs, computeBackoffFailureWeight, recordWaveOutcome are pure or near-pure functions that are straightforwardly testable but have no tests
  - packages/shared/src/quota/scheduler.ts:46 - scheduleWave has complex multi-branch logic (RPM cap, TPM cap, ramp-up, cooldown, host-limit, fallback, first-contact) with no test coverage
  - packages/shared/src/quota/slidingWindow.ts:5 - runSlidingWindow has no test file covering its concurrent-task lifecycle or onComplete callback
  - runtime:unit:packages-shared: confirmed — Deterministic runtime command succeeded: npm test

### MNT-001 — internalExecutors.ts is a god module at 810 lines with 10+ unrelated executor responsibilities

- Severity: high
- Confidence: high
- Lens: maintainability
- Files: packages/audit-code/src/orchestrator/internalExecutors.ts
- Summary: internalExecutors.ts at 810 lines implements intake, structure, design assessment, planning, result ingestion, runtime validation, synthesis, and external-analyzer-import executors in a single file alongside private helpers. Each executor is an independent unit with distinct dependencies; bundling them makes the file hard to navigate, test in isolation, or safely extend without risk of unintended coupling.
- Evidence:
  - packages/audit-code/src/orchestrator/internalExecutors.ts:206 - runIntakeExecutor begins
  - packages/audit-code/src/orchestrator/internalExecutors.ts:238 - runStructureExecutor begins
  - packages/audit-code/src/orchestrator/internalExecutors.ts:299 - runDesignAssessmentExecutor begins
  - packages/audit-code/src/orchestrator/internalExecutors.ts:363 - runPlanningExecutor begins (118 lines)
  - packages/audit-code/src/orchestrator/internalExecutors.ts:483 - runResultIngestionExecutor begins
  - packages/audit-code/src/orchestrator/internalExecutors.ts:566 - runRuntimeValidationExecutor begins
  - packages/audit-code/src/orchestrator/internalExecutors.ts:700 - runSynthesisExecutor begins
  - packages/audit-code/src/orchestrator/internalExecutors.ts:727 - runSynthesisNarrativeExecutor begins
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### COR-001 — isLens guard missing observability — throws instead of processing

- Severity: high
- Confidence: high
- Lens: correctness
- Files: packages/audit-code/src/orchestrator/flowRequeue.ts
- Summary: The isLens() predicate (lines 7-18) checks only 10 of the 11 Lens union members defined in types.ts; observability is absent. Any flow whose required_lenses includes "observability" reaches the throw at line 104, crashing buildFlowRequeueTasks instead of emitting the requeue task.
- Evidence:
  - packages/audit-code/src/orchestrator/flowRequeue.ts:7-18 - isLens array lists correctness, architecture, maintainability, security, reliability, performance, data_integrity, tests, operability, config_deployment — observability is not present
  - packages/audit-code/src/orchestrator/flowRequeue.ts:102-107 - loop throws Error for any lens string that fails isLens, so a flow requiring observability triggers the throw at runtime
  - packages/audit-code/src/types.ts:14 - Lens type union explicitly includes observability as a valid 11th member
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### COR-001 — isLens() in flowRequeue.ts missing observability lens value

- Severity: high
- Confidence: high
- Lens: correctness
- Files: packages/audit-code/src/orchestrator/flowRequeue.ts
- Summary: The isLens() guard in flowRequeue.ts does not include "observability" in its allowed-value list, but the Lens type in types.ts does include it. If a critical flow has "observability" as a required concern, buildFlowRequeueTasks will throw an unrecoverable error at line 104 when it tries to requeue work for that lens.
- Evidence:
  - packages/audit-code/src/orchestrator/flowRequeue.ts:6-17 - isLens() lists 10 lens values: correctness, architecture, maintainability, security, reliability, performance, data_integrity, tests, operability, config_deployment — observability is absent
  - packages/audit-code/src/types.ts:14 - Lens type union includes observability as a valid member
  - packages/audit-code/src/orchestrator/flowRequeue.ts:103-105 - throws Error when lensName passes required_lenses filter but fails isLens(), which would be the case for any observability lens from flow records
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### COR-001 — MCP tool names in opencode template do not match actual server exports

- Severity: high
- Confidence: high
- Lens: correctness
- Files: packages/audit-code/skills/audit-code/opencode-command-template.txt
- Summary: The opencode command template references MCP tools as `auditor_start_audit` and `auditor_continue_audit`, but the MCP server exposes them as `start_audit` and `continue_audit` (without the `auditor_` prefix). Any opencode agent following this template will fail to call the correct tool names at runtime.
- Evidence:
  - packages/audit-code/skills/audit-code/opencode-command-template.txt:6 - `call auditor_start_audit` — tool name uses auditor_ prefix
  - packages/audit-code/skills/audit-code/opencode-command-template.txt:7 - `auditor_continue_audit` — tool name uses auditor_ prefix
  - packages/audit-code/src/mcp/server.ts:549 - actual registered tool name is `start_audit` (no prefix)
  - packages/audit-code/src/mcp/server.ts:579 - actual registered tool name is `continue_audit` (no prefix)
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-001 — No unit tests for dispatch.ts exported logic

- Severity: high
- Confidence: high
- Lens: tests
- Files: packages/audit-code/src/cli/dispatch.ts
- Summary: The core exported functions in dispatch.ts — including buildDispatchComplexity, buildDispatchModelHint, withinRoot, isIsolatedLargeFilePacket, buildPendingAuditTasks, entriesByTaskId, resolveRunScopedArg, and prepareDispatchArtifacts — have no direct unit tests. All test coverage flows only through end-to-end integration tests that do not exercise individual branches or edge cases.
- Evidence:
  - packages/audit-code/src/cli/dispatch.ts:216 - withinRoot throws on path traversal (relativePath.startsWith('..')) but this branch is never tested
  - packages/audit-code/src/cli/dispatch.ts:161 - buildDispatchModelHint selects among three tiers (small/standard/deep) based on priority, lens, estimated_tokens, and tags — no unit tests for these tier-selection branches
  - packages/audit-code/src/cli/dispatch.ts:127 - isIsolatedLargeFilePacket checks file_paths.length === 1 and total_lines > LARGE_FILE_PACKET_TARGET_LINES — not directly tested
  - packages/audit-code/tests/prompt-invocation.test.mjs:1 - only prompts.ts is directly unit-tested; no test file imports from dist/cli/dispatch.js
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### DR-003 — Provider classes, resolution, and quota wiring are duplicated across both tools and have measurably drifted — including a security-relevant default

- Severity: high
- Confidence: high
- Lens: architecture
- Files: packages/audit-code/src/providers/index.ts, packages/remediate-code/src/providers/index.ts, packages/audit-code/src/providers/claudeCodeProvider.ts, packages/remediate-code/src/providers/claudeCodeProvider.ts, packages/remediate-code/src/providers/workerTaskLaunch.ts, packages/shared/src/providers/types.ts
- Summary: Both packages carry their own providers/{claudeCode,opencode,subprocessTemplate,vscodeTask,localSubprocess}Provider.ts, providers/index.ts, and quota/* even though @audit-tools/shared already owns the provider *types*, spawnLoggedCommand, applyWorkerTaskLaunchSettings, and resolveOpenCodeSpawnCommand. CLAUDE.md frames the duplication as intentional ('each keeps its own wiring'), but the copies have drifted in ways that are bugs waiting to happen: (a) audit-code imports applyWorkerTaskLaunchSettings from shared, while remediate-code imports a *local* providers/workerTaskLaunch.ts copy that can diverge silently; (b) the two resolveFreshSessionProviderName implementations differ structurally (remediate refactored into getAutoProviderContext/chooseAutoProvider; audit-code kept the inline form) and semantically — audit-code treats `name===undefined && provider==='local-subprocess'` as an auto-detect trigger and folds dangerously_skip_permissions into hasConfiguredClaudeCode, remediate-code does neither; (c) ClaudeCodeProvider defaults dangerously_skip_permissions to ON in remediate-code but OFF in audit-code — a security-relevant default living in copy-pasted code. Recommendation: hoist the five provider classes plus the resolver and quota wiring into shared behind the existing FreshSessionProvider interface, parameterizing only the genuinely tool-specific bits (artifact-dir name in the error message, skip-permissions default, prompt-via-arg vs prompt-via-stdin).
- Evidence:
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test
  - runtime:unit:packages-shared: confirmed — Deterministic runtime command succeeded: npm test

### DR-002 — remediate-code's decideNextStep is a 740-line god-function with embedded prompt markdown

- Severity: high
- Confidence: high
- Lens: maintainability
- Files: packages/remediate-code/src/steps/nextStep.ts
- Summary: steps/nextStep.ts interleaves at least six concerns: state-machine transitions, dispatch preparation, risk-tier classification (classifyFindingRisk), extracted-plan normalization (normalizeExtractedPlan), file-integrity gating, run-log instrumentation, and several hundred lines of inline Markdown prompt templates (clarificationPrompt, triagePrompt, collectStartingPointPrompt, synthesizeIntakePrompt, extractFindingsPrompt, the impl-risk classification and preview prompts). audit-code already demonstrates the better separation — prompt rendering lives in dedicated modules (orchestrator/designReviewPrompt.ts, prompts/renderWorkerPrompt.ts). Because prompts are the actual product (the contract the host executes), embedding them as template literals in control-flow code makes them hard to review, test, or diff. Recommendation: extract every prompt template into a prompts/ module, split the per-state logic into discrete handlers (or the registry from DR-001), and add golden-file tests for the rendered prompts. This file is also a hub in several reported dependency cycles, so decomposition pays double.
- Evidence:
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-001 — reviewPackets.ts is an 1848-line monolith mixing multiple distinct concerns

- Severity: high
- Confidence: high
- Lens: maintainability
- Files: packages/audit-code/src/orchestrator/reviewPackets.ts
- Summary: The file combines graph edge collection, degree indexing, three cluster-edge strategies, entrypoint flow bridge computation, packet chunking, quality metrics, and plan metrics all in one 1848-line module. This makes navigation, testing in isolation, and safe change difficult.
- Evidence:
  - packages/audit-code/src/orchestrator/reviewPackets.ts:233 - collectGraphEdges(): graph edge collection concern
  - packages/audit-code/src/orchestrator/reviewPackets.ts:292 - buildGraphDegreeIndex(): degree indexing concern
  - packages/audit-code/src/orchestrator/reviewPackets.ts:498 - buildBoundedClusterEdges(): cluster planning concern (120 lines)
  - packages/audit-code/src/orchestrator/reviewPackets.ts:1176 - chunkPacketTasks(): token-budget chunking concern
  - packages/audit-code/src/orchestrator/reviewPackets.ts:1697 - buildPacketQualityMetrics(): quality metrics concern
  - packages/audit-code/src/orchestrator/reviewPackets.ts:1773 - buildAuditPlanMetrics(): plan metrics concern (76 lines)
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-001 — scheduleWave quota-enabled path and buildDispatchQuota backoff logic have no test coverage

- Severity: high
- Confidence: high
- Lens: tests
- Files: packages/remediate-code/src/steps/waveScheduler.ts, packages/remediate-code/src/steps/waveScheduler.ts
- Summary: The wave-scheduler test suite only exercises the quota-disabled branch of scheduleWave (lines 73-93). The quota-enabled path (lines 95-116), including readQuotaState failure handling and quotaStateEntry propagation, is untested. Additionally, buildDispatchQuota's backoff_state construction when consecutive_429_count > 0 (lines 127-132) has no test, leaving the backoff logic unverified.
- Evidence:
  - packages/remediate-code/src/steps/waveScheduler.ts:73 - quota-disabled branch: if (!quota || quota.enabled === false) — only this branch is exercised in wave-scheduler.test.ts
  - packages/remediate-code/src/steps/waveScheduler.ts:95-99 - quota-enabled: reads quotaState and extracts entry per provider+model key; no test passes sessionConfig.quota.enabled=true
  - packages/remediate-code/src/steps/waveScheduler.ts:127-132 - backoffState built from consecutive_429_count; no test supplies a non-zero quotaStateEntry to buildDispatchQuota
  - packages/remediate-code/tests/wave-scheduler.test.ts:93-163 - all scheduleWave tests pass sessionConfig: null or sessionConfig without a quota property, so quota-enabled branch is never reached
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### DR-001 — The two orchestrators reimplement the same bounded-step loop divergently; extract a shared orchestration framework

- Severity: high
- Confidence: high
- Lens: architecture
- Files: packages/audit-code/src/orchestrator/nextStep.ts, packages/remediate-code/src/steps/nextStep.ts, packages/shared/src/types/stepContract.ts
- Summary: audit-code and remediate-code are two instances of one idea — a resumable orchestrator that advances one bounded step per invocation and emits a backend-rendered prompt contract — yet they share almost none of the loop machinery. audit-code/src/orchestrator/nextStep.ts resolves the next step declaratively: a PRIORITY array of obligation IDs plus an EXECUTOR_REGISTRY that maps obligations to executors, in ~77 lines. remediate-code/src/steps/nextStep.ts solves the identical problem with a ~740-line imperative for-loop over hard-coded `state.status === ...` branches, a MAX_ITERATIONS guard, ad-hoc run-log instrumentation, and inline prompt rendering. The two have already drifted in structure, error handling, and logging. Recommendation: hoist a shared step-orchestration core into @audit-tools/shared — an obligation/priority model, an executor registry, and the step-contract writer (stepContract types already live in shared) — and refactor remediate-code onto the registry pattern audit-code already uses. This eliminates a whole class of drift, makes each loop unit-testable, and gives future orchestrators a reuse path.
- Evidence:
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test
  - runtime:unit:packages-shared: confirmed — Deterministic runtime command succeeded: npm test

### TST-001 — waveScheduler.ts has zero test coverage

- Severity: high
- Confidence: high
- Lens: tests
- Files: packages/remediate-code/src/steps/waveScheduler.ts
- Summary: scheduleWave and buildDispatchQuota in waveScheduler.ts are not exercised by any test. These functions control wave size and token budget for every dispatch operation, and both the quota-disabled and quota-enabled branches go completely untested.
- Evidence:
  - packages/remediate-code/src/steps/waveScheduler.ts:61 - scheduleWave exported function with no corresponding test file
  - packages/remediate-code/src/steps/waveScheduler.ts:118 - buildDispatchQuota exported function with no corresponding test file
  - packages/remediate-code/tests/dispatch-reconciliation.test.ts:1 - test file imports only from dispatch.js, not waveScheduler
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-002 — withinRoot path-escape guard untested

- Severity: high
- Confidence: high
- Lens: tests
- Files: packages/audit-code/src/cli/dispatch.ts
- Summary: withinRoot is a security-relevant path-sanitization function that throws if a path escapes the repository root, but no test verifies the throw or the normal-case return. A regression here would silently allow worker prompts to access arbitrary file system paths.
- Evidence:
  - packages/audit-code/src/cli/dispatch.ts:220 - if (relativePath.startsWith('..') || isAbsolute(relativePath)) throw new Error — neither the throw path nor the happy path has a dedicated test
  - packages/audit-code/src/cli/dispatch.ts:216 - function withinRoot(root, path) used during large-file anchor extraction in prepareDispatchArtifacts but not tested in isolation
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### CD-001 — workflow_dispatch publish lacks branch gate

- Severity: high
- Confidence: high
- Lens: config_deployment
- Files: packages/remediate-code/.github/workflows/publish-package.yml, packages/remediate-code/.github/workflows/publish-package.yml, packages/remediate-code/.github/workflows/publish-package.yml
- Summary: Finding CD-001 is confirmed. The default-branch gate step (lines 44-55) has an explicit `if: github.event_name == release` condition, so it is entirely skipped for workflow_dispatch events. The workflow_dispatch trigger (lines 4-26) has no branches: filter. With dry_run defaulting to false (line 8), a manual dispatch from any non-default branch triggers a live npm publish via `npm publish` (line 149) with no branch restriction.
- Evidence:
  - packages/remediate-code/.github/workflows/publish-package.yml:44 - gate step has condition 'if: github.event_name == release' so it is entirely skipped on workflow_dispatch
  - packages/remediate-code/.github/workflows/publish-package.yml:4 - workflow_dispatch block has no branches: filter, allowing dispatch from any branch to trigger a live npm publish
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test
  - packages/remediate-code/.github/workflows/publish-package.yml:44-45 - `if: github.event_name == release` on the gate step means it is unconditionally skipped for workflow_dispatch, leaving no branch check path for manual dispatches
  - packages/remediate-code/.github/workflows/publish-package.yml:4-26 - workflow_dispatch block has inputs (dry_run, publish_tag) but no `branches:` filter; default dry_run is false (line 8)
  - packages/remediate-code/.github/workflows/publish-package.yml:143 - publish step condition `github.event_name != workflow_dispatch || inputs.dry_run == false` evaluates true for default manual dispatch, so live publish runs without any branch restriction
  - packages/remediate-code/.github/workflows/publish-package.yml:149 - `npm publish --access public --tag ...` executes in the unguarded workflow_dispatch path

### COR-001 — Worktree block commit failure silently ignored, causing lost file changes

- Severity: high
- Confidence: high
- Lens: correctness
- Files: packages/remediate-code/src/phases/implement.ts
- Summary: In runBlockInWorktree, the return value of the git commit call is not checked. If the commit fails (empty commit, hook rejection, etc.), the function still returns { ok: true, state: blockState }. mergeWorktreeBlock then merges a branch with no new commits, so code changes from executeBlock are silently discarded while state metadata (item status=resolved) is still merged — the state diverges from the actual file state.
- Evidence:
  - packages/remediate-code/src/phases/implement.ts:443 - runCommand("git", ["add", "."]) result is discarded
  - packages/remediate-code/src/phases/implement.ts:444-451 - git commit result is discarded; function falls through to return { ok: true, state: blockState } regardless
  - packages/remediate-code/src/phases/implement.ts:499-504 - mergeWorktreeBlock merges the branch unconditionally if rebase succeeds; if commit was a no-op the merge is a no-op and changes are lost
  - packages/remediate-code/src/phases/implement.ts:571-574 - mergeBlockState writes resolved item statuses back even when no code changes were merged
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-002 — worktreeIsolation.ts has no dedicated unit tests; critical error-recovery branches are uncovered

- Severity: high
- Confidence: high
- Lens: tests
- Files: packages/remediate-code/src/steps/worktreeIsolation.ts
- Summary: No test file targets worktreeIsolation.ts directly. The only incidental coverage is a single integration test in phase-implement.test.ts that exercises the parallel-safe happy path (no diff → clean cleanup). The 'already exists' branch in createWorktree (lines 38-42), merge-conflict abort flow in mergeWorktree (lines 83-92), cleanupAllWorktrees, isGitRepo, and the worktreePathForBlock sanitization logic all have zero test coverage.
- Evidence:
  - packages/remediate-code/src/steps/worktreeIsolation.ts:38-42 - branch: if (String(error).includes('already exists')) — retries git worktree add without -b; no test triggers this branch
  - packages/remediate-code/src/steps/worktreeIsolation.ts:83-92 - merge conflict: git merge --abort then returns {merged:false, conflicted:true}; never tested
  - packages/remediate-code/src/steps/worktreeIsolation.ts:119-129 - cleanupAllWorktrees: no test covers base-dir existence check or rm+prune path
  - packages/remediate-code/src/steps/worktreeIsolation.ts:131-138 - isGitRepo: untested; exercises git rev-parse --git-dir
  - packages/remediate-code/tests/phase-implement.test.ts:151-206 - only test referencing worktrees creates a B1 block with no commits, triggering the no-diff early-exit path; covers none of the error branches
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-002 — worktreeIsolation.ts has zero test coverage

- Severity: high
- Confidence: high
- Lens: tests
- Files: packages/remediate-code/src/steps/worktreeIsolation.ts
- Summary: createWorktree, mergeWorktree, removeWorktree, cleanupAllWorktrees, and isGitRepo in worktreeIsolation.ts are untested. The crash-recovery idempotency path and the merge-conflict abort path contain non-trivial error-handling logic that is never verified.
- Evidence:
  - packages/remediate-code/src/steps/worktreeIsolation.ts:27-30 - crash-recovery reuse path: if existsSync(wtPath) return early - untested
  - packages/remediate-code/src/steps/worktreeIsolation.ts:83-92 - merge-conflict abort path - untested
  - packages/remediate-code/src/steps/worktreeIsolation.ts:131 - isGitRepo helper - untested
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-001 — All audit-code tests import compiled dist rather than source

- Severity: medium
- Confidence: high
- Lens: tests
- Files: packages/audit-code/tests/render-worker-prompt.test.mjs, packages/audit-code/tests/staleness.test.mjs, packages/audit-code/tests/status-command.test.mjs, packages/audit-code/tests/syntax-resolution.test.mjs, packages/audit-code/tests/synthesis-narrative.test.mjs, packages/audit-code/tests/tree-sitter-analyzers.test.mjs, packages/audit-code/tests/typescript-analyzer.test.mjs
- Summary: All seven audit-code test files (render-worker-prompt, staleness, status-command, syntax-resolution, synthesis-narrative, tree-sitter-analyzers, typescript-analyzer) import exclusively from ../dist/ rather than from ../src/. Tests will silently pass on stale builds if dist/ is not rebuilt before running, and will not catch type-level or source changes that have not been compiled.
- Evidence:
  - packages/audit-code/tests/render-worker-prompt.test.mjs:4 - const { renderWorkerPrompt } = await import(../dist/prompts/renderWorkerPrompt.js)
  - packages/audit-code/tests/staleness.test.mjs:4 - const { computeArtifactMetadata } = await import(../dist/orchestrator/artifactMetadata.js)
  - packages/audit-code/tests/status-command.test.mjs:10 - const distCliUrl = pathToFileURL(join(repoRoot, dist, cli.js)).href
  - packages/audit-code/tests/synthesis-narrative.test.mjs:16 - await import(../dist/reporting/synthesis.js)
  - packages/audit-code/tests/tree-sitter-analyzers.test.mjs:7 - await import(../dist/extractors/analyzers/python.js)
  - packages/audit-code/tests/typescript-analyzer.test.mjs:8 - await import(../dist/extractors/analyzers/typescript.js)
  - runtime:flow:flow:surface:packages-audit-code-tests-status-command-test-mjs: confirmed — Deterministic runtime command succeeded: npm test
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-001 — All orchestrator/IO helpers imported from compiled dist, not source

- Severity: medium
- Confidence: high
- Lens: tests
- Files: packages/audit-code/tests/io-remediation.test.mjs, packages/audit-code/tests/next-step-edge-reasoning.test.mjs, packages/audit-code/tests/next-step-narrative.test.mjs, packages/audit-code/tests/mcp-server.test.mjs
- Summary: Every test file that uses internal orchestrator or IO helpers imports from dist/ (compiled output) rather than src/. Tests silently pass against a stale build if source is changed without rebuilding, masking regressions.
- Evidence:
  - packages/audit-code/tests/io-remediation.test.mjs:28 - `await import("../dist/io/artifacts.js")` imports compiled output, not source
  - packages/audit-code/tests/next-step-edge-reasoning.test.mjs:13 - `await import("../dist/orchestrator/advance.js")` — dist import
  - packages/audit-code/tests/next-step-narrative.test.mjs:13 - `await import("../dist/orchestrator/advance.js")` — dist import
  - packages/audit-code/tests/mcp-server.test.mjs:701 - `await import("../dist/mcp/server.js")` — dist import for unit-level extractFrames/dispatchRequest tests
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### DR-004 — All reported dependency cycles stem from two hub modules re-importing their own children

- Severity: medium
- Confidence: high
- Lens: architecture
- Files: packages/audit-code/src/cli.ts, packages/remediate-code/src/orchestrator.ts
- Summary: The deterministic pass reported ~10 import cycles; they cluster into exactly two roots. In audit-code, cli.ts imports its cli/* submodules (args, auditStep, dispatch, nextStepCommand, semanticReviewStep) and they import symbols back from cli.ts and src/index.ts (e.g. cli.ts -> cli/auditStep.ts -> cli/workerResult.ts -> io/runArtifacts.ts -> index.ts -> cli.ts). In remediate-code, orchestrator.ts imports phases/* (close, document, implement, plan, triage, workerTasks) and those phases import the orchestrator back. Both are the same anti-pattern: a hub module and its children mutually import. Recommendation: relocate the shared symbols (types and small helpers the children need) into leaf modules that both the hub and the children depend on, so edges flow one direction. This removes initialization-order fragility, makes the hubs unit-testable, and is a precondition for the decomposition in DR-002.
- Evidence:
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-004 — All shared tests import from compiled dist/ — silently pass on stale builds

- Severity: medium
- Confidence: high
- Lens: tests
- Files: packages/shared/tests/analyzerDeps.test.mjs, packages/shared/tests/exec.test.mjs, packages/shared/tests/git.test.mjs, packages/shared/tests/opencode-launch.test.mjs, packages/shared/tests/repoConventions.test.mjs, packages/shared/tests/runLog.test.mjs, packages/shared/tests/testCommand.test.mjs, packages/shared/tests/tokens.test.mjs, packages/shared/tests/worker-task-launch.test.mjs
- Summary: Every shared test file imports from '../dist/...' rather than TypeScript source. If dist/ is not rebuilt before running the test runner directly, tests exercise stale compiled artifacts and may not catch source changes.
- Evidence:
  - packages/shared/tests/analyzerDeps.test.mjs:8 - import('../dist/tooling/analyzerDeps.js')
  - packages/shared/tests/exec.test.mjs:4 - import('../dist/tooling/exec.js')
  - packages/shared/tests/git.test.mjs:7 - import('../dist/git.js')
  - packages/shared/tests/tokens.test.mjs:13 - comment acknowledges intentional dist import but notes rebuild is required; if skipped, tests pass on stale code
  - runtime:flow:flow:surface:packages-shared-tests-testCommand-test-mjs: confirmed — Deterministic runtime command succeeded: npm test
  - runtime:unit:packages-shared: confirmed — Deterministic runtime command succeeded: npm test

### TST-002 — All shared tests import from dist/ — silently pass on stale build outside npm test

- Severity: medium
- Confidence: high
- Lens: tests
- Files: packages/shared/src/tokens.ts, packages/shared/src/tooling/analyzerDeps.ts, packages/shared/src/tooling/exec.ts, packages/shared/src/tooling/repoConventions.ts
- Summary: Every test file in packages/shared/tests imports from ../dist/*.js rather than from TypeScript source. When running node --test directly without rebuilding, the tests exercise a stale compiled artifact instead of the current source, allowing source changes to go undetected without a build failure.
- Evidence:
  - packages/shared/tests/tokens.test.mjs:15 - imports from ../dist/tokens.js (compiled dist, not source)
  - packages/shared/tests/analyzerDeps.test.mjs:7 - imports from ../dist/tooling/analyzerDeps.js (compiled dist)
  - packages/shared/tests/exec.test.mjs:4 - imports from ../dist/tooling/exec.js (compiled dist)
  - packages/shared/tests/repoConventions.test.mjs:8 - imports from ../dist/tooling/repoConventions.js (compiled dist)
  - runtime:unit:packages-shared: confirmed — Deterministic runtime command succeeded: npm test

### TST-001 — All test files import from compiled dist, silently passing on stale builds

- Severity: medium
- Confidence: high
- Lens: tests
- Files: packages/audit-code/tests/orchestration.test.mjs, packages/audit-code/tests/orchestrator-remediation.test.mjs, packages/audit-code/tests/providers-remediation.test.mjs, packages/audit-code/tests/quota-scheduler.test.mjs
- Summary: Every test file uses top-level await imports from ../dist/ (compiled output). If the dist is stale or a developer runs node --test directly without rebuilding, the tests silently cover old code while appearing to pass.
- Evidence:
  - packages/audit-code/tests/orchestration.test.mjs:7 - const { decideNextStep } = await import("../dist/orchestrator/nextStep.js")
  - packages/audit-code/tests/orchestrator-remediation.test.mjs:6 - const { advanceAudit } = await import("../dist/orchestrator/advance.js")
  - packages/audit-code/tests/providers-remediation.test.mjs:12 - const { ACTIVE_CLAUDE_CODE_SESSION_MESSAGE, ClaudeCodeProvider } = await import("../dist/providers/claudeCodeProvider.js")
  - packages/audit-code/tests/quota-scheduler.test.mjs:6 - const { detectHostActiveSubagentLimit, resolveHostActiveSubagentLimit } = await import("../dist/quota/hostLimits.js")
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-001 — All test files import from dist/ instead of source

- Severity: medium
- Confidence: high
- Lens: tests
- Files: packages/audit-code/tests/review-packets.test.mjs, packages/audit-code/tests/schema-contracts.test.mjs, packages/audit-code/tests/scope.test.mjs, packages/audit-code/tests/supervisor-remediation.test.mjs
- Summary: Every test file in this packet imports compiled output from ../dist/ rather than TypeScript source. Tests will silently pass against a stale build if the source changes but the build is not refreshed, masking regressions until the next full rebuild.
- Evidence:
  - packages/audit-code/tests/review-packets.test.mjs:15 - const { buildAuditPlanMetrics, buildReviewPackets, orderTasksForPacketReview } = await import("../dist/orchestrator/reviewPackets.js");
  - packages/audit-code/tests/schema-contracts.test.mjs:11 - const { buildUnitManifest } = await import("../dist/orchestrator/unitBuilder.js");
  - packages/audit-code/tests/scope.test.mjs:9 - const { computeAuditScope, applyScopeToCoverage, resolveAuditScope, fullAuditScope } = await import("../dist/orchestrator/scope.js");
  - packages/audit-code/tests/supervisor-remediation.test.mjs:1 - const { buildAuditCodeHandoff, writeAuditCodeHandoffArtifacts } = await import("../dist/supervisor/operatorHandoff.js");
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-001 — All unit tests import compiled dist/ output rather than source

- Severity: medium
- Confidence: high
- Lens: tests
- Files: packages/audit-code/tests/adapters-remediation.test.mjs, packages/audit-code/tests/analyzer-seam.test.mjs, packages/audit-code/tests/discovered-limits.test.mjs, packages/audit-code/tests/edge-reasoning.test.mjs, packages/audit-code/tests/graph-framework-routes.test.mjs, packages/audit-code/tests/graph-path-utils.test.mjs, packages/audit-code/tests/header-extraction.test.mjs, packages/audit-code/tests/fixture-repo.test.mjs
- Summary: Every unit test in this packet (adapters-remediation, analyzer-seam, discovered-limits, edge-reasoning, graph-framework-routes, graph-path-utils, header-extraction, fixture-repo) uses top-level await import("../dist/..."). If dist/ is stale or absent the imports will either fail with a module-not-found error or silently exercise old compiled code, masking regressions in source. The sourceImport.mjs helper exists to compile from source on demand, but none of the tests in this packet use it.
- Evidence:
  - packages/audit-code/tests/adapters-remediation.test.mjs:4 - `const { normalizeCoverageSummary } = await import("../dist/adapters/coverageSummary.js");`
  - packages/audit-code/tests/analyzer-seam.test.mjs:8 - `"../dist/extractors/analyzers/merge.js"`
  - packages/audit-code/tests/fixture-repo.test.mjs:8 - `const { advanceAudit } = await import("../dist/orchestrator/advance.js");`
  - packages/audit-code/tests/helpers/sourceImport.mjs:33-86 - sourceImport helper compiles TypeScript on demand and is not imported by any in-packet test
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### OBS-001 — Analyzer failure swallowed without structured error context

- Severity: medium
- Confidence: high
- Lens: observability
- Files: packages/audit-code/src/orchestrator/graphEnrichmentExecutor.ts
- Summary: In runGraphEnrichmentExecutor, analyzer exceptions are caught and only the message string is embedded in a note field, losing the error type, stack trace, and any structured context. There is no way to distinguish a transient failure from a configuration error in the recorded output.
- Evidence:
  - packages/audit-code/src/orchestrator/graphEnrichmentExecutor.ts:201 - catch (error) block pushes only error.message into the note string; no error name, code, or stack is recorded alongside the capability entry
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### DI-004 — audit_findings.schema.json finding evidence is optional, contradicting finding.schema.json where it is required

- Severity: medium
- Confidence: high
- Lens: data_integrity
- Files: packages/audit-code/schemas/audit_findings.schema.json, packages/audit-code/schemas/finding.schema.json
- Summary: The audit-findings.json output contract defines findings inline and omits evidence from the required array, making it optional with no minItems. The canonical finding.schema.json marks evidence as required with minItems: 1. A finding written to the machine output contract can legally omit evidence even though the worker submission contract requires it.
- Evidence:
  - packages/audit-code/schemas/audit_findings.schema.json:40-48 - required array for finding items does not include evidence
  - packages/audit-code/schemas/audit_findings.schema.json:79 - evidence defined as optional array of strings with no minItems
  - packages/audit-code/schemas/finding.schema.json:8 - evidence is listed in required
  - packages/audit-code/schemas/finding.schema.json:61-65 - evidence has minItems: 1
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-002 — bash permission block duplicated verbatim under agent.auditor

- Severity: medium
- Confidence: high
- Lens: maintainability
- Files: opencode.json
- Summary: The entire bash permission map (lines 17-58) is copied verbatim into agent.auditor.permission.bash (lines 75-116) in opencode.json. Any change to an allow/deny rule must be made in two places, and the two copies will silently drift.
- Evidence:
  - opencode.json:17-58 - top-level bash permission block with ~20 allow/deny entries
  - opencode.json:75-116 - identical bash permission block nested under agent.auditor.permission, no mechanism for sharing or reference

### TST-001 — buildDispatchModelHint: several deep-tier trigger conditions lack dedicated tests

- Severity: medium
- Confidence: high
- Lens: tests
- Files: packages/audit-code/src/cli/dispatch.ts
- Summary: buildDispatchModelHint (dispatch.ts:161-214) routes packets to deep/standard/small model tiers based on seven tag and metric conditions, but the existing tests in review-packets.test.mjs only exercise three of them (isolated_large_file, high_priority, and small_low_priority_packet). The four untested deep-tier triggers are: critical_flow tag, external_analyzer_signal/external_tool tag, lens_verification tag, and estimated_tokens >= DEEP_MODEL_HINT_MIN_ESTIMATED_TOKENS without other deep reasons. A regression in any of these branches would silently misroute packets.
- Evidence:
  - packages/audit-code/src/cli/dispatch.ts:169 - critical_flow tag check: complexity.tags.some(tag => tag === 'critical_flow' || tag.startsWith('critical_flow:')) — no test exercises this
  - packages/audit-code/src/cli/dispatch.ts:173 - external_analyzer_signal/external_tool:* tag check leads to deep tier — not exercised
  - packages/audit-code/src/cli/dispatch.ts:180 - lens_verification tag check leads to deep tier — not exercised
  - packages/audit-code/src/cli/dispatch.ts:165 - estimated_tokens >= 9000 triggers deep tier; no test exercises token-count-driven deep routing alone
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-002 — buildPlanningGraphEdges chains four graph arrays with repeated spread-or-reuse pattern

- Severity: medium
- Confidence: high
- Lens: maintainability
- Files: packages/audit-code/src/orchestrator/reviewPackets.ts
- Summary: The function manually chains four intermediate graph arrays using an identical length>0 spread-or-reuse pattern four times. This repetition makes adding a fifth edge-builder strategy error-prone and obscures the pipeline structure.
- Evidence:
  - packages/audit-code/src/orchestrator/reviewPackets.ts:996 - graphWithBridges = bridgeEdges.length > 0 ? [...graphEdges, ...bridgeEdges] : graphEdges
  - packages/audit-code/src/orchestrator/reviewPackets.ts:1005 - graphWithSubsystems = subsystemEdges.length > 0 ? [...graphWithBridges, ...subsystemEdges] : graphWithBridges
  - packages/audit-code/src/orchestrator/reviewPackets.ts:1014 - graphWithPackageOwnership = packageOwnershipEdges.length > 0 ? [...graphWithSubsystems, ...packageOwnershipEdges] : graphWithSubsystems
  - packages/audit-code/src/orchestrator/reviewPackets.ts:1027 - fourth repetition for moduleOwnershipEdges; same spread-or-reuse pattern
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-003 — buildWorkBlocks union-find and dependency paths lack direct unit tests

- Severity: medium
- Confidence: high
- Lens: tests
- Files: packages/audit-code/src/reporting/workBlocks.ts
- Summary: buildWorkBlocks in workBlocks.ts implements union-find grouping, graph-edge dependency computation, and critical-flow ordering, but has no dedicated unit tests. It is only exercised transitively through buildAuditReportModel, leaving the multi-block sorting, graph-based depends_on derivation, and flow-based block chaining paths uncovered.
- Evidence:
  - packages/audit-code/src/reporting/workBlocks.ts:50 - computeDependencies walks graphBundle edges and criticalFlows to populate depends_on; never tested directly
  - packages/audit-code/src/reporting/workBlocks.ts:110 - union-find find/union functions handle multi-unit grouping; only single-unit blocks tested transitively
  - packages/audit-code/src/reporting/workBlocks.ts:184 - block re-indexing after severity sort not covered by a test with multiple severity-disparate blocks
  - packages/audit-code/tests/ - no file imports buildWorkBlocks directly
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-002 — chunking.ts has zero test coverage including critical edge cases

- Severity: medium
- Confidence: high
- Lens: tests
- Files: packages/audit-code/src/orchestrator/chunking.ts
- Summary: chunkLineCount is the only export of chunking.ts and has no tests. Untested edge cases: totalLines=0 must return [], an exact multiple of chunkSize must produce no trailing empty chunk, and single-line files. The function drives large-file splitting in taskBuilder and off-by-one bugs would silently mis-scope audit tasks.
- Evidence:
  - packages/audit-code/src/orchestrator/chunking.ts:6 - chunkLineCount is the sole export; no reference to chunking or chunkLineCount found in any test file under packages/audit-code/tests/
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-002 — classifyFindingRisk has no dedicated tests

- Severity: medium
- Confidence: high
- Lens: tests
- Files: packages/remediate-code/src/steps/nextStep.ts
- Summary: classifyFindingRisk in nextStep.ts is a pure function with four distinct rule branches (low-confidence, lens-is-breaking, change-is-destructive, lens-is-safe, low-risk) and is independently exported. It is used in buildImplementModelHint (dispatch.ts:133) and in the classify_impl_risks step (nextStep.ts:1074), but no test file imports or exercises it directly. The model-hints tests exercise buildImplementModelHint outcomes but do not assert the tier/reason values that classifyFindingRisk itself produces.
- Evidence:
  - packages/remediate-code/src/steps/nextStep.ts:157 - classifyFindingRisk is exported but no test file in tests/ imports it
  - packages/remediate-code/tests/model-hints.test.ts:133 - buildImplementModelHint tests pass findings with concrete_change fixed to "Fix it", so context_dependent/destructive branches of classifyFindingRisk are never triggered
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-001 — ClaudeCodeProvider active-session guard is never tested as throwing

- Severity: medium
- Confidence: high
- Lens: tests
- Files: packages/remediate-code/src/providers/claudeCodeProvider.ts
- Summary: providers.test.ts deletes process.env.CLAUDECODE before each ClaudeCodeProvider test so the guard at claudeCodeProvider.ts:30 is never exercised. There is no test that sets CLAUDECODE=1 and asserts that launch() throws the documented error message.
- Evidence:
  - packages/remediate-code/src/providers/claudeCodeProvider.ts:30 - if (process.env.CLAUDECODE) { throw new Error(ACTIVE_CLAUDE_CODE_SESSION_MESSAGE); }
  - packages/remediate-code/tests/providers.test.ts:355-358 - savedClaudeCode is deleted to clear CLAUDECODE, and only the non-throwing path is tested; there is no test block that sets CLAUDECODE=1 before calling launch()
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-001 — cli-remediation.test.mjs imports compiled dist/ output, not source

- Severity: medium
- Confidence: high
- Lens: tests
- Files: packages/audit-code/tests/cli-remediation.test.mjs
- Summary: cli-remediation.test.mjs imports dist/cli.js and dist/orchestrator/localCommands.js at the top level (lines 10-14). Every test in the file exercises the compiled output rather than TypeScript source, so the suite silently passes when dist/ is stale and source changes are not reflected.
- Evidence:
  - packages/audit-code/tests/cli-remediation.test.mjs:10-14 - `const distCliUrl = pathToFileURL(join(repoRoot, "dist", "cli.js")).href` and subsequent `await import(distCliUrl)` load compiled output; any TypeScript source change that is not followed by a rebuild will leave these tests passing against the stale binary.
  - runtime:flow:flow:surface:packages-audit-code-tests-cli-remediation-test-mjs: confirmed — Deterministic runtime command succeeded: npm test
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-003 — cli.ts re-exports and re-imports from ./cli/args.js in adjacent blocks creating unclear module boundary

- Severity: medium
- Confidence: high
- Lens: maintainability
- Files: packages/audit-code/src/cli.ts
- Summary: cli.ts first re-exports symbols from ./cli/args.js (lines 91-109) and then immediately imports an overlapping set of symbols from the same module (lines 111-134). The dual role of cli.ts as both a library facade and an executable blurs the module boundary and makes it hard to know which exports are part of the public API vs. internal use.
- Evidence:
  - packages/audit-code/src/cli.ts:91 - export { resolveHostDispatchCapability, DIRECT_CLI_DEFAULTS, getFlag, ... } from './cli/args.js' re-export block
  - packages/audit-code/src/cli.ts:111 - import { DIRECT_CLI_DEFAULTS, getFlag, hasFlag, fromBase64Url, ... } from './cli/args.js' immediately follows, importing overlapping symbols for internal use
  - packages/audit-code/src/cli.ts:175 - export const cliTestUtils exposes a third grouping of the same symbols from args.ts in the same file
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-003 — cmd.exe argument escaping regex duplicated with differing character sets in resolveOpentokenWrap vs quoteCmdArg

- Severity: medium
- Confidence: high
- Lens: maintainability
- Files: packages/audit-code/src/orchestrator/internalExecutors.ts
- Summary: internalExecutors.ts contains two independent implementations of cmd.exe safe-character detection: quoteCmdArg (line 199) uses /^[A-Za-z0-9_./:=+-]+$/ and the inline expression in resolveOpentokenWrap (line 121) uses /^[A-Za-z0-9_./:=@+-]+$/ -- the latter includes @. The character-set mismatch means the two paths treat @ differently, and future changes to one will not propagate to the other.
- Evidence:
  - packages/audit-code/src/orchestrator/internalExecutors.ts:121 - inline safe-char regex in resolveOpentokenWrap: /^[A-Za-z0-9_./:=@+-]+$/ (includes @)
  - packages/audit-code/src/orchestrator/internalExecutors.ts:200 - quoteCmdArg safe-char regex: /^[A-Za-z0-9_./:=+-]+$/ (missing @)
  - packages/audit-code/src/orchestrator/internalExecutors.ts:192-196 - quoteCmdArg used for the npm/npx/pnpm/yarn branch
  - packages/audit-code/src/orchestrator/internalExecutors.ts:119-125 - resolveOpentokenWrap uses its own inline escaping
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-002 — Complex internal parsers in graphManifestEdges have no unit tests

- Severity: medium
- Confidence: high
- Lens: tests
- Files: packages/audit-code/src/extractors/graphManifestEdges.ts
- Summary: stripJsonComments, removeTrailingJsonCommas, stripYamlComment, tomlArrayIsClosed, tomlStringArrayValues, cargoWorkspacePatterns, pnpmWorkspacePatterns, and goWorkspaceUseSpecifiers are non-trivial state-machine parsers only tested end-to-end through buildGraphBundle. Parser edge cases (escaped characters, multi-line TOML arrays, inline YAML lists, Go workspace replace directives) have no dedicated tests.
- Evidence:
  - packages/audit-code/src/extractors/graphManifestEdges.ts:267 - stripJsonComments: 58-line state-machine parser for JSONC comments, no direct test
  - packages/audit-code/src/extractors/graphManifestEdges.ts:327 - removeTrailingJsonCommas: 40-line state-machine parser, no direct test
  - packages/audit-code/src/extractors/graphManifestEdges.ts:491 - stripTomlComment: handles escaped quotes inside strings, no direct test
  - packages/audit-code/src/extractors/graphManifestEdges.ts:521 - tomlArrayIsClosed: tracks bracket depth through quoted strings, no direct test
  - packages/audit-code/src/extractors/graphManifestEdges.ts:602 - cargoWorkspacePatterns: multi-section TOML state machine, no direct test
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-003 — coverage.ts functions have no dedicated unit tests

- Severity: medium
- Confidence: high
- Lens: tests
- Files: packages/audit-code/src/coverage.ts
- Summary: createCoverageMatrix, markExcludedPath, applyUnitCoverage, applyFileCoverage, findUncoveredFiles, and buildRequeueTargets in coverage.ts are only exercised indirectly through orchestration integration tests. Edge cases such as applyFileCoverage with a lens not in required_lenses, or markExcludedPath on a non-existent path, are never asserted.
- Evidence:
  - packages/audit-code/src/coverage.ts:21 - markExcludedPath: silently returns when path is not in matrix; no test verifies this no-op behavior
  - packages/audit-code/src/coverage.ts:55 - applyFileCoverage: conditional update to completed_lenses only fires when coverage.lens is in required_lenses; no unit test exercises the else-branch
  - packages/audit-code/src/coverage.ts:85 - findUncoveredFiles: includes files with audit_status 'pending' and 'partial'; 'partial' case is not tested in isolation
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### COR-001 — Dead ternary in runtime_validation_current obligation always returns missing

- Severity: medium
- Confidence: high
- Lens: correctness
- Files: packages/audit-code/src/orchestrator/state.ts
- Summary: In deriveAuditState, the ternary expression on lines 188-190 evaluates has(bundle.runtime_validation_report) ? "missing" : "missing", making both branches identical. The distinction between whether runtime_validation_report exists or not is lost, and the orchestrator cannot distinguish between different not-ready states.
- Evidence:
  - packages/audit-code/src/orchestrator/state.ts:186-190 - runtimeReady ? "satisfied" : has(bundle.runtime_validation_report) ? "missing" : "missing" -- both non-satisfied branches return the same string "missing", rendering the inner ternary completely useless
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test
  - packages/audit-code/src/orchestrator/state.ts:186-190 - obligation('runtime_validation_current', runtimeReady ? 'satisfied' : has(bundle.runtime_validation_report) ? 'missing' : 'missing', ...) — both arms of the inner ternary are the string literal 'missing'

### DA-005 — Dependency cycle: 2 modules

- Severity: medium
- Confidence: high
- Lens: architecture
- Files: packages/remediate-code/src/phases/close.ts, packages/remediate-code/src/orchestrator.ts
- Summary: Circular dependency among packages/remediate-code/src/phases/close.ts → packages/remediate-code/src/orchestrator.ts → packages/remediate-code/src/phases/close.ts. Cycles increase coupling, complicate testing, and can cause initialization-order bugs.
- Evidence:
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### DA-010 — Dependency cycle: 2 modules

- Severity: medium
- Confidence: high
- Lens: architecture
- Files: packages/remediate-code/src/orchestrator.ts, packages/remediate-code/src/phases/document.ts, packages/remediate-code/src/phases/triage.ts, packages/remediate-code/src/phases/workerTasks.ts
- Summary: Circular dependency among packages/remediate-code/src/orchestrator.ts → packages/remediate-code/src/phases/document.ts → packages/remediate-code/src/phases/workerTasks.ts → packages/remediate-code/src/orchestrator.ts. Cycles increase coupling, complicate testing, and can cause initialization-order bugs.
- Evidence:
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-002 — deriveAuditState new obligations are untested

- Severity: medium
- Confidence: high
- Lens: tests
- Files: packages/audit-code/src/orchestrator/state.ts
- Summary: Three obligations added to deriveAuditState — graph_enrichment_current, design_assessment_current, and design_review_completed — are not exercised by any existing test, leaving their satisfaction conditions unverified.
- Evidence:
  - packages/audit-code/src/orchestrator/state.ts:95-115 — graph_enrichment_current and design_assessment_current obligations added alongside staleness tracking
  - packages/audit-code/src/orchestrator/state.ts:116-123 — design_review_completed obligation requires bundle.design_assessment.reviewed === true; no test exercises this path
  - Tests in staleness.test.mjs and orchestrator-remediation.test.mjs exercise older obligations only
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-001 — design-assessment and typescript-analyzer tests import stale dist/ output

- Severity: medium
- Confidence: high
- Lens: tests
- Files: packages/audit-code/src/extractors/designAssessment.ts, packages/audit-code/src/extractors/analyzers/typescript.ts
- Summary: design-assessment.test.mjs and typescript-analyzer.test.mjs import directly from ../dist/extractors/..., so running tests without a fresh build silently exercises stale compiled output. The extractors-remediation.test.mjs already uses the importSourceModule helper that compiles from source on-the-fly, so the pattern to fix this exists in the repo.
- Evidence:
  - packages/audit-code/tests/design-assessment.test.mjs:4 - const { buildDesignAssessment } = await import('../dist/extractors/designAssessment.js');
  - packages/audit-code/tests/typescript-analyzer.test.mjs:5 - const { typescriptAnalyzer } = await import('../dist/extractors/analyzers/typescript.js');
  - packages/audit-code/tests/typescript-analyzer.test.mjs:10 - const { buildPathLookup } = await import('../dist/extractors/graph.js');
  - packages/audit-code/tests/helpers/sourceImport.mjs:79 - importSourceModule compiles from source and is used in extractors-remediation.test.mjs but not these two test files
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-002 — design-assessment.test.mjs imports compiled dist/ output, not source

- Severity: medium
- Confidence: high
- Lens: tests
- Files: packages/audit-code/tests/design-assessment.test.mjs
- Summary: design-assessment.test.mjs imports ../dist/extractors/designAssessment.js (line 4). All assertions run against the compiled artifact, so the tests silently pass on a stale build when source is modified but not recompiled.
- Evidence:
  - packages/audit-code/tests/design-assessment.test.mjs:4-6 - `await import("../dist/extractors/designAssessment.js")` is the only import of the module under test; there is no source-level import path, so a stale dist/ produces false-green results.
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### DI-002 — dispatch_quota optional sub-objects lack additionalProperties: false

- Severity: medium
- Confidence: high
- Lens: data_integrity
- Files: packages/audit-code/schemas/dispatch_quota.schema.json
- Summary: The quota_source_snapshot and backoff_state objects in dispatch_quota.schema.json define named properties but omit additionalProperties: false. Unknown keys on these objects are accepted without error, creating a silent data-integrity gap where misspelled or stale fields go undetected.
- Evidence:
  - packages/audit-code/schemas/dispatch_quota.schema.json:103-121 - quota_source_snapshot defines 6 named properties but has no additionalProperties constraint
  - packages/audit-code/schemas/dispatch_quota.schema.json:113-121 - backoff_state defines 3 named properties but has no additionalProperties constraint
  - packages/audit-code/schemas/dispatch_quota.schema.json:19 - top-level object correctly sets additionalProperties: false, but nested optional objects do not
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-001 — dispatch/merge-results.mjs and dispatch/validate-result.mjs have no tests

- Severity: medium
- Confidence: high
- Lens: tests
- Files: packages/audit-code/dispatch/merge-results.mjs, packages/audit-code/dispatch/validate-result.mjs
- Summary: The standalone dispatch scripts merge-results.mjs and validate-result.mjs have no test coverage. These scripts drive the packet validation/merge pipeline and contain non-trivial error-handling logic including JSON parse failures and missing-file paths.
- Evidence:
  - packages/audit-code/dispatch/merge-results.mjs:44-63 - per-file JSON parse try/catch and validateResult loop not exercised by any test
  - packages/audit-code/dispatch/validate-result.mjs:37-46 - pending-audit-tasks.json fallback lookup path not covered by tests
  - packages/audit-code/dispatch/validate.mjs:1 - imports from ../dist/validation/auditResults.js; stale dist would affect these scripts silently with no tests to catch it
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-002 — Duplicate bash permission block in opencode.json between top-level and agent.auditor

- Severity: medium
- Confidence: high
- Lens: maintainability
- Files: packages/audit-code/opencode.json, packages/audit-code/opencode.json
- Summary: The bash permission map under opencode.json top-level permission (lines 17-55) is nearly identical to the agent.auditor.permission.bash block (lines 74-114), differing only by one extra entry in the agent block. Both must be updated in sync whenever command permissions change.
- Evidence:
  - packages/audit-code/opencode.json:17 - top-level bash block begins with deny rules for run-to-completion, synthesize, cleanup, requeue, ingest-results and allow rules for ensure, next-step, prepare-dispatch, submit-packet, merge-and-ingest, validate, worker-run
  - packages/audit-code/opencode.json:74 - agent.auditor.permission.bash block reproduces the identical deny and allow pattern, adding only Select-String at line 113
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### COR-001 — Duplicate task IDs from repeated lenses in required_lenses

- Severity: medium
- Confidence: high
- Lens: correctness
- Files: packages/audit-code/src/orchestrator.ts
- Summary: buildAuditTasks iterates required_lenses without deduplication. If a unit carries the same lens twice the loop emits two tasks with identical task_id (unit_id:lens), which downstream consumers treat as primary keys for ingestion, coverage, and packet submission — causing silent overwrites or double-counting.
- Evidence:
  - packages/audit-code/src/orchestrator.ts:99 - `for (const lens of unit.required_lenses)` iterates over lenses without checking for duplicates
  - packages/audit-code/src/orchestrator.ts:41-43 - assertLensArray only validates that each item is a valid Lens string; it does not reject duplicate entries
  - packages/audit-code/src/orchestrator.ts:105 - task_id is `${unit.unit_id}:${lens}`, so two tasks for the same lens on the same unit share an identical task_id
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-001 — Duplicated action handler bodies for run and next-step commands

- Severity: medium
- Confidence: high
- Lens: maintainability
- Files: packages/remediate-code/src/index.ts, packages/remediate-code/src/index.ts
- Summary: The run and next-step Commander action handlers in src/index.ts share identical bodies (both call decideNextStep with the same options construction and print the result). Any change to the next-step handler must be manually mirrored in the run handler.
- Evidence:
  - packages/remediate-code/src/index.ts:107-127 - run action calls withBackendLogsOnStderr(() => decideNextStep({...})) and console.log(JSON.stringify(step))
  - packages/remediate-code/src/index.ts:151-167 - next-step action is byte-for-byte identical; no shared helper extracted
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-002 — Duplicated LENS_ORDER constant across two modules with divergent contents

- Severity: medium
- Confidence: high
- Lens: maintainability
- Files: packages/audit-code/src/orchestrator.ts, packages/audit-code/src/orchestrator/auditTaskUtils.ts
- Summary: DEFAULT_LENS_ORDER in orchestrator.ts (10 items, omits observability) and LENS_ORDER in auditTaskUtils.ts (10 items, omits architecture) are separate copies of the lens enumeration with different contents. Neither is imported from a shared source, so lens ordering can silently diverge.
- Evidence:
  - packages/audit-code/src/orchestrator.ts:3 - DEFAULT_LENS_ORDER has 10 entries, omits observability
  - packages/audit-code/src/orchestrator/auditTaskUtils.ts:3 - LENS_ORDER has 10 entries, omits architecture, includes observability
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### DR-006 — ensure has no environment preflight; fresh checkouts and git worktrees fail with misleading errors

- Severity: medium
- Confidence: high
- Lens: operability
- Files: packages/audit-code/audit-code-wrapper-lib.mjs, packages/audit-code/audit-code.mjs
- Summary: Following the documented loader (`ensure`, then `next-step`) in a fresh checkout or a git worktree fails before any audit work begins. With no build present, `ensure` throws a raw `ENOENT ... packages/audit-code/dist`. Worse: in a git worktree that has not been `npm install`ed, the workspace symlink node_modules/@audit-tools/shared is absent, so module resolution walks up to a *different* checkout's stale shared/dist and the dependents emit ~16 TS2305 'has no exported member' errors (spawnLoggedCommand, buildQuotaSource, scheduleWave, ...) that masquerade as a broken repository — when the source is in fact consistent. This was observed first-hand during this run: this session's own Claude-Code worktree had no node_modules, so resolution resolved shared against the main checkout. Because the tool is frequently launched from throwaway worktrees, this is a real operability gap. Recommendation: add a preflight/doctor to `ensure` that verifies deps are installed, @audit-tools/shared is built, the workspace symlink resolves to the *local* shared, and the audit-code dist exists — and on any failure prints the exact remediation (install + build order) instead of a stack trace.
- Evidence:
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-002 — executeClosingAction git/npm action branches have no test coverage

- Severity: medium
- Confidence: high
- Lens: tests
- Files: packages/remediate-code/src/phases/close.ts
- Summary: phase-close.test.ts exercises only action:none and action:custom. The commit, push, open-pr, publish, and tag branches inside executeClosingAction are entirely untested, as is the e2e_command exception-throw path in runClosePhase.
- Evidence:
  - packages/remediate-code/src/phases/close.ts:181 - action === commit branch: no test
  - packages/remediate-code/src/phases/close.ts:184 - action === push branch: no test
  - packages/remediate-code/src/phases/close.ts:185 - action === open-pr branch: no test
  - packages/remediate-code/src/phases/close.ts:188 - action === publish branch: no test
  - packages/remediate-code/src/phases/close.ts:190 - action === tag branch: no test
  - packages/remediate-code/src/phases/close.ts:275 - e2e_command error throw: no test
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### DI-003 — external_analyzer_results line_start/line_end lack minimum: 1, allowing zero or negative line numbers

- Severity: medium
- Confidence: high
- Lens: data_integrity
- Files: packages/audit-code/schemas/external_analyzer_results.schema.json
- Summary: In external_analyzer_results.schema.json, result items' line_start and line_end fields are typed as integer but have no minimum constraint. The canonical finding.schema.json enforces minimum: 1 on the same fields. An external analyzer result can therefore carry a zero or negative line reference, which is invalid in any source file context.
- Evidence:
  - packages/audit-code/schemas/external_analyzer_results.schema.json:62 - "line_start": { "type": "integer" } with no minimum constraint
  - packages/audit-code/schemas/external_analyzer_results.schema.json:63 - "line_end": { "type": "integer" } with no minimum constraint
  - packages/audit-code/schemas/finding.schema.json:51-52 - the same fields carry minimum: 1 in the finding contract
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### DR-005 — File-type classifier mislabels Markdown and YAML in the inventory the user sees first

- Severity: medium
- Confidence: high
- Lens: data_integrity
- Files: packages/audit-code/src/extractors/fileInventory.ts, packages/audit-code/src/extractors/languageMap.generated.ts
- Summary: The design-review context this very run produced reports the file inventory as '489 files (typescript: 245, javascript: 90, json: 87, gcc machine description: 49, miniyaml: 11, ...)'. This repo contains zero GCC machine-description or MiniYAML files — those 49 + 11 are the project's Markdown (.md) and YAML (.yml/.yaml) files. GCC uses the .md extension for machine descriptions and OpenRA uses MiniYAML, so the generated language map (extractors/languageMap.generated.ts) is resolving an extension to a github-linguist language without weighting by popularity/primary status, letting an obscure language win over Markdown/YAML. This is the first artifact a user reads, and it visibly mislabels the project — undermining trust in every downstream finding. Recommendation: fix the precedence during language-map generation (prefer the primary/most-popular language for an extension, or special-case .md/.yml/.yaml), and add a unit test asserting .md resolves to Markdown. Consider sourcing detection from a maintained classifier rather than a hand-generated map.
- Evidence:
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-004 — fileAnchors.ts (buildFileAnchorSummary) has zero test coverage

- Severity: medium
- Confidence: high
- Lens: tests
- Files: packages/audit-code/src/orchestrator/fileAnchors.ts
- Summary: buildFileAnchorSummary is a complex function that parses file content to extract symbols, routes, keywords, graph edges, and analyzer signals, applies deduplication and truncation, and caps output at MAX_ANCHORS=160. None of this logic is tested. Missing: symbol pattern matching per language, keyword detection, anchor deduplication, the MAX_ANCHORS cap, and the omitted_anchor_count accuracy.
- Evidence:
  - packages/audit-code/src/orchestrator/fileAnchors.ts:38 - MAX_ANCHORS=160 cap applied at line 266 but never verified by a test; no test file imports fileAnchors or buildFileAnchorSummary
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-003 — fileIntegrity.ts has zero test coverage

- Severity: medium
- Confidence: high
- Lens: tests
- Files: packages/audit-code/src/orchestrator/fileIntegrity.ts
- Summary: checkFileIntegrity checks SHA-256 hashes against the repo manifest to detect changed or missing files. The function is never exercised by any test. Untested paths include the changed-file branch, missing-file branch, the scope filter (only checking a subset of manifest files), and the is_clean:true happy path.
- Evidence:
  - packages/audit-code/src/orchestrator/fileIntegrity.ts:18 - checkFileIntegrity exported function; no test file in packages/audit-code/tests/ imports fileIntegrity or checkFileIntegrity
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-003 — fileIntegrity.ts has zero test coverage

- Severity: medium
- Confidence: high
- Lens: tests
- Files: packages/remediate-code/src/utils/fileIntegrity.ts
- Summary: checkAffectedFileIntegrity and snapshotAffectedFileHashes in fileIntegrity.ts are not tested. These functions detect whether files changed between planning and implementation; silent failures here would allow remediation to proceed on modified files without detection.
- Evidence:
  - packages/remediate-code/src/utils/fileIntegrity.ts:33 - checkAffectedFileIntegrity exported but not referenced in any test file
  - packages/remediate-code/src/utils/fileIntegrity.ts:62 - snapshotAffectedFileHashes exported but not referenced in any test file
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-001 — Flat 18-branch if/else dispatch in runAuditCodeWrapper

- Severity: medium
- Confidence: high
- Lens: maintainability
- Files: packages/audit-code/audit-code-wrapper-lib.mjs
- Summary: The exported runAuditCodeWrapper function contains a flat chain of 18 if/else-if branches to dispatch subcommands (lines 2835-2936). Every new subcommand requires adding another branch in the same block, and the default fallback that synthesises the command name is buried at the end. A dispatch table mapping command names to handlers would make the function significantly easier to extend and read.
- Evidence:
  - packages/audit-code/audit-code-wrapper-lib.mjs:2835 - if (hasFlag(argv, '--help') || hasFlag(argv, '-h')) {
  - packages/audit-code/audit-code-wrapper-lib.mjs:2845 - if (argv[0] === 'prompt-path') {
  - packages/audit-code/audit-code-wrapper-lib.mjs:2850 - if (argv[0] === 'ensure') {
  - packages/audit-code/audit-code-wrapper-lib.mjs:2910 - if (argv[0] === 'submit-packet') {
  - packages/audit-code/audit-code-wrapper-lib.mjs:2935 - const command = hasFlag(wrapperArgs, '--single-step') ? 'advance-audit' : 'run-to-completion';
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### CD-001 — Floating npm version range used during publish step

- Severity: medium
- Confidence: high
- Lens: config_deployment
- Files: packages/audit-code/.github/workflows/publish-package.yml
- Summary: The publish workflow upgrades npm with a floating caret range (npm@^11.5.1), which allows any compatible newer version to be installed silently. This means publish behavior can change across runs if a new npm minor is released, reducing reproducibility for a security-sensitive step.
- Evidence:
  - packages/audit-code/.github/workflows/publish-package.yml:67 - npm install -g npm@^11.5.1 (caret range allows any npm >=11.5.1 <12.0.0)
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-003 — Frame-parsing logic duplicated between createMcpClient and parseFramedMessage

- Severity: medium
- Confidence: high
- Lens: maintainability
- Files: packages/audit-code/tests/mcp-server.test.mjs, packages/audit-code/tests/mcp-server.test.mjs
- Summary: In mcp-server.test.mjs, the Content-Length framing parse algorithm appears twice: inside the createMcpClient stdout.on('data') handler and again in the standalone parseFramedMessage function. The magic offset separator+4 and the content-length header search are duplicated.
- Evidence:
  - packages/audit-code/tests/mcp-server.test.mjs:43 - const separator = buffer.indexOf; frameLength = separator + 4 + contentLength inside createMcpClient
  - packages/audit-code/tests/mcp-server.test.mjs:113 - identical framing parse in parseFramedMessage; createMcpClient could delegate to parseFramedMessage
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### COR-002 — git add . in worktree stages remediation-artifacts files into block commit

- Severity: medium
- Confidence: high
- Lens: correctness
- Files: packages/remediate-code/src/phases/implement.ts
- Summary: runBlockInWorktree runs git add . inside the worktree, staging all files including task JSONs, prompt files, and stdout/stderr logs written into the shared artifactsDir. close.ts excludes .remediation-artifacts/ from staging via collectStagingFiles, but the worktree commit bypasses that filter, polluting the git history with ephemeral artifact files.
- Evidence:
  - packages/remediate-code/src/phases/implement.ts:443 - runCommand("git", ["add", "."]) stages everything in blockRoot, no exclusion filter
  - packages/remediate-code/src/phases/close.ts:137-140 - STAGING_EXCLUDE_PATTERNS excludes .remediation-artifacts/ only in collectStagingFiles, not in the worktree commit path
  - packages/remediate-code/src/phases/close.ts:142-145 - collectStagingFiles is only called from executeClosingAction, not from runBlockInWorktree
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### COR-002 — GitHub Release rollback hardcodes remote name origin instead of using resolved remoteName

- Severity: medium
- Confidence: high
- Lens: correctness
- Files: packages/remediate-code/scripts/release-and-publish.mjs
- Summary: In scripts/release-and-publish.mjs, when the GitHub Release creation fails, the rollback attempts to delete the remote tag by pushing to the hardcoded remote name origin rather than the dynamically resolved remoteName. If the repository remote is not named origin the tag deletion push silently targets the wrong remote, leaving a dangling tag and hiding the rollback failure.
- Evidence:
  - packages/remediate-code/scripts/release-and-publish.mjs:361 - run("git", ["push", "origin", `:refs/tags/${tag}`]) uses hardcoded string "origin" instead of remoteName variable
  - packages/remediate-code/scripts/release-and-publish.mjs:345 - const remoteName = getRemoteName(); is correctly used for push on line 348 and 351 but not in the rollback block at line 361
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### OBS-002 — Graph bundle builder silently skips unreadable files with no diagnostic

- Severity: medium
- Confidence: high
- Lens: observability
- Files: packages/audit-code/src/extractors/graph.ts
- Summary: In `buildGraphBundleFromFs`, file-read failures are caught and discarded with a comment (`// Best-effort graph extraction should not block structure planning.`) and no log or counter. Across a large repository, multiple unreadable files silently reduce graph coverage with no observable signal for operators.
- Evidence:
  - packages/audit-code/src/extractors/graph.ts:401-405 - `try { fileContents[file.path] = await readFile(...) } catch { /* Best-effort... */ }` — read error silently skips file with no log or skipped-file count
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-001 — graphManifestEdges.ts is too large: 8+ unrelated manifest parsers in one 1437-line file

- Severity: medium
- Confidence: high
- Lens: maintainability
- Files: packages/audit-code/src/extractors/graphManifestEdges.ts
- Summary: graphManifestEdges.ts packs parsers for JSON/JSONC, YAML, TOML, Go workspace go.work, XML/Maven pom.xml, and pyproject.toml six distinct format families plus edge-extraction logic for each, totalling 1437 lines. Adding or fixing support for any single manifest format requires navigating and risking regressions in unrelated parsers.
- Evidence:
  - packages/audit-code/src/extractors/graphManifestEdges.ts:267 - stripJsonComments: JSON/JSONC comment stripper
  - packages/audit-code/src/extractors/graphManifestEdges.ts:445 - pnpmWorkspacePatterns: YAML parser for pnpm-workspace.yaml
  - packages/audit-code/src/extractors/graphManifestEdges.ts:491 - stripTomlComment: TOML comment stripper separate from JSON/YAML
  - packages/audit-code/src/extractors/graphManifestEdges.ts:602 - cargoWorkspacePatterns: TOML parser for Cargo.toml workspaces
  - packages/audit-code/src/extractors/graphManifestEdges.ts:941 - stripGoLineComment: Go line-comment stripper for go.work
  - packages/audit-code/src/extractors/graphManifestEdges.ts:1144 - stripXmlComments: XML comment stripper for Maven pom.xml
  - packages/audit-code/src/extractors/graphManifestEdges.ts:1242 - pyprojectTestpaths: TOML parser for pyproject.toml tool.pytest.ini_options
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-001 — graphPathUtils core helpers have no direct unit tests

- Severity: medium
- Confidence: high
- Lens: tests
- Files: packages/audit-code/src/extractors/graphPathUtils.ts
- Summary: resolveCandidate, resolveSpecifier, resolveReferenceLiteral, graphEdge, and graphLookupKey are exported from graphPathUtils.ts but graph-path-utils.test.mjs only tests normalizeGraphPath and the manifest predicates. The extension-alias resolution logic (js->ts/tsx/jsx, mjs->mts, cjs->cts) and index-file fallback are not tested at the unit level.
- Evidence:
  - packages/audit-code/src/extractors/graphPathUtils.ts:49 - resolveCandidate exported, handles direct lookup, runtime->source extension aliasing, bare path + extensions, and index file probing
  - packages/audit-code/src/extractors/graphPathUtils.ts:128 - resolveSpecifier exported, used by graphRoutes.ts and other extractors
  - packages/audit-code/src/extractors/graphPathUtils.ts:141 - resolveReferenceLiteral exported, used by graphRoutes.ts Angular branch
  - packages/audit-code/tests/graph-path-utils.test.mjs:1 - test file only exercises normalizeGraphPath (line 16) and manifest predicates (line 30); no tests for any resolution helpers
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-002 — hostLimits.ts imported from compiled dist/ in tests while all other shared quota modules use workspace alias

- Severity: medium
- Confidence: high
- Lens: tests
- Files: packages/shared/src/quota/hostLimits.ts
- Summary: detectHostActiveSubagentLimit and resolveHostActiveSubagentLimit are imported in tests from the compiled ../dist/quota/hostLimits.js path, while scheduleWave and all state functions use the @audit-tools/shared workspace alias. A source change to hostLimits.ts without a rebuild silently tests stale compiled output.
- Evidence:
  - packages/audit-code/tests/quota-scheduler.test.mjs:8 - import from ../dist/quota/hostLimits.js (compiled dist path)
  - packages/audit-code/tests/quota-scheduler.test.mjs:4 - scheduleWave imported via @audit-tools/shared/quota/scheduler (workspace alias)
  - packages/audit-code/tests/quota-scheduler.test.mjs:16 - state functions imported via @audit-tools/shared/quota/state (workspace alias)
  - runtime:unit:packages-shared: confirmed — Deterministic runtime command succeeded: npm test

### MNT-002 — InputResolution interface duplicated across nextStep.ts and intakeResolver.ts

- Severity: medium
- Confidence: high
- Lens: maintainability
- Files: packages/remediate-code/src/steps/nextStep.ts, packages/remediate-code/src/steps/intakeResolver.ts
- Summary: An identical `InputResolution` interface is declared locally in `nextStep.ts` (lines 105-110) and exported again from `intakeResolver.ts` (lines 265-270); callers use the local copy, creating drift risk whenever the shape needs to change.
- Evidence:
  - packages/remediate-code/src/steps/nextStep.ts:105 - interface InputResolution { supplied: boolean; existing: string[]; missing: string[]; checked: string[]; } (private, local)
  - packages/remediate-code/src/steps/intakeResolver.ts:265 - export interface InputResolution { supplied: boolean; existing: string[]; missing: string[]; checked: string[]; } (exported duplicate)
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-003 — installBootstrap is a ~300-line function with repeated profile-flag pattern

- Severity: medium
- Confidence: high
- Lens: maintainability
- Files: packages/audit-code/audit-code-wrapper-lib.mjs
- Summary: installBootstrap (lines 2469-2769, ~300 lines) builds a large assetPaths object with nullable ternary fields per profile flag, then iterates over the same flags in sequential if-blocks to write files. Adding a new host surface requires editing the assetPaths object, the if-block, and the hostGuidance mapping in lockstep. The repetitive pattern could be table-driven.
- Evidence:
  - packages/audit-code/audit-code-wrapper-lib.mjs:2483 - assetPaths built with 20+ nullable ternary fields keyed on profile flags
  - packages/audit-code/audit-code-wrapper-lib.mjs:2574 - if (profile.writeCodex) {
  - packages/audit-code/audit-code-wrapper-lib.mjs:2601 - if (profile.writeClaudeDesktop) {
  - packages/audit-code/audit-code-wrapper-lib.mjs:2619 - if (profile.writeOpenCode) {
  - packages/audit-code/audit-code-wrapper-lib.mjs:2629 - if (profile.writeVSCode) {
  - packages/audit-code/audit-code-wrapper-lib.mjs:2658 - if (profile.writeAntigravity) {
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-003 — installToCache in analyzerDeps.ts has no test coverage

- Severity: medium
- Confidence: high
- Lens: tests
- Files: packages/shared/src/tooling/analyzerDeps.ts
- Summary: analyzerDeps.test.mjs tests resolveAnalyzerDep and parseAnalyzerSpec thoroughly but never exercises installToCache, which includes error paths (missing version, npm failure, package not found after install) that are unverified.
- Evidence:
  - packages/shared/tests/analyzerDeps.test.mjs:7 - only imports resolveAnalyzerDep and parseAnalyzerSpec; installToCache is not imported or exercised
  - packages/shared/src/tooling/analyzerDeps.ts:140-142 - missing-version error path (returns {ok:false, error:...}) is untested
  - packages/shared/src/tooling/analyzerDeps.ts:162-167 - npm install failure path (result.status !== 0) is untested
  - packages/shared/src/tooling/analyzerDeps.ts:168-171 - post-install package-not-found check is untested
  - runtime:unit:packages-shared: confirmed — Deterministic runtime command succeeded: npm test

### COR-002 — lensSetForFlow() in flowCoverage.ts silently excludes observability lens

- Severity: medium
- Confidence: high
- Lens: correctness
- Files: packages/audit-code/src/orchestrator/flowCoverage.ts
- Summary: The allowed set in lensSetForFlow() does not include "observability", so critical flows that declare observability concerns will never have those lenses tracked in the flow coverage manifest — they are silently dropped, making coverage tracking incorrect for observability-sensitive flows.
- Evidence:
  - packages/audit-code/src/orchestrator/flowCoverage.ts:8-15 - allowed Lens[] is security, reliability, correctness, data_integrity, operability, performance — observability is missing
  - packages/audit-code/src/types.ts:14 - observability is a valid Lens member
  - packages/audit-code/src/orchestrator/flowCoverage.ts:16-18 - filter silently discards any concern not in allowed, so observability concerns produce no required_lenses entry and buildFlowCoverage will never reflect observability coverage gaps
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### OBS-002 — MCP error logging omits stack trace and swallows structured error context

- Severity: medium
- Confidence: high
- Lens: observability
- Files: packages/remediate-code/src/mcp/server.ts, packages/remediate-code/src/mcp/server.ts, packages/remediate-code/src/mcp/server.ts
- Summary: logNextStepError logs request metadata plus the raw error object but errorMessage() reduces the error to a plain string in the wire response, discarding the stack trace. No correlation token links the stderr log to the JSON-RPC error response seen by the client.
- Evidence:
  - packages/remediate-code/src/mcp/server.ts:43-54 - logNextStepError calls console.error with raw error object but no guaranteed stack trace
  - packages/remediate-code/src/mcp/server.ts:56-59 - errorMessage(err) returns only err.message so wire error response carries no stack or cause chain
  - packages/remediate-code/src/mcp/server.ts:349 - writeError sends client-visible message stripped of stack
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### OBS-002 — MCP server logs no request or error telemetry

- Severity: medium
- Confidence: high
- Lens: observability
- Files: packages/audit-code/src/mcp/server.ts
- Summary: runAuditCodeMcpServer and dispatchRequest handle all JSON-RPC traffic but emit nothing to stderr or any log sink. Tool call errors are caught and returned as JSON-RPC -32000 payloads with only error.message — no tool name, no argument context, no stack trace, and no timing is logged anywhere for the MCP surface.
- Evidence:
  - packages/audit-code/src/mcp/server.ts:923-930 - catch block returns failure(request.id, -32000, error.message) with no stderr write or structured log
  - packages/audit-code/src/mcp/server.ts:964-973 - request dispatch loop: no timing or per-request log entry written
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-001 — MCP server module does too many things (God module)

- Severity: medium
- Confidence: high
- Lens: maintainability
- Files: packages/audit-code/src/mcp/server.ts
- Summary: server.ts (980 lines) combines JSON-RPC framing, tool dispatch, resource registry, and prompt registry in one file. handleToolCall is an 84-line switch with inline per-tool logic, mixing parameter validation, resolution, and subprocess invocation. Changes to any single tool or framing layer require navigating the entire file.
- Evidence:
  - packages/audit-code/src/mcp/server.ts:460 - handleToolCall switch covers 9 tools with inline logic each
  - packages/audit-code/src/mcp/server.ts:432 - runContinueAudit mixes subprocess execution with artifact file enrichment in one function
  - packages/audit-code/src/mcp/server.ts:288 - resourceRegistry, promptRegistry, and toolDefinitions() all colocated in the same module
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-005 — mcp-server concurrent guard describe block contains no actual concurrency test

- Severity: medium
- Confidence: high
- Lens: tests
- Files: packages/remediate-code/tests/mcp-server.test.ts
- Summary: The describe block named 'parseFrame — concurrent guard precondition' only tests that tool-call frames parse correctly, not that a second concurrent next_step call is actually rejected. The concurrent guard behavior itself is never asserted.
- Evidence:
  - packages/remediate-code/tests/mcp-server.test.ts:137 - describe block named concurrent guard precondition contains only parseFrame parsing assertions
  - packages/remediate-code/tests/mcp-server.test.ts:138-163 - tests verify frame parsing only; no concurrent request is sent and no rejection is asserted
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### COR-001 — merge-and-ingest: console status 'partial' diverges from persisted worker result status 'no_progress' on failure

- Severity: medium
- Confidence: high
- Lens: correctness
- Files: packages/audit-code/src/cli.ts
- Summary: In cmdMergeAndIngest, the local `status` variable (line 888) uses 'partial' when there are failures, but `buildWorkerResult` is called with 'no_progress' for the same condition (line 894). The console output and the written result file report different statuses, misleading callers about whether partial progress was made.
- Evidence:
  - packages/audit-code/src/cli.ts:888 - const status = failing.length > 0 ? 'partial' : ...
  - packages/audit-code/src/cli.ts:894 - status: failing.length > 0 ? 'no_progress' : ...
  - packages/audit-code/src/cli.ts:907 - console output uses local `status` variable ('partial') while file uses workerResult.status ('no_progress')
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-001 — Module-level mutable counter in designAssessment.ts

- Severity: medium
- Confidence: high
- Lens: maintainability
- Files: packages/audit-code/src/extractors/designAssessment.ts
- Summary: nextFindingId is a module-level mutable variable reset inside buildDesignAssessment. Concurrent calls or test suites that call the function multiple times without isolation will produce non-deterministic IDs.
- Evidence:
  - packages/audit-code/src/extractors/designAssessment.ts:5 - let nextFindingId = 1; (module-level mutable counter)
  - packages/audit-code/src/extractors/designAssessment.ts:289 - nextFindingId = 1; (reset inside exported function, not thread-safe)
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-001 — Multiple test files import compiled dist/ output, silently passing on stale builds

- Severity: medium
- Confidence: high
- Lens: tests
- Files: packages/audit-code/tests/orchestrator.test.mjs, packages/audit-code/tests/prompt-invocation.test.mjs, packages/audit-code/tests/quota-packets.test.mjs, packages/audit-code/tests/provider-auto-resolution.test.mjs
- Summary: orchestrator.test.mjs, prompt-invocation.test.mjs, quota-packets.test.mjs, and provider-auto-resolution.test.mjs all import from ../dist/... rather than source. If the build is stale (source changed but dist/ not rebuilt), these tests silently pass against the old compiled code, masking regressions.
- Evidence:
  - packages/audit-code/tests/orchestrator.test.mjs:4 - const { buildAuditTasks } = await import("../dist/orchestrator.js");
  - packages/audit-code/tests/prompt-invocation.test.mjs:4-6 - imports nextStepCommand and mergeAndIngestCommand from ../dist/cli/prompts.js
  - packages/audit-code/tests/quota-packets.test.mjs:4 - const { buildReviewPackets } = await import("../dist/orchestrator/reviewPackets.js");
  - packages/audit-code/tests/provider-auto-resolution.test.mjs:4-5 - const { resolveFreshSessionProviderName } = await import("../dist/providers/index.js");
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-002 — No direct tests for chromeExtensionRiskSignalsForManifest or deriveBrowserExtensionLensesForPath

- Severity: medium
- Confidence: high
- Lens: tests
- Files: packages/audit-code/src/extractors/browserExtension.ts, packages/audit-code/src/extractors/browserExtension.ts
- Summary: browserExtension.ts exports chromeExtensionRiskSignalsForManifest (line 477) and deriveBrowserExtensionLensesForPath (line 378) which have no dedicated tests. The extractors-remediation.test.mjs Chrome extension test only exercises buildGraphBundle and buildSurfaceManifest; neither risk-signal extraction nor lens derivation logic is verified.
- Evidence:
  - packages/audit-code/src/extractors/browserExtension.ts:378 - export function deriveBrowserExtensionLensesForPath — no test invokes this directly
  - packages/audit-code/src/extractors/browserExtension.ts:477 - export function chromeExtensionRiskSignalsForManifest — no test invokes this directly
  - packages/audit-code/tests/extractors-remediation.test.mjs:649 - Chrome extension test only checks graph edges and surface manifest, not risk signals or lens derivation
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### OBS-001 — No logging at subprocess execution or failure in localCommands

- Severity: medium
- Confidence: high
- Lens: observability
- Files: packages/audit-code/src/orchestrator/localCommands.ts
- Summary: runFirstAvailableCommand executes subprocesses and captures errors and exit codes in a return struct, but never emits any log or diagnostic at the point of execution or failure. Callers receive a LocalCommandResult and must themselves decide whether to report; any silent discard by a caller loses forensic context permanently.
- Evidence:
  - packages/audit-code/src/orchestrator/localCommands.ts:125-145 - spawnSync is called and its result (including result.error and result.status) is packaged into a return object with no logging; stderr is captured but never surfaced unless the caller explicitly checks it
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-001 — No tests for discoveredLimits persistence functions

- Severity: medium
- Confidence: high
- Lens: tests
- Files: packages/audit-code/src/quota/discoveredLimits.ts
- Summary: readDiscoveredLimitsCache, writeDiscoveredLimitsCache, updateDiscoveredLimits, and lookupDiscoveredLimits in discoveredLimits.ts are not tested. The existing tests only cover mergeDiscoveredLimits. These functions handle file I/O with non-trivial logic including cache-miss fallback, partial-update merging, and null-entry filtering.
- Evidence:
  - packages/audit-code/src/quota/discoveredLimits.ts:28 - readDiscoveredLimitsCache reads and validates persisted cache; returns empty object on ENOENT
  - packages/audit-code/src/quota/discoveredLimits.ts:52 - writeDiscoveredLimitsCache writes atomically to path derived from getQuotaStatePath()
  - packages/audit-code/src/quota/discoveredLimits.ts:58 - updateDiscoveredLimits merges partial limits into the cache without replacing existing nulls
  - packages/audit-code/src/quota/discoveredLimits.ts:79 - lookupDiscoveredLimits returns null when both rpm and tpm are absent; no test covers this path
  - packages/audit-code/tests/discovered-limits.test.mjs:4 - only mergeDiscoveredLimits is imported and exercised; no test touches the file-backed functions
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-004 — No tests for envelope.ts helper functions

- Severity: medium
- Confidence: high
- Lens: tests
- Files: packages/audit-code/src/cli/envelope.ts
- Summary: buildBlockedAuditState, buildManualReviewBlocker, and shouldRunInlineExecutor in envelope.ts have no direct unit tests. buildBlockedAuditState mutates obligation states and deduplicates blockers — logic subtle enough to warrant isolated tests.
- Evidence:
  - packages/audit-code/src/cli/envelope.ts:102 - blockers: [...new Set([...(params.state.blockers ?? []), params.blocker])] — deduplication logic not tested in isolation
  - packages/audit-code/src/cli/envelope.ts:87 - shouldRunInlineExecutor returns false for null or 'agent', true otherwise — not unit-tested
  - packages/audit-code/src/cli/envelope.ts:80 - buildManualReviewBlocker returns different strings based on LOCAL_SUBPROCESS_PROVIDER_NAME — not tested
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-003 — No tests for prompt rendering functions in prompts.ts

- Severity: medium
- Confidence: high
- Lens: tests
- Files: packages/audit-code/src/cli/prompts.ts
- Summary: renderDispatchReviewPrompt, renderSingleTaskFallbackStepPrompt, renderEdgeReasoningStepPrompt, renderEdgeReasoningDispatchPrompt, renderAnalyzerInstallPrompt, renderBlockedStepPrompt, and renderPresentReportPrompt produce the human-visible step instructions served to the host agent, but none are unit-tested for their output content or shape.
- Evidence:
  - packages/audit-code/src/cli/prompts.ts:57 - renderDispatchReviewPrompt: modelLine inclusion depends on hostCanSelectSubagentModel, toolsLine depends on hostCanRestrictSubagentTools — neither branch is tested
  - packages/audit-code/src/cli/prompts.ts:81 - dispatchDataLines has two branches (with/without dispatchQuotaPath) — not tested
  - packages/audit-code/tests/prompt-invocation.test.mjs:6 - only nextStepCommand and mergeAndIngestCommand are imported and tested; rendering functions are absent
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-006 — No tests for reviewRun.ts lifecycle functions

- Severity: medium
- Confidence: high
- Lens: tests
- Files: packages/audit-code/src/cli/reviewRun.ts
- Summary: ensureSemanticReviewRun, persistConfigErrorHandoff, writeHandoffOnly, loadCurrentActiveReviewRun, and activeReviewRunFromTask have no direct tests. ensureSemanticReviewRun has two branches (existing run reuse vs. new run creation) that are exercised only through full end-to-end tests.
- Evidence:
  - packages/audit-code/src/cli/reviewRun.ts:93 - if (existingRun) branch reuses an already-created run; no test verifies this idempotency branch
  - packages/audit-code/src/cli/reviewRun.ts:122 - new run creation path builds runId, writes task files, pendingTasks, handoff — not tested in isolation
  - packages/audit-code/src/cli/reviewRun.ts:179 - if (!activeReviewRun) throw — the internal error guard is untested
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### COR-001 — OPENCODE_REMEDIATE_EDIT_PERMISSION missing remediation-closing-result.json in index.ts

- Severity: medium
- Confidence: high
- Lens: correctness
- Files: packages/remediate-code/src/index.ts, packages/remediate-code/scripts/postinstall.mjs
- Summary: The OPENCODE_REMEDIATE_EDIT_PERMISSION constant in src/index.ts omits the remediation-closing-result.json allow rule that is present in the scripts/postinstall.mjs copy of the same permission object. This causes the ensure command (which uses the index.ts copy) to install an OpenCode permission config that does not grant write access to remediation-closing-result.json, while a fresh package install (via postinstall.mjs) does grant it. The two code paths produce divergent permission configs.
- Evidence:
  - packages/remediate-code/src/index.ts:23-28 - OPENCODE_REMEDIATE_EDIT_PERMISSION has only .remediation-artifacts/**, remediation-report.md, and remediation-report.json; remediation-closing-result.json is absent
  - packages/remediate-code/scripts/postinstall.mjs:57-63 - Same-named constant includes remediation-closing-result.json: allow in addition to the other three rules
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### SHD-001 — opentoken wrap path in spawnLoggedCommand is entirely untested

- Severity: medium
- Confidence: high
- Lens: tests
- Files: packages/shared/src/providers/spawnLoggedCommand.ts
- Summary: The `options.opentoken = true` branch in `spawnLoggedCommand` (lines 66-74) applies a command wrapping via `applyOpenTokenWrap`, including a Windows-specific cmd.exe form. No test in the packet (or visible in providers.test.ts) exercises this code path, meaning the opentoken integration is shipped without test coverage.
- Evidence:
  - packages/shared/src/providers/spawnLoggedCommand.ts:66-74 - `if (options.opentoken)` branch wraps command; never exercised in providers.test.ts
  - packages/shared/src/providers/spawnLoggedCommand.ts:30-45 - `applyOpenTokenWrap` with Windows path also untested
  - runtime:unit:packages-shared: confirmed — Deterministic runtime command succeeded: npm test

### COR-001 — parseNumericValue rejects zero, hiding exhausted quota state

- Severity: medium
- Confidence: high
- Lens: correctness
- Files: packages/audit-code/src/quota/headerExtraction.ts
- Summary: parseNumericValue returns null for n<=0, so a server response of remaining-requests:0 or remaining-tokens:0 is silently discarded. Callers cannot distinguish an exhausted quota from an absent header, which could cause the system to proceed when it should wait.
- Evidence:
  - packages/audit-code/src/quota/headerExtraction.ts:46 - return Number.isFinite(n) && n > 0 ? n : null - zero is rejected
  - packages/audit-code/src/quota/headerExtraction.ts:15-18 - remaining_requests and remaining_tokens fields use parseNumericValue with no custom transform, so 0 values are dropped
  - packages/audit-code/src/quota/headerExtraction.ts:60-77 - same parseNumericValue is used for both limit fields (where 0 is invalid) and remaining fields (where 0 is a valid exhausted state)
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-006 — persistAnalyzerSettings has no test coverage

- Severity: medium
- Confidence: high
- Lens: tests
- Files: packages/audit-code/src/supervisor/sessionConfig.ts
- Summary: persistAnalyzerSettings in sessionConfig.ts is not tested. It merges per-analyzer resolution decisions into session-config.json, validates the merged result, and writes it back. Non-trivial merge logic (preserving unknown fields, merging into existing analyzers map) and the validation-failure error path have zero test coverage.
- Evidence:
  - packages/audit-code/src/supervisor/sessionConfig.ts:57 - persistAnalyzerSettings reads current config, merges analyzers map, re-validates, and writes back
  - packages/audit-code/src/supervisor/sessionConfig.ts:65 - isRecord guard on base config before merge not covered by any test
  - packages/audit-code/src/supervisor/sessionConfig.ts:69 - validation error path throws formatted message; not exercised
  - packages/audit-code/tests/ - no file imports persistAnalyzerSettings
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### COR-001 — postinstall: bare readFileSync for opencode-command-template.txt throws uncaught on missing file

- Severity: medium
- Confidence: high
- Lens: correctness
- Files: packages/audit-code/scripts/postinstall.mjs
- Summary: Line 281 of postinstall.mjs calls readFileSync on 'opencode-command-template.txt' at module top-level with no try/catch or existence check, unlike all other source reads which use readRequiredSource/readOptionalSource. If the file is absent (e.g. in a non-standard install), this throws an unhandled exception before any graceful-exit path runs, causing postinstall to fail with an ugly stack trace instead of the diagnostic warning the rest of the script provides.
- Evidence:
  - packages/audit-code/scripts/postinstall.mjs:281 - const OPENCODE_MCP_COMMAND_TEMPLATE = readFileSync(opencodeCommandTemplateFile, 'utf8').replace(/
/g, '
').trim(); — no try/catch or existsSync guard
  - packages/audit-code/scripts/postinstall.mjs:13-20 - readRequiredSource() wraps readFileSync with existsSync check and graceful process.exitCode=0 return, but is not used here
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-001 — prepareDispatchArtifacts is an oversized function with multiple mixed responsibilities

- Severity: medium
- Confidence: high
- Lens: maintainability
- Files: packages/audit-code/src/cli/dispatch.ts
- Summary: prepareDispatchArtifacts in dispatch.ts spans ~418 lines (lines 325-742) and mixes task loading, packet building, file anchor extraction, prompt rendering, quota computation, and artifact writing. This makes it difficult to read, test, or change any one concern without risk of affecting the others.
- Evidence:
  - packages/audit-code/src/cli/dispatch.ts:325 - function signature begins; params span task loading, packet building, quota, and host limits
  - packages/audit-code/src/cli/dispatch.ts:350-360 - loads workerTask.json and pending tasks and immediately merges with bundle data
  - packages/audit-code/src/cli/dispatch.ts:428-636 - for-loop over packets handles anchor extraction, prompt rendering, and per-packet plan building all inline
  - packages/audit-code/src/cli/dispatch.ts:646-692 - quota computation and wave scheduling embedded at end of same function
  - packages/audit-code/src/cli/dispatch.ts:715-741 - writes four separate artifact files (dispatch plan, result map, dispatch quota, active dispatch) before returning
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-002 — prepareDispatchArtifacts: path-escape guard and oversized-packet warning path lack tests

- Severity: medium
- Confidence: high
- Lens: tests
- Files: packages/audit-code/src/cli/dispatch.ts, packages/audit-code/src/cli/dispatch.ts
- Summary: withinRoot (dispatch.ts:216-224) throws when a path escapes the repo root, but no test exercises that rejection. The oversized-packet warning path (lines 698-707) that fires when estimated_tokens exceeds the context budget is also never exercised; all integration tests assert warning_count === 0. These gaps mean a regression in path validation or quota-budget warning would not be caught by the test suite.
- Evidence:
  - packages/audit-code/src/cli/dispatch.ts:220 - path escape check throws Error when relativePath.startsWith('..') or isAbsolute(relativePath) — no test passes a traversal path to trigger this
  - packages/audit-code/src/cli/dispatch.ts:698 - oversized-packet warning block pushes warning when estimated_tokens > contextBudget — no test configures quota limits low enough to trigger this
  - packages/audit-code/src/cli/dispatch.ts:709 - warningsPath is written only when warnings.length > 0; no test verifies this branch or checks dispatch-warnings.json content
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### OBS-002 — Provider launch error log missing task/run context

- Severity: medium
- Confidence: high
- Lens: observability
- Files: packages/remediate-code/src/phases/implement.ts
- Summary: When a provider launch fails in runStepWithProvider, the catch block logs the error with stdout/stderr file paths but omits task_id, run_id, provider name, and process exit code, making it difficult to correlate the failure with a specific agent invocation in a multi-block run.
- Evidence:
  - packages/remediate-code/src/phases/implement.ts:88-93 - catch(err) block logs `Step ${stepName} failed for ${findingId}: ${err}` with stdout/stderr paths but no provider name, task run_id, or exit code
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-001 — Provider parameter typed as 'any' obscures FreshSessionProvider contract

- Severity: medium
- Confidence: high
- Lens: maintainability
- Files: packages/remediate-code/src/phases/implement.ts
- Summary: The provider field in ExecuteBlockDeps and the provider parameter of runStepWithProvider and runRefactorWithRetry are all typed 'any'. FreshSessionProvider from @audit-tools/shared is the correct type; using 'any' prevents static contract checking and makes the interface invisible to readers.
- Evidence:
  - packages/remediate-code/src/phases/implement.ts:129 - 'provider: any;' in ExecuteBlockDeps interface
  - packages/remediate-code/src/phases/implement.ts:27 - function runStepWithProvider(provider: any, ...) parameter is untyped
  - packages/remediate-code/src/phases/implement.ts:306 - function runRefactorWithRetry(provider: any, ...) parameter is untyped
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### COR-001 — providerAuditResultsPath always clears pendingAuditResultsPath during agent steps

- Severity: medium
- Confidence: high
- Lens: correctness
- Files: packages/audit-code/src/cli/runToCompletion.ts, packages/audit-code/src/cli/runToCompletion.ts
- Summary: At line 1042, `if (providerAuditResultsPath) pendingAuditResultsPath = undefined` clears the pending --results path on every agent run because providerAuditResultsPath is always a newly-constructed path (truthy) when preferredExecutor is 'agent'. If the decision first selects 'agent' while a --results file is pending, the path is wiped before the result_ingestion_executor ever reads it, silently dropping the user-supplied results file.
- Evidence:
  - packages/audit-code/src/cli/runToCompletion.ts:904-907 - providerAuditResultsPath is set to join(paths.runDir, 'audit-results.json') when preferredExecutor==='agent', which is always truthy
  - packages/audit-code/src/cli/runToCompletion.ts:1042 - `if (providerAuditResultsPath) pendingAuditResultsPath = undefined` executes on every agent iteration, clearing the --results path even when the agent step was unrelated to ingestion
  - packages/audit-code/src/cli/runToCompletion.ts:228-232 - pendingAuditResultsPath is consumed by the result_ingestion_executor branch only when bundle.coverage_matrix is present, meaning it may not yet have been used when the agent step runs
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### CFG-001 — publish-shared skips verify:release gate before publishing

- Severity: medium
- Confidence: high
- Lens: config_deployment
- Files: .github/workflows/publish-package.yml
- Summary: The publish-shared job does not run 'npm run verify:release' before publishing to npm. Both publish-audit-code (lines 108-114) and publish-remediate-code (lines 271-277) run this gate (typecheck + tests + packaged smoke), but publish-shared jumps straight from Build to Resolve publish metadata, so a broken shared package can be published without verification.
- Evidence:
  - .github/workflows/publish-package.yml:108-114 - publish-audit-code runs 'npm run verify:release' with timeout-minutes: 20 before publishing
  - .github/workflows/publish-package.yml:271-277 - publish-remediate-code runs 'npm run verify:release' with timeout-minutes: 20 before publishing
  - .github/workflows/publish-package.yml:419-424 - publish-shared runs only 'npm run build'; no verify:release step exists in the job

### OBS-001 — Quota state corruption silently resets to empty state

- Severity: medium
- Confidence: high
- Lens: observability
- Files: packages/shared/src/quota/state.ts
- Summary: In readQuotaState(), when the file is unreadable (non-ENOENT errors), the code logs to stderr and silently returns an empty state. This means a corrupted quota-state.json causes all learned quota data to be silently discarded on that read, with only a single stderr message that may go unnoticed.
- Evidence:
  - packages/shared/src/quota/state.ts:66-79 - On invalid JSON or parse failure (code != ENOENT), writes one line to process.stderr then returns { version: 2, entries: {} }, discarding all learned rate-limit history silently
  - runtime:unit:packages-shared: confirmed — Deterministic runtime command succeeded: npm test

### MNT-003 — quoteCmdArg duplicated in spawnLoggedCommand.ts and opencodeLaunch.ts; canonical version already exported from exec.ts

- Severity: medium
- Confidence: high
- Lens: maintainability
- Files: packages/shared/src/providers/spawnLoggedCommand.ts, packages/shared/src/providers/opencodeLaunch.ts
- Summary: spawnLoggedCommand.ts defines a private quoteCmdArg and opencodeLaunch.ts defines quoteOpenCodeCmdArg, both implementing the same Windows cmd.exe quoting logic. exec.ts already exports the canonical quoteForCmd. These private copies can drift independently.
- Evidence:
  - packages/shared/src/providers/spawnLoggedCommand.ts:25-28 - private quoteCmdArg uses same double-quote with ^-escape regex as quoteForCmd
  - packages/shared/src/providers/opencodeLaunch.ts:28-33 - private quoteOpenCodeCmdArg is identical in logic
  - packages/shared/src/tooling/exec.ts:40-44 - quoteForCmd is the canonical exported version
  - runtime:unit:packages-shared: confirmed — Deterministic runtime command succeeded: npm test

### MNT-004 — Raw-spawn initialize+request+kill lifecycle repeated across five tests

- Severity: medium
- Confidence: high
- Lens: maintainability
- Files: packages/audit-code/tests/mcp-server.test.mjs, packages/audit-code/tests/mcp-server.test.mjs, packages/audit-code/tests/mcp-server.test.mjs, packages/audit-code/tests/mcp-server.test.mjs, packages/audit-code/tests/mcp-server.test.mjs
- Summary: Five tests in mcp-server.test.mjs each spawn a raw MCP child, write an initialize message, call readFramedPayload, write a follow-up message, read the response, then kill the process in a finally block. This boilerplate is copy-pasted verbatim and a bug in any step must be fixed five times.
- Evidence:
  - packages/audit-code/tests/mcp-server.test.mjs:419 - child.stdin.write(encodeMessage({ method: 'initialize' ... })); await readFramedPayload(child.stdout); pattern repeated at lines 453, 489, 669
  - packages/audit-code/tests/mcp-server.test.mjs:447 - finally { child.kill(); await new Promise((resolve) => child.on('exit', resolve)); } identical finally block in every raw-spawn test
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-003 — recordWaveOutcome core persistence path has no test coverage

- Severity: medium
- Confidence: high
- Lens: tests
- Files: packages/shared/src/quota/state.ts
- Summary: The exported recordWaveOutcome and its internal recordWaveOutcomeUnsafe in state.ts — the primary mutation path that writes success/failure bucket weights and triggers cooldowns — have no tests. Only the pure computation functions are exercised. A regression in the disk-write or bucket-update logic would go undetected.
- Evidence:
  - packages/shared/src/quota/state.ts:148-155 - recordWaveOutcome (exported) — not imported in any test file
  - packages/shared/src/quota/state.ts:157-198 - recordWaveOutcomeUnsafe: success branch increments buckets 1..concurrency; rate_limited branch applies failure weights to buckets concurrency..concurrency+4 — neither branch has a test
  - packages/shared/src/quota/state.ts:82-88 - writeQuotaState also untested directly
  - runtime:unit:packages-shared: confirmed — Deterministic runtime command succeeded: npm test

### COR-002 — release-and-publish: git add uses wrong relative path for monorepo root package-lock.json

- Severity: medium
- Confidence: high
- Lens: correctness
- Files: packages/audit-code/scripts/release-and-publish.mjs
- Summary: In bumpVersionAndTag (line 155), 'git add' is called with '../../package-lock.json' while the cwd is 'packages/audit-code' (repoRoot). From that directory, '../../' resolves to the parent of the monorepo root, one level above the intended monorepo root package-lock.json; the correct path would be '../package-lock.json'. This causes git add to silently attempt staging a file outside the repo, which git will reject with an error or silently skip, leaving the monorepo lock file unstaged in the release commit.
- Evidence:
  - packages/audit-code/scripts/release-and-publish.mjs:8-9 - here = dirname(scripts/), repoRoot = resolve(here, '..') = packages/audit-code
  - packages/audit-code/scripts/release-and-publish.mjs:155 - run('git', ['add', 'package.json', 'package-lock.json', '../../package-lock.json']) with cwd=repoRoot (packages/audit-code); ../../package-lock.json from packages/audit-code is two levels up (parent of monorepo root), not the monorepo root package-lock.json which would be ../package-lock.json
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### DI-003 — remediation_report missing outcome categories present in remediation_outcomes

- Severity: medium
- Confidence: high
- Lens: data_integrity
- Files: packages/remediate-code/schemas/remediation_outcomes.schema.json, packages/remediate-code/schemas/remediation_report.schema.json
- Summary: remediation_outcomes.schema.json defines five outcome values (resolved, verified_no_change, inappropriate, ignored, blocked) but remediation_report.schema.json only has top-level arrays for three of them (resolved, inappropriate, ignored). Findings with outcomes 'verified_no_change' or 'blocked' cannot be represented in the report.
- Evidence:
  - packages/remediate-code/schemas/remediation_outcomes.schema.json:14-25 - by_outcome required: resolved, verified_no_change, inappropriate, ignored, blocked
  - packages/remediate-code/schemas/remediation_report.schema.json:14-51 - report arrays: resolved, inappropriate, ignored only; no 'verified_no_change' or 'blocked' arrays
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-005 — renderSemanticReviewStep has no unit tests

- Severity: medium
- Confidence: high
- Lens: tests
- Files: packages/audit-code/src/cli/semanticReviewStep.ts
- Summary: renderSemanticReviewStep in semanticReviewStep.ts is untested. Both branches (hostCanDispatch=false producing a single_task_fallback step, and hostCanDispatch=true producing a dispatch_review step with quota artifacts) have no test coverage. This function is a critical output for the host agent driving the audit loop.
- Evidence:
  - packages/audit-code/src/cli/semanticReviewStep.ts:33 - hostCanDispatch=false branch: writes a single_task_fallback step; no test exercises this path
  - packages/audit-code/src/cli/semanticReviewStep.ts:67 - hostCanDispatch=true branch: calls prepareDispatchArtifacts and writes a dispatch_review step; no test verifies the assembled StepArtifact fields
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-002 — renderSharedMcpLauncher generates code as concatenated string arrays

- Severity: medium
- Confidence: high
- Lens: maintainability
- Files: packages/audit-code/audit-code-wrapper-lib.mjs
- Summary: renderSharedMcpLauncher (lines 1019-1123) produces the MCP launcher script by returning a large array of JS code strings joined by newlines. Any logic change to the launcher requires editing escaped JavaScript-inside-strings, making it error-prone and impossible to typecheck or lint. The generated tryCandidates resolution logic mirrors the wrapper-level candidate logic conceptually but diverges in detail, with no shared abstraction.
- Evidence:
  - packages/audit-code/audit-code-wrapper-lib.mjs:1019 - function renderSharedMcpLauncher(sourcePackageRoot) {
  - packages/audit-code/audit-code-wrapper-lib.mjs:1048 - JS code stored as string literals within an array
  - packages/audit-code/audit-code-wrapper-lib.mjs:1060 - candidate path resolution duplicated as string template
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-001 — resolveIntakeStep has no direct unit tests

- Severity: medium
- Confidence: high
- Lens: tests
- Files: packages/remediate-code/src/steps/intakeResolver.ts
- Summary: intakeResolver.ts exports resolveIntakeStep, a function with at least seven distinct branches (manifest refresh, missing-file fallback, audit fast-path, conversationStart path, source resolution, synthesize_intake, collect_intake_clarifications, extract_findings). All coverage of these branches is exercised indirectly via decideNextStep integration tests in next-step.test.ts; there are no unit tests that call resolveIntakeStep directly with a stubbed store/promptBuilders. This means every branch can only be validated by running the full next-step integration harness, and failures in prompt-builder callbacks or the InputResolution contract are hard to isolate.
- Evidence:
  - packages/remediate-code/src/steps/intakeResolver.ts:24 - resolveIntakeStep is the sole export of the module; the function accepts 10 injectable callbacks but no test file imports or calls it directly
  - packages/remediate-code/tests/next-step.test.ts:153 - the closest coverage is via decideNextStep({root, input}) which drives the intake path only through the full orchestrator loop
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### COR-001 — retry-after threshold misclassifies values at exactly 600

- Severity: medium
- Confidence: high
- Lens: correctness
- Files: packages/shared/src/quota/errorParsing.ts
- Summary: extractRetryAfterMs converts values < 600 from seconds to ms, but a retry-after value of exactly 600 (a common 10-minute cooldown) is treated as already being in milliseconds (0.6 seconds) rather than 600 seconds (600000 ms). The boundary condition should be <= 600 or the documentation should clarify the cutoff.
- Evidence:
  - packages/shared/src/quota/errorParsing.ts:37 - `return val < 600 ? val * 1000 : val;` — a value of exactly 600 is returned as-is (600 ms = 0.6 s) instead of being multiplied to 600000 ms (10 minutes). The comment says values < 600 are treated as seconds, so 600 itself is silently treated as milliseconds, yielding an almost instant retry rather than a 10-minute cooldown.
  - runtime:unit:packages-shared: confirmed — Deterministic runtime command succeeded: npm test

### MNT-001 — reviewPackets.ts: several long functions with multiple interleaved concerns

- Severity: medium
- Confidence: high
- Lens: maintainability
- Files: packages/audit-code/src/orchestrator/reviewPackets.ts, packages/audit-code/src/orchestrator/reviewPackets.ts, packages/audit-code/src/orchestrator/reviewPackets.ts
- Summary: Three functions in reviewPackets.ts exceed 100 lines and mix distinct concerns: buildEntrypointFlowBridgeEdges (~110 lines, BFS traversal plus edge deduplication plus display-path resolution), buildBoundedClusterEdges (~119 lines, cluster selection plus token budget check plus edge emission), and buildPlanningGraphEdges (chains four graph-augmentation passes with intermediate arrays making the pipeline hard to follow). These functions are hard to change safely in isolation because a change to one pass in buildPlanningGraphEdges requires understanding the full sequence, and adding a new cluster strategy to buildBoundedClusterEdges requires untangling the multi-level loop.
- Evidence:
  - packages/audit-code/src/orchestrator/reviewPackets.ts:498 - buildBoundedClusterEdges accepts 9-field params object, contains nested Map/Set iteration with token budget check, cluster entry comparison, and edge emission all in one body
  - packages/audit-code/src/orchestrator/reviewPackets.ts:916 - BFS queue processing in buildEntrypointFlowBridgeEdges mixes hop-limit checks, branch-limit checks, bridgeEdge key computation, and visited-set management in a single while loop body
  - packages/audit-code/src/orchestrator/reviewPackets.ts:983 - buildPlanningGraphEdges chains bridge, subsystem, packageOwnership, and moduleOwnership edge sets through four consecutive conditional spreads, making the transformation sequence hard to trace
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### COR-001 — run-to-completion path omits selfInvocationEnv(), breaking dogfooded source-checkout continuation commands

- Severity: medium
- Confidence: high
- Lens: correctness
- Files: packages/audit-code/audit-code-wrapper-lib.mjs
- Summary: The default run-to-completion dispatch at line 2936 calls run() without passing selfInvocationEnv(), so the AUDIT_CODE_INVOCATION hint is never set on the spawned dist backend. All other runDistCommand calls (next-step, prepare-dispatch, submit-packet, etc.) at line 2796-2798 correctly spread selfInvocationEnv() into the env option; the run-to-completion path is the only one that does not, meaning the dist backend emits continuation commands using the global audit-code bin instead of the local wrapper when running from a source checkout.
- Evidence:
  - packages/audit-code/audit-code-wrapper-lib.mjs:2936 - await run(nodeExecutable(), [distEntry, command, ...wrapperArgs]); — no options object, so run() falls through to `env: options.env ?? process.env` at line 104, never injecting AUDIT_CODE_INVOCATION
  - packages/audit-code/audit-code-wrapper-lib.mjs:2796-2798 - runDistCommand passes { env: { ...process.env, ...selfInvocationEnv() } }, correctly propagating the hint to all other subcommands
  - packages/audit-code/audit-code-wrapper-lib.mjs:69-79 - selfInvocationEnv() sets AUDIT_CODE_INVOCATION to the local audit-code.mjs path when not in node_modules; without it the dist backend cannot emit the correct local wrapper path in continuation commands
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-003 — runClosePhase is an oversized function with deeply mixed concerns

- Severity: medium
- Confidence: high
- Lens: maintainability
- Files: packages/remediate-code/src/phases/close.ts
- Summary: runClosePhase spans 288 lines (lines 205-492) and performs at least five distinct responsibilities: running unit tests, running e2e tests, executing the closing action, generating a Markdown report, and cleaning up branches and artifacts. This makes it hard to read, test, or change any single concern in isolation.
- Evidence:
  - packages/remediate-code/src/phases/close.ts:218-251 - unit test execution block with triage fallback
  - packages/remediate-code/src/phases/close.ts:259-281 - e2e test execution block
  - packages/remediate-code/src/phases/close.ts:284-289 - closing action execution
  - packages/remediate-code/src/phases/close.ts:292-433 - inline Markdown report construction via repeated string concatenation
  - packages/remediate-code/src/phases/close.ts:453-488 - git branch cleanup and artifact directory deletion
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### OBS-002 — runCommand captures only last 10 output lines, discarding earlier failure context

- Severity: medium
- Confidence: high
- Lens: observability
- Files: packages/audit-code/src/orchestrator/internalExecutors.ts
- Summary: The runtime-validation runCommand helper trims combined stdout+stderr to the final 10 lines before storing them as evidence. When a command fails with a long diagnostic the root cause may be in the truncated portion with no indication that truncation occurred.
- Evidence:
  - packages/audit-code/src/orchestrator/internalExecutors.ts:163 - const evidence = output.length > 0 ? output.split(/\r?\n/).slice(-10) : []; -- hard-coded 10-line tail with no configurable limit and no annotation indicating lines were omitted
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-002 — runDeterministicForNextStep handles too many executor branches in a single function

- Severity: medium
- Confidence: high
- Lens: maintainability
- Files: packages/audit-code/src/cli/nextStepCommand.ts
- Summary: runDeterministicForNextStep in nextStepCommand.ts is ~360 lines (lines 78-439) and contains a loop that dispatches to six distinct executor types, each with its own multi-step logic. Adding or modifying any branch requires understanding the full loop context.
- Evidence:
  - packages/audit-code/src/cli/nextStepCommand.ts:131-429 - main for-loop with six separate if-blocks each 30-90 lines long
  - packages/audit-code/src/cli/nextStepCommand.ts:179-278 - graph_enrichment_executor branch handles analyzer installs AND edge-reasoning as nested sub-cases
  - packages/audit-code/src/cli/nextStepCommand.ts:280-310 - design_review branch reads incoming file and mutates bundle.design_assessment directly
  - packages/audit-code/src/cli/nextStepCommand.ts:311-343 - synthesis_narrative branch mirrors the same read-incoming-file pattern as design_review
  - packages/audit-code/src/cli/nextStepCommand.ts:376-428 - catch path writes two separate JSON files (audit_state + progress) inline
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-001 — runDocumentPhase nearly untested as a direct unit

- Severity: medium
- Confidence: high
- Lens: tests
- Files: packages/remediate-code/src/phases/document.ts
- Summary: phase-document.test.ts contains only one test covering the deemed_inappropriate resolution sub-path. The happy path (provider returns item_spec, item advances to documented), the clarification_request return path, the parallel_safe strip on public_contract clarifications, and the warning logged for empty normalizeClarificationResolutions are not directly unit-tested.
- Evidence:
  - packages/remediate-code/src/phases/document.ts:146 - main finding loop with item_spec / clarification_request branching not covered by direct unit tests
  - packages/remediate-code/src/phases/document.ts:248 - parallel_safe stripping on public_contract clarification not directly asserted
  - packages/remediate-code/src/phases/document.ts:280 - pending-item blocking after loop has no direct test
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### OBS-001 — RunLogger defaults to disabled — all advance events silently dropped without caller opt-in

- Severity: medium
- Confidence: high
- Lens: observability
- Files: packages/audit-code/src/orchestrator/advance.ts
- Summary: advanceAudit accepts an optional runLogger that defaults to RunLogger.disabled(), meaning all structured obligation/executor/artifact events are silently discarded unless the caller explicitly wires up a logger. In practice the MCP path and CLI paths that do not supply a logger produce zero observability output regardless of how many steps execute.
- Evidence:
  - packages/audit-code/src/orchestrator/advance.ts:96 - const log = options.runLogger ?? RunLogger.disabled();
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-002 — runPlanPhase has excessive length with seven mixed responsibilities

- Severity: medium
- Confidence: high
- Lens: maintainability
- Files: packages/remediate-code/src/phases/plan.ts
- Summary: runPlanPhase (125 lines, plan.ts:477-601) inlines input loading, LLM extraction dispatch, cross-lens dedup, fallback block derivation, context-budget splitting, project-type detection, and plan validation in a single function body.
- Evidence:
  - packages/remediate-code/src/phases/plan.ts:488-518 - Input loading and conditional LLM extraction inline in the function body
  - packages/remediate-code/src/phases/plan.ts:521-539 - Cross-lens dedup, fallback block derivation, and context-budget splitting as sequential top-level statements
  - packages/remediate-code/src/phases/plan.ts:543-556 - Project-type detection (package.json / go.mod / pyproject.toml) embedded directly in the phase function
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-004 — runTracked in exec.ts has no test coverage

- Severity: medium
- Confidence: high
- Lens: tests
- Files: packages/shared/src/tooling/exec.ts
- Summary: exec.test.mjs only imports and tests resolveExecArgv, quoteForCmd, shellQuote, and platformCommand. The runTracked function itself — which wraps spawnSync, handles empty argv, merges opentoken, and returns structured results — is never exercised.
- Evidence:
  - packages/shared/tests/exec.test.mjs:4 - only imports resolveExecArgv, quoteForCmd, shellQuote, platformCommand; runTracked is absent
  - packages/shared/src/tooling/exec.ts:143-149 - empty-argv guard path (returns error object) is untested
  - packages/shared/src/tooling/exec.ts:156-166 - spawnSync call with all options (timeout, input, maxBuffer, stdio) is untested
  - runtime:unit:packages-shared: confirmed — Deterministic runtime command succeeded: npm test

### MNT-001 — runWrapper duplicated across three test files

- Severity: medium
- Confidence: high
- Lens: maintainability
- Files: packages/audit-code/tests/next-step.test.mjs, packages/audit-code/tests/next-step-narrative.test.mjs, packages/audit-code/tests/next-step-edge-reasoning.test.mjs
- Summary: The runWrapper helper function (spawn wrapper, stdout/stderr accumulation, promise resolution) is copy-pasted identically in next-step.test.mjs, next-step-narrative.test.mjs, and next-step-edge-reasoning.test.mjs. Any change to process-spawning behavior or error handling must be made in three places.
- Evidence:
  - packages/audit-code/tests/next-step.test.mjs:20 - function runWrapper(args, options = {}) with spawn/stdout/stderr/exit pattern
  - packages/audit-code/tests/next-step-narrative.test.mjs:23 - identical runWrapper function body
  - packages/audit-code/tests/next-step-edge-reasoning.test.mjs:37 - identical runWrapper function body; should live in a shared test helper module
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-006 — scheduleWave contains a deeply nested else-if ladder with repeated waveSize mutation

- Severity: medium
- Confidence: high
- Lens: maintainability
- Files: packages/shared/src/quota/scheduler.ts
- Summary: The waveSize computation in scheduleWave (lines 110-183) has three nesting levels: cooldown guard, then RPM/TPM caps, then a long else-if chain over quotaStateEntry/hostConcurrencyLimit/providerType. Each branch mutates the same waveSize variable, making it hard to trace which rules applied.
- Evidence:
  - packages/shared/src/quota/scheduler.ts:114-119 - outer cooldown guard sets waveSize=1
  - packages/shared/src/quota/scheduler.ts:122-182 - inner if(!cooldownUntil) block with RPM cap, TPM cap, then three-way else-if on quotaStateEntry/hostConcurrencyLimit/providerType
  - packages/shared/src/quota/scheduler.ts:158-182 - deepest nesting: else block with fallbackCap, unlimited string constant, and firstContactCap magic number
  - runtime:unit:packages-shared: confirmed — Deterministic runtime command succeeded: npm test

### MNT-004 — selectiveDeepening.ts bundles six distinct task-building strategies in one 1111-line file

- Severity: medium
- Confidence: high
- Lens: maintainability
- Files: packages/audit-code/src/orchestrator/selectiveDeepening.ts
- Summary: selectiveDeepening.ts is 1111 lines and contains six independent task-builder strategies plus all their supporting helpers in a single module. Each strategy (finding followup, conflict followup, high-risk-clean, runtime validation, lens verification, verification followup) is self-contained and could be a separate module, reducing navigation cost and enabling isolated testing.
- Evidence:
  - packages/audit-code/src/orchestrator/selectiveDeepening.ts:204-247 - buildFindingFollowupTask strategy
  - packages/audit-code/src/orchestrator/selectiveDeepening.ts:249-306 - buildConflictFollowupTask strategy
  - packages/audit-code/src/orchestrator/selectiveDeepening.ts:341-375 - buildHighRiskCleanFollowupTask strategy
  - packages/audit-code/src/orchestrator/selectiveDeepening.ts:413-457 - buildRuntimeValidationFollowupTask strategy
  - packages/audit-code/src/orchestrator/selectiveDeepening.ts:702-768 - buildLensVerificationTask strategy
  - packages/audit-code/src/orchestrator/selectiveDeepening.ts:822-913 - buildVerificationFollowupTasks strategy — six independent builder strategies all colocated
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-003 — sessionConfig loaded via readOptionalJsonFile three times inside one call

- Severity: medium
- Confidence: high
- Lens: maintainability
- Files: packages/remediate-code/src/steps/nextStep.ts, packages/remediate-code/src/steps/nextStep.ts
- Summary: `decideNextStepInner` reads session-config.json from disk up to three separate times (lines 718-721, 909-914, 1291-1296) to drive document-dispatch and implement-dispatch branches; the result is not hoisted, so every invocation may redundantly hit the filesystem and the paths differ between the two inner reads.
- Evidence:
  - packages/remediate-code/src/steps/nextStep.ts:718 - const sessionConfig = options.sessionConfig ?? await readOptionalJsonFile<SessionConfig>(join(root, session-config.json)); (first read in decideNextStep)
  - packages/remediate-code/src/steps/nextStep.ts:909 - const sessionConfig = options.sessionConfig ?? await readOptionalJsonFile<SessionConfig>(join(root, .remediation-artifacts, session-config.json)) ?? await readOptionalJsonFile<SessionConfig>(join(root, session-config.json)); (second read, different paths, inside document-dispatch branch)
  - packages/remediate-code/src/steps/nextStep.ts:1291 - same pattern repeated verbatim inside implement-dispatch branch
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-002 — Shared mutable RegExp objects with per-call lastIndex resets in graph.ts

- Severity: medium
- Confidence: high
- Lens: maintainability
- Files: packages/audit-code/src/extractors/graph.ts
- Summary: IMPORT_PATTERNS contains RegExp objects with the global flag. Each caller manually resets pattern.lastIndex before use; any future caller that omits the reset will silently skip matches. Safer pattern: recreate regexps per call or remove the g flag from the constant.
- Evidence:
  - packages/audit-code/src/extractors/graph.ts:72-89 - IMPORT_PATTERNS module-level array of RegExp objects with /g flag
  - packages/audit-code/src/extractors/graph.ts:242 - pattern.lastIndex = 0; (reset in extractImportEdges)
  - packages/audit-code/src/extractors/graph.ts:269 - pattern.lastIndex = 0; (reset in importSpecifierRanges)
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### REL-002 — Synchronous `spawnSync` in `commandExists` blocks the event loop during async provider validation

- Severity: medium
- Confidence: high
- Lens: reliability
- Files: packages/audit-code/src/validation/sessionConfig.ts
- Summary: `commandExists` at line 175 of packages/audit-code/src/validation/sessionConfig.ts uses `spawnSync` (synchronous child-process creation) which blocks the Node.js event loop for the duration of the `where`/`which` subprocess. It is called from `validateConfiguredProviderEnvironment` which is invoked during async orchestration startup, stalling all other in-flight async work (timers, pending I/O callbacks) for the subprocess duration.
- Evidence:
  - packages/audit-code/src/validation/sessionConfig.ts:175 - `const result = spawnSync(lookupCommand, [command], { stdio: 'ignore' });` is synchronous; blocks the entire event loop until the subprocess exits
  - packages/audit-code/src/validation/sessionConfig.ts:341-399 - `validateConfiguredProviderEnvironment` is a synchronous function that calls `commandExists` (or the caller-supplied override) on lines 355 and 378; it is not async, so the caller cannot await around the blocking call
  - packages/audit-code/src/validation/sessionConfig.ts:173-176 - no timeout is passed to spawnSync; if `where`/`which` hangs (e.g. on a network filesystem), the block is unbounded
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-002 — taskPriority and getExternalSignalPaths duplicated across requeue.ts and flowRequeue.ts

- Severity: medium
- Confidence: high
- Lens: maintainability
- Files: packages/audit-code/src/orchestrator/requeue.ts, packages/audit-code/src/orchestrator/flowRequeue.ts
- Summary: Both requeue.ts and flowRequeue.ts define private taskPriority and getExternalSignalPaths functions with nearly identical bodies but with a subtle priority-logic difference: requeue.ts elevates security/data_integrity/reliability without an external signal to medium, while flowRequeue.ts does not. This divergence is invisible and will drift further as either copy is maintained independently.
- Evidence:
  - packages/audit-code/src/orchestrator/requeue.ts:5-14 - taskPriority returns medium for security/data_integrity/reliability even without external signal
  - packages/audit-code/src/orchestrator/flowRequeue.ts:38-49 - taskPriority returns medium only when hasExternalSignal is true; lens-based medium branch is absent
  - packages/audit-code/src/orchestrator/requeue.ts:16-31 - getExternalSignalPaths defined locally
  - packages/audit-code/src/orchestrator/flowRequeue.ts:21-36 - identical getExternalSignalPaths defined locally again
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### COR-001 — tree-sitter module cache ignores subsequent dependencyPath arguments

- Severity: medium
- Confidence: high
- Lens: correctness
- Files: packages/audit-code/src/extractors/analyzers/treeSitter.ts
- Summary: The module-level `modulePromise` in treeSitter.ts is set once on the first call and reused for all subsequent calls, silently ignoring any different `dependencyPath` passed by later callers. If the first call resolves a path but that module load fails, no retry occurs; if two analyzers intend to use different dependency paths, only the first one's path is honored.
- Evidence:
  - packages/audit-code/src/extractors/analyzers/treeSitter.ts:87 - `async function getModule(dependencyPath?: string): Promise<ParserModule | undefined>` ignores the parameter after the first call
  - packages/audit-code/src/extractors/analyzers/treeSitter.ts:89 - `if (!modulePromise) { modulePromise = importParserModule(dependencyPath); }` - only initializes once; subsequent calls with a different path are silently discarded
  - packages/audit-code/src/extractors/analyzers/treeSitter.ts:48 - `let modulePromise: Promise<ParserModule | undefined> | undefined;` - module-level singleton not keyed on dependencyPath
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-004 — treeSitter module cache ignores dependencyPath on subsequent calls

- Severity: medium
- Confidence: high
- Lens: maintainability
- Files: packages/audit-code/src/extractors/analyzers/treeSitter.ts
- Summary: getTreeSitterParser memoises modulePromise without keying on dependencyPath. If two callers supply different dependencyPath values, the second call silently reuses the first loader's module. This is a hidden coupling that makes the loader behaviour unpredictable as the codebase grows.
- Evidence:
  - packages/audit-code/src/extractors/analyzers/treeSitter.ts:48 - `let modulePromise: Promise<ParserModule | undefined> | undefined;` module-level singleton
  - packages/audit-code/src/extractors/analyzers/treeSitter.ts:88 - `if (!modulePromise) { modulePromise = importParserModule(dependencyPath); }` — dependencyPath is only used on the first call; subsequent calls always reuse the cached promise regardless of path
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-003 — Triage auto-retry via impl_preview_acknowledged.json is untested

- Severity: medium
- Confidence: high
- Lens: tests
- Files: packages/remediate-code/src/phases/triage.ts
- Summary: triage.ts lines 73-85 implement an auto-retry shortcut that bypasses manual triage when impl_preview_acknowledged.json exists, but phase-triage.test.ts has no test case creating that file and asserting the returned state is documenting with rework_count incremented.
- Evidence:
  - packages/remediate-code/src/phases/triage.ts:73-85 - if (existsSync(previewAckPath)) { ... autoRetried = true; } if (autoRetried) { return { ...state, status: documenting }; }
  - packages/remediate-code/tests/phase-triage.test.ts:1-137 - all tests omit creating impl_preview_acknowledged.json; the auto-retry branch is never reached in any test scenario
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### OBS-001 — TypeScript analyzer silently swallows all extraction failures

- Severity: medium
- Confidence: high
- Lens: observability
- Files: packages/audit-code/src/extractors/analyzers/typescript.ts
- Summary: The `analyze()` function in typescript.ts has two bare catch blocks that return `{ edges: [] }` on any failure — a TypeScript load failure, a compiler API crash, or a resolution error — with no log, warning, or counter emitted. Operators cannot distinguish a clean empty result from a silent failure that degraded graph coverage.
- Evidence:
  - packages/audit-code/src/extractors/analyzers/typescript.ts:329-334 - `try { ts = await loadTypescript(...) } catch { return { edges: [] }; }` — TypeScript load failure returns empty silently
  - packages/audit-code/src/extractors/analyzers/typescript.ts:336-359 - outer try/catch around entire program build and edge collection; any compiler error returns `{ edges: [] }` with no diagnostic
  - packages/audit-code/src/extractors/analyzers/typescript.ts:50-51 - `loadTypescript` inner catch also suppresses errors with a comment only, compounding silence
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-001 — UnionFind class has zero test coverage

- Severity: medium
- Confidence: high
- Lens: tests
- Files: packages/audit-code/src/orchestrator/unionFind.ts
- Summary: The UnionFind class in unionFind.ts (35 lines) has no test at all. Key behaviors — path-compression correctness, empty-key construction, self-union idempotency, and alphabetical root selection in union() — are untested in isolation.
- Evidence:
  - packages/audit-code/src/orchestrator/unionFind.ts:1-35 — full UnionFind class with find (path-compression), union (alphabetical root selection), and groups() has no corresponding test file or test case
  - No test file across packages/audit-code/tests/ references unionFind or UnionFind
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### OBS-001 — Unstructured phase-execution logs in implement.ts

- Severity: medium
- Confidence: high
- Lens: observability
- Files: packages/remediate-code/src/phases/implement.ts, packages/remediate-code/src/phases/implement.ts, packages/remediate-code/src/phases/implement.ts
- Summary: Phase execution logs throughout implement.ts use free-text console.log/warn strings that mix finding IDs, step names, block IDs, and outcomes without consistent key=value or JSON-line structure, making it impossible to programmatically parse or correlate log lines across a parallel multi-block run.
- Evidence:
  - packages/remediate-code/src/phases/implement.ts:163 - console.log(`Implementing item ${findingId}...`) — free-text only, no block_id, phase, or timestamp fields
  - packages/remediate-code/src/phases/implement.ts:429 - console.warn concatenates block_id and failure reasons into a single unstructured string
  - packages/remediate-code/src/phases/implement.ts:519 - console.log("Running Implement Phase...") — no run ID or artifact dir context
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-001 — updateRuntimeValidationReport has no direct unit tests

- Severity: medium
- Confidence: high
- Lens: tests
- Files: packages/audit-code/src/orchestrator/runtimeValidationUpdate.ts
- Summary: runtimeValidationUpdate.ts is only exercised indirectly through runRuntimeValidationUpdateExecutor in orchestrator-remediation.test.mjs. No direct tests verify: (a) results for task IDs absent from the manifest are filtered out, (b) tasks missing from the update are initialized as pending, or (c) the sorted output order.
- Evidence:
  - packages/audit-code/src/orchestrator/runtimeValidationUpdate.ts:17 - updateRuntimeValidationReport exported but never imported directly in any test file
  - packages/audit-code/tests/orchestrator-remediation.test.mjs:685 - runRuntimeValidationUpdateExecutor is the only test surface; the validity-filter, pending-init, and sort branches are never isolated
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-002 — validateArtifacts accumulates all checks in a single 415-line function

- Severity: medium
- Confidence: high
- Lens: maintainability
- Files: packages/remediate-code/src/validation/artifacts.ts
- Summary: The exported validateArtifacts function in artifacts.ts spans lines 287-415 and orchestrates nine distinct validation concerns (state, plan, items, persisted plan, item_spec files, clarification requests, triage batch, triage resolution, current step, dispatch artifacts, closing result, report JSON) as a sequential flat list. This makes it hard to add, remove, or reorder a single concern without reading the entire function.
- Evidence:
  - packages/remediate-code/src/validation/artifacts.ts:287 - export async function validateArtifacts(...) — function declaration opens
  - packages/remediate-code/src/validation/artifacts.ts:321 - validates persisted remediation_plan.json in a separate readJsonForValidation call inside the same function body
  - packages/remediate-code/src/validation/artifacts.ts:332 - inline collectFiles loop validating item_spec_*.json without any named sub-routine
  - packages/remediate-code/src/validation/artifacts.ts:388 - validateCurrentStep called inline alongside triage and dispatch concerns
  - packages/remediate-code/src/validation/artifacts.ts:415 - closing brace — 129 effective lines in one function
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-004 — validateArtifacts function is untested

- Severity: medium
- Confidence: high
- Lens: tests
- Files: packages/remediate-code/src/validation/artifacts.ts
- Summary: The 415-line validateArtifacts function in artifacts.ts, including the stale-result cross-reference logic in validateDispatchArtifacts, has no tests. Regressions in artifact validation would go undetected.
- Evidence:
  - packages/remediate-code/src/validation/artifacts.ts:280-284 - stale worker result detection logic with no test exercising it
  - packages/remediate-code/src/validation/artifacts.ts:287 - validateArtifacts exported function not imported in any test file in packet
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-005 — validation/basic.ts functions have no test coverage

- Severity: medium
- Confidence: high
- Lens: tests
- Files: packages/shared/src/validation/basic.ts
- Summary: The validation helpers in basic.ts (requireKeys, prefixValidationIssues, formatValidationIssues, isRecord, describeValue, pushValidationIssue) are used throughout both orchestrators but have no dedicated tests. Key paths such as requireKeys receiving a non-object, or prefixValidationIssues handling already-prefixed paths, are unverified.
- Evidence:
  - packages/shared/tests/ - no validation.test.mjs or basic.test.mjs file exists in the test directory
  - packages/shared/src/validation/basic.ts:61-82 - requireKeys has a branch for non-object input (lines 67-71) and a missing-key loop (lines 73-79) that are both untested
  - packages/shared/src/validation/basic.ts:40-53 - prefixValidationIssues has three path-rewriting branches (empty path, already-prefixed, plain) that are untested
  - runtime:unit:packages-shared: confirmed — Deterministic runtime command succeeded: npm test

### OPR-001 — waitForReleaseRun polling loop emits no progress logs

- Severity: medium
- Confidence: high
- Lens: operability
- Files: packages/remediate-code/scripts/release-and-publish.mjs
- Summary: The waitForReleaseRun function polls for up to 10 minutes but emits no log lines while waiting. Operators see no output during this window, making it impossible to distinguish a stalled run from normal propagation delay.
- Evidence:
  - packages/remediate-code/scripts/release-and-publish.mjs:200-219 - while loop polls up to releaseRunTimeoutMs (10min) but contains no console.log inside the loop body; only the outer caller at line 378 logs before entering.
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-001 — waveManifest helpers have no unit tests

- Severity: medium
- Confidence: high
- Lens: tests
- Files: packages/audit-code/src/cli/waveManifest.ts
- Summary: readWaveManifest, writeWaveManifest, removeWaveManifest, and buildWaveSlotEntry in waveManifest.ts have no dedicated unit tests. The wave-recovery logic in runToCompletion.ts that reads and replays interrupted waves is only exercised through full end-to-end integration tests, leaving the contract of individual helpers unverified.
- Evidence:
  - packages/audit-code/src/cli/waveManifest.ts:34 - writeWaveManifest: no test file imports or calls this function directly
  - packages/audit-code/src/cli/waveManifest.ts:44 - readWaveManifest: no test file exercises this; recovery path at runToCompletion.ts:163 is only hit by integration tests
  - packages/audit-code/src/cli/waveManifest.ts:59 - buildWaveSlotEntry: collects task_ids from a group and maps paths; no test validates the mapping
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-001 — Windows cmd-shim branch never tested on non-Windows CI

- Severity: medium
- Confidence: high
- Lens: tests
- Files: packages/remediate-code/tests/providers.test.ts
- Summary: The OpenCodeProvider Windows cmd.exe shim test at line 430 branches on `process.platform === 'win32'` at runtime, so the Windows-specific assertion is skipped entirely on Linux CI. The `resolveOpenCodeSpawnCommand` Win32 path goes uncovered on any non-Windows environment.
- Evidence:
  - packages/remediate-code/tests/providers.test.ts:444 - `if (process.platform === 'win32')` guards the Windows assertion; on Linux/macOS only the else branch runs
  - packages/shared/src/providers/opencodeLaunch.ts:15-26 - Win32 shim logic that the else branch does not exercise
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-003 — withTempRepo and runWrapper helpers duplicated across test files

- Severity: medium
- Confidence: high
- Lens: maintainability
- Files: packages/audit-code/tests/audit-code-completion.test.mjs, packages/audit-code/tests/audit-code-lifecycle.test.mjs
- Summary: audit-code-completion.test.mjs and audit-code-lifecycle.test.mjs each define their own withTempRepo (identical directory structure and file contents) and runWrapper (identical spawn logic), meaning any change to the shared test setup must be applied in two files.
- Evidence:
  - packages/audit-code/tests/audit-code-completion.test.mjs:45-70 - runWrapper defined with spawn + stdout/stderr accumulation
  - packages/audit-code/tests/audit-code-lifecycle.test.mjs:13-38 - identical runWrapper definition
  - packages/audit-code/tests/audit-code-completion.test.mjs:72-124 - withTempRepo creates src/api, src/lib, infra, writes auth.ts, session.ts, deploy.yml
  - packages/audit-code/tests/audit-code-lifecycle.test.mjs:40-88 - withTempRepo creates same directory structure with same file contents
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### DI-001 — worker_result item_spec variant does not require the item_spec payload

- Severity: medium
- Confidence: high
- Lens: data_integrity
- Files: packages/remediate-code/schemas/worker_result.schema.json
- Summary: In worker_result.schema.json the first oneOf variant uses type: 'item_spec' as discriminator but does not require the 'item_spec' property. A producer can emit {"type":"item_spec"} with no spec data and the document passes schema validation, silently dropping the remediation specification.
- Evidence:
  - packages/remediate-code/schemas/worker_result.schema.json:9-12 - first oneOf branch: required=["type"] only; 'item_spec' key is present in properties but absent from required
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-002 — workerResult module helpers have no unit tests

- Severity: medium
- Confidence: high
- Lens: tests
- Files: packages/audit-code/src/cli/workerResult.ts
- Summary: buildWorkerResult, isWorkerResult, buildWorkerFailureBlocker, persistWorkerRunArtifacts, and formatAuditResultValidationError in workerResult.ts are untested in isolation. The isWorkerResult guard used to decide whether a provider emitted a valid contract is only exercised through integration tests where a subprocess produces output.
- Evidence:
  - packages/audit-code/src/cli/workerResult.ts:47 - isWorkerResult: checks contract_version string equality; no unit test exercises the false-branch (invalid/null/missing contract_version)
  - packages/audit-code/src/cli/workerResult.ts:56 - buildWorkerFailureBlocker: concatenates summary + errors; edge case of empty errors array vs populated is not tested
  - packages/audit-code/src/cli/workerResult.ts:63 - formatAuditResultValidationError: exposed but never imported in any test file
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-002 — WorkerSlot interface defined inside the while-loop body

- Severity: medium
- Confidence: high
- Lens: maintainability
- Files: packages/audit-code/src/cli/runToCompletion.ts
- Summary: The WorkerSlot interface is declared inside the while loop at line 451, making it invisible to module-level tooling and forcing readers to hunt for the type definition buried in procedural code. Interfaces should live at module scope.
- Evidence:
  - packages/audit-code/src/cli/runToCompletion.ts:451 - `interface WorkerSlot {` declared inside `while (runCount < maxRuns)` loop body, nested inside the `if (preferredExecutor === 'agent' && parallelWorkers > 1)` branch
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### OBS-001 — worktreeIsolation swallows all git errors silently

- Severity: medium
- Confidence: high
- Lens: observability
- Files: packages/remediate-code/src/steps/worktreeIsolation.ts
- Summary: All catch blocks in worktreeIsolation.ts swallow errors with bare comments, discarding the actual error details. When git operations fail unexpectedly, there is no log, no structured event, and no diagnostic surface to understand what went wrong.
- Evidence:
  - packages/remediate-code/src/steps/worktreeIsolation.ts:72 - catch {} with comment drops the diff error without any structured log
  - packages/remediate-code/src/steps/worktreeIsolation.ts:84 - catch {} drops merge --abort error silently with comment only
  - packages/remediate-code/src/steps/worktreeIsolation.ts:110-115 - rm fallback and worktree prune errors both swallowed with comments only; no runLog event emitted
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-007 — DispatchPlanItem construction logic duplicated between prepareDocumentDispatch and mergeDocumentResults

- Severity: medium
- Confidence: medium
- Lens: maintainability
- Files: packages/remediate-code/src/steps/dispatch.ts, packages/remediate-code/src/steps/dispatch.ts
- Summary: The code that constructs a `DispatchPlanItem` (taskId, finding_id, model_hint, access) is written in full in both `prepareDocumentDispatch` (lines 379-409) and `mergeDocumentResults` (lines 468-485); any change to item shape requires two edits.
- Evidence:
  - packages/remediate-code/src/steps/dispatch.ts:379 - taskId/promptPath/resultPath construction and DispatchPlanItem push in prepareDocumentDispatch
  - packages/remediate-code/src/steps/dispatch.ts:468 - identical taskId/resultPath construction and manual DispatchPlanItem push in mergeDocumentResults reconciliation branch with same access shape
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### DA-012 — Dominant unit: packages-audit-code

- Severity: medium
- Confidence: medium
- Lens: architecture
- Files: packages/audit-code/.gemini/commands/audit-code.toml, packages/audit-code/.github/workflows/ci.yml, packages/audit-code/.github/workflows/packaged-entrypoint.yml, packages/audit-code/.github/workflows/product-e2e.yml, packages/audit-code/.github/workflows/publish-package.yml, packages/audit-code/.github/workflows/test-suite.yml, packages/audit-code/.gitignore, packages/audit-code/audit-code-wrapper-lib.mjs, packages/audit-code/audit-code.mjs, packages/audit-code/dispatch/lens-definitions.json
- Summary: Unit packages-audit-code contains 238 of 401 files (59%). A single unit this large suggests insufficient decomposition.
- Evidence:
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### CD-002 — npm install -g uses floating version without integrity verification

- Severity: medium
- Confidence: medium
- Lens: config_deployment
- Files: packages/remediate-code/.github/workflows/publish-package.yml
- Summary: The publish pipeline upgrades npm via npm install -g npm@11.5.1 without lockfile or hash verification. The file's own comment acknowledges supply-chain risk is accepted, but this runs in a privileged publish context where a compromised npm version could exfiltrate the OIDC token.
- Evidence:
  - packages/remediate-code/.github/workflows/publish-package.yml:81 - npm install -g npm@11.5.1 without --ignore-scripts or hash pinning in a privileged publish context that holds id-token:write
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### DR-007 — Promote the bounded-step prompt contract to a first-class, host-agnostic protocol and make MCP a thin wrapper

- Severity: medium
- Confidence: medium
- Lens: architecture
- Files: packages/shared/src/types/stepContract.ts, packages/audit-code/src/mcp/server.ts, packages/remediate-code/src/mcp/server.ts
- Summary: The core value of both tools is a single idea: a resumable orchestrator that emits exactly one backend-rendered prompt contract (versioned JSON + a markdown prompt) per invocation, which any host agent executes and then calls back. That contract already has shared types (shared/src/types/stepContract.ts) and a contract_version field, and each tool's MCP server is described as a 'legacy/compatibility adapter' over it. Recommendation: lean into this. Define the step-contract as the single public, versioned protocol; provide a thin shared runtime for it (ties to DR-001); and regenerate the MCP servers as thin wrappers over that protocol rather than maintaining them as a parallel orchestration path. Publish the contract schema alongside the existing artifact schemas/. This makes the audit -> report -> remediate pipeline compose through one documented contract, lets non-Claude hosts be first-class, and removes the second code path that today can drift from the canonical next-step flow.
- Evidence:
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test
  - runtime:unit:packages-shared: confirmed — Deterministic runtime command succeeded: npm test

### TST-007 — runToCompletion deepening-cycle guard and rate-limit cooldown paths are untested

- Severity: medium
- Confidence: medium
- Lens: tests
- Files: packages/audit-code/src/cli/runToCompletion.ts, packages/audit-code/src/cli/runToCompletion.ts, packages/audit-code/src/cli/runToCompletion.ts
- Summary: The deepening-cycle guard that caps selective_deepening tasks at MAX_DEEPENING_CYCLES=3, the rate-limit cooldown wait, and the header-extraction branch in runToCompletion.ts have no targeted tests. Integration tests run the normal happy-path flow and cannot trigger these defensive branches.
- Evidence:
  - packages/audit-code/src/cli/runToCompletion.ts:206 - deepeningCycles > MAX_DEEPENING_CYCLES break: no test injects selective_deepening tasks that would loop past this limit
  - packages/audit-code/src/cli/runToCompletion.ts:439 - cooldown_until wait: no test sets up a quotaState that triggers a non-zero waitMs
  - packages/audit-code/src/cli/runToCompletion.ts:691 - getHeaderExtractorForProvider / updateDiscoveredLimits: only reachable via a subprocess stderr file containing rate-limit headers; no test exercises this branch
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-005 — All tests import compiled dist/ — stale-build silent-pass risk

- Severity: low
- Confidence: high
- Lens: tests
- Files: packages/audit-code/src/quota/discoveredLimits.ts, packages/audit-code/src/reporting/workBlocks.ts
- Summary: Every test file in packages/audit-code/tests imports from ../dist/ rather than source. If dist/ is stale after a source edit without a rebuild, the test suite silently validates old compiled code. There is no guard that asserts dist/ is current relative to src/.
- Evidence:
  - packages/audit-code/tests/discovered-limits.test.mjs:4 - import from ../dist/quota/discoveredLimits.js
  - packages/audit-code/tests/header-extraction.test.mjs:4 - import from ../dist/quota/headerExtraction.js
  - packages/audit-code/tests/reporting-remediation.test.mjs:4 - import from ../dist/reporting/mergeFindings.js
  - packages/audit-code/tests/supervisor-remediation.test.mjs:7 - import from ../dist/supervisor/operatorHandoff.js
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-005 — any types used for clarification resolution data in document phase

- Severity: low
- Confidence: high
- Lens: maintainability
- Files: packages/remediate-code/src/phases/document.ts
- Summary: resolutionsMap is typed as Map<string, any> and the raw file read uses readOptionalJsonFile<any>, bypassing the ClarificationResolution type already defined in the same file. This means future changes to the resolution shape have no type-level safety net.
- Evidence:
  - packages/remediate-code/src/phases/document.ts:114 - const resolutionsMap = new Map<string, any>()
  - packages/remediate-code/src/phases/document.ts:118 - const resolutions = await readOptionalJsonFile<any>(resolutionPath)
  - packages/remediate-code/src/phases/document.ts:29 - ClarificationResolution interface is defined in scope but not used for the map value type
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-004 — appendSelectiveDeepeningTasks call pattern repeated three times with inconsistent artifact dedup

- Severity: low
- Confidence: high
- Lens: maintainability
- Files: packages/audit-code/src/orchestrator/internalExecutors.ts
- Summary: appendSelectiveDeepeningTasks is called identically in runResultIngestionExecutor, runRuntimeValidationExecutor, and runRuntimeValidationUpdateExecutor. Only the first callsite applies the .filter(a => a !== 'audit_tasks.json') dedup guard when spreading selectiveDeepening.artifacts; the other two return the array directly. The asymmetry means a future selective-deepening artifact change must be applied in three places consistently.
- Evidence:
  - packages/audit-code/src/orchestrator/internalExecutors.ts:528-532 - appendSelectiveDeepeningTasks call in runResultIngestionExecutor
  - packages/audit-code/src/orchestrator/internalExecutors.ts:553 - .filter(artifact => artifact !== 'audit_tasks.json') applied only here
  - packages/audit-code/src/orchestrator/internalExecutors.ts:621-625 - appendSelectiveDeepeningTasks call in runRuntimeValidationExecutor; no dedup filter
  - packages/audit-code/src/orchestrator/internalExecutors.ts:662-666 - appendSelectiveDeepeningTasks call in runRuntimeValidationUpdateExecutor; no dedup filter
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-002 — assert.fail used as control-flow in resolveExternalDocument

- Severity: low
- Confidence: high
- Lens: maintainability
- Files: packages/audit-code/tests/helpers/jsonSchemaAssert.mjs
- Summary: resolveExternalDocument throws via assert.fail when a schema reference cannot be resolved, coupling the test-assertion library to validation control flow. This makes the error signal indistinguishable from an assertion failure and surprises readers who expect assert.fail only at test boundaries.
- Evidence:
  - packages/audit-code/tests/helpers/jsonSchemaAssert.mjs:89 - assert.fail used to signal unresolvable  inside a utility function rather than throwing a descriptive Error
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-005 — auditTaskUtils.ts utility helpers have no unit tests

- Severity: low
- Confidence: high
- Lens: tests
- Files: packages/audit-code/src/orchestrator/auditTaskUtils.ts
- Summary: priorityRank(), sortLenses(), and LENS_ORDER in auditTaskUtils.ts are used widely across orchestrator logic but have no dedicated unit tests. The default branch of priorityRank (returns 1 for unknown priority) and the Set-filtering in sortLenses are untested. An incorrect LENS_ORDER constant would silently mis-schedule audit work without any test catching it.
- Evidence:
  - packages/audit-code/src/orchestrator/auditTaskUtils.ts:16 - priorityRank default case at line 22 is never covered by any test; no test file imports auditTaskUtils
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### OBS-003 — autoFixExecutor records no per-tool timing information

- Severity: low
- Confidence: high
- Lens: observability
- Files: packages/audit-code/src/orchestrator/autoFixExecutor.ts
- Summary: runAutoFixExecutor captures which formatters executed and a single completion timestamp but no per-tool duration, making it impossible to identify slow formatters that could bottleneck the pipeline.
- Evidence:
  - packages/audit-code/src/orchestrator/autoFixExecutor.ts:142 - resultsArtifact = { executed_tools: executedTools, timestamp: new Date().toISOString() } -- single completion timestamp only; no start time or per-tool durations captured
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-004 — autoFixExecutor uses synchronous fs while rest of codebase is async-first

- Severity: low
- Confidence: high
- Lens: maintainability
- Files: packages/audit-code/src/orchestrator/autoFixExecutor.ts
- Summary: autoFixExecutor.ts imports existsSync and readFileSync from node:fs and uses them in hasPrettierConfig, while every other file in io/ and orchestrator/ imports exclusively from node:fs/promises. This breaks the async-first abstraction boundary and makes the file a maintenance exception.
- Evidence:
  - packages/audit-code/src/orchestrator/autoFixExecutor.ts:3 - import { existsSync, readFileSync } from 'node:fs' — synchronous imports
  - packages/audit-code/src/orchestrator/autoFixExecutor.ts:34 - hasPrettierConfig uses existsSync and readFileSync synchronously
  - packages/audit-code/src/io/artifacts.ts:1 - uses node:fs/promises exclusively
  - packages/audit-code/src/orchestrator/advance.ts - no synchronous fs imports
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-003 — autoFixExecutor: individual formatter detection branches have no unit tests

- Severity: low
- Confidence: high
- Lens: tests
- Files: packages/audit-code/src/orchestrator/autoFixExecutor.ts, packages/audit-code/src/orchestrator/autoFixExecutor.ts
- Summary: runAutoFixExecutor (autoFixExecutor.ts:54-155) runs formatters conditionally based on file extensions and config detection, but it is exercised only through integration (fixture-repo.test.mjs line 80) where the fixture produces executed_tools: []. No test verifies that prettier is skipped when hasPrettierConfig returns false, that black/sqlfluff/gofmt are attempted for .py/.sql/.go repos, or that the package.json prettier key triggers the config path. A bug in hasPrettierConfig or the extension Set logic would be invisible to the suite.
- Evidence:
  - packages/audit-code/src/orchestrator/autoFixExecutor.ts:34 - hasPrettierConfig checks PRETTIER_CONFIG_FILES list then reads package.json for a prettier key; neither conditional branch has a dedicated test
  - packages/audit-code/src/orchestrator/autoFixExecutor.ts:105 - Python black branch only runs if extensions.has('py'); fixture repo contains no .py files so this branch is never executed in tests
  - packages/audit-code/tests/fixture-repo.test.mjs:80 - integration advances through autoFix step but does not assert on executed_tools contents, confirming formatter selection logic is untested
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-007 — Bash permission rules duplicated between top-level and agent.remediator sections in opencode.json

- Severity: low
- Confidence: high
- Lens: maintainability
- Files: packages/remediate-code/opencode.json, packages/remediate-code/opencode.json
- Summary: The remediate-code bash allow/deny rules appear in both permission.bash and agent.remediator.permission.bash in opencode.json. A change to either set must be manually mirrored, and the two sets are already partially out of sync with the top-level section having more entries than the agent section.
- Evidence:
  - packages/remediate-code/opencode.json:35-55 - top-level bash section has remediate-code run* deny plus 8 allow rules
  - packages/remediate-code/opencode.json:92-101 - agent.remediator.permission.bash has the same remediate-code allow/deny rules but is missing git diff and validate-artifacts entries present at top level
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### OBS-001 — Build auto-rebuild output routed to stderr with no severity tagging

- Severity: low
- Confidence: high
- Lens: observability
- Files: packages/remediate-code/remediate-code.mjs
- Summary: The wrapper auto-rebuild in remediate-code.mjs routes both stdout and stderr of the build process to process.stderr, making it impossible to distinguish build progress from build errors when diagnosing startup failures. There is no severity label or prefix on these messages.
- Evidence:
  - packages/remediate-code/remediate-code.mjs:58 - build stdout merged into stderr losing severity separation
  - packages/remediate-code/remediate-code.mjs:59 - build stderr also written to stderr without a distinguishing prefix
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### OBS-002 — Build lock wait loop emits no progress signal

- Severity: low
- Confidence: high
- Lens: observability
- Files: packages/audit-code/audit-code-wrapper-lib.mjs
- Summary: waitForPeerBuild polls every 200 ms for up to 2 minutes with no visible output. A developer or CI runner has no indication that the process is waiting, how long it has been waiting, or which PID holds the lock.
- Evidence:
  - packages/audit-code/audit-code-wrapper-lib.mjs:205-219 - tight polling loop with `await sleep(BUILD_LOCK_WAIT_INTERVAL_MS)` and no log statement inside the loop body; lock file contains pid and acquired_at (line 225) but that data is never surfaced during the wait
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-004 — buildAuditCodeHandoff called identically in both writeHandoffOnly and emitEnvelope

- Severity: low
- Confidence: high
- Lens: maintainability
- Files: packages/audit-code/src/cli/envelope.ts, packages/audit-code/src/cli/reviewRun.ts
- Summary: emitEnvelope (envelope.ts) and writeHandoffOnly (reviewRun.ts) both call buildAuditCodeHandoff with the same parameter set and then call writeAuditCodeHandoffArtifacts. The only difference is that emitEnvelope also logs JSON to stdout. This near-duplicate increases the risk of the two call sites diverging.
- Evidence:
  - packages/audit-code/src/cli/envelope.ts:51-61 - calls buildAuditCodeHandoff({root, artifactsDir, state, bundle, providerName, progressSummary, isConfigError, activeReviewRun}), writes artifacts, then logs JSON
  - packages/audit-code/src/cli/reviewRun.ts:71-81 - calls buildAuditCodeHandoff with identical parameter set, writes artifacts, returns without logging
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-002 — buildChunkedAuditTasks flow-task test omits pass_id and rationale assertions

- Severity: low
- Confidence: high
- Lens: tests
- Files: packages/audit-code/tests/field-trial-remediation.test.mjs
- Summary: The flow-task test at lines 443-461 only verifies `task_id`, `lens`, and `file_paths` but omits `pass_id`, `rationale`, and `tags` fields, meaning those could be missing or wrong without causing a test failure.
- Evidence:
  - packages/audit-code/tests/field-trial-remediation.test.mjs:443 - deepEqual only checks task_id, lens, file_paths; pass_id and rationale are not validated for flow tasks
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-003 — buildChunkedAuditTasks large-file split path is untested

- Severity: low
- Confidence: high
- Lens: tests
- Files: packages/audit-code/src/orchestrator/taskBuilder.ts
- Summary: The large-file split path inside addTaskBlock — where a file exceeding file_split_threshold gets its own single-file task tagged large_file — has no dedicated test. Existing tests cover the budget-split path (part-N tasks) but not the file_split_threshold branch.
- Evidence:
  - packages/audit-code/src/orchestrator/taskBuilder.ts:233-236 — oversizedFiles filtered by file_split_threshold (default 5000)
  - packages/audit-code/src/orchestrator/taskBuilder.ts:268-289 — oversized files get individual tasks tagged large_file; no test exercises this with a file_split_threshold override
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-005 — buildClaudeDesktopBundle mixes file-copy, code-generation, archive creation, and manifest writing

- Severity: low
- Confidence: high
- Lens: maintainability
- Files: packages/audit-code/audit-code-wrapper-lib.mjs
- Summary: buildClaudeDesktopBundle (lines 1228-1360) is a ~130-line function that performs at least four distinct responsibilities: copying dist and schema files, generating a server entrypoint script, assembling a manifest, and creating a ZIP archive. These responsibilities are hard to test or modify in isolation.
- Evidence:
  - packages/audit-code/audit-code-wrapper-lib.mjs:1238 - await cp(distEntry.replace(...), ...) file copying mixed with code gen
  - packages/audit-code/audit-code-wrapper-lib.mjs:1262 - const serverEntry = [...].join('\n') code generation as strings
  - packages/audit-code/audit-code-wrapper-lib.mjs:1291 - const manifest = { manifest_version: '0.3', ... } manifest assembly
  - packages/audit-code/audit-code-wrapper-lib.mjs:1349 - const archive = await createStoredZipBuffer(bundleRoot) archive creation
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-004 — buildGraphBundle is an excessively long function with many side-effecting dispatch calls

- Severity: low
- Confidence: high
- Lens: maintainability
- Files: packages/audit-code/src/extractors/graph.ts
- Summary: buildGraphBundle spans ~150 lines (412-561) and dispatches to 20+ extractor functions without intermediate grouping. The per-file loop mixes heuristic container edges, auth-session edges, import extraction, reference extraction, route extraction, and manifest edge extraction in one flat body, making it hard to add or test individual concerns in isolation.
- Evidence:
  - packages/audit-code/src/extractors/graph.ts:412-561 - single function body dispatching ~20 extractor calls with heterogeneous heuristics interleaved
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-003 — buildToolingManifest: missing-inputs and absent package.json paths untested

- Severity: low
- Confidence: high
- Lens: tests
- Files: packages/audit-code/src/io/toolingManifest.ts
- Summary: buildToolingManifest silently skips inputs that do not exist on disk and returns null for package_version when package.json is absent. Both branches are unreachable from io-remediation.test.mjs because it always runs against the real package root. No test exercises a scratch directory with no TOOLING_INPUTS present.
- Evidence:
  - packages/audit-code/src/io/toolingManifest.ts:71 - pathExists guard skips missing inputs silently
  - packages/audit-code/src/io/toolingManifest.ts:83 - package_version receives readPackageVersion() which returns null when package.json absent, never asserted null in tests
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-001 — CLAUDECODE env-var save/restore pattern duplicated across two provider tests

- Severity: low
- Confidence: high
- Lens: maintainability
- Files: packages/remediate-code/tests/providers.test.ts
- Summary: The pattern of saving, deleting, and restoring process.env.CLAUDECODE in a try/finally block appears in two consecutive it-blocks. Extracting this into a shared helper would eliminate the duplication and reduce the risk of drift between the two setups.
- Evidence:
  - packages/remediate-code/tests/providers.test.ts:353-382 - first test saves CLAUDECODE, deletes it, runs assertions, restores in finally
  - packages/remediate-code/tests/providers.test.ts:384-405 - second test repeats exactly the same save/delete/restore try-finally idiom
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-002 — cleanupStaleArtifactsDir has no test coverage for the status-guard invariant

- Severity: low
- Confidence: high
- Lens: tests
- Files: packages/audit-code/src/cli/cleanup.ts
- Summary: src/cli/cleanup.ts exports cleanupStaleArtifactsDir which embodies a critical safety invariant: only delete when status is complete or not_started. No test verifies this logic; a regression could cause in-progress audit artifacts to be deleted.
- Evidence:
  - packages/audit-code/src/cli/cleanup.ts:25 - if (status === "complete" || status === "not_started") { await rm(...) } — guard condition has no unit test
  - packages/audit-code/src/cli/cleanup.ts:19-22 - isFileMissingError early-return path is also untested in isolation
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### OBS-003 — Closing phase uses bare console.warn for cleanup failures without structured context

- Severity: low
- Confidence: high
- Lens: observability
- Files: packages/remediate-code/src/phases/close.ts, packages/remediate-code/src/phases/close.ts
- Summary: close.ts emits structured runLogger events for per-outcome telemetry but falls back to raw console.warn for branch cleanup and artifact removal failures. These bare logs carry no phase, obligation, or finding_id context, making them hard to correlate in multi-run logs.
- Evidence:
  - packages/remediate-code/src/phases/close.ts:466 - console.warn for branch cleanup failure carries no phase or obligation tag
  - packages/remediate-code/src/phases/close.ts:487 - console.warn for artifact directory failure carries no path or run-id context
  - packages/remediate-code/src/phases/close.ts:399-406 - runLogger.event() used for outcome telemetry showing the structured pattern exists but cleanup failures bypass it
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-005 — collectGraphEdges hardcodes graph bucket names as untyped magic strings

- Severity: low
- Confidence: high
- Lens: maintainability
- Files: packages/audit-code/src/orchestrator/fileAnchors.ts
- Summary: collectGraphEdges in fileAnchors.ts iterates over the literal array ["imports", "calls", "references"] to access GraphBundle.graphs fields. If GraphBundle adds or renames a bucket, this function silently misses it, and there is no compile-time link to the type definition to catch the divergence.
- Evidence:
  - packages/audit-code/src/orchestrator/fileAnchors.ts:134 - for (const key of ["imports", "calls", "references"]) -- untyped string literals used to index graphBundle.graphs
  - packages/audit-code/src/orchestrator/graphEnrichmentExecutor.ts:158 - bucketEdges typed as { imports, calls, references } -- if a new bucket is added here, fileAnchors will not pick it up automatically
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### OBS-102 — compositeQuotaSource silently swallows all source errors

- Severity: low
- Confidence: high
- Lens: observability
- Files: packages/shared/src/quota/compositeQuotaSource.ts
- Summary: CompositeQuotaSource.queryCurrentUsage catches every error from every quota source and silently moves to the next without logging. There is no way for operators to know if a quota source is failing persistently.
- Evidence:
  - packages/shared/src/quota/compositeQuotaSource.ts:19-24 - catch block in queryCurrentUsage loop is empty; no log or counter is incremented when a quota source throws
  - runtime:unit:packages-shared: confirmed — Deterministic runtime command succeeded: npm test

### SHD-004 — CompositeQuotaSource.buildQuotaSource factory and error-skipping behavior not tested

- Severity: low
- Confidence: high
- Lens: tests
- Files: packages/shared/src/quota/compositeQuotaSource.ts
- Summary: `CompositeQuotaSource.queryCurrentUsage` silently swallows errors from individual sources (lines 20-23) and tries the next one. The `buildQuotaSource` factory that wires the production cascade (line 36) is also untested. Neither the source-failure fallthrough nor the factory composition is covered by tests in this packet.
- Evidence:
  - packages/shared/src/quota/compositeQuotaSource.ts:19-24 - error catch/skip in queryCurrentUsage loop; no test injects a throwing source
  - packages/shared/src/quota/compositeQuotaSource.ts:36-41 - buildQuotaSource exported but not referenced in any test in this packet
  - runtime:unit:packages-shared: confirmed — Deterministic runtime command succeeded: npm test

### MNT-004 — console.warn save/restore pattern repeated five times without a helper

- Severity: low
- Confidence: high
- Lens: maintainability
- Files: packages/audit-code/tests/cli-remediation.test.mjs
- Summary: Four warnIfNotGitRepo tests in cli-remediation.test.mjs each manually save console.warn, override it, call the function under test, restore it in a finally block, and clean up a temp dir. The ~12-line save/override/restore idiom is repeated verbatim with no shared wrapper, making each test harder to read and change.
- Evidence:
  - packages/audit-code/tests/cli-remediation.test.mjs:265 - save/override console.warn, try/finally restore — first instance
  - packages/audit-code/tests/cli-remediation.test.mjs:289 - second save/override pattern (adds console.log capture too)
  - packages/audit-code/tests/cli-remediation.test.mjs:309 - third instance: override to no-op
  - packages/audit-code/tests/cli-remediation.test.mjs:330 - fourth instance
  - runtime:flow:flow:surface:packages-audit-code-tests-cli-remediation-test-mjs: confirmed — Deterministic runtime command succeeded: npm test
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### OBS-002 — console.warn used for unknown template placeholder warnings in subprocess provider

- Severity: low
- Confidence: high
- Lens: observability
- Files: packages/audit-code/src/providers/subprocessTemplateProvider.ts
- Summary: subprocessTemplateProvider.ts line 43 uses console.warn for unknown placeholder warnings while the rest of the codebase uses process.stderr.write. console.warn is buffered differently and may interleave or be suppressed differently than process.stderr in scripts, reducing the reliability of operator-visible diagnostics.
- Evidence:
  - packages/audit-code/src/providers/subprocessTemplateProvider.ts:43 - console.warn(`applyTemplate: unknown placeholder ${match} provider=${context.providerName} runId=${input.runId} ...`) — uses console.warn instead of process.stderr.write used elsewhere; syntaxResolutionExecutor.ts:123 uses process.stderr.write for contrast
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-004 — conventionalRoutePath segment edge cases not tested (catch-all, group, pages/api)

- Severity: low
- Confidence: high
- Lens: tests
- Files: packages/audit-code/src/extractors/graphRoutes.ts
- Summary: conventionalRoutePath handles Next.js catch-all ([...slug]), route group segments ((group)), and the pages/api directory convention. The existing test only exercises the App Router route.ts happy path; catch-all conversion (:slug*), group elision, and pages/api convention are untested.
- Evidence:
  - packages/audit-code/src/extractors/graphRoutes.ts:272 - nextRouteSegment: catch-all [...x] maps to :x*, grouped (x) maps to undefined (elided)
  - packages/audit-code/src/extractors/graphRoutes.ts:295 - conventionalRoutePath: pages/api branch at line 308 is a separate code path never exercised by any test
  - packages/audit-code/tests/extractors-remediation.test.mjs:1086 - only tests src/app/api/health/route.ts (App Router); no pages/api or catch-all fixture
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-003 — Copy-pasted root guard repeated for five executors in advance.ts

- Severity: low
- Confidence: high
- Lens: maintainability
- Files: packages/audit-code/src/orchestrator/advance.ts
- Summary: Five executor branches in advanceAudit repeat the identical pattern if (!options.root) throw new Error('advanceAudit <executor> requires root'). This pattern should be extracted into a helper or the type system should encode root-required executors distinctly.
- Evidence:
  - packages/audit-code/src/orchestrator/advance.ts:142 - intake_executor root guard
  - packages/audit-code/src/orchestrator/advance.ts:165 - planning_executor root guard
  - packages/audit-code/src/orchestrator/advance.ts:186 - runtime_validation_executor root guard
  - packages/audit-code/src/orchestrator/advance.ts:224 - auto_fix_executor root guard
  - packages/audit-code/src/orchestrator/advance.ts:227 - syntax_resolution_executor root guard
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-004 — countLines helper duplicated across three test files

- Severity: low
- Confidence: high
- Lens: maintainability
- Files: packages/audit-code/tests/audit-code-completion.test.mjs, packages/audit-code/tests/fixture-repo.test.mjs, packages/audit-code/tests/helpers/provider-assisted-bridge.mjs
- Summary: The countLines function (counts non-empty lines, accounting for trailing newline) is independently defined in audit-code-completion.test.mjs, fixture-repo.test.mjs, and provider-assisted-bridge.mjs with identical logic, making the three copies a change-hazard.
- Evidence:
  - packages/audit-code/tests/audit-code-completion.test.mjs:16-24 - countLines reads file, returns split length adjusted for trailing newline
  - packages/audit-code/tests/fixture-repo.test.mjs:24-32 - identical countLines implementation
  - packages/audit-code/tests/helpers/provider-assisted-bridge.mjs:52-60 - identical countLines implementation
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### DI-005 — critical_flows confidence is a binary string enum, inconsistent with numeric confidence in graph_bundle

- Severity: low
- Confidence: high
- Lens: data_integrity
- Files: packages/audit-code/schemas/critical_flows.schema.json
- Summary: The confidence field in critical_flows.schema.json is a string enum restricted to high or low, while all graph edge confidence fields in graph_bundle.schema.json are numeric values in the range 0..1. Consumers reading confidence across these related artifacts encounter two incompatible representations of the same concept.
- Evidence:
  - packages/audit-code/schemas/critical_flows.schema.json:36-39 - confidence: { type: string, enum: [high, low] }
  - packages/audit-code/schemas/graph_bundle.schema.json:28-31 (boundary) - confidence: { type: number, minimum: 0, maximum: 1 } on import edges, a different representation of the same concept
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### COR-002 — Cycle deduplication discards valid distinct directed cycles with the same node set

- Severity: low
- Confidence: high
- Lens: correctness
- Files: packages/audit-code/src/extractors/designAssessment.ts
- Summary: In `designAssessment.ts`, `deduplicateCycles` normalizes each cycle by sorting its nodes and joining them to form a key. This means two distinct directed cycles that traverse the same set of nodes in different orders (e.g., A→B→C→A and A→C→B→A) are treated as duplicates and collapsed to one, causing the second valid cycle to be silently dropped from the findings report.
- Evidence:
  - packages/audit-code/src/extractors/designAssessment.ts:63 - `function deduplicateCycles(cycles: string[][]): string[][]` sorts nodes to form the dedup key
  - packages/audit-code/src/extractors/designAssessment.ts:67 - `const normalized = [...cycle].sort().join('\0');` - direction information is lost; A→B→C and A→C→B both produce key 'A\0B\0C'
  - packages/audit-code/src/extractors/designAssessment.ts:24 - `detectCycles` builds adjacency from directed edges and finds directed cycles, but deduplication treats them as undirected
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### OBS-002 — Deprecated probeProvider emits no runtime warning to callers

- Severity: low
- Confidence: high
- Lens: observability
- Files: packages/audit-code/src/quota/probe.ts
- Summary: probeProvider is annotated @deprecated in JSDoc but never emits a runtime stderr warning when called. Callers get no observable signal at runtime that they are invoking a deprecated code path.
- Evidence:
  - packages/audit-code/src/quota/probe.ts:9 - JSDoc @deprecated annotation present: 'Phase 3A replaces this with the QuotaSource abstraction.'
  - packages/audit-code/src/quota/probe.ts:10-28 - Function body has no process.stderr.write, console.warn, or equivalent runtime deprecation signal before returning.
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-005 — describeValue and isRecord reimplemented in provider-assisted-bridge.mjs

- Severity: low
- Confidence: high
- Lens: maintainability
- Files: packages/audit-code/tests/helpers/provider-assisted-bridge.mjs
- Summary: provider-assisted-bridge.mjs defines its own describeValue and isRecord functions that are semantically identical to the exported versions in packages/shared/src/validation/basic.ts, spreading the same validation primitives across two locations.
- Evidence:
  - packages/audit-code/tests/helpers/provider-assisted-bridge.mjs:9-13 - describeValue: array to 'array', null to 'null', else typeof
  - packages/audit-code/tests/helpers/provider-assisted-bridge.mjs:15-17 - isRecord: typeof==='object' && !null && !Array
  - packages/shared/src/validation/basic.ts:9-21 - identical describeValue and isRecord implementations
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-004 — design-assessment tests do not exercise cycle/hub detection via reference edges

- Severity: low
- Confidence: high
- Lens: tests
- Files: packages/audit-code/src/extractors/designAssessment.ts
- Summary: The makeParams helper in design-assessment.test.mjs initializes graphBundle.graphs with only imports and calls keys, never references. Because allEdges() in designAssessment.ts processes all graph keys (except routes), tests never verify that cycles or hub modules within reference edges are detected.
- Evidence:
  - packages/audit-code/tests/design-assessment.test.mjs:8 - makeParams sets graphBundle: { graphs: { imports: [], calls: [] } } — no 'references' key
  - packages/audit-code/src/extractors/designAssessment.ts:11 - allEdges() iterates Object.entries(graphBundle.graphs), skips 'routes' but includes 'references' if present; no test exercises this path
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-003 — designAssessment module-level mutable counter not tested for reset correctness across calls

- Severity: low
- Confidence: high
- Lens: tests
- Files: packages/audit-code/src/extractors/designAssessment.ts, packages/audit-code/src/extractors/designAssessment.ts
- Summary: designAssessment.ts uses a module-level mutable counter (nextFindingId) reset inside buildDesignAssessment. No test exercises two successive calls to verify the reset occurs correctly, meaning a regression that removes or breaks the reset would not be caught by the existing tests.
- Evidence:
  - packages/audit-code/src/extractors/designAssessment.ts:5 - let nextFindingId = 1; // module-level mutable state
  - packages/audit-code/src/extractors/designAssessment.ts:289 - nextFindingId = 1; // reset at start of each call — not tested across successive calls
  - packages/audit-code/tests/design-assessment.test.mjs:213 - 'finding ids are unique and sequentially assigned' test calls buildDesignAssessment only once
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-007 — designReviewPrompt.ts has no test coverage

- Severity: low
- Confidence: high
- Lens: tests
- Files: packages/audit-code/src/orchestrator/designReviewPrompt.ts
- Summary: renderDesignReviewPrompt builds the design-review prompt from an ArtifactBundle. Six private summarizer helpers (units, graph, flows, risk, surfaces, files) each have empty-collection branches, and units truncates after 40 entries. None of this is covered by any test. A malformed prompt could silently cause the design review LLM step to produce garbage results.
- Evidence:
  - packages/audit-code/src/orchestrator/designReviewPrompt.ts:109 - renderDesignReviewPrompt exported; grep over all test files finds no import of designReviewPrompt
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### DI-001 — dispatch_quota.schema.json uses JSON Schema draft-07 instead of draft/2020-12

- Severity: low
- Confidence: high
- Lens: data_integrity
- Files: packages/audit-code/schemas/dispatch_quota.schema.json
- Summary: All other schemas declare $schema: https://json-schema.org/draft/2020-12/schema, but dispatch_quota.schema.json declares $schema: http://json-schema.org/draft-07/schema#. This version inconsistency can cause validators that honor the meta-schema to apply different keyword semantics to this schema than to all others.
- Evidence:
  - packages/audit-code/schemas/dispatch_quota.schema.json:2 - "$schema": "http://json-schema.org/draft-07/schema#" (draft-07)
  - packages/audit-code/schemas/audit_result.schema.json:2 - "$schema": "https://json-schema.org/draft/2020-12/schema" (representative of all other schemas in this directory)
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-005 — dispatch/validate.mjs hard-codes relative path into compiled dist/ output

- Severity: low
- Confidence: high
- Lens: maintainability
- Files: packages/audit-code/dispatch/validate.mjs
- Summary: validate.mjs imports from '../dist/validation/auditResults.js', tightly coupling this runtime-executed dispatch helper to the TypeScript build output location. If the build target directory changes or the file is moved within dispatch/, this path reference breaks without a compile-time signal.
- Evidence:
  - packages/audit-code/dispatch/validate.mjs:1 - import { validateAuditResults } from '../dist/validation/auditResults.js' reaches up a level into the compiled dist/ tree with a hardcoded relative path
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### OBS-004 — Document phase provider errors logged without artifact paths or provider name

- Severity: low
- Confidence: high
- Lens: observability
- Files: packages/remediate-code/src/phases/document.ts
- Summary: When the document phase fails to read or validate a worker result, it logs a generic error with only the finding ID but does not emit the resultPath, taskPath, or provider name, making it difficult to locate the artefact that caused the failure without re-running the step.
- Evidence:
  - packages/remediate-code/src/phases/document.ts:270 - console.error catches failure for finding.id but resultPath and provider name are not included
  - packages/remediate-code/src/phases/document.ts:175-181 - resultPath taskPath stdoutPath stderrPath all defined locally but not surfaced in the catch block
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### OBS-002 — Document-dispatch reconciliation logged to stdout but not to the run log

- Severity: low
- Confidence: high
- Lens: observability
- Files: packages/remediate-code/src/steps/dispatch.ts, packages/remediate-code/src/steps/dispatch.ts
- Summary: prepareDocumentDispatch and prepareImplementDispatch emit reconciliation counts via console.log but never record them in the RunLogger, so the structured run.log.jsonl file has no trace of how many items were reused from a previous run.
- Evidence:
  - packages/remediate-code/src/steps/dispatch.ts:384 - `console.log('Reusing existing document result for ...')` — plain stdout, not a structured event
  - packages/remediate-code/src/steps/dispatch.ts:410 - `console.log('Reconciliation: reused ${reconciledCount} ...')` — ditto
  - packages/remediate-code/src/steps/dispatch.ts:603 - `console.log('Reusing existing implement result for block ...')` — plain stdout
  - packages/remediate-code/src/steps/dispatch.ts:629 - `console.log('Reconciliation: reused ${reconciledCount} ...')` — ditto; RunLogger is not in scope at this call site
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-001 — Duplicate async-temp-dir helper pattern across test files

- Severity: low
- Confidence: high
- Lens: maintainability
- Files: packages/audit-code/tests/provider-assisted-bridge.test.mjs, packages/audit-code/tests/provider-assisted-continuation.test.mjs
- Summary: The withTempDir / withTempRepo async-scoped-directory helpers are independently implemented in provider-assisted-bridge.test.mjs (lines 35-41) and provider-assisted-continuation.test.mjs (lines 55-107). Both follow an identical mkdtemp/try/finally/rm pattern. Extracting this to the shared helpers directory would remove the duplication and make the pattern easier to change once.
- Evidence:
  - packages/audit-code/tests/provider-assisted-bridge.test.mjs:35 - async function withTempDir(fn) { const dir = await mkdtemp(...); try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); } }
  - packages/audit-code/tests/provider-assisted-continuation.test.mjs:55 - async function withTempRepo(fn) { const tempDir = await mkdtemp(...); ... try { ... return await fn(root); } finally { await rm(tempDir, { recursive: true, force: true }); } }
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-002 — Duplicate runWrapper / spawn-then-collect pattern in two test files

- Severity: low
- Confidence: high
- Lens: maintainability
- Files: packages/audit-code/tests/provider-assisted-bridge.test.mjs, packages/audit-code/tests/provider-assisted-continuation.test.mjs
- Summary: provider-assisted-bridge.test.mjs (lines 12-33) and provider-assisted-continuation.test.mjs (lines 14-40) each define a local runBridge / runWrapper function that spawns a child process and accumulates stdout/stderr into strings before resolving/rejecting. The two functions are structurally identical modulo the target script path. A shared helper in helpers/ would consolidate this pattern.
- Evidence:
  - packages/audit-code/tests/provider-assisted-bridge.test.mjs:12 - function runBridge(taskPath) { return new Promise((resolve, reject) => { const child = spawn(process.execPath, [bridgePath, taskPath], ...); let stdout = ''; let stderr = ''; child.stdout.on('data', ...); child.stderr.on('data', ...); child.on('exit', ...); }); }
  - packages/audit-code/tests/provider-assisted-continuation.test.mjs:14 - function runWrapper(args, options = {}) { ... return new Promise((resolve, reject) => { const child = spawn(process.execPath, [wrapperPath, ...args], ...); let stdout = ''; let stderr = ''; child.stdout.on('data', ...); child.stderr.on('data', ...); child.on('exit', ...); }); }
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-002 — Duplicated auto-detection boolean expression in providers/index.ts

- Severity: low
- Confidence: high
- Lens: maintainability
- Files: packages/audit-code/src/providers/index.ts, packages/audit-code/src/providers/index.ts
- Summary: The three-condition autoDetectionRequested check is copy-pasted verbatim in resolveFreshSessionProviderName and createFreshSessionProvider. If the detection semantics change, both sites must be updated consistently.
- Evidence:
  - packages/audit-code/src/providers/index.ts:50-52 - shouldAutoDetect = requestedProvider === undefined || requestedProvider === 'auto' || (name === undefined && requestedProvider === 'local-subprocess')
  - packages/audit-code/src/providers/index.ts:110-113 - autoDetectionRequested has the identical three-condition expression repeated verbatim
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-001 — Duplicated blockId sanitization expression in worktreeIsolation.ts

- Severity: low
- Confidence: high
- Lens: maintainability
- Files: packages/remediate-code/src/steps/worktreeIsolation.ts, packages/remediate-code/src/steps/worktreeIsolation.ts, packages/remediate-code/src/steps/worktreeIsolation.ts, packages/remediate-code/src/steps/worktreeIsolation.ts
- Summary: The regex replace `/[^a-zA-Z0-9_-]/g, "_"` and the branch-name prefix `remediate-${blockId.replace(...)}` are repeated verbatim in createWorktree, mergeWorktree, and removeWorktree rather than being extracted into a shared helper. Any change to the sanitization rule must be applied in three places.
- Evidence:
  - packages/remediate-code/src/steps/worktreeIsolation.ts:17 - const safe = blockId.replace(/[^a-zA-Z0-9_-]/g, "_");
  - packages/remediate-code/src/steps/worktreeIsolation.ts:32 - const branchName = `remediate-${blockId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  - packages/remediate-code/src/steps/worktreeIsolation.ts:59 - const branchName = `remediate-${blockId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  - packages/remediate-code/src/steps/worktreeIsolation.ts:101 - const branchName = `remediate-${blockId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;  — third duplication in removeWorktree
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-003 — Duplicated incoming-file read-then-consume pattern across three executor branches

- Severity: low
- Confidence: high
- Lens: maintainability
- Files: packages/audit-code/src/cli/nextStepCommand.ts
- Summary: Three executor branches in runDeterministicForNextStep (design_review, synthesis_narrative, edge_reasoning) each repeat the same try-readJsonFile / catch-isFileMissing / check-defined / run-step / unlink pattern. This boilerplate is copy-pasted with minor type differences, making it easy for the branches to diverge silently.
- Evidence:
  - packages/audit-code/src/cli/nextStepCommand.ts:252-270 - edge-reasoning: try readJsonFile, catch isFileMissingError, check defined, run step, unlink
  - packages/audit-code/src/cli/nextStepCommand.ts:284-302 - design_review: identical try/catch/check structure, different type only
  - packages/audit-code/src/cli/nextStepCommand.ts:319-334 - synthesis_narrative: same pattern a third time
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-001 — Duplicated inline console-capture boilerplate across four tests

- Severity: low
- Confidence: high
- Lens: maintainability
- Files: packages/audit-code/tests/review-packets.test.mjs, packages/audit-code/tests/review-packets.test.mjs, packages/audit-code/tests/review-packets.test.mjs, packages/audit-code/tests/review-packets.test.mjs
- Summary: The same save-capture-restore pattern for console.log is inlined four times in review-packets.test.mjs instead of being extracted to a shared helper like runValidate does in validate-command.test.mjs. Any change to the capture logic must be made in four places.
- Evidence:
  - packages/audit-code/tests/review-packets.test.mjs:1024 - const previousConsoleLog = console.log; let stdout = ""; console.log = (...values) => { stdout += ... }
  - packages/audit-code/tests/review-packets.test.mjs:1133 - const previousConsoleLog = console.log; console.log = () => {};
  - packages/audit-code/tests/review-packets.test.mjs:1179 - const previousConsoleLog = console.log; console.log = () => {};
  - packages/audit-code/tests/review-packets.test.mjs:1257 - const previousConsoleLog = console.log; let stdout = ""; console.log = (...values) => { stdout += ... }
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-001 — Duplicated makeFinding factory across two test files

- Severity: low
- Confidence: high
- Lens: maintainability
- Files: packages/remediate-code/tests/cross-lens-dedup.test.ts, packages/remediate-code/tests/model-hints.test.ts
- Summary: The makeFinding helper function is defined identically in both cross-lens-dedup.test.ts and model-hints.test.ts. Any future change to the default Finding shape must be applied twice, risking drift.
- Evidence:
  - packages/remediate-code/tests/cross-lens-dedup.test.ts:9 - function makeFinding(overrides: Partial<Finding> & { id: string }): Finding { return { title: "Example finding", ... } }
  - packages/remediate-code/tests/model-hints.test.ts:9 - function makeFinding(overrides: Partial<Finding> & { id: string }): Finding { return { title: "Example finding", ... } } — identical body in same package
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-001 — Duplicated withTempDir helper across test files

- Severity: low
- Confidence: high
- Lens: maintainability
- Files: packages/audit-code/tests/orchestration.test.mjs, packages/audit-code/tests/providers-remediation.test.mjs
- Summary: The withTempDir helper function is defined identically in two test files (orchestration.test.mjs and providers-remediation.test.mjs) with the same signature and cleanup logic, creating a maintenance burden if the pattern ever needs to change.
- Evidence:
  - packages/audit-code/tests/orchestration.test.mjs:117 - async function withTempDir(fn) { const dir = await mkdtemp(...); try { return await fn(dir); } finally { await rm(dir, ...) } }
  - packages/audit-code/tests/providers-remediation.test.mjs:21 - async function withTempDir(prefix, fn) { const dir = await mkdtemp(...); try { return await fn(dir); } finally { await rm(dir, ...) } }
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### OBS-001 — Entry-point error handler discards stack trace

- Severity: low
- Confidence: high
- Lens: observability
- Files: packages/audit-code/audit-code.mjs
- Summary: audit-code.mjs catches all errors and logs only error.message, discarding the stack trace. Operators diagnosing unexpected failures see only a single-line message with no source location or cause chain.
- Evidence:
  - packages/audit-code/audit-code.mjs:11 - console.error(error instanceof Error ? error.message : String(error)) — stack is silently dropped
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-003 — entrypoint-contract.test.mjs asserts exact documentation prose strings

- Severity: low
- Confidence: high
- Lens: tests
- Files: packages/audit-code/tests/entrypoint-contract.test.mjs
- Summary: The product-docs consistency test asserts that README.md, docs/product.md, skills/audit-code/SKILL.md, and skills/audit-code/audit-code.prompt.md contain specific verbatim sentences (e.g. "advance the audit automatically until it completes or no further automatic progress is possible"). Any rewording that preserves meaning but changes wording will break the test, creating a maintenance burden without catching real behavioral regressions.
- Evidence:
  - packages/audit-code/tests/entrypoint-contract.test.mjs:28-31 - assert.ok(content.includes("advance the audit automatically until it completes or no further automatic progress is possible")) called on three docs
  - packages/audit-code/tests/entrypoint-contract.test.mjs:33-43 - further exact-string assertions on Conversation Setup, Repo-Local Backend Fallback, conversational product surface first, probe alternate, etc.
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-001 — executeBlock tests use hardcoded /tmp paths (Windows-incompatible)

- Severity: low
- Confidence: high
- Lens: tests
- Files: packages/remediate-code/tests/phase-implement.test.ts, packages/remediate-code/tests/phase-implement.test.ts
- Summary: Two executeBlock tests pass root: '/tmp' and artifactsDir: '/tmp/arts' directly. On Windows these paths do not exist, so any code path that tries to use them as real filesystem locations will fail, making the tests platform-fragile.
- Evidence:
  - packages/remediate-code/tests/phase-implement.test.ts:103 - await executeBlock(block, '/tmp', { state: ..., options: { root: '/tmp', artifactsDir: '/tmp/arts' }, ... })
  - packages/remediate-code/tests/phase-implement.test.ts:130 - await executeBlock(block, '/tmp', { state: ..., options: { root: '/tmp', artifactsDir: '/tmp/arts' }, ... })
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-003 — fallbackRouteEdge and uniqueSortedRoutes have no tests

- Severity: low
- Confidence: high
- Lens: tests
- Files: packages/audit-code/src/extractors/graphRoutes.ts, packages/audit-code/src/extractors/graphRoutes.ts
- Summary: fallbackRouteEdge (returns a synthetic GET edge for files with api/ or route in their path) and uniqueSortedRoutes (deduplication + sort of RouteEdge arrays) are exported from graphRoutes.ts but are never exercised in any test file.
- Evidence:
  - packages/audit-code/src/extractors/graphRoutes.ts:40 - uniqueSortedRoutes: deduplication by signature + sort by path/handler/method, no test
  - packages/audit-code/src/extractors/graphRoutes.ts:552 - fallbackRouteEdge: heuristic fallback that encodes filePath into route path with replaceAll, no test
  - packages/audit-code/tests/graph-framework-routes.test.mjs:1 - entire test file exercises extractRegisteredRouteEvidence/extractFrameworkRouteEvidence only through buildGraphBundle; uniqueSortedRoutes and fallbackRouteEdge not referenced
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### OBS-004 — File integrity check result logs to stdout, mixing with structured JSON output

- Severity: low
- Confidence: high
- Lens: observability
- Files: packages/audit-code/src/cli/nextStepCommand.ts
- Summary: In runDeterministicForNextStep, a console.log call at line 173 emits a human-readable file integrity message to stdout, which is the same channel used for the structured JSON step envelope. This can corrupt the parseable output if a downstream consumer reads stdout as a stream rather than parsing the final JSON.
- Evidence:
  - packages/audit-code/src/cli/nextStepCommand.ts:173 - console.log used for diagnostic file integrity output, same stdout channel as the final JSON step (console.log at line 481, 517, 536, etc.)
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### OBS-003 — fileIntegrity hash errors silently return undefined with no log

- Severity: low
- Confidence: high
- Lens: observability
- Files: packages/remediate-code/src/utils/fileIntegrity.ts
- Summary: Both hashFile and hashFileSync catch all file-read and hash-computation errors, returning undefined without any log or structured event. A caller checking file integrity cannot distinguish a hash error from a missing file.
- Evidence:
  - packages/remediate-code/src/utils/fileIntegrity.ts:13-14 - hashFileSync catch block returns undefined with no log
  - packages/remediate-code/src/utils/fileIntegrity.ts:21-23 - hashFile catch block returns undefined with no log
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### OBS-005 — fileIntegrity I/O errors silently reclassified as missing files

- Severity: low
- Confidence: high
- Lens: observability
- Files: packages/audit-code/src/orchestrator/fileIntegrity.ts
- Summary: In checkFileIntegrity, when readFile throws for a file that exists on disk the error is swallowed and the path is added to missing_files with no record of the actual error. This makes it impossible to distinguish genuine absent files from permission errors or I/O failures.
- Evidence:
  - packages/audit-code/src/orchestrator/fileIntegrity.ts:44 - } catch { missing.push(record.path); } -- bare catch with no error logging; any I/O failure is silently treated as a missing file
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### OBS-002 — FileLockTimeoutError lacks elapsed-time and retry-count context

- Severity: low
- Confidence: high
- Lens: observability
- Files: packages/shared/src/quota/fileLock.ts
- Summary: FileLockTimeoutError only includes the lock path in its message, omitting the timeout duration, elapsed wait time, and retry count. When diagnosing contention or deadlocks, operators have no numeric context from the error alone.
- Evidence:
  - packages/shared/src/quota/fileLock.ts:7-11 - FileLockTimeoutError constructor only embeds lockPath; timeoutMs parameter is not captured in the message or as a property
  - runtime:unit:packages-shared: confirmed — Deterministic runtime command succeeded: npm test

### MNT-004 — Finding deduplication key construction duplicated inline across two loops in cmdSubmitPacket

- Severity: low
- Confidence: high
- Lens: maintainability
- Files: packages/audit-code/src/cli.ts
- Summary: The four-part finding key (lens|category|title|affected_files[0].path) is constructed identically in two consecutive loops within cmdSubmitPacket. Extracting a named helper would make the deduplication contract explicit and prevent drift if the key schema changes.
- Evidence:
  - packages/audit-code/src/cli.ts:631 - const key = [(f.lens ?? '').trim().toLowerCase(), (f.category ?? '').trim().toLowerCase(), (f.title ?? '').trim().toLowerCase(), f.affected_files?.[0]?.path ?? ''].join('|') in loop over prior packet findings
  - packages/audit-code/src/cli.ts:644 - identical four-part join pattern repeated in second loop over incoming payload findings
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-002 — fixture-repo.test.mjs skips the graph enrichment step between structure and design assessment

- Severity: low
- Confidence: high
- Lens: tests
- Files: packages/audit-code/tests/fixture-repo.test.mjs
- Summary: The fixture-repo integration walk advances intake → externalAnalyzerImport → autoFix → syntaxResolution → structure → designAssessment → planning but omits the graph_enrichment_executor step that audit-code-lifecycle.test.mjs shows runs between structure and design assessment. The enriched graph_bundle content is therefore never exercised in the fixture-repo walk.
- Evidence:
  - packages/audit-code/tests/fixture-repo.test.mjs:80-86 - structure step called then immediately passed to designAssessment without a graph enrichment step
  - packages/audit-code/tests/audit-code-lifecycle.test.mjs:119-123 - lifecycle test confirms graph_enrichment_executor runs between structure and design assessment and yields next_likely_step=design_assessment_current
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-006 — flowPlanning.ts (claimFlowReviewBlocks) has no test coverage

- Severity: low
- Confidence: high
- Lens: tests
- Files: packages/audit-code/src/orchestrator/flowPlanning.ts
- Summary: claimFlowReviewBlocks assigns flow-grouped review blocks to pending lens/path pairs using an assigned Set to prevent double-assignment. The function has non-trivial sorting (by file count, then lens priority, then flow ID) and path deduplication but is never exercised in any test file.
- Evidence:
  - packages/audit-code/src/orchestrator/flowPlanning.ts:25 - claimFlowReviewBlocks exported; no import of flowPlanning found in any test file under packages/audit-code/tests/
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-002 — getCachePath derives sibling path by regex-replacing quota-state.json filename

- Severity: low
- Confidence: high
- Lens: maintainability
- Files: packages/audit-code/src/quota/discoveredLimits.ts
- Summary: discoveredLimits.ts computes its cache path by replacing the hardcoded string 'quota-state.json' at the end of getQuotaStatePath(). This creates implicit coupling to the naming convention of an unrelated function: if getQuotaStatePath() ever changes its filename, getCachePath() silently stops transforming the path.
- Evidence:
  - packages/audit-code/src/quota/discoveredLimits.ts:25 - return getQuotaStatePath().replace(/quota-state\.json$/, "discovered-limits.json"); — assumes the sibling naming convention of getQuotaStatePath rather than a dedicated path function
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-005 — git.test.mjs has no coverage of actual non-empty git output parsing

- Severity: low
- Confidence: high
- Lens: tests
- Files: packages/shared/tests/git.test.mjs
- Summary: git.test.mjs only tests the degraded empty-result paths. There are no tests that create a real git repo with commits and verify changedFiles, fileCommits, or stagedAndUntracked return correct non-empty results.
- Evidence:
  - packages/shared/tests/git.test.mjs:26 - only 'degrade to empty results outside a repo' is tested; changedFiles, fileCommits, stagedAndUntracked are never asserted to return actual data from a repo with real commits
  - runtime:unit:packages-shared: confirmed — Deterministic runtime command succeeded: npm test

### SHD-005 — git.ts utility functions have no tests in this packet

- Severity: low
- Confidence: high
- Lens: tests
- Files: packages/shared/src/git.ts
- Summary: All five exported git helpers (`isGitRepo`, `gitRefExists`, `changedFiles`, `fileCommits`, `stagedAndUntracked`) have no test coverage in this packet. These helpers are used by both orchestrators and have non-trivial behavior (early return on `.git` existence, graceful degradation on command failure). While some are implicitly exercised at integration time, unit tests are absent.
- Evidence:
  - packages/shared/src/git.ts:21-28 - `isGitRepo` with `.git` directory shortcut and command fallback; no test
  - packages/shared/src/git.ts:47-49 - `changedFiles` returns empty on non-zero exit; no test for failure path
  - runtime:unit:packages-shared: confirmed — Deterministic runtime command succeeded: npm test

### DI-008 — graph_bundle graphs object allows arbitrary additional graph types without any type validation

- Severity: low
- Confidence: high
- Lens: data_integrity
- Files: packages/audit-code/schemas/graph_bundle.schema.json
- Summary: The graphs object in graph_bundle.schema.json uses additionalProperties: true, meaning any key beyond the four defined types is accepted with no type check. An analyzer could write a malformed extra graph type without any schema rejection.
- Evidence:
  - packages/audit-code/schemas/graph_bundle.schema.json:118-119 - additionalProperties: true on the graphs object allows any arbitrary additional graph type
  - packages/audit-code/schemas/graph_bundle.schema.json:7-117 - the four known graph types (imports, calls, references, routes) each have structured array schemas; extra types bypass all constraints
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### REL-003 — graph-framework-routes.test.mjs: top-level await on dist import creates all-or-nothing module load failure

- Severity: low
- Confidence: high
- Lens: reliability
- Files: packages/audit-code/tests/graph-framework-routes.test.mjs
- Summary: Line 4 uses a top-level await to import from the built dist/ directory. If the build artifact is missing or the import rejects, the entire test module fails to load and all tests are silently skipped rather than reported as failures, obscuring build/test dependency issues in CI.
- Evidence:
  - packages/audit-code/tests/graph-framework-routes.test.mjs:4 - const { buildGraphBundle } = await import('../dist/extractors/graph.js');
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### OBS-004 — graphEnrichmentExecutor progress_summary omits analyzer failure and skip counts

- Severity: low
- Confidence: high
- Lens: observability
- Files: packages/audit-code/src/orchestrator/graphEnrichmentExecutor.ts
- Summary: When analyzers fail or are absent, runGraphEnrichmentExecutor reports only the count of contributing analyzers in progress_summary. Skipped and failed analyzer counts are not surfaced in the human-visible summary, only accessible by parsing analyzer_capability.json.
- Evidence:
  - packages/audit-code/src/orchestrator/graphEnrichmentExecutor.ts:278 - progress_summary line references only analyzersUsed (contributing analyzers); absent/failed/skipped entries recorded in entries[] are not reflected in the summary string
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-003 — Indentation inconsistency at line 124 in cmdRunToCompletion

- Severity: low
- Confidence: high
- Lens: maintainability
- Files: packages/audit-code/src/cli/runToCompletion.ts
- Summary: Line 124 (`const explicitProvider = getExplicitProvider(argv);`) has no leading indentation while the surrounding function body uses 2-space indentation uniformly, indicating a stale edit that was not reformatted.
- Evidence:
  - packages/audit-code/src/cli/runToCompletion.ts:124 - `const explicitProvider = getExplicitProvider(argv);` at column 0 while adjacent lines 125-135 use 2-space indent
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-003 — Inline auth-session heuristic duplicates pathPatterns logic in graph.ts

- Severity: low
- Confidence: high
- Lens: maintainability
- Files: packages/audit-code/src/extractors/graph.ts
- Summary: The heuristic auth-session link block (lines 444-465 of graph.ts) inlines simple string-includes checks for auth and session directly inside the main buildGraphBundle loop. Equivalent predicates exist in pathPatterns.ts (isSecuritySensitivePath, isIdentityPath). This fragment should be extracted to a dedicated helper consistent with how every other heuristic edge type is factored.
- Evidence:
  - packages/audit-code/src/extractors/graph.ts:444-465 - inline normalized.includes auth and session heuristic embedded in main loop
  - packages/audit-code/src/extractors/flows.ts:22-28 - same repo uses isSecuritySensitivePath/isIdentityPath from pathPatterns for the equivalent concern
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-004 — Inline type aliases (PreliminaryEntry, ReviewedEntry, PrelimEntry) defined inside loop body

- Severity: low
- Confidence: high
- Lens: maintainability
- Files: packages/remediate-code/src/steps/nextStep.ts, packages/remediate-code/src/steps/nextStep.ts
- Summary: Three local `type` aliases are declared inside the loop body of `decideNextStepInner`, making them invisible to external tooling, impossible to reuse or test independently, and hard to locate during debugging.
- Evidence:
  - packages/remediate-code/src/steps/nextStep.ts:1050 - type PreliminaryEntry = { finding_id: string; title: string; ... } defined inside the for-loop iteration body
  - packages/remediate-code/src/steps/nextStep.ts:1176 - type ReviewedEntry = { ... } and type PrelimEntry = { ... } defined inside the function body after the preliminary file has been written
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-005 — intake.ts has no dedicated test file

- Severity: low
- Confidence: high
- Lens: tests
- Files: packages/remediate-code/src/intake.ts
- Summary: src/intake.ts exports blockingIntakeQuestions, isIntakeReady, resolveManifestSources, buildDocumentSourceManifest, and buildConversationSourceManifest but none of these functions have any test coverage, direct or indirect, in the current test suite.
- Evidence:
  - packages/remediate-code/src/intake.ts:124 - blockingIntakeQuestions: blocking !== false distinction (truthy-absent vs explicit false) has no test
  - packages/remediate-code/src/intake.ts:101 - resolveManifestSources path resolution and missing-file separation have no test
  - packages/remediate-code/src/intake.ts:132 - isIntakeReady combining ready flag and blocking questions has no test
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### DI-005 — item_spec tests_to_write assertions array lacks minItems constraint

- Severity: low
- Confidence: high
- Lens: data_integrity
- Files: packages/remediate-code/schemas/item_spec.schema.json
- Summary: In item_spec.schema.json, the tests_to_write items require an 'assertions' field but it has no minItems constraint. An empty assertions array is schema-valid, producing a structurally valid test spec that never verifies anything.
- Evidence:
  - packages/remediate-code/schemas/item_spec.schema.json:18-20 - 'assertions': type=array, items=string, no minItems; empty list is valid
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-001 — jsonSchemaAssert.mjs has no documented scope boundary

- Severity: low
- Confidence: high
- Lens: maintainability
- Files: packages/audit-code/tests/helpers/jsonSchemaAssert.mjs
- Summary: The hand-rolled JSON Schema validator exports a single function with no JSDoc, no inline comments listing supported keywords, and no documented schema-dialect subset. Callers cannot determine what keywords are handled (e.g. if/then/else and not are silently absent) without reading the full 451-line implementation.
- Evidence:
  - packages/audit-code/tests/helpers/jsonSchemaAssert.mjs:432 - exported function has no JSDoc; supported keyword set is undocumented
  - packages/audit-code/tests/helpers/jsonSchemaAssert.mjs:398-410 - keywordValidators / valueKeywordValidators arrays define supported keywords but this list is never surfaced to callers
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### OBS-005 — LLM plan-extraction error log lacks input identifier and run context

- Severity: low
- Confidence: high
- Lens: observability
- Files: packages/remediate-code/src/phases/plan.ts
- Summary: In plan.ts, when LLM-based plan extraction fails, the catch block logs only console.error("Failed to extract plan via LLM:", e) with no indication of which input file was being processed, the run/task ID, or how much content was attempted, making post-mortem debugging of extraction failures harder.
- Evidence:
  - packages/remediate-code/src/phases/plan.ts:664-666 - catch(e) logs generic message with no input path, content length, task run_id, or timestamp; promptPath and resultPath are in scope but not logged
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-004 — loadSessionConfig test has no coverage for pre-existing or corrupt config files

- Severity: low
- Confidence: high
- Lens: tests
- Files: packages/audit-code/tests/field-trial-remediation.test.mjs
- Summary: The only test for `loadSessionConfig` covers the missing-file case and writes a default. There are no tests for a pre-existing valid config (to confirm it is read without overwrite) or a corrupt JSON file (to confirm a graceful error rather than a crash).
- Evidence:
  - packages/audit-code/tests/field-trial-remediation.test.mjs:606 - single test scenario covers only the missing-file default write; no test for already-existing config or malformed JSON
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-002 — LocalSubprocessProvider empty worker_command error path is untested

- Severity: low
- Confidence: high
- Lens: tests
- Files: packages/remediate-code/src/providers/localSubprocessProvider.ts
- Summary: localSubprocessProvider.ts throws MISSING_WORKER_COMMAND_MESSAGE when task.worker_command is empty, but no test exercises this branch. The providers.test.ts fixture always supplies a non-empty worker_command.
- Evidence:
  - packages/remediate-code/src/providers/localSubprocessProvider.ts:20-22 - if (!task.worker_command?.length) { throw new Error(MISSING_WORKER_COMMAND_MESSAGE); }
  - packages/remediate-code/tests/providers.test.ts:96-110 - withProviderFiles always writes worker_command: ["node", "worker.js"]; no test path passes an empty array
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### OBS-001 — Lock acquisition failures and stale-lock removals not logged

- Severity: low
- Confidence: high
- Lens: observability
- Files: packages/remediate-code/src/state/store.ts
- Summary: The acquireLock function silently retries on EEXIST errors and removes stale locks without emitting any log event, making it impossible to trace contention or stale-lock cleanup in production runs.
- Evidence:
  - packages/remediate-code/src/state/store.ts:115 - removeStaleLockIfNeeded called but its return value (true = removed) is not logged
  - packages/remediate-code/src/state/store.ts:108-130 - retry loop has no log output; operators cannot tell how many retries occurred or whether a stale lock was cleaned up
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### OBS-001 — Lock contention in run ledger has no observable signal before timeout

- Severity: low
- Confidence: high
- Lens: observability
- Files: packages/audit-code/src/supervisor/runLedger.ts
- Summary: acquireLedgerLock retries up to 100 times (2 second window) with no intermediate log or warning. Under lock contention operators have no signal that the process is waiting; the first observable event is the thrown timeout error.
- Evidence:
  - packages/audit-code/src/supervisor/runLedger.ts:121-142 - acquireLedgerLock loops up to LOCK_RETRY_LIMIT (100) iterations with await sleep(LOCK_RETRY_DELAY_MS) (20ms) between each; no process.stderr.write or log call exists within the loop body or at any retry threshold.
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-001 — Magic constant 4 for --host-max-active-subagents duplicated in two code paths

- Severity: low
- Confidence: high
- Lens: maintainability
- Files: .gemini/commands/audit-code.toml
- Summary: The value 4 for --host-max-active-subagents appears twice (lines 35 and 44) in separate code blocks for the global bin and monorepo-root dev paths. If the recommended default changes, both occurrences must be updated in sync, and the prose rationale on line 38 ("4 is a safe default") is the only explanation.
- Evidence:
  - .gemini/commands/audit-code.toml:35 - `audit-code next-step --host-max-active-subagents 4`
  - .gemini/commands/audit-code.toml:44 - `node packages/audit-code/audit-code.mjs next-step --host-max-active-subagents 4`
  - .gemini/commands/audit-code.toml:38 - inline comment explains "4 is a safe default" but value is not defined in one place

### MNT-003 — Magic exponent cap literal in lock backoff formula

- Severity: low
- Confidence: high
- Lens: maintainability
- Files: packages/remediate-code/src/state/store.ts
- Summary: The lock retry backoff in store.ts uses unnamed literal 4 as the exponent ceiling in an exponential-backoff calculation. The surrounding delay constants are named, but this cap is not, obscuring what the formula produces at each retry level.
- Evidence:
  - packages/remediate-code/src/state/store.ts:126 - 'LOCK_RETRY_DELAY_MS * 2 ** Math.min(attempt, 4)' — the literal 4 is an unnamed exponent cap; at base 20ms it caps the step at 320ms before LOCK_RETRY_MAX_DELAY_MS clips it
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-005 — Magic literal 24 used as default half-life hours in prepareDispatchArtifacts

- Severity: low
- Confidence: high
- Lens: maintainability
- Files: packages/audit-code/src/cli/dispatch.ts
- Summary: dispatch.ts line 663 uses the literal 24 as a fallback for empirical_half_life_hours with no named constant, making it unclear whether 24 is a deliberate domain value or an arbitrary placeholder.
- Evidence:
  - packages/audit-code/src/cli/dispatch.ts:663 - const halfLifeHours = sessionConfig.quota?.empirical_half_life_hours ?? 24; — literal 24 has no companion named constant
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-007 — Magic numeric thresholds for quota remaining_pct and first-contact cap are inline literals

- Severity: low
- Confidence: high
- Lens: maintainability
- Files: packages/shared/src/quota/scheduler.ts
- Summary: Several domain-significant thresholds appear as unnamed inline literals: the 0.1 and 0.3 quota remaining_pct thresholds and the 0.5 halving factor in scheduler.ts, and the default first_contact_concurrency fallback of 3. Named constants for BASE_COOLDOWN_MS and MAX_COOLDOWN_MS exist but the threshold cluster is inconsistently extracted.
- Evidence:
  - packages/shared/src/quota/scheduler.ts:179 - quota.first_contact_concurrency ?? 3 — the literal 3 is the only unextracted fallback integer in this file
  - packages/shared/src/quota/scheduler.ts:187 - quotaSourceSnapshot.remaining_pct < 0.1 — unnamed throttle threshold
  - packages/shared/src/quota/scheduler.ts:192 - quotaSourceSnapshot.remaining_pct < 0.3 — unnamed halve threshold
  - packages/shared/src/quota/scheduler.ts:193 - Math.floor(waveSize * 0.5) — unnamed halving factor
  - runtime:unit:packages-shared: confirmed — Deterministic runtime command succeeded: npm test

### MNT-005 — Magic numeric timeout and unexplained framing byte offset

- Severity: low
- Confidence: high
- Lens: maintainability
- Files: packages/audit-code/tests/mcp-server.test.mjs, packages/audit-code/tests/mcp-server.test.mjs, packages/audit-code/tests/mcp-server.test.mjs
- Summary: The 5000 ms timeout in readFramedPayload and the +4 byte offset in the framing parsers are unexplained inline literals. The +4 encodes the byte length of the CRNL+CRNL separator and is silently repeated in two locations without a named constant.
- Evidence:
  - packages/audit-code/tests/mcp-server.test.mjs:135 - const timeout = setTimeout(() => { ... }, 5000); magic 5000 ms with no label
  - packages/audit-code/tests/mcp-server.test.mjs:55 - const frameLength = separator + 4 + contentLength; magic 4 repeated at line 122
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-005 — Magic schema-version string literals used inline without named constants

- Severity: low
- Confidence: high
- Lens: maintainability
- Files: packages/remediate-code/src/steps/nextStep.ts, packages/remediate-code/src/steps/nextStep.ts
- Summary: The schema version strings impl-risk-preliminary/v1 and impl-risk-reviewed/v1 are hardcoded inline at two locations each in `nextStep.ts` with no named constant, making version bumps error-prone.
- Evidence:
  - packages/remediate-code/src/steps/nextStep.ts:1096 - schema_version: impl-risk-preliminary/v1 hardcoded in writeJsonFile call
  - packages/remediate-code/src/steps/nextStep.ts:1152 - schema_version: impl-risk-reviewed/v1 hardcoded in the prompt template string
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-002 — Magic sentinel string in resolveArtifactsDirOption couples callers to implementation detail

- Severity: low
- Confidence: high
- Lens: maintainability
- Files: packages/remediate-code/src/index.ts
- Summary: resolveArtifactsDirOption checks whether artifactsDir equals the literal default string to decide whether to join with root, embedding the default value as a sentinel that callers must not alter. This makes the function behaviour invisible from call sites and brittle if the default changes.
- Evidence:
  - packages/remediate-code/src/index.ts:323 - string equality check against .remediation-artifacts used as the only branch condition; callers passing any other relative path get resolve() without joining to root
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-002 — Magic string `/tmp` used as root path in executeBlock tests

- Severity: low
- Confidence: high
- Lens: maintainability
- Files: packages/remediate-code/tests/phase-implement.test.ts, packages/remediate-code/tests/phase-implement.test.ts
- Summary: The string literal `/tmp` is hardcoded as the `root` and `artifactsDir` options in two executeBlock test cases, embedding a platform-specific filesystem assumption as an unnamed magic constant.
- Evidence:
  - packages/remediate-code/tests/phase-implement.test.ts:103 - `await executeBlock(block, "/tmp", { ... options: { root: "/tmp", artifactsDir: "/tmp/arts" }, ...`
  - packages/remediate-code/tests/phase-implement.test.ts:131 - same `/tmp` and `/tmp/arts` hardcoded in second executeBlock test case
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-003 — Magic string `no test specified` embedded inline in testCommand.ts

- Severity: low
- Confidence: high
- Lens: maintainability
- Files: packages/shared/src/tooling/testCommand.ts
- Summary: The regex pattern `/no test specified/i` on line 73 of testCommand.ts is an inline magic string that encodes npm-init boilerplate knowledge without a named constant or explanatory comment, making the intent opaque to future readers.
- Evidence:
  - packages/shared/src/tooling/testCommand.ts:73 - `if (testScript && !/no test specified/i.test(testScript)) {` — inline regex string for npm-init placeholder test detection without a named constant
  - runtime:flow:flow:surface:packages-shared-src-tooling-testCommand-ts: confirmed — Deterministic runtime command succeeded: npm test
  - runtime:unit:packages-shared: confirmed — Deterministic runtime command succeeded: npm test

### MNT-003 — Magic string contract version in validateClosingResult

- Severity: low
- Confidence: high
- Lens: maintainability
- Files: packages/remediate-code/src/validation/artifacts.ts
- Summary: The closing-result contract version string "remediate-code-closing-result/v1alpha1" is inlined at line 189 of artifacts.ts but is not referenced from a named constant or the steps/types.ts module that already exports the other contract version constants, creating a risk of silent mismatch if the version ever changes.
- Evidence:
  - packages/remediate-code/src/validation/artifacts.ts:189 - if (value.contract_version !== "remediate-code-closing-result/v1alpha1") — hardcoded inline string
  - packages/remediate-code/src/validation/artifacts.ts:15-18 - REMEDIATION_DISPATCH_PLAN_CONTRACT_VERSION, REMEDIATION_STEP_CONTRACT_VERSION, REMEDIATION_WORKER_RESULT_CONTRACT_VERSION are imported from steps/types.js but closing-result has no counterpart
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-004 — Magic string literals for graph property names in collectGraphEdges

- Severity: low
- Confidence: high
- Lens: maintainability
- Files: packages/audit-code/src/orchestrator/reviewPackets.ts
- Summary: The graph property names imports, calls, and references are embedded as raw string literals in an inline array with no named constant, making typos silent and future renames require text search rather than a compile-time reference.
- Evidence:
  - packages/audit-code/src/orchestrator/reviewPackets.ts:238 - for (const key of ["imports", "calls", "references"]) -- inline magic strings with no named constant
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-004 — Markdown report built via repeated string concatenation instead of a rendering abstraction

- Severity: low
- Confidence: high
- Lens: maintainability
- Files: packages/remediate-code/src/phases/close.ts
- Summary: The remediation report in runClosePhase is assembled by appending to a mutable string variable across roughly 90 lines with no templating function or helper. Adding a new report section requires understanding the full concatenation sequence and inserting in the right order.
- Evidence:
  - packages/remediate-code/src/phases/close.ts:292 - let reportContent initialized as mutable string
  - packages/remediate-code/src/phases/close.ts:352-384 - repeated reportContent += appends for each section (resolved, verifiedNoChange, inappropriate, ignored)
  - packages/remediate-code/src/phases/close.ts:386-419 - further reportContent += appends for closing action, e2e result, outcomes summary
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-004 — MCP submit_clarifications and submit_triage handlers not tested

- Severity: low
- Confidence: high
- Lens: tests
- Files: packages/remediate-code/src/mcp/server.ts
- Summary: mcp-server.test.ts tests parseFrame and the start_remediation/initialize/tools/list dispatch paths, but handleSubmitClarifications and handleSubmitTriage (including file-write side-effects and subsequent next-step dispatch) have no test coverage.
- Evidence:
  - packages/remediate-code/src/mcp/server.ts:387 - handleSubmitClarifications writes clarification_resolution.json then calls handleNextStep: no test
  - packages/remediate-code/src/mcp/server.ts:403 - handleSubmitTriage writes triage_resolution.json then calls handleNextStep: no test
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### OBS-002 — merge-results only surfaces first error per failing task

- Severity: low
- Confidence: high
- Lens: observability
- Files: packages/audit-code/dispatch/merge-results.mjs
- Summary: When a task result fails validation, merge-results.mjs logs only errors[0] to stderr, silently discarding any additional validation errors for that task. Operators cannot see the full failure picture without reading the failed-tasks.json file.
- Evidence:
  - packages/audit-code/dispatch/merge-results.mjs:73 - process.stderr.write(`  ✗ ${f.task_id}: ${f.errors[0]}
`) — only the first error is printed; f.errors may contain multiple
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### OBS-003 — mergeDocumentResults and mergeImplementResults have no structured log events

- Severity: low
- Confidence: high
- Lens: observability
- Files: packages/remediate-code/src/steps/dispatch.ts, packages/remediate-code/src/steps/dispatch.ts
- Summary: The two merge functions emit warnings via console.warn for blocked items but never record item-level merge outcomes (documented, blocked, clarification counts) in the run log, leaving gaps in the structured audit trail.
- Evidence:
  - packages/remediate-code/src/steps/dispatch.ts:493 - `console.warn('Missing document worker result: ...')` — not a structured RunLogger event
  - packages/remediate-code/src/steps/dispatch.ts:757 - `console.warn('Missing implement worker result: ...')` — not a structured RunLogger event
  - packages/remediate-code/src/steps/dispatch.ts:809 - `process.stderr.write('[remediate-code] ...')` for merge-conflict errors — not in run log
  - packages/remediate-code/src/steps/nextStep.ts:1393-1408 - triage executor_start/end events exist but no equivalent around mergeDocumentResults / mergeImplementResults call sites
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-002 — mergeRuntimeValidationReport prior-result branch not tested

- Severity: low
- Confidence: high
- Lens: tests
- Files: packages/audit-code/src/orchestrator/runtimeValidation.ts
- Summary: runtimeValidation.ts exports mergeRuntimeValidationReport whose primary purpose is to re-use existing results (the prior ?? {...} fallback at line 116), but no test exercises a call where existing already contains a result for a task, so the merge path is untested.
- Evidence:
  - packages/audit-code/src/orchestrator/runtimeValidation.ts:116 - prior ?? { task_id: task.id, status: 'pending', ... } — the non-null branch (prior !== undefined) is never exercised by any test
  - packages/audit-code/tests/schema-contracts.test.mjs:589 - only buildRuntimeValidationTasks is exercised; mergeRuntimeValidationReport is absent from all test files
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-004 — Misleading test name: 'unknown hosted provider' uses the known claude-code name

- Severity: low
- Confidence: high
- Lens: tests
- Files: packages/remediate-code/tests/quota-scheduler.test.ts
- Summary: The scheduleWave test at line 212 is titled 'defaults unknown hosted provider to concurrency 1' but passes `providerName: 'claude-code'`, which is a known provider name. The intent seems to be testing the no-quota-state, no-host-model path, but the test name creates confusion about what scenario is actually exercised and whether a truly unknown provider name would behave differently.
- Evidence:
  - packages/remediate-code/tests/quota-scheduler.test.ts:213-219 - `providerName: 'claude-code'` is used but the test name says 'unknown hosted provider'
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-003 — Missing test for equal-severity tie-breaking in cross-lens dedup

- Severity: low
- Confidence: high
- Lens: tests
- Files: packages/remediate-code/tests/cross-lens-dedup.test.ts
- Summary: cross-lens-dedup.test.ts covers the case where one finding has lower severity and one has higher severity (TST-003 survivor is the higher-severity one), but there is no test asserting which finding survives when both have identical severity. The tie-breaking behavior is unverified and unspecified in the test suite.
- Evidence:
  - packages/remediate-code/tests/cross-lens-dedup.test.ts:116 - it(keeps higher severity finding as survivor) only tests asymmetric severity
  - packages/remediate-code/tests/cross-lens-dedup.test.ts:44 - it(merges findings with same title...) does not assert which finding survives
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### DI-006 — model-hints tests use non-canonical lens values absent from finding schema enum

- Severity: low
- Confidence: high
- Lens: data_integrity
- Files: packages/remediate-code/tests/model-hints.test.ts
- Summary: model-hints.test.ts creates Finding fixtures with lens values 'style', 'lint', and 'format' which are not in the canonical lens enum in finding.schema.json. These fixtures would fail schema validation, meaning the tests exercise non-schema-compliant data.
- Evidence:
  - packages/remediate-code/tests/model-hints.test.ts:97 - lens: 'style' - not in finding.schema.json lens enum
  - packages/remediate-code/tests/model-hints.test.ts:104 - lens: 'lint' - not in finding.schema.json lens enum
  - packages/remediate-code/tests/model-hints.test.ts:128 - lens: 'format' - not in finding.schema.json lens enum; valid values include correctness, architecture, security, data_integrity, etc.
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### OBS-003 — No extraction metrics or edge counts emitted by graph builders

- Severity: low
- Confidence: high
- Lens: observability
- Files: packages/audit-code/src/extractors/graph.ts
- Summary: Neither `buildGraphBundle` nor `buildGraphBundleFromFs` emits any metrics — e.g. files read, files skipped, edges extracted per kind, or duration. Callers receive a `GraphBundle` with no accompanying diagnostics, making it impossible to detect regressions in extraction quality without diffing raw artifact output.
- Evidence:
  - packages/audit-code/src/extractors/graph.ts:374-410 - `buildGraphBundleFromFs` reads files and calls `buildGraphBundle`; no summary stats returned or logged
  - packages/audit-code/src/extractors/graph.ts:412-561 - `buildGraphBundle` processes all files and builds edge arrays; function returns only `GraphBundle` with no metadata about extraction coverage
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-005 — No unit tests for lineIndex.ts functions

- Severity: low
- Confidence: high
- Lens: tests
- Files: packages/audit-code/src/cli/lineIndex.ts
- Summary: buildLineIndex, buildLineIndexForPaths, and addFileLineCountHints have no direct unit tests. The functions swallow file-read errors silently (returning 0), which could mask missing files in audit tasks.
- Evidence:
  - packages/audit-code/src/cli/lineIndex.ts:21 - catch block returns [file.path, 0] silently on read error; no test verifies this fallback
  - packages/audit-code/src/cli/lineIndex.ts:34 - buildLineIndexForPaths deduplicates paths via Set — uniqueness behavior not tested
  - packages/audit-code/src/cli/lineIndex.ts:51 - addFileLineCountHints annotates tasks; merging behavior not tested
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### OBS-003 — normalizeExternal silently drops items missing path or summary

- Severity: low
- Confidence: high
- Lens: observability
- Files: packages/audit-code/src/adapters/normalizeExternal.ts
- Summary: normalizeGenericExternalResults filters out any item where path or summary is falsy, with no log or counter. Callers importing ESLint, semgrep, npm-audit, or coverage results receive a quietly truncated result set and have no signal that records were discarded.
- Evidence:
  - packages/audit-code/src/adapters/normalizeExternal.ts:21 - .filter((item) => item.path && item.summary) — items failing this predicate are silently dropped with no count or warning emitted
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-002 — normalizeForMetadataHash: tooling_manifest.json stripping branch not tested

- Severity: low
- Confidence: high
- Lens: tests
- Files: packages/audit-code/src/orchestrator/artifactFreshness.ts
- Summary: artifactFreshness.ts strips generated_at from both repo_manifest.json and tooling_manifest.json, but staleness.test.mjs only asserts the repo_manifest.json stripping. There is no assertion that tooling_manifest.json is treated identically, so a regression removing that branch would not be caught.
- Evidence:
  - packages/audit-code/src/orchestrator/artifactFreshness.ts:24 - condition checks artifactName === tooling_manifest.json but no test in staleness.test.mjs calls hashArtifactValue(tooling_manifest.json,...) to verify the strip
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-002 — not combiner behavior is completely untested in json-schema-assert tests

- Severity: low
- Confidence: high
- Lens: tests
- Files: packages/audit-code/tests/json-schema-assert.test.mjs
- Summary: The jsonSchemaAssert test for combiners only checks that a schema without a `not` keyword does not restrict any value (a trivial no-op assertion). There is no test that a schema with a `not` constraint correctly rejects a value that matches the negated sub-schema.
- Evidence:
  - packages/audit-code/tests/json-schema-assert.test.mjs:175 - test is titled `not keyword absent means no restriction` and only tests a schema with `type: string` and no `not` — the `not` combiner path in the helper is never exercised
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### COR-002 — output_tokens_per_minute silently dropped from discovered limits cache

- Severity: low
- Confidence: high
- Lens: correctness
- Files: packages/audit-code/src/quota/discoveredLimits.ts, packages/audit-code/src/quota/discoveredLimits.ts
- Summary: DiscoveredLimitsCacheEntry has no output_tokens_per_minute field, so updateDiscoveredLimits silently discards any output_tokens_per_minute passed in DiscoveredRateLimits. lookupDiscoveredLimits will never return a non-null output_tokens_per_minute from cache.
- Evidence:
  - packages/audit-code/src/quota/discoveredLimits.ts:5-10 - DiscoveredRateLimits has output_tokens_per_minute field
  - packages/audit-code/src/quota/discoveredLimits.ts:12-17 - DiscoveredLimitsCacheEntry has no output_tokens_per_minute field
  - packages/audit-code/src/quota/discoveredLimits.ts:69-76 - updateDiscoveredLimits only copies requests_per_minute and input_tokens_per_minute; output_tokens_per_minute is never written
  - packages/audit-code/src/quota/discoveredLimits.ts:86-91 - lookupDiscoveredLimits returns output_tokens_per_minute: null unconditionally
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### OBS-004 — Packet planning budget hits produce no observable signal

- Severity: low
- Confidence: high
- Lens: observability
- Files: packages/audit-code/src/orchestrator/reviewPackets.ts
- Summary: The token-budget and task-count chunking logic in chunkPacketTasks silently splits packets when thresholds are exceeded. The resulting packet split is not logged or surfaced in any metric field on the packet or in the plan metrics, so there is no way to know post-hoc that a packet was split due to budget pressure versus graph structure.
- Evidence:
  - packages/audit-code/src/orchestrator/reviewPackets.ts:1207-1214 - wouldExceedTaskCount and wouldExceedTokens conditions silently push the current chunk and start a new one; no split reason is recorded in the returned chunk or propagated to the ReviewPacket fields
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-002 — Packet-submission loop duplicated across three test bodies and a setup helper

- Severity: low
- Confidence: high
- Lens: maintainability
- Files: packages/audit-code/tests/audit-code-wrapper.test.mjs, packages/audit-code/tests/audit-code-wrapper.test.mjs, packages/audit-code/tests/audit-code-wrapper.test.mjs
- Summary: The pattern of iterating dispatch-plan packets, building AuditResult objects from taskById+resultMap, and calling submit-packet appears three times: in setupSubmitPacketFixture (partially), and fully in the merge-and-ingest tests at lines 494-517, 656-679 and the swapped-results test at lines 727-742. validAuditResultForTask exists as a helper but is bypassed in favour of inlined equivalents each time.
- Evidence:
  - packages/audit-code/tests/audit-code-wrapper.test.mjs:494 - inline result construction (task_id, unit_id, pass_id, lens, file_coverage, findings) duplicating validAuditResultForTask
  - packages/audit-code/tests/audit-code-wrapper.test.mjs:656 - same inline construction repeated verbatim in the spurious-file test
  - packages/audit-code/tests/audit-code-wrapper.test.mjs:729 - validResult() inner helper defined a third time inside test body instead of reusing validAuditResultForTask
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-004 — parseContentLength MAX_CONTENT_LENGTH_BYTES boundary not tested

- Severity: low
- Confidence: high
- Lens: tests
- Files: packages/audit-code/src/mcp/server.ts
- Summary: mcp-server.test.mjs tests that negative and fractional Content-Length values are rejected, but it does not test values equal to MAX_CONTENT_LENGTH_BYTES (accepted) or one byte above (rejected). The boundary at 10*1024*1024 bytes is unguarded by any assertion.
- Evidence:
  - packages/audit-code/src/mcp/server.ts:150 - contentLength > MAX_CONTENT_LENGTH_BYTES triggers bad Content-Length but no test supplies a value of exactly MAX_CONTENT_LENGTH_BYTES+1 to verify rejection
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-004 — Permanently-deprecated probeProvider stub still exported from public barrel

- Severity: low
- Confidence: high
- Lens: maintainability
- Files: packages/remediate-code/src/quota/probe.ts, packages/remediate-code/src/quota/index.ts
- Summary: probe.ts exports probeProvider marked @deprecated with a body that unconditionally returns supported=false and no implementation path. The stub is still re-exported from quota/index.ts, keeping it in the package's public surface with no removal plan.
- Evidence:
  - packages/remediate-code/src/quota/probe.ts:8-9 - '@deprecated Phase 3A replaces this with the QuotaSource abstraction.' with no replacement call or removal plan
  - packages/remediate-code/src/quota/probe.ts:17-24 - All branches return supported=false; no provider is actually probed
  - packages/remediate-code/src/quota/index.ts:65 - 'export { probeProvider } from "./probe.js";' surfaces the deprecated stub
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-004 — Permission pattern constants duplicated between definition object and assertion function

- Severity: low
- Confidence: high
- Lens: maintainability
- Files: packages/audit-code/audit-code-wrapper-lib.mjs, packages/audit-code/audit-code-wrapper-lib.mjs
- Summary: The allow/deny bash permission patterns are defined in OPENCODE_AUDIT_BASH_PERMISSION (lines 666-705) and then re-enumerated as string literals inside assertOpenCodeAuditPermissionConfig (lines 857-896). Adding or removing a pattern requires editing both locations; the assertion does not derive its checks from the constant it is verifying.
- Evidence:
  - packages/audit-code/audit-code-wrapper-lib.mjs:667 - 'audit-code run-to-completion*': 'deny' defined in constant object
  - packages/audit-code/audit-code-wrapper-lib.mjs:884 - 'audit-code run-to-completion*' re-listed as literal string in assertion loop
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-004 — phase-plan.test.ts references undefined __dirname without importing it

- Severity: low
- Confidence: high
- Lens: maintainability
- Files: packages/remediate-code/tests/phase-plan.test.ts
- Summary: phase-plan.test.ts uses __dirname in the TEST_DIR and FIXTURE constant declarations (lines 7-8) without the standard ESM shim (`const __dirname = dirname(fileURLToPath(import.meta.url))`) that every other test file in the package defines. The omission either causes a ReferenceError at runtime or silently falls back to a Node global — both are fragile and inconsistent with the file's own imports.
- Evidence:
  - packages/remediate-code/tests/phase-plan.test.ts:7 - const TEST_DIR = join(__dirname, ".test-plan-artifacts"); — __dirname used but never declared in this file
  - packages/remediate-code/tests/phase-plan.test.ts:8 - const FIXTURE = join(__dirname, "fixtures", "audit-findings-simple.json"); — same missing binding
  - packages/remediate-code/tests/next-step.test.ts:12 - const __dirname = dirname(fileURLToPath(import.meta.url)); — correct ESM shim present in the sibling file
  - packages/remediate-code/tests/dispatch-reconciliation.test.ts:18 - const __dirname = dirname(fileURLToPath(import.meta.url)); — correct shim also present here
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### OPR-001 — postinstall.mjs: no summary count or timing after multi-target global install

- Severity: low
- Confidence: high
- Lens: operability
- Files: packages/audit-code/scripts/postinstall.mjs
- Summary: postinstall.mjs installs to six distinct global config targets (Claude command, Codex skill, Codex prompt, OpenCode config, Antigravity plugin, Claude Desktop plugin + MCP entry) but emits no final summary line reporting how many targets succeeded or failed, and no elapsed-time indication. Operators running npm install on a slow machine or in CI see only individual per-file lines, making it unclear whether the overall install completed normally.
- Evidence:
  - packages/audit-code/scripts/postinstall.mjs:414-425 - each install item logs individually with console.log/console.warn but there is no aggregation; a failed optional install is silently continued with a warn and no final tallied outcome
  - packages/audit-code/scripts/postinstall.mjs:428-434 - MCP launcher install similarly logged individually without any aggregate result
  - packages/audit-code/scripts/postinstall.mjs:505-519 - Claude Desktop config update is the last operation; no final summary line such as 'postinstall complete: N/M targets installed' follows
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-002 — probeProvider mode-switch logic is untested

- Severity: low
- Confidence: high
- Lens: tests
- Files: packages/audit-code/src/quota/probe.ts
- Summary: probeProvider in probe.ts has no unit tests. While it always returns {supported: false}, it contains a three-branch mode switch (never/auto/force) and a provider-name discriminant that are implicit contracts. Any future implementation of the probe would silently pass without a test baseline for the existing branch behavior.
- Evidence:
  - packages/audit-code/src/quota/probe.ts:13 - probeMode never returns {supported:false} early before provider check
  - packages/audit-code/src/quota/probe.ts:18 - non-subprocess-template providers return {supported:false} with provider name in reason string
  - packages/audit-code/src/quota/probe.ts:24 - subprocess-template probe not implemented stub also returns {supported:false}
  - packages/audit-code/tests/ - no file imports probeProvider or probe.js
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-001 — promoteFinalAuditReport: success+cleanup-failure branch untested

- Severity: low
- Confidence: high
- Lens: tests
- Files: packages/audit-code/src/io/artifacts.ts
- Summary: The branch in promoteFinalAuditReport where copy succeeds but rm fails (returning {promoted:true,cleaned:false,warning}) is not exercised. Only the copy-fails path is tested in io-remediation.test.mjs, leaving the partial-success warning path uncovered.
- Evidence:
  - packages/audit-code/src/io/artifacts.ts:295 - try { await remove(...) } block that emits promoted:true,cleaned:false,warning is only reachable when copy succeeds and remove throws, but tests/io-remediation.test.mjs line 183 only injects a copy failure, never a remove failure
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### OBS-003 — Provider auto-resolution is silent on selected provider

- Severity: low
- Confidence: high
- Lens: observability
- Files: packages/remediate-code/src/providers/index.ts
- Summary: When provider=auto resolves successfully to claude-code, opencode, vscode-task, or subprocess-template, no log is emitted. Only the unhappy path (fallback to local-subprocess) produces a structured warning, leaving operators unable to confirm which provider was chosen without inspecting source or adding debug output.
- Evidence:
  - packages/remediate-code/src/providers/index.ts:119-130 - only the local-subprocess fallback branch writes to stderr; all other providerName branches in the switch (lines 133-156) are silent on selection
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### OPR-002 — publish-package.yml registry-propagation retry loop lacks elapsed-time in log messages

- Severity: low
- Confidence: high
- Lens: operability
- Files: packages/audit-code/.github/workflows/publish-package.yml
- Summary: The registry propagation poll loop (lines 155-163) logs attempt number and a 10-second sleep hint per iteration but does not report total elapsed time in each message. With up to 24 attempts (4 minutes), operators inspecting a stalled publish run cannot easily gauge how long the wait has been without counting attempts.
- Evidence:
  - packages/audit-code/.github/workflows/publish-package.yml:155-163 - the loop uses 'attempt' counter and prints 'retrying in 10 seconds' but no cumulative elapsed wall-clock time is reported in the log line, making it hard to know how long propagation has been waited for
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### OPR-001 — publish-shared missing failure troubleshooting guidance step

- Severity: low
- Confidence: high
- Lens: operability
- Files: .github/workflows/publish-package.yml
- Summary: The publish-shared job has no 'Emit troubleshooting guidance' failure step, unlike publish-audit-code (lines 201-207) and publish-remediate-code (lines 364-369). When the shared publish fails, operators receive no actionable error message pointing them to artifact logs or Trusted Publishing configuration.
- Evidence:
  - .github/workflows/publish-package.yml:201-207 - publish-audit-code has 'Emit troubleshooting guidance' step on failure; publish-shared (lines 371-505) has no equivalent step
  - .github/workflows/publish-package.yml:497-505 - publish-shared ends at 'Upload npm debug logs'; no subsequent failure step emits a human-readable ::error:: message

### OPR-002 — publish-shared step summary omits dry-run mode indicator

- Severity: low
- Confidence: high
- Lens: operability
- Files: .github/workflows/publish-package.yml
- Summary: The 'Resolve publish metadata' step in publish-shared does not write the mode (dry-run vs live) to the GitHub step summary, while the equivalent steps in publish-audit-code and publish-remediate-code do. Operators cannot tell from the summary whether a run was live or a dry run.
- Evidence:
  - .github/workflows/publish-package.yml:140-146 - publish-audit-code step summary includes '- mode: ${MODE}' line
  - .github/workflows/publish-package.yml:446-451 - publish-shared step summary omits mode entirely; no MODE variable is computed or written

### TST-005 — Python import resolver exported APIs not directly tested

- Severity: low
- Confidence: high
- Lens: tests
- Files: packages/audit-code/src/extractors/graphPythonImports.ts
- Summary: resolvePythonImportTarget and resolvePythonFromImportTargets are exported from graphPythonImports.ts as shared APIs for the tree-sitter Python analyzer but are never directly tested. The only coverage goes through buildGraphBundle; the exported contract itself is verified only indirectly.
- Evidence:
  - packages/audit-code/src/extractors/graphPythonImports.ts:374 - resolvePythonImportTarget: exported, validates absolute module specifier only, then delegates
  - packages/audit-code/src/extractors/graphPythonImports.ts:390 - resolvePythonFromImportTargets: exported, tries submodule files first then falls back to module
  - packages/audit-code/tests/tree-sitter-analyzers.test.mjs:7 - imports pythonAnalyzer (tree-sitter layer) but never calls resolvePythonImportTarget or resolvePythonFromImportTargets directly
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-001 — python-test-util-suite-link helpers/ test uses non-exhaustive OR assertion

- Severity: low
- Confidence: high
- Lens: tests
- Files: packages/audit-code/tests/extractors-remediation.test.mjs
- Summary: The test at line 1795-1797 uses `assert.ok(A || B)` to verify an undirected edge exists in either direction, but does not assert the total count of edges, so an implementation producing zero edges still passes if neither branch is evaluated incorrectly, and extra spurious edges in wrong directories would be silently accepted.
- Evidence:
  - packages/audit-code/tests/extractors-remediation.test.mjs:1795 - `assert.ok(edgePairs.some(...) || edgePairs.some(...))` does not verify edge count, direction cardinality, or absence of unexpected edges
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-004 — quota/probe.ts and quota/hostLimits.ts have zero test coverage

- Severity: low
- Confidence: high
- Lens: tests
- Files: packages/remediate-code/src/quota/probe.ts, packages/remediate-code/src/quota/hostLimits.ts
- Summary: probeProvider (probe.ts) has branching on providerName and probeMode values. resolveHostActiveSubagentLimit (hostLimits.ts) wraps the shared helper with a custom ENV_PREFIX. Neither file has any direct test coverage; findings found in those functions would be invisible.
- Evidence:
  - packages/remediate-code/src/quota/probe.ts:9-25 - probeProvider branches on probeMode (never returns early, non-subprocess-template returns early, subprocess-template returns stub); none of these branches are tested
  - packages/remediate-code/src/quota/hostLimits.ts:7 - ENV_PREFIX = REMEDIATE_CODE; if shared helper changes its prefix logic, the remediator-specific wrapper would silently break with no test catching it
  - No grep match for probeProvider or detectHostActiveSubagentLimit or resolveHostActiveSubagentLimit in packages/remediate-code/tests/
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### OPR-006 — release-changed.mjs omits per-package elapsed time for verify:release gate

- Severity: low
- Confidence: high
- Lens: operability
- Files: scripts/release-changed.mjs
- Summary: The preflight loop runs npm run verify:release for each changed package, which can each take several minutes, but no start time or elapsed time is logged per package. Operators cannot tell how long each gate is taking.
- Evidence:
  - scripts/release-changed.mjs:300-303 - for-of loop logs 'Pre-flight gate: <label> (verify:release)...' before run() but no elapsed time or completion line after; if verify:release hangs, the operator sees no further output.

### TST-004 — renderSynthesisNarrativePrompt truncation logic is untested

- Severity: low
- Confidence: high
- Lens: tests
- Files: packages/audit-code/src/reporting/synthesisNarrativePrompt.ts
- Summary: renderSynthesisNarrativePrompt in synthesisNarrativePrompt.ts is not tested. It implements a MAX_RENDERED_FINDINGS=120 cap with an overflow note when exceeded, plus a no-findings branch. These edge-case paths have no coverage.
- Evidence:
  - packages/audit-code/src/reporting/synthesisNarrativePrompt.ts:3 - MAX_RENDERED_FINDINGS = 120; overflow note at line 26 never exercised by any test
  - packages/audit-code/src/reporting/synthesisNarrativePrompt.ts:44 - no-findings fallback text not tested
  - packages/audit-code/tests/ - no file imports renderSynthesisNarrativePrompt
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-006 — renderTierSection and renderNoOpSection are nested closures inside the state machine loop

- Severity: low
- Confidence: high
- Lens: maintainability
- Files: packages/remediate-code/src/steps/nextStep.ts
- Summary: Two rendering helpers `renderTierSection` and `renderNoOpSection` are defined as closures inside the `decideNextStepInner` loop body, capturing `reviewedMap` and `prelimMap` implicitly; extracting them as module-level helpers with explicit parameters would make them independently testable.
- Evidence:
  - packages/remediate-code/src/steps/nextStep.ts:1212 - function renderTierSection(tier: string, label: string): string defined inside loop body, closes over reviewedMap and prelimMap
  - packages/remediate-code/src/steps/nextStep.ts:1229 - function renderNoOpSection(): string defined immediately after, same pattern
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-002 — Repeated env-var save/restore boilerplate across ClaudeCodeProvider tests

- Severity: low
- Confidence: high
- Lens: maintainability
- Files: packages/audit-code/tests/providers-remediation.test.mjs, packages/audit-code/tests/providers-remediation.test.mjs, packages/audit-code/tests/providers-remediation.test.mjs
- Summary: The CLAUDECODE env-var save/restore pattern (save original, delete or restore in finally) is copy-pasted across three tests in providers-remediation.test.mjs without extraction to a helper, making it easy to introduce subtle asymmetries.
- Evidence:
  - packages/audit-code/tests/providers-remediation.test.mjs:70 - const original = process.env.CLAUDECODE; process.env.CLAUDECODE = 1; try { ... } finally { if (original === undefined) { delete process.env.CLAUDECODE; } else { process.env.CLAUDECODE = original; } }
  - packages/audit-code/tests/providers-remediation.test.mjs:89 - const savedClaude = process.env.CLAUDECODE; delete process.env.CLAUDECODE; try { ... } finally { if (savedClaude === undefined) { delete process.env.CLAUDECODE; } else { process.env.CLAUDECODE = savedClaude; } }
  - packages/audit-code/tests/providers-remediation.test.mjs:134 - same pattern repeated a third time
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-001 — Repeated spawnSync env construction in postinstall tests

- Severity: low
- Confidence: high
- Lens: maintainability
- Files: packages/remediate-code/tests/postinstall.test.ts
- Summary: Six separate test cases in postinstall.test.ts each reconstruct the same `{ ...process.env, HOME: TEMP_HOME, USERPROFILE: TEMP_HOME }` env object inline rather than extracting it into a shared constant or helper, duplicating the setup pattern throughout the file.
- Evidence:
  - packages/remediate-code/tests/postinstall.test.ts:29 - `{ ...process.env, HOME: TEMP_HOME, USERPROFILE: TEMP_HOME }` repeated inline in spawnSync at lines 29, 39, 52, 67, 116, 117, 125, 135
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### DI-007 — repo_manifest.schema.json generated_at has no format constraint unlike other timestamp fields

- Severity: low
- Confidence: high
- Lens: data_integrity
- Files: packages/audit-code/schemas/repo_manifest.schema.json
- Summary: The generated_at field in repo_manifest.schema.json is typed as plain string with no format annotation. In contrast, dispatch_quota.schema.json applies format: date-time to cooldown_until, and the test helper actively validates date-time format strings. A repo manifest can be written with an arbitrary string for generated_at without schema rejection.
- Evidence:
  - packages/audit-code/schemas/repo_manifest.schema.json:20 - "generated_at": { "type": "string" } with no format constraint
  - packages/audit-code/schemas/dispatch_quota.schema.json:99 - cooldown_until uses format: date-time for comparable timestamp enforcement
  - packages/audit-code/tests/helpers/jsonSchemaAssert.mjs:273-320 - the test helper actively validates date-time format strings showing enforcement is feasible
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### SHD-003 — resolveWorkerTaskTimeoutMs edge cases (0, negative, NaN, Infinity) not tested

- Severity: low
- Confidence: high
- Lens: tests
- Files: packages/shared/src/providers/workerTaskLaunch.ts
- Summary: `resolveWorkerTaskTimeoutMs` in `workerTaskLaunch.ts` guards against non-positive and non-finite values but no test in the packet verifies that inputs of 0, -1, NaN, or Infinity all correctly fall back to the `fallbackMs`. The happy path is implicitly tested via provider tests, but the boundary guards are not exercised directly.
- Evidence:
  - packages/shared/src/providers/workerTaskLaunch.ts:19-24 - guards `Number.isFinite`, `> 0`, and `typeof === 'number'`; no dedicated test for these guards
  - packages/shared/src/providers/workerTaskLaunch.ts:26 - fallback `return fallbackMs` path untested for each invalid input type
  - runtime:unit:packages-shared: confirmed — Deterministic runtime command succeeded: npm test

### DI-006 — review_packets graphEdge requires confidence but graph_bundle edges treat it as optional

- Severity: low
- Confidence: high
- Lens: data_integrity
- Files: packages/audit-code/schemas/review_packets.schema.json, packages/audit-code/schemas/graph_bundle.schema.json
- Summary: The graphEdge $def in review_packets.schema.json lists confidence in its required array, making it mandatory for every key_edge in a packet. The equivalent edge objects in graph_bundle.schema.json treat confidence as an optional property. A graph edge written without confidence is valid at creation time but becomes invalid if promoted into a review packet's key_edges.
- Evidence:
  - packages/audit-code/schemas/review_packets.schema.json:33 - required: [from, to, confidence] — confidence is mandatory in review packet edges
  - packages/audit-code/schemas/graph_bundle.schema.json:18-23 - import edge: from and to are required; confidence listed in properties but not in required
  - packages/audit-code/schemas/graph_bundle.schema.json:47-52 - call edge: same pattern, confidence is optional
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### OPR-002 — run-mcp-server.mjs emits no startup confirmation

- Severity: low
- Confidence: high
- Lens: operability
- Files: packages/remediate-code/scripts/run-mcp-server.mjs
- Summary: The MCP server launcher spawns the subprocess without printing any startup message. Operators cannot confirm the server process was launched or distinguish a silent exit from normal operation.
- Evidence:
  - packages/remediate-code/scripts/run-mcp-server.mjs:10-16 - spawnSync invoked and process.exit called with no console.log before or after; if the child exits non-zero operators receive no explanation beyond the exit code.
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-003 — runBlockInWorktree rebase-failure fallback path untested

- Severity: low
- Confidence: high
- Lens: tests
- Files: packages/remediate-code/src/phases/implement.ts
- Summary: The worktree integration test skips all real implementation steps via not_applicable_steps, so it never exercises the mergeWorktreeBlock rebase-failure branch (rebase abort, sequentialFallbackQueue push) or the case where worktree creation fails and execution falls back to sequential immediately.
- Evidence:
  - packages/remediate-code/src/phases/implement.ts:493 - sequentialFallbackQueue.push on merge failure: not covered by any test
  - packages/remediate-code/src/phases/implement.ts:428 - worktree creation failure warning and ok:false return: not covered by any test
  - packages/remediate-code/src/phases/implement.ts:497 - rebase abort on failure branch: not covered by any test
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### SHD-002 — RunLogger non-serializable event path has no test coverage

- Severity: low
- Confidence: high
- Lens: tests
- Files: packages/shared/src/observability/runLog.ts
- Summary: The `RunLogger.event()` method catches JSON serialization failures at line 55-57 and logs a minimal marker. This fallback path for non-serializable payloads (circular references, BigInt values) has no test in the packet. The `now` injectable clock option is also untested.
- Evidence:
  - packages/shared/src/observability/runLog.ts:54-58 - catch block emitting fallback marker for non-serializable events; no test covers this branch
  - packages/shared/src/observability/runLog.ts:37 - injectable `now` option with no test using it
  - runtime:unit:packages-shared: confirmed — Deterministic runtime command succeeded: npm test

### OBS-003 — Runtime validation command discovery drops silently when no command found

- Severity: low
- Confidence: high
- Lens: observability
- Files: packages/audit-code/src/orchestrator/runtimeValidation.ts
- Summary: discoverRuntimeValidationCommand returns undefined when no test command is discoverable, causing buildRuntimeValidationTasks to return an empty task manifest. There is no log or diagnostic emitted to explain the absence, so operators have no visibility into why runtime validation was skipped.
- Evidence:
  - packages/audit-code/src/orchestrator/runtimeValidation.ts:33-34 - function returns discoverProjectCommands(root).test which may be undefined; buildRuntimeValidationTasks at line 41 short-circuits with { tasks: [] } if !params.command with no log emitted
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-001 — runWrapper and runWrapperJsonOutput share duplicated spawn/collect boilerplate

- Severity: low
- Confidence: high
- Lens: maintainability
- Files: packages/audit-code/tests/audit-code-wrapper.test.mjs, packages/audit-code/tests/audit-code-wrapper.test.mjs
- Summary: runWrapper (lines 29-58) and runWrapperJsonOutput (lines 60-126) are ~70-line near-identical spawn+collect functions differing only in the early-JSON-parse exit path. Any change to spawn options, environment stripping, or error handling must be applied in both places.
- Evidence:
  - packages/audit-code/tests/audit-code-wrapper.test.mjs:29 - runWrapper: spawn + env strip + stdout/stderr collect + exit handler
  - packages/audit-code/tests/audit-code-wrapper.test.mjs:60 - runWrapperJsonOutput: identical spawn setup, env strip, stdout/stderr collect; differs only in setTimeout + early JSON.parse settle logic
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### OBS-003 — runWrapperCommand subprocess captures stderr but never surfaces it on MCP server stderr

- Severity: low
- Confidence: high
- Lens: observability
- Files: packages/audit-code/src/mcp/server.ts
- Summary: runWrapperCommand accumulates the child process stderr in memory and returns it as part of CliExecutionResult, but the MCP server never writes that stderr to its own process.stderr. When a wrapped audit-code invocation fails, the diagnostic output from the child is only surfaced in the JSON-RPC error message (truncated to a single string), not forwarded as a stream for operator visibility.
- Evidence:
  - packages/audit-code/src/mcp/server.ts:185-198 - stdout/stderr accumulated but never forwarded to process.stderr
  - packages/audit-code/src/mcp/server.ts:210-212 - parseCliJson: combined = stdout.trim() || stderr.trim() — stderr visible only when JSON parse of stdout fails
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-009 — scheduleWave exports two overlapping token-estimate parameters with one marked deprecated

- Severity: low
- Confidence: high
- Lens: maintainability
- Files: packages/shared/src/quota/scheduler.ts
- Summary: ScheduleWaveOptions carries both estimatedSlotTokens (canonical per-slot array) and the deprecated estimatedPacketTokens (average scalar). Having two semantically overlapping fields on a public exported interface creates ambiguity for callers and the deprecated field cannot be removed without a breaking change.
- Evidence:
  - packages/shared/src/quota/scheduler.ts:32 - estimatedSlotTokens?: number[] — preferred per-slot array
  - packages/shared/src/quota/scheduler.ts:34 - @deprecated estimatedPacketTokens?: number — kept for backward compatibility
  - packages/shared/src/quota/scheduler.ts:63-65 - avgTokens computed from whichever is non-null/non-zero, silently merging two inputs
  - runtime:unit:packages-shared: confirmed — Deterministic runtime command succeeded: npm test

### REL-001 — schema-contracts.test.mjs: top-level await on dynamic imports creates all-or-nothing module load failure

- Severity: low
- Confidence: high
- Lens: reliability
- Files: packages/audit-code/tests/schema-contracts.test.mjs
- Summary: Lines 11-21 use top-level await to dynamically import from dist/. If any single import rejects (e.g., build artifact missing), the entire test module fails to load and all tests in it are silently skipped rather than reported as failures, making CI unreliable for detecting partial build breakage.
- Evidence:
  - packages/audit-code/tests/schema-contracts.test.mjs:11 - const { buildUnitManifest } = await import('../dist/orchestrator/unitBuilder.js');
  - packages/audit-code/tests/schema-contracts.test.mjs:12 - const { buildRiskRegister } = await import('../dist/extractors/risk.js');
  - packages/audit-code/tests/schema-contracts.test.mjs:13 - const { buildSurfaceManifest } = await import('../dist/extractors/surfaces.js');
  - packages/audit-code/tests/schema-contracts.test.mjs:14 - const { buildGraphBundle } = await import('../dist/extractors/graph.js');
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-001 — severityRank duplicated across mergeFindings and workBlocks

- Severity: low
- Confidence: high
- Lens: maintainability
- Files: packages/audit-code/src/reporting/mergeFindings.ts, packages/audit-code/src/reporting/workBlocks.ts
- Summary: The private severityRank function is defined independently in both mergeFindings.ts and workBlocks.ts with identical switch-case bodies. Any change to severity ordering or a new severity value must be made in both files.
- Evidence:
  - packages/audit-code/src/reporting/mergeFindings.ts:57 - function severityRank(severity: Finding["severity"]): number { switch(severity) { case "critical": return 5; case "high": return 4; ... } }
  - packages/audit-code/src/reporting/workBlocks.ts:11 - identical function severityRank with same switch body — both files define this independently
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### COR-002 — Shared lock path based on PID allows test interference under concurrent runs

- Severity: low
- Confidence: high
- Lens: correctness
- Files: packages/remediate-code/tests/quota-file-lock.test.ts
- Summary: quota-file-lock.test.ts constructs the test lock path using process.pid, meaning all tests in this file share one lock file path. If the test suite is run concurrently (e.g. multiple workers, CI matrix, or watch mode), two processes with the same PID race on the same lock file path, causing spurious failures or incorrect test behavior. The audit-code counterpart uses randomUUID() to avoid this.
- Evidence:
  - packages/remediate-code/tests/quota-file-lock.test.ts:12 - const TEST_LOCK = join(tmpdir(), `test-lock-${process.pid}.lock`) — uses PID, not a unique UUID per test run
  - packages/audit-code/tests/quota-file-lock.test.mjs:11 - function tmpLock() { return join(tmpdir(), `test-lock-${randomUUID()}.lock`); } — audit-code version uses randomUUID() per test call
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### OPR-005 — shared release-and-publish.mjs missing elapsed-time log on successful waitForRunCompletion

- Severity: low
- Confidence: high
- Lens: operability
- Files: packages/shared/scripts/release-and-publish.mjs
- Summary: waitForRunCompletion logs attempt count and elapsed ms on each poll but emits no completion log on success, so operators cannot easily compare expected vs actual publish run duration across releases.
- Evidence:
  - packages/shared/scripts/release-and-publish.mjs:196-208 - on successful completion (runEntry.status === 'completed') the function returns runEntry with no success log line; the remediate-code counterpart at line 239 does log elapsed time on success.
  - runtime:unit:packages-shared: confirmed — Deterministic runtime command succeeded: npm test

### OBS-001 — Silent parse failures in manifest extractors produce no log or metric

- Severity: low
- Confidence: high
- Lens: observability
- Files: packages/audit-code/src/extractors/graphManifestEdges.ts, packages/audit-code/src/extractors/graphManifestEdges.ts, packages/audit-code/src/extractors/graphManifestEdges.ts, packages/audit-code/src/extractors/graphManifestEdges.ts
- Summary: Multiple catch blocks in graphManifestEdges.ts silently discard parse failures (JSON, JSONC, and custom YAML/TOML parsers) with no log output, no metric increment, and no structured context. When a manifest file is malformed or unexpectedly shaped, the extractor returns an empty result and the caller has no visibility into why edges were dropped.
- Evidence:
  - packages/audit-code/src/extractors/graphManifestEdges.ts:70 - catch block in packageEntrypointCandidates returns [] with no log when JSON.parse fails
  - packages/audit-code/src/extractors/graphManifestEdges.ts:147 - catch block in packageScriptCandidates returns [] with no log when JSON.parse fails
  - packages/audit-code/src/extractors/graphManifestEdges.ts:246 - catch block in packageWorkspacePatterns returns [] with no log when JSON.parse fails
  - packages/audit-code/src/extractors/graphManifestEdges.ts:373 - catch block in parseJsoncObject returns undefined with no log when stripped JSONC fails to parse
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### OBS-002 — Silent scope degradation — dropped_note written to struct but never logged

- Severity: low
- Confidence: high
- Lens: observability
- Files: packages/audit-code/src/orchestrator/scope.ts
- Summary: resolveAuditScope silently downgrades delta-scope runs to full-audit runs when the git ref is missing or the repo root is absent. The reason is encoded in a dropped_note string on the returned manifest, but no log statement is emitted at the moment of degradation, making it invisible unless the caller inspects and surfaces the field.
- Evidence:
  - packages/audit-code/src/orchestrator/scope.ts:219-237 - three separate fallback branches each call fullAuditScope with a dropped_note string and return immediately; no console.warn or structured log is emitted at any of these decision points
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### OBS-001 — Silent swallowing of parse and load failures with no log output

- Severity: low
- Confidence: high
- Lens: observability
- Files: packages/audit-code/src/extractors/analyzers/css.ts, packages/audit-code/src/extractors/analyzers/html.ts, packages/audit-code/src/extractors/analyzers/python.ts, packages/audit-code/src/extractors/analyzers/treeSitter.ts
- Summary: Multiple analyzer files silently catch exceptions with empty catch blocks, discarding error context. In css.ts, html.ts, and python.ts, parse failures are swallowed without emitting any log entry; in treeSitter.ts the module-load, init, and grammar-load failures are similarly silent, so a broken tree-sitter installation produces no diagnostic output.
- Evidence:
  - packages/audit-code/src/extractors/analyzers/css.ts:103 - catch block is empty, parse failure for a CSS file produces no log output
  - packages/audit-code/src/extractors/analyzers/html.ts:94 - empty catch: parse failure for an HTML file discards error context
  - packages/audit-code/src/extractors/analyzers/python.ts:124 - empty catch after parser.parse(): Python file parse failure is silent
  - packages/audit-code/src/extractors/analyzers/treeSitter.ts:72 - each try/catch inside importParserModule silently skips specifiers with no log; when all fail the caller gets undefined with no indication of why
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### OBS-003 — Silent task budget truncation in selective deepening produces no diagnostic

- Severity: low
- Confidence: high
- Lens: observability
- Files: packages/audit-code/src/orchestrator/selectiveDeepening.ts
- Summary: When buildSelectiveDeepeningTasks reaches the effectiveMax budget it silently returns from pushIfNew without logging which tasks were dropped or how many. Operators and downstream consumers have no way to know the deepening budget was exhausted without reading artifacts directly.
- Evidence:
  - packages/audit-code/src/orchestrator/selectiveDeepening.ts:986-990 - function pushIfNew(task): void { if (created.length >= effectiveMax || existingIds.has(task.task_id)) { return; } ... } — silent return with no log or counter increment; callers (lines 1006, 1020, 1036, 1063, 1080, 1094) cannot distinguish budget-full from dedup-hit
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### OPR-003 — smoke-packaged-remediate-code.mjs omits elapsed time for slow npm steps

- Severity: low
- Confidence: high
- Lens: operability
- Files: packages/remediate-code/scripts/smoke-packaged-remediate-code.mjs
- Summary: The pack and install steps can each take tens of seconds but no elapsed time is reported on completion or failure, making it difficult to tell whether a timeout or network slowness is the cause of a failure.
- Evidence:
  - packages/remediate-code/scripts/smoke-packaged-remediate-code.mjs:92-111 - shared pack step prints 'packing @audit-tools/shared...' before but no elapsed time after completion.
  - packages/remediate-code/scripts/smoke-packaged-remediate-code.mjs:114-143 - pack step for remediate-code prints 'packing...' but no elapsed time on success or failure.
  - packages/remediate-code/scripts/smoke-packaged-remediate-code.mjs:158-167 - npm install step logs failure but not elapsed time, making root cause harder to distinguish.
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### OBS-101 — spawnLoggedCommand heartbeat telemetry only emits when onProgress is wired

- Severity: low
- Confidence: high
- Lens: observability
- Files: packages/shared/src/providers/spawnLoggedCommand.ts
- Summary: The heartbeat interval in spawnLoggedCommand emits a structured JSON line to stderr and calls onProgress only when input.onProgress is provided. Callers that omit onProgress receive heartbeat text to stderrLog but no structured telemetry, creating an inconsistent observability surface.
- Evidence:
  - packages/shared/src/providers/spawnLoggedCommand.ts:233-248 - structured process.stderr.write with type=provider_heartbeat and onProgress callback only executed inside if (input.onProgress) guard; auditor-side invocations get no structured heartbeat events
  - runtime:unit:packages-shared: confirmed — Deterministic runtime command succeeded: npm test

### MNT-005 — sql.ts analyze signature drops required parameters, diverging from LanguageAnalyzer interface

- Severity: low
- Confidence: high
- Lens: maintainability
- Files: packages/audit-code/src/extractors/analyzers/sql.ts
- Summary: The sql.ts `analyze` function is declared as `function analyze(): AnalyzerOutput` with no parameters, while the LanguageAnalyzer interface requires `analyze(files, context)`. TypeScript accepts this due to structural subtyping on functions, but the discrepancy makes the stub misleading and harder to promote to a real implementation later.
- Evidence:
  - packages/audit-code/src/extractors/analyzers/sql.ts:15 - `function analyze(): AnalyzerOutput {` — parameters omitted entirely
  - packages/audit-code/src/extractors/analyzers/types.ts:41 - LanguageAnalyzer interface requires `analyze(files: string[], context: AnalyzerContext): Promise<AnalyzerOutput> | AnalyzerOutput`
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### OBS-001 — Stale build lock cleanup is silent — no warning logged

- Severity: low
- Confidence: high
- Lens: observability
- Files: packages/audit-code/audit-code-wrapper-lib.mjs
- Summary: When acquireBuildLock detects a stale lock (older than BUILD_LOCK_MAX_AGE_MS), it silently unlinks it and retries. No warning is emitted, so operators cannot tell from logs that a stale lock was forcibly removed or that a peer build timed out.
- Evidence:
  - packages/audit-code/audit-code-wrapper-lib.mjs:231-232 - stale lock detected via mtimeMs comparison, then `await unlink(buildLockPath).catch(() => {})` proceeds silently with no console.warn or log entry
  - packages/audit-code/audit-code-wrapper-lib.mjs:213-215 - BUILD_LOCK_WAIT_TIMEOUT_MS expiry in waitForPeerBuild throws an Error but produces no log line before throwing, so no structured record of which PID held the lock or how long the wait lasted
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-005 — Stale JSDoc: file_split_threshold says Default 3000 but code default is 5000

- Severity: low
- Confidence: high
- Lens: maintainability
- Files: packages/audit-code/src/orchestrator/taskBuilder.ts, packages/audit-code/src/orchestrator/taskBuilder.ts
- Summary: The JSDoc for BuildChunkedTaskOptions.file_split_threshold states 'Default: 3000' but the actual default constant DEFAULT_FILE_SPLIT_THRESHOLD is 5000. Stale documentation will mislead callers tuning task budgets.
- Evidence:
  - packages/audit-code/src/orchestrator/taskBuilder.ts:26 - JSDoc comment says 'Default: 3000' for file_split_threshold
  - packages/audit-code/src/orchestrator/taskBuilder.ts:92 - const DEFAULT_FILE_SPLIT_THRESHOLD = 5000; — actual default is 5000, contradicting the doc
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### OBS-003 — Stale lock cleanup failure is silently swallowed

- Severity: low
- Confidence: high
- Lens: observability
- Files: packages/shared/src/quota/fileLock.ts
- Summary: In acquireLock(), when a stale lock is detected and unlink() fails, the error is caught and discarded without any log. This makes it impossible to distinguish expected races from unexpected filesystem failures during lock cleanup.
- Evidence:
  - packages/shared/src/quota/fileLock.ts:38-45 - catch block after unlink(lockPath) is empty with only a comment; no logging of the error or the stale lock path
  - runtime:unit:packages-shared: confirmed — Deterministic runtime command succeeded: npm test

### TST-001 — stale_installed_skill ensure refresh path has no test

- Severity: low
- Confidence: high
- Lens: tests
- Files: packages/audit-code/audit-code-wrapper-lib.mjs
- Summary: detectBootstrapRefreshReason returns stale_installed_skill when the installed skill diverges from the source skill, but no test in audit-code-wrapper.test.mjs exercises this code path. The analogous stale_installed_prompt path is tested.
- Evidence:
  - packages/audit-code/audit-code-wrapper-lib.mjs:2348 - reads installedSkill, compares with sourceSkill, returns stale_installed_skill when different
  - packages/audit-code/tests/audit-code-wrapper.test.mjs:884 - only stale_installed_prompt reason is asserted in the ensure refresh tests; stale_installed_skill is absent
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-002 — stale_mcp_launcher and missing_mcp_launcher ensure refresh paths have no test

- Severity: low
- Confidence: high
- Lens: tests
- Files: packages/audit-code/audit-code-wrapper-lib.mjs
- Summary: detectBootstrapRefreshReason checks for a stale or missing MCP launcher (lines 2407-2417) and returns stale_mcp_launcher or missing_mcp_launcher, but no existing test corrupts the launcher file to verify that ensure correctly detects and rebuilds it.
- Evidence:
  - packages/audit-code/audit-code-wrapper-lib.mjs:2407 - reads launcher, returns missing_mcp_launcher if null
  - packages/audit-code/audit-code-wrapper-lib.mjs:2413 - returns stale_mcp_launcher if launcher content is missing the executable resolution sentinel
  - packages/audit-code/tests/audit-code-wrapper.test.mjs:878-893 - ensure test only mutates the installed prompt; no test corrupts the MCP launcher
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-005 — Step name strings duplicated as bare literals rather than named constants

- Severity: low
- Confidence: high
- Lens: maintainability
- Files: packages/remediate-code/src/phases/implement.ts
- Summary: The step name strings 'Write Tests', 'Refactor Code', and 'Verify Code Against Documentation' appear as bare string literals both as lookup keys into itemSpec.not_applicable_steps and as stepName arguments to runStepWithProvider. A rename requires coordinated edits with no compile-time consistency guarantee.
- Evidence:
  - packages/remediate-code/src/phases/implement.ts:166 - 's.step === "Write Tests"' as skip lookup key
  - packages/remediate-code/src/phases/implement.ts:171 - '"Write Tests"' passed as stepName argument to runStepWithProvider
  - packages/remediate-code/src/phases/implement.ts:209 - 's.step === "Refactor Code"' as skip lookup key
  - packages/remediate-code/src/phases/implement.ts:244 - 's.step === "Verify Code Against Documentation"' as skip lookup key and step name
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-004 — steps.ts writeCurrentStep has no unit tests

- Severity: low
- Confidence: high
- Lens: tests
- Files: packages/audit-code/src/cli/steps.ts
- Summary: The writeCurrentStep function and the StepArtifact contract (STEP_CONTRACT_VERSION, all StepKind values) in steps.ts have no unit tests. There is no test that verifies the written current-step.json matches the StepArtifact interface or that the promptPath written to disk matches the prompt string.
- Evidence:
  - packages/audit-code/src/cli/steps.ts:61 - writeCurrentStep: no test file imports dist/cli/steps.js
  - packages/audit-code/src/cli/steps.ts:7 - STEP_CONTRACT_VERSION constant: never asserted in tests; a regression to the version string would go undetected
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-003 — subsystemRootForPath uses a hard-to-scan nested ternary to determine depth

- Severity: low
- Confidence: high
- Lens: maintainability
- Files: packages/audit-code/src/orchestrator/reviewPackets.ts
- Summary: The depth selection uses a multi-line nested ternary spanning five OR conditions, making the intent (a directory-depth table keyed by top-level namespace) difficult to parse at a glance.
- Evidence:
  - packages/audit-code/src/orchestrator/reviewPackets.ts:473 - depth computed via nested ternary over five namespace string comparisons; a small lookup object would be clearer
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### CD-004 — test-suite.yml has no branch filter — runs on every push and PR

- Severity: low
- Confidence: high
- Lens: config_deployment
- Files: packages/audit-code/.github/workflows/test-suite.yml
- Summary: The on.push and on.pull_request triggers have no branches: restriction, causing CI to run on all branches. While safe for a test workflow, it diverges from the remediate-code ci.yml which scopes to main and wastes runner minutes on ephemeral or draft branches.
- Evidence:
  - packages/audit-code/.github/workflows/test-suite.yml:4 - on.push: has no branches: key, matching every push ref across all branches
  - packages/audit-code/.github/workflows/test-suite.yml:5 - on.pull_request: has no branches: key, matching every PR regardless of target branch
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### REL-002 — test-suite.yml: unpinned Node 20 matrix entry allows silent version drift

- Severity: low
- Confidence: high
- Lens: reliability
- Files: packages/audit-code/.github/workflows/test-suite.yml
- Summary: The matrix node-version entry '"20"' (line 23) resolves to whatever the latest Node 20 patch is at run time. This can cause tests to pass or fail on an unexpected Node patch version, making the CI signal unreliable. The sibling entry uses the pinned exact version '"22.14.0"' showing that pinning is the project convention.
- Evidence:
  - packages/audit-code/.github/workflows/test-suite.yml:22 - matrix: node-version: - "20" - "22.14.0"
  - packages/audit-code/.github/workflows/test-suite.yml:23 - - "20"   # unpinned major, picks up any 20.x patch at run time
  - packages/audit-code/.github/workflows/test-suite.yml:24 - - "22.14.0"  # pinned exact version (project convention)
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-006 — testCommand.test.mjs missing edge case: package.json (no test script) + pyproject.toml

- Severity: low
- Confidence: high
- Lens: tests
- Files: packages/shared/tests/testCommand.test.mjs, packages/shared/src/tooling/testCommand.ts
- Summary: discoverProjectCommands has a code path where a Node project without a test script falls through to Python detection, but no test exercises co-existing package.json and pyproject.toml together to verify this fallthrough.
- Evidence:
  - packages/shared/tests/testCommand.test.mjs:71 - 'Node package.json without a test script still falls through to Go' covers package.json+go.mod but not package.json+pyproject.toml
  - packages/shared/src/tooling/testCommand.ts:88 - else if (existsSync(pyproject.toml) || existsSync(pytest.ini)) — Python fallthrough path is exercised by no test
  - runtime:flow:flow:surface:packages-shared-src-tooling-testCommand-ts: confirmed — Deterministic runtime command succeeded: npm test
  - runtime:flow:flow:surface:packages-shared-tests-testCommand-test-mjs: confirmed — Deterministic runtime command succeeded: npm test
  - runtime:unit:packages-shared: confirmed — Deterministic runtime command succeeded: npm test

### TST-004 — Tests of staleness.ts and providers/index.ts import stale dist/ rather than source

- Severity: low
- Confidence: high
- Lens: tests
- Files: packages/audit-code/src/orchestrator/staleness.ts, packages/audit-code/src/providers/index.ts, packages/audit-code/src/orchestrator/syntaxResolutionExecutor.ts
- Summary: The test files covering staleness.ts, state.ts, syntaxResolutionExecutor.ts, and providers/index.ts all import from ../dist/ (compiled output). If dist/ is stale after a source edit, tests silently exercise old code and can yield false positives.
- Evidence:
  - staleness.test.mjs imports computeStaleArtifacts, deriveAuditState, ARTIFACT_DEPENDENCY_MAP from ../dist/orchestrator/*.js
  - provider-auto-resolution.test.mjs imports resolveFreshSessionProviderName from ../dist/providers/index.js
  - syntax-resolution.test.mjs imports runSyntaxResolutionExecutor from ../dist/orchestrator/syntaxResolutionExecutor.js
  - field-trial-remediation.test.mjs uses importSourceModule (on-demand ts-node compilation) for the same modules — a safer pattern that does not share this fragility
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-006 — treeSitter cache reset seam is never called in tests

- Severity: low
- Confidence: high
- Lens: tests
- Files: packages/audit-code/src/extractors/analyzers/treeSitter.ts
- Summary: treeSitter.ts exports __resetTreeSitterForTests (line 167) specifically as a test seam to clear the module-level modulePromise, initPromise, and languageCache. However, no test file imports or calls this function, so tests that run multiple analyzer scenarios share stale caches and may mask failures if a later test would have triggered a different init path.
- Evidence:
  - packages/audit-code/src/extractors/analyzers/treeSitter.ts:167 - __resetTreeSitterForTests exported but never imported in any test file
  - packages/audit-code/tests/tree-sitter-analyzers.test.mjs:1 - imports python/html/css/sql analyzers and runs multiple tests without resetting the shared grammar cache between tests
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### OBS-004 — TypeScript analyzer symbol-resolution errors are silently ignored

- Severity: low
- Confidence: high
- Lens: observability
- Files: packages/audit-code/src/extractors/analyzers/typescript.ts
- Summary: In `resolveSymbolToIncluded`, the `getAliasedSymbol` call is wrapped in a try/catch that discards the error and falls back to the un-aliased symbol. Failures here degrade edge quality but are invisible to operators or callers.
- Evidence:
  - packages/audit-code/src/extractors/analyzers/typescript.ts:153-157 - `try { resolved = state.checker.getAliasedSymbol(resolved); } catch { /* Keep un-aliased symbol on failure */ }` — silent symbol alias resolution failure
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-001 — Unexplained magic score constants in selectLensVerificationFiles

- Severity: low
- Confidence: high
- Lens: maintainability
- Files: packages/audit-code/src/orchestrator/selectiveDeepening.ts
- Summary: selectLensVerificationFiles uses bare integer literals (6, 6, 4, 5, 8) as importance scores for tag-based path prioritization. Without named constants or comments, the relative weight rationale is opaque to future maintainers.
- Evidence:
  - packages/audit-code/src/orchestrator/selectiveDeepening.ts:651 - add(path, 6, 0); // critical_flow tag score — value undocumented
  - packages/audit-code/src/orchestrator/selectiveDeepening.ts:652 - add(path, 6, 0); // external_analyzer_signal tag score
  - packages/audit-code/src/orchestrator/selectiveDeepening.ts:653 - add(path, 4, 0); // large_file tag score
  - packages/audit-code/src/orchestrator/selectiveDeepening.ts:654 - add(path, 5, 0); // highRiskClean score
  - packages/audit-code/src/orchestrator/selectiveDeepening.ts:664 - add(path, 8, 0); // externalAnalyzerPaths bonus — highest weight but no explanation of why 8 > 6
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### OBS-001 — Unstructured stderr logging in syntax resolution executor lacks run context

- Severity: low
- Confidence: high
- Lens: observability
- Files: packages/audit-code/src/orchestrator/syntaxResolutionExecutor.ts, packages/audit-code/src/orchestrator/syntaxResolutionExecutor.ts
- Summary: Parse-error log messages in syntaxResolutionExecutor.ts (lines 123-125 and 226-228) emit plain text to process.stderr with no run ID, artifact directory, or invocation timestamp. When multiple concurrent audit runs exist or output is aggregated, these messages cannot be correlated to the originating run.
- Evidence:
  - packages/audit-code/src/orchestrator/syntaxResolutionExecutor.ts:123 - process.stderr.write(`[syntax-resolution] tsc output could not be parsed: ${outputSnippet}
`) — no run_id or artifact path in message
  - packages/audit-code/src/orchestrator/syntaxResolutionExecutor.ts:226 - process.stderr.write(`[syntax-resolution] eslint output could not be parsed: ${outputSnippet}
`) — same pattern; snippet is truncated to 500 chars so the full error context may be lost
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### OPR-004 — update-languages.mjs: no diff or change summary when regenerating language map

- Severity: low
- Confidence: high
- Lens: operability
- Files: packages/audit-code/scripts/update-languages.mjs
- Summary: update-languages.mjs is a code-generation script that overwrites languageMap.generated.ts unconditionally, but it only logs the count of extensions in the new map. It does not report how many entries changed, were added, or were removed compared to the previous file, nor does it report any extension conflicts resolved during generation. Operators running this script after a linguist-languages upgrade cannot tell from stdout whether anything actually changed.
- Evidence:
  - packages/audit-code/scripts/update-languages.mjs:63-64 - only one log line: 'Updated <path> with N language extensions.' There is no comparison against the prior file content, no count of additions/removals, and no report of conflict resolutions applied
  - packages/audit-code/scripts/update-languages.mjs:38-45 - conflict resolution logic silently picks the higher-priority language type; no logging for how many conflicts were encountered or resolved
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-004 — updateAuditTaskStatuses not directly tested

- Severity: low
- Confidence: high
- Lens: tests
- Files: packages/audit-code/src/orchestrator/resultIngestion.ts
- Summary: resultIngestion.ts exports both ingestAuditResults and updateAuditTaskStatuses but only the former is imported directly in tests. updateAuditTaskStatuses is exercised indirectly; the branch where a task has no matching result and status defaults to task.status ?? 'pending' is never explicitly asserted.
- Evidence:
  - packages/audit-code/src/orchestrator/resultIngestion.ts:28 - updateAuditTaskStatuses exported but not imported directly in any test
  - packages/audit-code/tests/orchestrator-remediation.test.mjs:23 - only ingestAuditResults is directly imported from resultIngestion.js; updateAuditTaskStatuses is only reachable via the executor wrapper
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-002 — URL/absolute-specifier guard duplicated verbatim in four resolver functions

- Severity: low
- Confidence: high
- Lens: maintainability
- Files: packages/audit-code/src/extractors/graphManifestEdges.ts, packages/audit-code/src/extractors/graphManifestEdges.ts, packages/audit-code/src/extractors/graphManifestEdges.ts, packages/audit-code/src/extractors/graphManifestEdges.ts
- Summary: The three-condition guard that rejects empty, absolute, or scheme-prefixed specifiers is copy-pasted into resolvePackageEntrypoint, resolveTypescriptProjectReference, resolveGoWorkspaceModuleReference, and resolveMavenModuleReference. A single named helper would make the intent clear and prevent future divergence.
- Evidence:
  - packages/audit-code/src/extractors/graphManifestEdges.ts:94 - resolvePackageEntrypoint: guard normalizedSpecifier.length === 0 || startsWith('/') || scheme regex
  - packages/audit-code/src/extractors/graphManifestEdges.ts:888 - resolveTypescriptProjectReference: identical guard block
  - packages/audit-code/src/extractors/graphManifestEdges.ts:1090 - resolveGoWorkspaceModuleReference: identical guard block
  - packages/audit-code/src/extractors/graphManifestEdges.ts:1183 - resolveMavenModuleReference: identical guard block
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### COR-001 — Vacuously-true guard in rate-limited cooldown branch

- Severity: low
- Confidence: high
- Lens: correctness
- Files: packages/shared/src/quota/state.ts
- Summary: In recordWaveOutcomeUnsafe, the condition `new429Count > 0` on line 178 is always true when outcome is "rate_limited" because new429Count is computed as prev429Count + 1 (where prev429Count >= 0), making it always >= 1. The guard provides no protection and could mislead future maintainers into thinking there is a meaningful branch.
- Evidence:
  - packages/shared/src/quota/state.ts:173 - const prev429Count = entry.consecutive_429_count ?? 0;
  - packages/shared/src/quota/state.ts:174 - const new429Count = outcome.outcome === "rate_limited" ? prev429Count + 1 : prev429Count;
  - packages/shared/src/quota/state.ts:178 - if (outcome.outcome === "rate_limited" && new429Count > 0) — new429Count is always >= 1 here because outcome is "rate_limited" triggers prev429Count+1
  - runtime:unit:packages-shared: confirmed — Deterministic runtime command succeeded: npm test

### MNT-005 — VALID_LENSES, VALID_SEVERITIES, VALID_CONFIDENCES locally re-defined instead of imported from shared

- Severity: low
- Confidence: high
- Lens: maintainability
- Files: packages/audit-code/src/validation/auditResults.ts
- Summary: auditResults.ts defines its own VALID_LENSES, VALID_SEVERITIES, and VALID_CONFIDENCES as local constant sets rather than importing from @audit-tools/shared. Adding or removing a lens or severity value requires editing this file in addition to any shared definition.
- Evidence:
  - packages/audit-code/src/validation/auditResults.ts:36 - const VALID_SEVERITIES = new Set(["critical", "high", "medium", "low", "info"]);
  - packages/audit-code/src/validation/auditResults.ts:37 - const VALID_CONFIDENCES = new Set(["high", "medium", "low"]);
  - packages/audit-code/src/validation/auditResults.ts:40-52 - const VALID_LENSES = new Set([...11 string literals...]); — defined locally despite @audit-tools/shared already being imported
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-003 — validateImplementWorkerResult error paths are not tested

- Severity: low
- Confidence: high
- Lens: tests
- Files: packages/remediate-code/src/steps/dispatch.ts
- Summary: The private validateImplementWorkerResult function in dispatch.ts validates five invariants (must be object, correct contract_version, phase=implement, item_results array, each item is an object with string finding_id and valid status). dispatch-reconciliation.test.ts covers the happy path and one wrong-contract-version case, but the remaining error branches (non-object root, phase mismatch, non-array item_results, per-item object check, invalid status value) have no test coverage. These branches would throw and surface as unhandled errors in mergeImplementResults.
- Evidence:
  - packages/remediate-code/src/steps/dispatch.ts:669 - validateImplementWorkerResult has five throw paths
  - packages/remediate-code/tests/dispatch-reconciliation.test.ts:259 - only the wrong contract_version branch is exercised (phase mismatch, non-array, per-item validation are untested)
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-003 — verify-install error reporting path not tested

- Severity: low
- Confidence: high
- Lens: tests
- Files: packages/audit-code/audit-code-wrapper-lib.mjs
- Summary: verifyInstalledBootstrap outputs issue_count > 0 and sets process.exitCode = 1 when assets are stale or missing, but only the all-ok happy path is tested. No test verifies that verify-install accurately reports failures, e.g. when the installed prompt is mutated between install and verify.
- Evidence:
  - packages/audit-code/audit-code-wrapper-lib.mjs:2250 - counts errors across generalChecks and hostResults, sets exitCode 1 when issueCount > 0
  - packages/audit-code/tests/audit-code-wrapper.test.mjs:1077 - only happy path tested: assert.equal(verifiedInstall.status, ok); assert.equal(verifiedInstall.issue_count, 0)
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### OBS-002 — waveScheduler quota read failure not logged as structured event

- Severity: low
- Confidence: high
- Lens: observability
- Files: packages/remediate-code/src/steps/waveScheduler.ts
- Summary: When readQuotaState() throws in scheduleWave, the error is silently caught with a comment. No structured log or diagnostic is emitted, so operators have no visibility into quota state read failures at runtime.
- Evidence:
  - packages/remediate-code/src/steps/waveScheduler.ts:95-101 - try/catch around readQuotaState() with empty catch body and comment; no log event or stderr output emitted on failure
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### DI-002 — worker_result implement variant uses a different discriminator pattern than other variants

- Severity: low
- Confidence: high
- Lens: data_integrity
- Files: packages/remediate-code/schemas/worker_result.schema.json
- Summary: The implement-phase variant of worker_result (lines 30-55) discriminates on 'contract_version'+'phase' while the other two variants discriminate on 'type'. Consumers must attempt all three branches since no single mandatory field unambiguously identifies the variant, increasing the risk of misinterpretation under partial data.
- Evidence:
  - packages/remediate-code/schemas/worker_result.schema.json:9 - first variant required=["type"], type=const 'item_spec'
  - packages/remediate-code/schemas/worker_result.schema.json:18 - second variant required=["type","clarifications"], type=const 'clarification_request'
  - packages/remediate-code/schemas/worker_result.schema.json:32 - third variant required=["contract_version","phase","item_results"] with no 'type' discriminator field
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-003 — Workspace pattern partition loop duplicated in extractWorkspacePackageEdges and extractCargoWorkspaceMemberEdges

- Severity: low
- Confidence: high
- Lens: maintainability
- Files: packages/audit-code/src/extractors/graphManifestEdges.ts, packages/audit-code/src/extractors/graphManifestEdges.ts
- Summary: The code that partitions raw workspace patterns into positivePatterns/negativePatterns and then applies them against pathLookup values is structurally identical in extractWorkspacePackageEdges (lines 763-804) and extractCargoWorkspaceMemberEdges (lines 822-863). The only difference is the manifest predicate and edge kind, both of which could be parameterized.
- Evidence:
  - packages/audit-code/src/extractors/graphManifestEdges.ts:763 - extractWorkspacePackageEdges: positivePatterns/negativePatterns partition then nested for-loop over pathLookup.values()
  - packages/audit-code/src/extractors/graphManifestEdges.ts:822 - extractCargoWorkspaceMemberEdges: identical partition and nested for-loop structure
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-002 — writeFixtureRepo near-duplicated across narrative and edge-reasoning test files

- Severity: low
- Confidence: high
- Lens: maintainability
- Files: packages/audit-code/tests/next-step-edge-reasoning.test.mjs, packages/audit-code/tests/next-step-narrative.test.mjs
- Summary: writeFixtureRepo in next-step-edge-reasoning.test.mjs and next-step-narrative.test.mjs write nearly identical fixture repos (same package.json, src/api/auth.ts, src/lib/session.ts). The narrative variant adds infra/deploy.yml. Both functions must be kept in sync when fixture file contents change.
- Evidence:
  - packages/audit-code/tests/next-step-edge-reasoning.test.mjs:57 - async function writeFixtureRepo(root) writes package.json, auth.ts, session.ts
  - packages/audit-code/tests/next-step-narrative.test.mjs:43 - async function writeFixtureRepo(root) writes same files plus infra/deploy.yml; a shared helper with optional extras would eliminate the duplication
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### DA-011 — 1 orphan unit(s) with no graph connections

- Severity: low
- Confidence: medium
- Lens: architecture
- Files: .vscode/mcp.json
- Summary: Units [-vscode] have no import, call, or reference edges in the dependency graph. They may be dead code, or the graph extraction missed their connections.

### OBS-004 — Artifact I/O has no logging — failures in loadArtifactBundle are opaque

- Severity: low
- Confidence: medium
- Lens: observability
- Files: packages/audit-code/src/io/artifacts.ts
- Summary: loadArtifactBundle iterates all artifact definitions and reads each file, but there is no logging of which artifacts were found, which were missing, or how long the load took. A missing or corrupt artifact is silently skipped (readOptionalJsonFile returns undefined). There is no observability hook to distinguish a fresh run from a partially corrupt artifact directory.
- Evidence:
  - packages/audit-code/src/io/artifacts.ts:215-221 - loop over ARTIFACT_ENTRIES with no log on missing/read artifacts; undefined silently omitted
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-006 — ARTIFACT_DEPENDENCY_MAP name inverts conventional dependency direction

- Severity: low
- Confidence: medium
- Lens: maintainability
- Files: packages/audit-code/src/orchestrator/dependencyMap.ts, packages/audit-code/src/orchestrator/artifactFreshness.ts
- Summary: ARTIFACT_DEPENDENCY_MAP maps an upstream artifact to the downstream artifacts it invalidates (an invalidation map), but the name suggests 'artifact depends on these'. buildReverseDependencyMap must then be called to recover the actual 'X depends on Y' direction used in computeArtifactMetadata. Naming the invalidation map 'dependency' and needing 'reverse' to get the actual dependency direction inverts conventional meaning for every reader.
- Evidence:
  - packages/audit-code/src/orchestrator/dependencyMap.ts:1 - map key is upstream artifact, value list is downstream artifacts it invalidates
  - packages/audit-code/src/orchestrator/artifactFreshness.ts:47 - buildReverseDependencyMap inverts this to get the actual depends-on direction
  - packages/audit-code/src/orchestrator/artifactMetadata.ts:13 - const REVERSE_DEPENDENCY_MAP = buildReverseDependencyMap() must invert at module load before use
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### COR-001 — Bridge edge map overwrites with last-found path instead of highest-confidence path

- Severity: low
- Confidence: medium
- Lens: correctness
- Files: packages/audit-code/src/orchestrator/reviewPackets.ts
- Summary: In buildEntrypointFlowBridgeEdges, the bridgeEdges map unconditionally overwrites on each new path (line 961). BFS discovers paths in FIFO order but confidence is the min of edge weights along the path, so a later-discovered path can overwrite a higher-confidence earlier path. The emitted bridge edge confidence is non-deterministic when multiple paths connect the same source/destination pair.
- Evidence:
  - packages/audit-code/src/orchestrator/reviewPackets.ts:961 - bridgeEdges.set(from+to+kind key, bridgeEdge) unconditionally overwrites any previously stored bridge edge for the same (from, to, kind) triple, regardless of whether the new path has higher or lower confidence than the prior one
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-006 — buildChunkedAuditTasks contains large closure-capturing inner functions

- Severity: low
- Confidence: medium
- Lens: maintainability
- Files: packages/audit-code/src/orchestrator/taskBuilder.ts
- Summary: buildChunkedAuditTasks defines chunkByTaskBudget (~35 lines) and addTaskBlock (~65 lines) as inner functions that close over outer locals. This makes the outer function ~240 lines with interleaved logic and tightly couples the helpers to the outer scope, hindering testability.
- Evidence:
  - packages/audit-code/src/orchestrator/taskBuilder.ts:187-222 - chunkByTaskBudget defined as inner function, closes over maxTaskLines and maxTaskFiles
  - packages/audit-code/src/orchestrator/taskBuilder.ts:224-289 - addTaskBlock defined as inner function closing over fileSplitThreshold, tasks, seen, unitLineIndex — 65 lines of logic inside an already large outer function
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### CD-003 — bumpOnly path creates a local git tag unexpectedly

- Severity: low
- Confidence: medium
- Lens: config_deployment
- Files: packages/shared/scripts/release-and-publish.mjs
- Summary: When --bump-only is passed, shared/scripts/release-and-publish.mjs calls bumpVersionAndTag() which unconditionally runs git tag -a. This creates a dangling local tag that can conflict with a subsequent full release run, and diverges from the remediate-code counterpart which deliberately avoids tagging in bump-only mode.
- Evidence:
  - packages/shared/scripts/release-and-publish.mjs:259 - bumpOnly branch calls bumpVersionAndTag(npm) which internally runs git tag -a at line 158
  - packages/shared/scripts/release-and-publish.mjs:158 - run(git, [tag, -a, tag, -m, tag]) executes unconditionally inside bumpVersionAndTag
  - runtime:unit:packages-shared: confirmed — Deterministic runtime command succeeded: npm test

### TST-004 — captureRunCli not safe for parallel test execution

- Severity: low
- Confidence: medium
- Lens: tests
- Files: packages/audit-code/tests/cli-remediation.test.mjs
- Summary: captureRunCli in cli-remediation.test.mjs monkey-patches console.log, console.error, and process.exitCode at the process level (lines 16-39). If any two tests that call captureRunCli run concurrently, their stdout/stderr captures and exit-code checks will bleed into each other, producing non-deterministic results. Node test runner may run sibling tests in parallel.
- Evidence:
  - packages/audit-code/tests/cli-remediation.test.mjs:23-29 - `process.exitCode = 0; console.log = ...; console.error = ...` are global mutations with no concurrency guard; multiple concurrent callers would share the same console references.
  - runtime:flow:flow:surface:packages-audit-code-tests-cli-remediation-test-mjs: confirmed — Deterministic runtime command succeeded: npm test
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### DI-004 — clarification_request options array permits empty array

- Severity: low
- Confidence: medium
- Lens: data_integrity
- Files: packages/remediate-code/schemas/clarification_request.schema.json
- Summary: The 'options' field in clarification_request.schema.json is optional but has no minItems constraint. An empty options array is schema-valid, making the options field meaningless for that request.
- Evidence:
  - packages/remediate-code/schemas/clarification_request.schema.json:23-25 - 'options': type=array, items=string, no minItems; empty array [] is valid per schema
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-002 — ClaudeCodeProvider env-mutation tests use fragile manual save/restore instead of isolation

- Severity: low
- Confidence: medium
- Lens: tests
- Files: packages/remediate-code/tests/providers.test.ts
- Summary: Two ClaudeCodeProvider tests (lines 353-405) manually save and restore `process.env.CLAUDECODE` via try/finally. If a test assertion throws before `finally`, the env state is restored; however this pattern is verbose and error-prone compared to using a `beforeEach`/`afterEach` setup or a vi.stubEnv mock, and any synchronous throw inside the `withProviderFiles` callback that bypasses the inner `finally` could leave the env dirty for subsequent tests.
- Evidence:
  - packages/remediate-code/tests/providers.test.ts:355-381 - manual `savedClaudeCode` save/restore around `withProviderFiles`; the outer finally restores but the inner async callback is not guarded by it
  - packages/remediate-code/tests/providers.test.ts:384-405 - same pattern repeated for the dangerously-skip-permissions variant
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### OBS-004 — cmdWorkerRun logs no in-progress status for long-running agent work

- Severity: low
- Confidence: medium
- Lens: observability
- Files: packages/audit-code/src/cli.ts
- Summary: cmdWorkerRun in src/cli.ts executes potentially long-running audit steps without emitting any progress indicator to stdout or stderr until the step completes. Operators monitoring a batch run have no visibility into whether a worker is actively executing or hung.
- Evidence:
  - packages/audit-code/src/cli.ts:431-466 - runAuditStep() is awaited directly; no progress log, heartbeat, or elapsed-time reporting before the result is written at line 466
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### OBS-004 — Deprecated probe.ts stub invoked without any log

- Severity: low
- Confidence: medium
- Lens: observability
- Files: packages/remediate-code/src/quota/probe.ts
- Summary: probeProvider() is marked @deprecated and always returns supported=false without emitting any log. Call sites cannot distinguish silent skip from an attempted probe, and callers get no deprecation warning at runtime.
- Evidence:
  - packages/remediate-code/src/quota/probe.ts:9 - JSDoc @deprecated tag present but no runtime console.warn/error emitted; function returns {supported:false} silently for all probeMode values
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### COR-003 — deriveBlocksFromTestGraph usefulness check inverted for single-finding case

- Severity: low
- Confidence: medium
- Lens: correctness
- Files: packages/remediate-code/src/phases/plan.ts
- Summary: deriveBlocksFromTestGraph returns useful=true when findings.length <= 1, even when the test-graph produced no grouping benefit (blocks.length === findings.length). This causes the test_graph block strategy to be unconditionally chosen for single-finding runs, bypassing git_cocommit and file_overlap heuristics that may produce better grouping if the single finding touches multiple files.
- Evidence:
  - packages/remediate-code/src/phases/plan.ts:217 - useful: blocks.length < findings.length || findings.length <= 1
  - packages/remediate-code/src/phases/plan.ts:449-455 - deriveFallbackBlocks returns early with test_graph result when testGraph.useful is true, skipping git_cocommit
  - packages/remediate-code/src/phases/plan.ts:217 - for findings.length === 1 and blocks.length === 1, the primary condition (1 < 1) is false but the secondary (1 <= 1) is true, forcing useful=true
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-006 — dispatch reconciliation tests do not cover clarification_request as a valid pre-existing result

- Severity: low
- Confidence: medium
- Lens: tests
- Files: packages/remediate-code/tests/dispatch-reconciliation.test.ts
- Summary: prepareDocumentDispatch reconciliation tests only treat type:item_spec files as valid existing results. A pre-existing type:clarification_request result is also a valid document response but is not tested to confirm it is correctly recognized as skippable rather than re-dispatched.
- Evidence:
  - packages/remediate-code/tests/dispatch-reconciliation.test.ts:109-119 - only item_spec results used in skips items with existing valid result files test
  - packages/remediate-code/tests/dispatch-reconciliation.test.ts:131-149 - re-dispatch test uses corrupt JSON, not a valid clarification_request result
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### OBS-001 — Dispatch warnings silently dropped when run proceeds without warning persistence

- Severity: low
- Confidence: medium
- Lens: observability
- Files: packages/audit-code/src/cli/dispatch.ts
- Summary: In prepareDispatchArtifacts, dispatch warnings (oversized_packet, large_packet, missing_lens_definition, etc.) are written to dispatch-warnings.json only when warnings.length > 0, but there is no mechanism to surface or log those warnings at runtime when the dispatch proceeds. The caller (renderSemanticReviewStep) is not shown the warnings path unless it reads the quota file, so warnings can be silently ignored by operators.
- Evidence:
  - packages/audit-code/src/cli/dispatch.ts:709 - warningsPath is conditionally set, but warnings are written to a file without any stderr/stdout signal
  - packages/audit-code/src/cli/dispatch.ts:724 - return value includes dispatch_warnings_path but calling code may not surface this to the operator
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-006 — Exported const arrays in types/ have no runtime smoke tests

- Severity: low
- Confidence: medium
- Lens: tests
- Files: packages/shared/src/types/flows.ts, packages/shared/src/types/surfaces.ts, packages/shared/src/types/runLedger.ts, packages/shared/src/types/sessionConfig.ts
- Summary: The types/ files export const arrays (FLOW_CONFIDENCE_LEVELS, SURFACE_KINDS, PROVIDER_NAMES, RUN_LEDGER_STATUSES, SESSION_UI_MODES, ANALYZER_SETTINGS) that are used as runtime validation sets. No smoke tests verify these arrays contain expected members, leaving silent regressions possible if values are renamed or removed.
- Evidence:
  - packages/shared/src/types/flows.ts:1 - FLOW_CONFIDENCE_LEVELS const array exported; no test checks it contains ["high","low"]
  - packages/shared/src/types/surfaces.ts:1 - SURFACE_KINDS const array exported; no test
  - packages/shared/src/types/runLedger.ts:1-6 - RUN_LEDGER_STATUSES const array exported; no test
  - packages/shared/src/types/sessionConfig.ts:1-8 - PROVIDER_NAMES, SESSION_UI_MODES, ANALYZER_SETTINGS const arrays exported; no test
  - runtime:unit:packages-shared: confirmed — Deterministic runtime command succeeded: npm test

### MNT-006 — flowRequeue.ts throws on invalid lens values, inconsistent with filter-based guards elsewhere

- Severity: low
- Confidence: medium
- Lens: maintainability
- Files: packages/audit-code/src/orchestrator/flowRequeue.ts
- Summary: buildFlowRequeueTasks throws a hard Error when an unsupported lens value appears in required_lenses (line 103-106). All peer modules use filter-based defensive guards that silently drop unknown values. This inconsistency means callers receive different behavior depending on which requeue path is taken.
- Evidence:
  - packages/audit-code/src/orchestrator/flowRequeue.ts:102-107 - throws Error for unsupported lens in required_lenses
  - packages/audit-code/src/orchestrator/flowCoverage.ts:8-19 - lensSetForFlow silently filters unsupported concerns via Array.filter
  - packages/audit-code/src/orchestrator/flowPlanning.ts:38-42 - desiredLenses uses .filter to silently drop unsupported concerns
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-002 — Fragile phase-close test: triage-transition check mutates the input state object

- Severity: low
- Confidence: medium
- Lens: tests
- Files: packages/remediate-code/tests/phase-close.test.ts
- Summary: The test transitions to triage when test_command fails (phase-close.test.ts, line 75) asserts next.status === triage but then checks state.items!.F1.status === blocked on the original input state object. This relies on runClosePhase mutating its input argument by reference, which is an implicit and fragile contract that could silently pass even if the mutation mechanism changes.
- Evidence:
  - packages/remediate-code/tests/phase-close.test.ts:75 - it(transitions to triage when test_command fails)
  - packages/remediate-code/tests/phase-close.test.ts:91 - expect(next.status).toBe(triage) - checks returned state
  - packages/remediate-code/tests/phase-close.test.ts:92 - expect(state.items!.F1.status).toBe(blocked) - checks original input object mutation
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-005 — Gemini command content parity not asserted and ensure staleness not tested for it

- Severity: low
- Confidence: medium
- Lens: tests
- Files: packages/audit-code/.gemini/commands/audit-code.toml, packages/audit-code/audit-code-wrapper-lib.mjs
- Summary: The Antigravity test case only checks that geminiCommandPath appears in guidance supporting_paths; it does not verify the file content matches the source prompt body. Additionally, detectBootstrapRefreshReason has no case for a stale Gemini TOML, so if the source prompt changes the installed .gemini/commands/audit-code.toml will silently drift until a full reinstall. This is inconsistent with the VS Code prompt body sync check.
- Evidence:
  - packages/audit-code/audit-code-wrapper-lib.mjs:2391 - antigravity case in detectBootstrapRefreshReason checks expectedSkillPath and its content parity, but has no check for the gemini command TOML body parity
  - packages/audit-code/audit-code-wrapper-lib.mjs:2382 - vscode case returns stale_host_asset:vscode:prompt when body differs, giving VS Code prompt drift detection
  - packages/audit-code/tests/audit-code-wrapper.test.mjs:1004 - Antigravity assertHost only checks guidance paths, not file content
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-003 — git_cocommit block-grouping tests do not cover git command failure fallback

- Severity: low
- Confidence: medium
- Lens: tests
- Files: packages/remediate-code/tests/phase-plan.test.ts
- Summary: The git_cocommit strategy tests (lines 268-321) inject a mock `runCommand` that always returns status 0. There is no test covering what happens when `runCommand` returns a non-zero status, where the expectation should be a graceful fallback to per-finding individual blocks rather than an error throw.
- Evidence:
  - packages/remediate-code/tests/phase-plan.test.ts:287 - `runCommand: () => ({ status: 0, stdout: '...' })` — only the success path is mocked
  - packages/remediate-code/tests/phase-plan.test.ts:314 - second git_cocommit test also always passes status: 0
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-005 — graphSuites.ts individual extractor functions lack direct unit tests

- Severity: low
- Confidence: medium
- Lens: tests
- Files: packages/audit-code/src/extractors/graphSuites.ts
- Summary: extractJsonSchemaReferenceEdges, extractSchemaContractTestEdges, and extractBoundedSuiteEdges are only exercised transitively through buildGraphBundle integration tests. Edge cases such as a fragment-only $ref (e.g. #/definitions/foo producing no edge), a basename collision across directories, or a suite exactly at MAX_BOUNDED_SUITE_EDGE_FILES are not directly asserted.
- Evidence:
  - packages/audit-code/src/extractors/graphSuites.ts:67 - resolveJsonSchemaRef returns undefined for empty targetSpecifier (fragment-only ref), tested only indirectly
  - packages/audit-code/src/extractors/graphSuites.ts:151 - literalBasenames.size > MAX_BOUNDED_SUITE_EDGE_FILES early return never explicitly asserted in tests
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-004 — Hardcoded Codex Desktop concurrency magic constant `6` in wave-scheduler test

- Severity: low
- Confidence: medium
- Lens: maintainability
- Files: packages/remediate-code/tests/wave-scheduler.test.ts
- Summary: The test at wave-scheduler.test.ts:32 asserts `result.active_subagents === 6` using a bare numeric literal that mirrors a hardcoded implementation constant, making the relationship between test expectation and implementation silent and easy to break.
- Evidence:
  - packages/remediate-code/tests/wave-scheduler.test.ts:32 - `expect(result!.active_subagents).toBe(6)` — magic literal 6 for Codex Desktop hardcoded limit, not imported from or linked to the source constant
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### CD-002 — Hardcoded node executable path baked into installed MCP launcher at postinstall time

- Severity: low
- Confidence: medium
- Lens: config_deployment
- Files: packages/audit-code/scripts/postinstall.mjs
- Summary: postinstall.mjs embeds process.execPath (the absolute path to the node binary at install time) into the generated global MCP launcher script. If the Node.js binary moves after a version upgrade, the installed launcher silently uses the stale path until the package is reinstalled.
- Evidence:
  - packages/audit-code/scripts/postinstall.mjs:287 - const nodeExecPath = replaceBackslashes(process.execPath); -- absolute path captured at install time
  - packages/audit-code/scripts/postinstall.mjs:306 - command: [nodeExecPath, pkgEntrypoint, mcp] -- baked into opencode MCP config at install time
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-005 — Individual test functions in phase-plan.test.ts lack explicit timeout overrides for long-running cleanup

- Severity: low
- Confidence: medium
- Lens: tests
- Files: packages/remediate-code/tests/phase-plan.test.ts
- Summary: The beforeEach/afterEach hooks specify a 60,000ms timeout, but the test functions themselves rely on Vitest's default timeout (5 seconds). The byte-split test at line 323 performs real file I/O (writing two 50KB files) and calls `runPlanPhase` twice; under slow disk or contention this could silently exceed 5 seconds. Only the cleanup hooks have explicit timeouts.
- Evidence:
  - packages/remediate-code/tests/phase-plan.test.ts:88-96 - beforeEach/afterEach have 60_000 timeout, but test bodies at e.g. line 323 have none
  - packages/remediate-code/tests/phase-plan.test.ts:355-363 - two 50KB file writes + two runPlanPhase calls with no test-level timeout
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-006 — Inline prompt string in document phase mixes logic, formatting, and data

- Severity: low
- Confidence: medium
- Lens: maintainability
- Files: packages/remediate-code/src/phases/document.ts
- Summary: The worker prompt for each finding is assembled inline inside the per-finding loop in runDocumentPhase using template literals with embedded conditionals. This couples prompt wording to orchestration logic and makes prompt changes require understanding the full loop.
- Evidence:
  - packages/remediate-code/src/phases/document.ts:184-210 - const promptContent assembled inline over 27 lines with conditional interpolation of extraContext, themeHint, and repoConventions inside the per-finding loop
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### OBS-004 — installToCache npm install failure produces no log

- Severity: low
- Confidence: medium
- Lens: observability
- Files: packages/shared/src/tooling/analyzerDeps.ts
- Summary: installToCache() returns a structured result on failure but never emits any log. A failed npm install is surfaced only to the immediate caller; if the caller silently falls back to 'absent', there is no observable record of the installation failure.
- Evidence:
  - packages/shared/src/tooling/analyzerDeps.ts:158-175 - on npm install failure (status !== 0) or post-install verification failure, returns {ok: false, error: ...} with no process.stderr.write or equivalent
  - runtime:unit:packages-shared: confirmed — Deterministic runtime command succeeded: npm test

### MNT-005 — Inverted updateDispatch guard in writeWorkerTaskFiles obscures intent

- Severity: low
- Confidence: medium
- Lens: maintainability
- Files: packages/audit-code/src/io/runArtifacts.ts
- Summary: In writeWorkerTaskFiles (runArtifacts.ts line 191), the guard 'if (options.updateDispatch === false)' writes schema files and returns early. This reads as the skip-dispatch-update branch yet still performs side-effects before returning. The inverted boolean and the work inside the skip branch make the intent unclear without careful reading.
- Evidence:
  - packages/audit-code/src/io/runArtifacts.ts:191 - if (options.updateDispatch === false) { await writeDispatchSchemaFiles(artifactsDir); return; } — schema files are written even in the skip-update branch
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-005 — jsonSchemaAssert helper has no self-tests for URL-relative $ref resolution or combiner error paths

- Severity: low
- Confidence: medium
- Lens: tests
- Files: packages/audit-code/tests/helpers/jsonSchemaAssert.mjs
- Summary: The helper module `jsonSchemaAssert.mjs` exports `assertMatchesJsonSchema` with URL-relative `$ref` resolution (lines 78-87) and `oneOf`/`anyOf` combiner logic, but no tests in this packet exercise those paths directly; failures in `resolveExternalDocument` URL logic or combiner edge cases would only be caught indirectly through boundary-file schema-contract tests.
- Evidence:
  - packages/audit-code/tests/helpers/jsonSchemaAssert.mjs:78-87 - URL-relative ref resolution branch (`new URL(ref, context.baseId)`) has no direct test coverage in the packet files
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-003 — Large inline fixture-setup block obscures test intent in provider-assisted-continuation

- Severity: low
- Confidence: medium
- Lens: maintainability
- Files: packages/audit-code/tests/provider-assisted-continuation.test.mjs
- Summary: The withTempRepo helper (lines 55-107) in provider-assisted-continuation.test.mjs contains 52 lines of filesystem scaffolding that makes it hard to see what the actual test scenario is. Extracting the fixture files into helper constants or a shared fixture builder would bring the signal-to-noise ratio back in line with the other test files.
- Evidence:
  - packages/audit-code/tests/provider-assisted-continuation.test.mjs:59 - await mkdir(join(root, 'src', 'api'), { recursive: true }); ... (followed by three separate writeFile calls each with inline multi-line string content, totalling ~40 lines of fixture data)
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-003 — Large MCP integration tests have no per-test timeout guard

- Severity: low
- Confidence: medium
- Lens: tests
- Files: packages/audit-code/tests/mcp-server.test.mjs, packages/audit-code/tests/mcp-server.test.mjs
- Summary: The main MCP integration test (line 214) and the resource/prompt lifecycle tests spin up real child processes via createMcpClient. If client.close() hangs (e.g., the child never exits), the test suite blocks indefinitely — Node test runner has no default timeout and none is set per-test.
- Evidence:
  - packages/audit-code/tests/mcp-server.test.mjs:102 - client.close() awaits child exit with no timeout: `await new Promise((resolve) => child.on("exit", resolve))`
  - packages/audit-code/tests/mcp-server.test.mjs:214 - integration test body has no test({ timeout: ... }) option — relies solely on the 5 s readFramedPayload guard, which does not protect the close() path
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-005 — lens_verification followup cross-lens filter has no test

- Severity: low
- Confidence: medium
- Lens: tests
- Files: packages/audit-code/src/orchestrator/selectiveDeepening.ts
- Summary: The guard in buildVerificationFollowupTasks that silently drops followup task suggestions whose lens differs from the verification result lens has no test exercising the rejection case.
- Evidence:
  - packages/audit-code/src/orchestrator/selectiveDeepening.ts:856 — if (suggestion.lens !== params.result.lens) { continue; } silently discards cross-lens suggestions
  - Existing steward followup test (orchestrator-remediation.test.mjs ~line 497) only provides matching-lens suggestions; cross-lens rejection branch is not covered
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-003 — line_budget_split tag absence on non-split tasks is never tested

- Severity: low
- Confidence: medium
- Lens: tests
- Files: packages/audit-code/tests/field-trial-remediation.test.mjs
- Summary: There is no test asserting that when files fit within a single chunk (no split occurs), the `tags` array does not contain `line_budget_split`. A regression introducing spurious tags would be undetected.
- Evidence:
  - packages/audit-code/tests/field-trial-remediation.test.mjs:504-522 - asserts presence of line_budget_split tag on split chunks, but no companion test asserts its absence when splitting does not occur
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### OBS-003 — MCP probe stderr captured but not surfaced on success

- Severity: low
- Confidence: medium
- Lens: observability
- Files: packages/audit-code/audit-code-wrapper-lib.mjs
- Summary: probeMcpServer captures the child process stderr and includes it in the returned result object, but callers (collectVerifyCheck blocks) never log or expose it on a successful probe. Any startup warnings printed by the MCP server are silently discarded on the happy path.
- Evidence:
  - packages/audit-code/audit-code-wrapper-lib.mjs:1992-1994 - `stderr: client.readStderr()` is included in the resolved result object on success
  - packages/audit-code/audit-code-wrapper-lib.mjs:2194-2211 - shared_launcher_mcp verify check destructures only `probe.tools`, `probe.initialize`, and `probe.resources`; `probe.stderr` is never checked or logged, so MCP startup warnings are invisible on a clean run
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-004 — Missing test for info/low-confidence boundary in buildDocumentModelHint

- Severity: low
- Confidence: medium
- Lens: tests
- Files: packages/remediate-code/tests/model-hints.test.ts
- Summary: model-hints.test.ts tests info severity with high confidence (expects small tier) and low severity with low confidence (expects standard tier), but does not test info severity with low confidence. This boundary case is unverified - it is unclear whether the implementation returns small or standard for this combination.
- Evidence:
  - packages/remediate-code/tests/model-hints.test.ts:103 - it(returns small for info severity + high confidence) - only info+high is tested
  - packages/remediate-code/tests/model-hints.test.ts:118 - it(returns standard for low severity + low confidence) - low+low is tested but not info+low
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### COR-003 — Module-level mutable `nextFindingId` counter is reset inside a public function, causing ID collisions on concurrent invocations

- Severity: low
- Confidence: medium
- Lens: correctness
- Files: packages/audit-code/src/extractors/designAssessment.ts
- Summary: The module-level `nextFindingId` counter in `designAssessment.ts` is reset to 1 at the start of every `buildDesignAssessment` call. If `buildDesignAssessment` were called more than once per process lifetime (e.g., in tests or if the module is reused across audit runs), IDs produced by sub-functions across calls would restart from DA-001, making finding IDs non-unique across invocations.
- Evidence:
  - packages/audit-code/src/extractors/designAssessment.ts:5 - `let nextFindingId = 1;` - module-level mutable counter
  - packages/audit-code/src/extractors/designAssessment.ts:289 - `nextFindingId = 1;` inside `buildDesignAssessment` - resets the shared counter on each call, not just on first use
  - packages/audit-code/src/extractors/designAssessment.ts:7 - `function findingId(): string { return 'DA-' + ... }` - all sub-detection functions share this counter
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-005 — No negative test for fsIntake cyclic symlink termination

- Severity: low
- Confidence: medium
- Lens: tests
- Files: packages/audit-code/src/extractors/fsIntake.ts
- Summary: The fsIntake walk() function does not guard against cyclic symlinks. The existing test in extractors-remediation.test.mjs verifies that a symlink is either followed or skipped (non-file), but there is no test asserting that a circular symlink (symlink pointing to a parent directory) does not cause infinite recursion.
- Evidence:
  - packages/audit-code/src/extractors/fsIntake.ts:72 - entry.isDirectory() branch recurses into walk() with no cycle detection
  - packages/audit-code/tests/extractors-remediation.test.mjs:168 - symlink test only verifies correct inclusion/exclusion, not cycle protection
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-003 — No test for submit-packet base64 flag variants used in production

- Severity: low
- Confidence: medium
- Lens: tests
- Files: packages/audit-code/tests/audit-code-wrapper.test.mjs
- Summary: All submit-packet tests in audit-code-wrapper.test.mjs use the plain --run-id/--packet-id/--artifacts-dir flags, but the audit system generates packet prompt files that use --run-id-b64/--packet-id-b64/--artifacts-dir-b64 (base64-encoded) variants. The b64 decode path in the CLI is never exercised by the test suite.
- Evidence:
  - packages/audit-code/tests/audit-code-wrapper.test.mjs:514-518 - submit-packet calls in all three rejection tests pass --run-id, --packet-id, --artifacts-dir; the packet prompt template (as seen from the packet prompt read in this session) uses --run-id-b64/--packet-id-b64/--artifacts-dir-b64 flags instead.
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-003 — normalizeCoverageSummary missing edge-case test for high-severity result without branches_pct

- Severity: low
- Confidence: medium
- Lens: tests
- Files: packages/audit-code/src/adapters/coverageSummary.ts
- Summary: The summary formatting branch in normalizeCoverageSummary for a high-severity file (lines_pct < 50) that lacks branches_pct is not exercised in any test. The existing test only exercises the high-severity path with branches_pct present.
- Evidence:
  - packages/audit-code/src/adapters/coverageSummary.ts:22 - typeof file.branches_pct === "number" conditional: the high-severity path (lines_pct < 50) without branches_pct is never tested; only the medium-severity-without-branches_pct and high-severity-with-branches_pct paths are covered
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### COR-001 — Oversized-packet warning uses raw context budget without safety margin

- Severity: low
- Confidence: medium
- Lens: correctness
- Files: packages/audit-code/src/cli/dispatch.ts
- Summary: The oversized-packet warning at line 694 computes `contextBudget = resolved_limits.context_tokens - resolved_limits.output_tokens` without applying `BLOCK_SAFETY_MARGIN` (0.7), so the effective threshold is ~43% higher than the budget actually enforced by `resolveContextBudget`. Packets between the unscaled and scaled budgets will silently pass the warning check but still fail at runtime.
- Evidence:
  - packages/audit-code/src/cli/dispatch.ts:694 - `const contextBudget = waveSchedule.resolved_limits.context_tokens - waveSchedule.resolved_limits.output_tokens;` — safety margin not applied here
  - packages/shared/src/tokens.ts:76 - `resolveContextBudget` multiplies by `margin` (defaults to BLOCK_SAFETY_MARGIN = 0.7) before returning — the actual enforced budget is 30% smaller than what the warning check uses
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-003 — postinstall side-effect tests discard spawnSync result before asserting files

- Severity: low
- Confidence: medium
- Lens: tests
- Files: packages/remediate-code/tests/postinstall.test.ts
- Summary: The tests that check installed file contents call spawnSync but ignore result.status and result.stderr. A silent failure in the postinstall script would go undetected while the subsequent file-content assertion could still pass on a previously-installed file.
- Evidence:
  - packages/remediate-code/tests/postinstall.test.ts:36 - spawnSync result is discarded before checking existsSync; no assertion on result.status
  - packages/remediate-code/tests/postinstall.test.ts:49 - spawnSync result discarded; file-content check could pass from a prior run
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### OPR-004 — postinstall.mjs provides no elapsed-time or progress reporting

- Severity: low
- Confidence: medium
- Lens: operability
- Files: packages/remediate-code/scripts/postinstall.mjs
- Summary: postinstall.mjs performs multiple file-system installs and JSON merges but emits only one-line success/warning messages with no timing information. For installs on slow or network-mounted file systems this makes troubleshooting harder.
- Evidence:
  - packages/remediate-code/scripts/postinstall.mjs:223-237 - for-of loop over installs calls writeGeneratedFile and logs action but no timing.
  - packages/remediate-code/scripts/postinstall.mjs:246-257 - installMergedJson for OpenCode config logs action string but no elapsed time.
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-001 — prefixValidationIssues has opaque multi-branch deduplication logic

- Severity: low
- Confidence: medium
- Lens: maintainability
- Files: packages/shared/src/validation/basic.ts
- Summary: The ternary inside prefixValidationIssues (lines 46-51) encodes three path cases—empty, already-prefixed, and plain—without a named helper or comment explaining each branch. Readers must trace the conditions to understand the deduplication invariant.
- Evidence:
  - packages/shared/src/validation/basic.ts:46-51 - nested ternary with three path conditions (empty, already-prefixed via startsWith, and fallback) with no explanatory comment
  - runtime:unit:packages-shared: confirmed — Deterministic runtime command succeeded: npm test

### OBS-004 — Provider auto-detection fallback warning is unstructured and emitted only once

- Severity: low
- Confidence: medium
- Lens: observability
- Files: packages/audit-code/src/providers/index.ts
- Summary: When provider resolution falls back to local-subprocess (index.ts lines 117-121), the warning is a one-shot plain string with no timestamp or resolved provider chain. There is no logging of which providers were probed and found absent, making it difficult to diagnose auto-detection failures without source-level knowledge.
- Evidence:
  - packages/audit-code/src/providers/index.ts:117-121 - process.stderr.write("audit-code: auto provider resolved to local-subprocess — no capable agent provider detected. ...") — no indication of which commands were tested (claude, opencode), their PATH resolution status, or the session-config provider field value
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-003 — provider-assisted-continuation parallel test does not assert task-level coverage

- Severity: low
- Confidence: medium
- Lens: tests
- Files: packages/audit-code/tests/provider-assisted-continuation.test.mjs
- Summary: The parallel workers test uses --max-runs 1 but only checks ledger.runs.length >= 1 and that each entry has a valid result file. It does not assert run_id uniqueness or that any tasks were actually included, so a run that wrote an empty task list would still pass.
- Evidence:
  - packages/audit-code/tests/provider-assisted-continuation.test.mjs:175 - assert.ok(ledger.runs.length >= 1) satisfied even if ledger has no task-level entries
  - packages/audit-code/tests/provider-assisted-continuation.test.mjs:177-180 - checks result_path content but not task coverage count
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### OBS-005 — Quota scheduler wave decisions emit no operational log

- Severity: low
- Confidence: medium
- Lens: observability
- Files: packages/shared/src/quota/scheduler.ts
- Summary: scheduleWave() applies multiple caps (RPM, TPM, cooldown, ramp-up, host concurrency) and returns a WaveSchedule, but emits no log of the final wave_size, which cap was binding, or why. Diagnosing unexpectedly conservative or liberal scheduling requires re-deriving the decision from scratch.
- Evidence:
  - packages/shared/src/quota/scheduler.ts:46-211 - no process.stderr.write, console.log, or structured log emitted anywhere in scheduleWave(); the returned WaveSchedule.source and .confidence fields carry provenance but are not emitted to any observable channel
  - runtime:unit:packages-shared: confirmed — Deterministic runtime command succeeded: npm test

### OBS-002 — Quota source snapshot failures silently ignored, reducing quota observability

- Severity: low
- Confidence: medium
- Lens: observability
- Files: packages/audit-code/src/cli/dispatch.ts
- Summary: In prepareDispatchArtifacts, quotaSourceSnapshot and related quota query failures are caught with .catch(() => null), meaning any errors querying current quota usage are silently swallowed. No warning or log entry is emitted when quota state cannot be read, which could mask persistent quota-system failures.
- Evidence:
  - packages/audit-code/src/cli/dispatch.ts:649 - quotaState read failure caught and returns hardcoded empty object with no log
  - packages/audit-code/src/cli/dispatch.ts:660 - lookupDiscoveredLimits failure silently returns null without stderr message
  - packages/audit-code/src/cli/dispatch.ts:664 - quotaSource.queryCurrentUsage failure silently returns null
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-002 — quota-file-lock timing test has a fragile 100ms lower-bound assertion

- Severity: low
- Confidence: medium
- Lens: tests
- Files: packages/audit-code/tests/quota-file-lock.test.mjs
- Summary: The test acquireLock blocks when lock is held releases the lock after 150ms and then asserts elapsed >= 100ms. On heavily loaded CI runners the setTimeout(150) callback can fire late, making the 50ms margin between release and assertion tight, and there is no upper-bound guard.
- Evidence:
  - packages/audit-code/tests/quota-file-lock.test.mjs:29-37 - setTimeout releases lock after 150ms; assertion checks elapsed >= 100ms with no upper bound; on slow CI the margin can be squeezed
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-008 — recordWaveOutcomeUnsafe applies failure weight over concurrency+4 buckets with no named constant

- Severity: low
- Confidence: medium
- Lens: maintainability
- Files: packages/shared/src/quota/state.ts
- Summary: In the failure branch of recordWaveOutcomeUnsafe (state.ts line 188), failure weight is applied to buckets from the actual concurrency level up to concurrency+4. The +4 spread is an intentional policy constant that should be named (e.g. FAILURE_SPREAD_BUCKETS) to signal it is not an off-by-one.
- Evidence:
  - packages/shared/src/quota/state.ts:188 - for (let n = outcome.concurrency; n <= outcome.concurrency + 4; n++) — magic +4 spread with no named constant or explanatory comment
  - runtime:unit:packages-shared: confirmed — Deterministic runtime command succeeded: npm test

### OPR-007 — release-changed.mjs lacks a final elapsed-time summary

- Severity: low
- Confidence: medium
- Lens: operability
- Files: scripts/release-changed.mjs
- Summary: The orchestrator script publishes multiple packages in sequence but logs no total elapsed time at completion. For a multi-package release that can take 15+ minutes, a final summary with elapsed time would help operators confirm the run finished as expected.
- Evidence:
  - scripts/release-changed.mjs:308-315 - the final for-of publish loop ends without any summary log of total elapsed time or a release-complete message.

### TST-003 — requeueCommand.ts dedup-by-scope path between file and flow tasks untested

- Severity: low
- Confidence: medium
- Lens: tests
- Files: packages/audit-code/src/orchestrator/requeueCommand.ts
- Summary: buildRequeuePayload in requeueCommand.ts applies a dedupeByScope pass across the merged file+flow task list, but only a single scenario (flow duplicate skipped because file coverage is complete) is tested. The case where a file task and a flow task share identical lens+file_paths and one is dropped has no test.
- Evidence:
  - packages/audit-code/src/orchestrator/requeueCommand.ts:59 - dedupeByScope([...fileTasks, ...flowTasks]) collapses same-scope tasks but only one test covers this path
  - packages/audit-code/tests/field-trial-remediation.test.mjs:307 - single test only verifies flow duplicate skipped when file coverage complete; no test where a flow task duplicates an existing file task's scope
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-003 — review-packets.test.mjs: no test for buildReviewPackets with an empty task list

- Severity: low
- Confidence: medium
- Lens: tests
- Files: packages/audit-code/tests/review-packets.test.mjs
- Summary: buildReviewPackets is exercised with one, two, and three tasks but never with an empty array. An empty input is a valid caller-side state (no pending tasks) and boundary behaviour of the function is unverified.
- Evidence:
  - packages/audit-code/tests/review-packets.test.mjs:49 - first test begins with a 3-task array; no test exercises buildReviewPackets([])
  - packages/audit-code/tests/review-packets.test.mjs:56 - const packets = buildReviewPackets(tasks); // minimum observed task count is 1
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-003 — runStatus helper monkey-patches global console and process.exitCode

- Severity: low
- Confidence: medium
- Lens: maintainability
- Files: packages/audit-code/tests/status-command.test.mjs
- Summary: The runStatus test helper in status-command.test.mjs replaces console.log, console.error, and process.exitCode with captured versions. Any exception thrown before the finally block would still restore state, but the three separate global mutations make the pattern fragile if future tests run concurrently or if the CLI itself spawns async I/O that writes to console after control returns to the test.
- Evidence:
  - packages/audit-code/tests/status-command.test.mjs:29 - console.log = (...values) => { stdout += ... } global reassignment
  - packages/audit-code/tests/status-command.test.mjs:31 - console.error = (...values) => { stderr += ... } global reassignment
  - packages/audit-code/tests/status-command.test.mjs:36 - process.exitCode = 0 mutates global process state
  - runtime:flow:flow:surface:packages-audit-code-tests-status-command-test-mjs: confirmed — Deterministic runtime command succeeded: npm test
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-002 — scope.test.mjs: no test for resolveAuditScope with zero changed files in a real git repo

- Severity: low
- Confidence: medium
- Lens: tests
- Files: packages/audit-code/tests/scope.test.mjs
- Summary: The real-git integration test in resolveAuditScope (line 222) only covers the case where one file was modified. There is no test for the scenario where git reports zero changed files (e.g., HEAD points to a clean commit), leaving the empty-seed path untested in the integration path.
- Evidence:
  - packages/audit-code/tests/scope.test.mjs:239 - await writeFile(join(root, "a.ts"), "import ./b;
export const a = 99;
"); // only tests one-file-changed scenario
  - packages/audit-code/tests/scope.test.mjs:271 - const scope = resolveAuditScope({ root, since: "HEAD", bundle }); // no clean-tree / zero-change case
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### OPR-003 — smoke-linked-audit-code.mjs: no elapsed-time reporting per step

- Severity: low
- Confidence: medium
- Lens: operability
- Files: packages/audit-code/scripts/smoke-linked-audit-code.mjs
- Summary: The linked smoke script records step labels and errors to stderr but does not capture or report per-step or total elapsed time. For a script that runs npm link, multiple audit-code invocations, and a full audit cycle, the absence of timing makes it harder to diagnose performance regressions in CI.
- Evidence:
  - packages/audit-code/scripts/smoke-linked-audit-code.mjs:190-200 - step(), detail(), and success() helpers all write to stderr but carry no timestamp or elapsed-ms context
  - packages/audit-code/scripts/smoke-linked-audit-code.mjs:728-732 - success message at the end does not include total elapsed time for the full smoke run
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### OPR-005 — smoke-packaged-audit-code.mjs: no elapsed-time reporting per step or for total run

- Severity: low
- Confidence: medium
- Lens: operability
- Files: packages/audit-code/scripts/smoke-packaged-audit-code.mjs
- Summary: The packaged smoke script has step/detail/success helpers that write to stderr but include no per-step or total elapsed time. Given that the script packs two tarballs, installs them into a temp dir, runs multiple audit-code invocations, and exercises the MCP server, timing information would help operators distinguish slow pack operations from slow MCP startup when diagnosing CI failures.
- Evidence:
  - packages/audit-code/scripts/smoke-packaged-audit-code.mjs:217-227 - step(), detail(), and success() helpers write prefix-tagged lines to stderr with no timestamp or elapsed-ms context
  - packages/audit-code/scripts/smoke-packaged-audit-code.mjs:1007-1009 - success message on line 1007 does not include total elapsed time for the packaged smoke run
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-004 — spawnLoggedCommand single Promise closure holds 13+ mutable variables and 6 inner functions

- Severity: low
- Confidence: medium
- Lens: maintainability
- Files: packages/shared/src/providers/spawnLoggedCommand.ts
- Summary: The Promise constructor callback in spawnLoggedCommand (lines 76-293) declares 13 mutable closure variables alongside 6 inner helper functions, all sharing that mutable state. The volume of interleaved state makes the settling logic difficult to reason about in isolation.
- Evidence:
  - packages/shared/src/providers/spawnLoggedCommand.ts:80-91 - 13 closure-level mutable variables: timedOut, settled, child, timer, heartbeat, forceKillTimer, pendingLogWrites, childClosed, closeCode, closeSignal, logsEnded, stdoutLineBuf, startedAt
  - packages/shared/src/providers/spawnLoggedCommand.ts:93-179 - 6 inner functions (clearTimers, endLogs, settle, fail, writeLog, maybeSettleFromClose) all mutating those variables
  - runtime:unit:packages-shared: confirmed — Deterministic runtime command succeeded: npm test

### TST-004 — stepWriter.ts has no direct unit tests

- Severity: low
- Confidence: medium
- Lens: tests
- Files: packages/remediate-code/src/steps/stepWriter.ts
- Summary: stepWriter.ts is a small but critical module: it writes both the machine-readable current-step.json and the human-readable current-prompt.md; it merges artifact_paths; and it trims leading whitespace from prompts. None of its exported functions (writeCurrentStep, stepsDir, currentStepPath, currentPromptPath) are imported by any test file. The function is only exercised indirectly through next-step integration tests that call decideNextStep. A dedicated unit test would catch regressions in the prompt_path merging logic or the leading-whitespace trim without running the full orchestrator.
- Evidence:
  - packages/remediate-code/src/steps/stepWriter.ts:35 - writeCurrentStep is exported but no test file in tests/ imports it or any of the path helpers (stepsDir, currentStepPath, currentPromptPath)
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-002 — store lock-timeout test may race against the 15 s vitest test timeout

- Severity: low
- Confidence: medium
- Lens: tests
- Files: packages/remediate-code/tests/store.test.ts
- Summary: The test that verifies a pre-existing lock causes a timeout sets a 15 s test-level timeout but the StateStore internal retry window may be comparable, creating a race where the framework cancels before the store fires and the expect is never reached.
- Evidence:
  - packages/remediate-code/tests/store.test.ts:63 - it('times out and throws when lock file is pre-existing and never released', ..., 15_000) — 15 s vitest timeout wrapping an internal store timeout whose actual duration is unknown from this test alone
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### OBS-003 — treeSitter module-level caches prevent per-run observability of stale state

- Severity: low
- Confidence: medium
- Lens: observability
- Files: packages/audit-code/src/extractors/analyzers/treeSitter.ts
- Summary: The module-level singletons modulePromise, initPromise, and languageCache in treeSitter.ts are never reset between analyzer runs unless the test seam is called. If a grammar loads successfully in one run but the wasm file is deleted before the next, all subsequent callers silently get a cached parser without any log indicating the cache was used or that the grammar path is now stale.
- Evidence:
  - packages/audit-code/src/extractors/analyzers/treeSitter.ts:48 - modulePromise, initPromise, and languageCache are module-level; no log is emitted when a cached hit is returned vs. a fresh load
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-004 — validate-command.test.mjs: positive path for review_packets validation is not tested

- Severity: low
- Confidence: medium
- Lens: tests
- Files: packages/audit-code/tests/validate-command.test.mjs
- Summary: The validate-command integration test for review_packets (line 275) only covers the error case where a file_line_counts entry is missing. There is no corresponding test confirming that a fully valid review_packets.json produces exit code 0 and zero issues, so a future regression that breaks the happy path would go undetected.
- Evidence:
  - packages/audit-code/tests/validate-command.test.mjs:275 - test("audit-code validate rejects review packets missing listed file line counts" — only error path covered
  - packages/audit-code/tests/validate-command.test.mjs:309 - assert.notEqual(result.code, 0); // no symmetric test for valid packet → exit 0
  - runtime:flow:flow:surface:packages-audit-code-tests-validate-command-test-mjs: confirmed — Deterministic runtime command succeeded: npm test
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-007 — validateFinding mixes multiple validation concerns in one 165-line function

- Severity: low
- Confidence: medium
- Lens: maintainability
- Files: packages/audit-code/src/validation/auditResults.ts
- Summary: The validateFinding function in auditResults.ts spans approximately 165 lines and sequentially handles required fields, severity, confidence, lens, nested affected_files per-entry checks, and evidence. Extracting named sub-validators for affected_files and evidence would reduce the cognitive load of the function.
- Evidence:
  - packages/audit-code/src/validation/auditResults.ts:133 - function validateFinding(finding: unknown, ...) — 165-line function
  - packages/audit-code/src/validation/auditResults.ts:197-257 - 60-line inline block validating affected_files entries with nested per-item checks inlined directly
  - packages/audit-code/src/validation/auditResults.ts:259-296 - 37-line inline block validating evidence entries — also inlined within the same function
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-005 — validation-remediation.test.mjs: validateConfiguredProviderEnvironment not tested for claude-code or subprocess-template providers

- Severity: low
- Confidence: medium
- Lens: tests
- Files: packages/audit-code/tests/validation-remediation.test.mjs
- Summary: validateConfiguredProviderEnvironment is tested only for the opencode provider with an absolute Windows path (line 437). The claude-code and subprocess-template providers have different resolution logic (commandExists vs pathExists) that is never exercised in the test suite.
- Evidence:
  - packages/audit-code/tests/validation-remediation.test.mjs:441 - provider: "opencode" — only provider tested in environment validation
  - packages/audit-code/tests/validation-remediation.test.mjs:347 - validateSessionConfig({ provider: "claude-code", ... }) is called but validateConfiguredProviderEnvironment for claude-code is never exercised
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-002 — Very short wall-clock timeout in SIGKILL escalation test may be flaky under CI load

- Severity: low
- Confidence: medium
- Lens: tests
- Files: packages/audit-code/tests/providers-remediation.test.mjs
- Summary: The spawnLoggedCommand SIGTERM-to-SIGKILL escalation test uses timeoutMs: 20 and killGraceMs: 10, relying on actual wall-clock timing. Under a loaded CI environment these sub-millisecond-range values can cause the test to intermittently fail or pass vacuously.
- Evidence:
  - packages/audit-code/tests/providers-remediation.test.mjs:293 - const input = buildLaunchInput(root, { timeoutMs: 20 });
  - packages/audit-code/tests/providers-remediation.test.mjs:300 - killGraceMs: 10, -- the FakeChildProcess only emits close on SIGKILL setImmediate, so the real timing window is the 20ms before SIGTERM fires plus 10ms grace
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### OBS-002 — Wave recovery path logs slot count but not individual slot identities

- Severity: low
- Confidence: medium
- Lens: observability
- Files: packages/audit-code/src/cli/runToCompletion.ts
- Summary: When runToCompletion recovers an interrupted wave it logs only the aggregate slot count and obligation id. If recovery partially succeeds (some slots produce results, some are unreadable), operators cannot tell from logs which run IDs recovered and which were skipped, making post-incident triage harder.
- Evidence:
  - packages/audit-code/src/cli/runToCompletion.ts:165 - logs `Recovering interrupted wave (N slot(s), obligation X)` but does not enumerate run_ids
  - packages/audit-code/src/cli/runToCompletion.ts:185 - failed slot catch only logs the result path, not the run_id: `Skipping unreadable results for ${entry.run_id}` (actually uses audit_results_path — the variable name in the catch is entry which has run_id, so this is fine, but success path emits no per-slot log)
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-002 — withTempRepo unconditionally installs fake ESLint for all syntax-resolution tests

- Severity: low
- Confidence: medium
- Lens: maintainability
- Files: packages/audit-code/tests/syntax-resolution.test.mjs
- Summary: withTempRepo always calls writeFakeEslint even when a test targets the tsc path rather than ESLint. Tests that do not exercise ESLint receive implicit scaffolding, making the setup/teardown contract opaque and coupling unrelated tests to the fake ESLint binary.
- Evidence:
  - packages/audit-code/tests/syntax-resolution.test.mjs:15 - await writeFakeEslint(root); called unconditionally inside withTempRepo
  - packages/audit-code/tests/syntax-resolution.test.mjs:96 - tsc test uses withTempRepo but never references ESLint; the fake binary is installed silently
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### COR-003 — Work block flow dependencies use alphabetical block ID sort instead of flow path order

- Severity: low
- Confidence: medium
- Lens: correctness
- Files: packages/audit-code/src/reporting/workBlocks.ts
- Summary: In computeDependencies, blocks touched by a critical flow are sorted by block ID string alphabetically rather than by the order of paths in the flow. Dependency edges are added in alphabetical block ID order which has no meaningful relationship to the actual data-flow direction.
- Evidence:
  - packages/audit-code/src/reporting/workBlocks.ts:87 - const ordered = [...flowBlocks].sort() - lexicographic sort of block IDs loses flow direction
  - packages/audit-code/src/reporting/workBlocks.ts:79-85 - flow.paths iteration builds a Set but path order is discarded; only block membership is tracked
  - packages/audit-code/src/reporting/workBlocks.ts:88-91 - sequential depends_on edges based on sorted block IDs rather than flow path order
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### DR-008 — Hand-rolled cross-process file locking and quota math are candidates for maintained libraries or property tests

- Severity: low
- Confidence: low
- Lens: reliability
- Files: packages/shared/src/quota/fileLock.ts, packages/shared/src/quota/slidingWindow.ts
- Summary: shared/src/quota/fileLock.ts implements advisory cross-process file locking (documented as 20ms initial backoff, 250ms max, 20 retries, 30s stale-lock cleanup) and the quota subsystem hand-rolls sliding-window and backoff math (slidingWindow.ts, scheduler.ts, state.ts). The logic looks correct, but this is exactly the class of concurrency code where edge cases bite — clock skew, crash-during-write leaving a half-written lock, and differing Windows vs POSIX rename/unlink semantics (notable given this repo is Windows-first). Recommendation: either adopt a battle-tested dependency (e.g. proper-lockfile for the lock) or keep the in-house implementation but add property/fuzz tests that exercise concurrent acquirers and stale-lock recovery. Lower priority than the duplication and decomposition findings; included as a library opportunity per the review brief.
- Evidence:
  - runtime:unit:packages-shared: confirmed — Deterministic runtime command succeeded: npm test

### MNT-006 — AuditPlanMetrics.packet_quality typed as large anonymous inline object

- Severity: info
- Confidence: high
- Lens: maintainability
- Files: packages/audit-code/src/types/reviewPlanning.ts
- Summary: The packet_quality property of AuditPlanMetrics is typed as a 22-line anonymous object literal with 14 nested fields. This inline shape cannot be referred to, extended, or independently documented without duplicating the full anonymous type.
- Evidence:
  - packages/audit-code/src/types/reviewPlanning.ts:62 - packet_quality: { — begins a large anonymous inline object type spanning to line 84
  - packages/audit-code/src/types/reviewPlanning.ts:63-84 - 14 fields inlined without a named interface: average_cohesion_score, boundary_crossing_count, weakly_explained_packet_samples, etc.
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-003 — Deprecated probeProvider stub still exported in public API

- Severity: info
- Confidence: high
- Lens: maintainability
- Files: packages/audit-code/src/quota/probe.ts, packages/audit-code/src/quota/index.ts
- Summary: probe.ts exports a probeProvider function marked @deprecated that always returns supported: false. The function body is a stub with no useful implementation, but it remains in the public API surface re-exported from quota/index.ts, making the intended removal boundary unclear.
- Evidence:
  - packages/audit-code/src/quota/probe.ts:8 - @deprecated Phase 3A replaces this with the QuotaSource abstraction.
  - packages/audit-code/src/quota/probe.ts:11-28 - every branch returns { supported: false, reason: ... }; entire function is a non-functional stub
  - packages/audit-code/src/quota/index.ts:74 - export { probeProvider } from './probe.js'; — still part of the public module surface
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### OBS-003 — Deterministic progress JSON contains no wall-clock duration between iterations

- Severity: info
- Confidence: high
- Lens: observability
- Files: packages/audit-code/src/cli/nextStepCommand.ts
- Summary: The deterministic-progress.json artifact written in the main loop of runDeterministicForNextStep records iteration count and timestamp but not the elapsed duration for each deterministic step. Without per-iteration duration, debugging slow or hung runs requires manual timestamp arithmetic.
- Evidence:
  - packages/audit-code/src/cli/nextStepCommand.ts:409 - progress JSON written after step; includes timestamp but no elapsed_ms field to track step duration
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### TST-004 — install-host error path for non-copilot hosts is untested

- Severity: info
- Confidence: high
- Lens: tests
- Files: packages/audit-code/audit-code-wrapper-lib.mjs
- Summary: installHostPrompt throws an Error when called with any host other than copilot, but no test exercises this rejection. The command is described in help text and has a documented purpose, so the guard logic is user-visible behavior that should be tested.
- Evidence:
  - packages/audit-code/audit-code-wrapper-lib.mjs:2774 - throws if host !== copilot: install-host currently supports only copilot
  - packages/audit-code/tests/audit-code-wrapper.test.mjs:1285 - only the success path (copilot) is tested; no test passes a non-copilot host to install-host
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-004 — isDataLayerPath contains redundant hasSegment calls already covered by hasToken on DATA_LAYER_KEYWORDS

- Severity: info
- Confidence: high
- Lens: maintainability
- Files: packages/audit-code/src/extractors/pathPatterns.ts
- Summary: In isDataLayerPath, the explicit hasSegment calls for models, schemas, migrations, and seeds (lines 247-251) are redundant because those tokens already appear in DATA_LAYER_KEYWORDS and hasToken covers the same matches. Only hasSegment for db adds coverage not in the keyword list.
- Evidence:
  - packages/audit-code/src/extractors/pathPatterns.ts:50 - DATA_LAYER_KEYWORDS includes model, models, schema, schemas, migration, migrations, seed, seeds
  - packages/audit-code/src/extractors/pathPatterns.ts:247 - hasSegment(normalized, 'models') is redundant; hasToken already covers it via DATA_LAYER_KEYWORDS
  - packages/audit-code/src/extractors/pathPatterns.ts:248 - hasSegment(normalized, 'schemas') is redundant for same reason
  - packages/audit-code/src/extractors/pathPatterns.ts:249 - hasSegment(normalized, 'migrations') is redundant for same reason
  - packages/audit-code/src/extractors/pathPatterns.ts:250 - hasSegment(normalized, 'seeds') is redundant for same reason
  - packages/audit-code/src/extractors/pathPatterns.ts:252 - hasSegment(normalized, 'db') is the only non-redundant extra check
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### OBS-005 — Legacy file archive failures only reported to stderr without run logger entry

- Severity: info
- Confidence: high
- Lens: observability
- Files: packages/audit-code/src/cli/auditStep.ts
- Summary: In maybeArchiveLegacyPendingResults, rename failures are written directly to process.stderr but not captured in the RunLogger (which is initialized just above). This means archive failures won't appear in the structured run.log.jsonl audit trail.
- Evidence:
  - packages/audit-code/src/cli/auditStep.ts:39 - process.stderr.write used for archive failure, bypassing RunLogger initialized at line 63
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-006 — Magic literal 25 used as concurrency batch size in buildLineIndex

- Severity: info
- Confidence: high
- Lens: maintainability
- Files: packages/audit-code/src/cli/lineIndex.ts
- Summary: buildLineIndex in lineIndex.ts uses the literal 25 as a Promise.all batch size with no named constant or rationale comment explaining why that value was chosen.
- Evidence:
  - packages/audit-code/src/cli/lineIndex.ts:14 - const batchSize = 25; — inline literal with no named constant or explanatory comment
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-003 — Magic timeout constant 30_000 in runWrapperJsonOutput

- Severity: info
- Confidence: high
- Lens: maintainability
- Files: packages/audit-code/tests/audit-code-wrapper.test.mjs
- Summary: The default timeout of 30_000 ms on line 76 is an unnamed literal. Call sites that want a different timeout pass timeoutMs explicitly, but the default is invisible at use-sites and would need to be updated in two places (the literal and any callers that rely on it).
- Evidence:
  - packages/audit-code/tests/audit-code-wrapper.test.mjs:76 - options.timeoutMs ?? 30_000 — unnamed literal; no named constant
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### OBS-003 — Unstructured error message in discoveredLimits cache read omits context fields

- Severity: info
- Confidence: high
- Lens: observability
- Files: packages/audit-code/src/quota/discoveredLimits.ts
- Summary: When the discovered-limits cache file is unreadable the error message is a free-form string with no structured context such as the cache path or providerModelKey, making it harder to correlate the warning in logs.
- Evidence:
  - packages/audit-code/src/quota/discoveredLimits.ts:42-47 - process.stderr.write(`[quota] ignoring unreadable discovered-limits cache: ${error...}
`) logs only the error message string; the cache file path (getCachePath() result) is not included, making it hard to identify which file caused the warning.
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### OBS-005 — Deprecated orchestrator loop emits unstructured timing logs bypassing RunLogger

- Severity: info
- Confidence: medium
- Lens: observability
- Files: packages/remediate-code/src/orchestrator.ts
- Summary: The deprecated runOrchestrator emits per-phase timing via console.log while the canonical step-driven path uses RunLogger for structured event emission. As long as the deprecated path is invocable its logs are unstructured and inconsistent with the event schema used elsewhere.
- Evidence:
  - packages/remediate-code/src/orchestrator.ts:63 - console.log iteration/phase entry as plain text with no structured fields
  - packages/remediate-code/src/orchestrator.ts:100 - console.log elapsed time emitted as free-form string rather than a metric field
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-005 — getErrorParserForProvider allocates a new ClaudeCodeErrorParser instance per call while returning a singleton for the generic case

- Severity: info
- Confidence: medium
- Lens: maintainability
- Files: packages/shared/src/quota/errorParsers/index.ts
- Summary: PROVIDER_PARSERS stores factory functions so each call to getErrorParserForProvider('claude-code') allocates a new instance, while the generic fallback returns a module-level singleton. Since parsers are stateless, the factory pattern adds no benefit and the asymmetry is confusing.
- Evidence:
  - packages/shared/src/quota/errorParsers/index.ts:9-11 - PROVIDER_PARSERS stores factories: { 'claude-code': () => new ClaudeCodeErrorParser() }
  - packages/shared/src/quota/errorParsers/index.ts:13 - genericParser is a pre-constructed singleton
  - packages/shared/src/quota/errorParsers/index.ts:15-18 - getErrorParserForProvider: factory() allocates new instance each call for known providers
  - runtime:unit:packages-shared: confirmed — Deterministic runtime command succeeded: npm test

### MNT-002 — makeSpawnMock and makeWriteStream mock factories defined at module scope but used only in one describe block

- Severity: info
- Confidence: medium
- Lens: maintainability
- Files: packages/remediate-code/tests/providers.test.ts
- Summary: makeSpawnMock and makeWriteStream are defined at module scope (lines 44-80) but are only consumed inside the spawnLoggedCommand describe block. Placing them closer to their sole usage site would improve locality and make clear they are not general test utilities.
- Evidence:
  - packages/remediate-code/tests/providers.test.ts:44-59 - makeWriteStream defined at module scope
  - packages/remediate-code/tests/providers.test.ts:61-80 - makeSpawnMock defined at module scope
  - packages/remediate-code/tests/providers.test.ts:128-233 - both helpers only consumed within the spawnLoggedCommand describe block
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

### MNT-004 — Provider extractor registry uses factory functions inconsistently with singleton default

- Severity: info
- Confidence: medium
- Lens: maintainability
- Files: packages/audit-code/src/quota/headerExtractors/index.ts
- Summary: PROVIDER_EXTRACTORS maps provider names to factory functions that instantiate a new extractor on each call, while the generic extractor is a module-level singleton. The inconsistency is undocumented and leaves readers uncertain whether the factory pattern carries meaningful intent.
- Evidence:
  - packages/audit-code/src/quota/headerExtractors/index.ts:9-11 - PROVIDER_EXTRACTORS: Record<string, () => HeaderExtractor> = { 'claude-code': () => new ClaudeCodeHeaderExtractor() }
  - packages/audit-code/src/quota/headerExtractors/index.ts:13 - const genericExtractor = new GenericHeaderExtractor(); — singleton, not wrapped in a factory
  - runtime:unit:packages-audit-code: confirmed — Deterministic runtime command succeeded: npm test

### OBS-103 — RunLogEvent kind field is untyped string with no enforcement of known event kinds

- Severity: info
- Confidence: medium
- Lens: observability
- Files: packages/shared/src/observability/runLog.ts
- Summary: The RunLogEvent.kind field is typed as string with example values documented in a comment but no union type constraint. Event consumers cannot rely on a stable, typed vocabulary of event kinds, making log aggregation fragile.
- Evidence:
  - packages/shared/src/observability/runLog.ts:14 - kind field typed as string with comment enumerating examples but no union type constraint; any string passes at compile time
  - runtime:unit:packages-shared: confirmed — Deterministic runtime command succeeded: npm test

### OBS-004 — Session-config read path in decideNextStepInner duplicates readOptionalJsonFile without logging failures

- Severity: info
- Confidence: medium
- Lens: observability
- Files: packages/remediate-code/src/steps/nextStep.ts, packages/remediate-code/src/steps/nextStep.ts
- Summary: The planning and implementing branches each independently re-read session-config.json with separate readOptionalJsonFile calls; if the file is present but malformed, both reads fail silently with no log entry, making the root cause of dispatch misconfiguration invisible.
- Evidence:
  - packages/remediate-code/src/steps/nextStep.ts:909-914 - readOptionalJsonFile for session-config.json called inside the planning branch; errors suppressed silently
  - packages/remediate-code/src/steps/nextStep.ts:1291-1296 - identical second read inside the implement branch; no log event on parse failure or missing-file fallback
  - runtime:unit:packages-remediate-code: confirmed — Deterministic runtime command succeeded: npm test

## Scope and Coverage

This report is deterministic output from the completed audit. Non-auditable files were excluded from scope before task generation.
