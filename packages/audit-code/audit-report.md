# Audit Report

## Summary

- Findings: 224
- Work blocks: 2
- Severity breakdown: critical: 4, high: 40, medium: 114, low: 66
- Fully audited files: 92
- Excluded non-auditable files: 79

## Work Blocks

### block-1

- Max severity: critical
- Units: -gemini-commands, -github-workflows, -opencode, -tmp-opentoken, -vscode, Codeauditor-lambda-audit-artifacts, dispatch, module-audit-code-wrapper-lib-mjs, root-config, schemas, scripts, skills-audit-code, src-cli-ts, src-extractors, src-index-ts, src-io, src-mcp, src-orchestrator, src-prompts, src-providers, src-quota, src-supervisor, src-types, src-validation, tests-adapters-remediation-test-mjs, tests-audit-code-completion-test-mjs, tests-audit-code-lifecycle-test-mjs, tests-audit-code-wrapper-test-mjs, tests-cli-remediation-test-mjs, tests-config-error-handling-test-mjs, tests-design-assessment-test-mjs, tests-discovered-limits-test-mjs, tests-entrypoint-contract-test-mjs, tests-extractors-remediation-test-mjs, tests-fixture-repo-test-mjs, tests-header-extraction-test-mjs, tests-helpers, tests-json-schema-assert-test-mjs, tests-mcp-server-test-mjs, tests-next-step-test-mjs, tests-orchestration-test-mjs, tests-postinstall-contract-test-mjs, tests-provider-assisted-bridge-test-mjs, tests-provider-assisted-continuation-test-mjs, tests-provider-auto-resolution-test-mjs, tests-providers-remediation-test-mjs, tests-quota-error-parsers-test-mjs, tests-quota-error-parsing-test-mjs, tests-quota-file-lock-test-mjs, tests-quota-limits-test-mjs, tests-quota-packets-test-mjs, tests-quota-scheduler-test-mjs, tests-quota-sliding-window-test-mjs, tests-quota-source-test-mjs, tests-release-contract-test-mjs, tests-render-worker-prompt-test-mjs, tests-reporting-remediation-test-mjs, tests-review-packets-test-mjs, tests-schema-contracts-test-mjs, tests-staleness-test-mjs, tests-status-command-test-mjs, tests-supervisor-remediation-test-mjs, tests-syntax-resolution-test-mjs, tests-validate-command-test-mjs, tests-validation-remediation-test-mjs
- Owned files: .gemini/commands/audit-code.toml, .github/workflows/ci.yml, .github/workflows/packaged-entrypoint.yml, .github/workflows/product-e2e.yml, .github/workflows/publish-package.yml, .github/workflows/test-suite.yml, .gitignore, .opencode/.gitignore, .opencode/package.json, .tmp/opentoken/.github/FUNDING.yml, .tmp/opentoken/.github/workflows/ci.yml, .tmp/opentoken/.gitignore, .tmp/opentoken/.npmignore, .tmp/opentoken/.opencode/opentoken-config-schema.json, .tmp/opentoken/.opencode/package.json, .tmp/opentoken/.opencode/pkg.json, .tmp/opentoken/.opencode/plugins/opentoken-tui.tsx, .tmp/opentoken/.opencode/plugins/opentoken.ts, .tmp/opentoken/.opencode/plugins/opentoken/autoescalate.ts, .tmp/opentoken/.opencode/plugins/opentoken/dedup.ts, .tmp/opentoken/.opencode/plugins/opentoken/families/cargo.ts, .tmp/opentoken/.opencode/plugins/opentoken/families/detect.ts, .tmp/opentoken/.opencode/plugins/opentoken/families/docker.ts, .tmp/opentoken/.opencode/plugins/opentoken/families/fs.ts, .tmp/opentoken/.opencode/plugins/opentoken/families/generic.ts, .tmp/opentoken/.opencode/plugins/opentoken/families/git.ts, .tmp/opentoken/.opencode/plugins/opentoken/families/make.ts, .tmp/opentoken/.opencode/plugins/opentoken/families/npm.ts, .tmp/opentoken/.opencode/plugins/opentoken/families/pip.ts, .tmp/opentoken/.opencode/plugins/opentoken/families/test.ts, .tmp/opentoken/.opencode/plugins/opentoken/filters/glob.ts, .tmp/opentoken/.opencode/plugins/opentoken/filters/grep.ts, .tmp/opentoken/.opencode/plugins/opentoken/filters/read.ts, .tmp/opentoken/.opencode/plugins/opentoken/folding.ts, .tmp/opentoken/.opencode/plugins/opentoken/history.ts, .tmp/opentoken/.opencode/plugins/opentoken/index.ts, .tmp/opentoken/.opencode/plugins/opentoken/jsonsample.ts, .tmp/opentoken/.opencode/plugins/opentoken/lspfirst.ts, .tmp/opentoken/.opencode/plugins/opentoken/ltsc.ts, .tmp/opentoken/.opencode/plugins/opentoken/lzw.ts, .tmp/opentoken/.opencode/plugins/opentoken/memory.ts, .tmp/opentoken/.opencode/plugins/opentoken/outputcomp.ts, .tmp/opentoken/.opencode/plugins/opentoken/postcall.ts, .tmp/opentoken/.opencode/plugins/opentoken/precall.ts, .tmp/opentoken/.opencode/plugins/opentoken/progressive.ts, .tmp/opentoken/.opencode/plugins/opentoken/rewind.ts, .tmp/opentoken/.opencode/plugins/opentoken/router.ts, .tmp/opentoken/.opencode/plugins/opentoken/session.ts, .tmp/opentoken/.opencode/plugins/opentoken/skeleton.ts, .tmp/opentoken/.opencode/plugins/opentoken/statusline.ts, .tmp/opentoken/.opencode/plugins/opentoken/symbolindex.ts, .tmp/opentoken/.opencode/plugins/opentoken/toon.ts, .tmp/opentoken/.opencode/plugins/opentoken/tui.tsx, .tmp/opentoken/.opencode/plugins/opentoken/utils/cache.ts, .tmp/opentoken/.opencode/plugins/opentoken/utils/errors.ts, .tmp/opentoken/.opencode/plugins/opentoken/utils/metrics.ts, .tmp/opentoken/.opencode/plugins/opentoken/utils/secrets.ts, .tmp/opentoken/.opencode/plugins/opentoken/utils/session-store.ts, .tmp/opentoken/.opencode/plugins/opentoken/utils/stats.ts, .tmp/opentoken/.opencode/plugins/opentoken/utils/tokens.ts, .tmp/opentoken/SHA256SUMS, .tmp/opentoken/biome.json, .tmp/opentoken/bun.lock, .tmp/opentoken/install.sh, .tmp/opentoken/package.json, .tmp/opentoken/scripts/check-regex-safety.ts, .tmp/opentoken/src/autoescalate.test.ts, .tmp/opentoken/src/autoescalate.ts, .tmp/opentoken/src/dedup.ts, .tmp/opentoken/src/families/cargo.ts, .tmp/opentoken/src/families/detect.ts, .tmp/opentoken/src/families/docker.ts, .tmp/opentoken/src/families/fs.ts, .tmp/opentoken/src/families/generic.test.ts, .tmp/opentoken/src/families/generic.ts, .tmp/opentoken/src/families/git.ts, .tmp/opentoken/src/families/make.ts, .tmp/opentoken/src/families/npm.ts, .tmp/opentoken/src/families/pip.ts, .tmp/opentoken/src/families/test.ts, .tmp/opentoken/src/filters/glob.ts, .tmp/opentoken/src/filters/grep.ts, .tmp/opentoken/src/filters/read.ts, .tmp/opentoken/src/folding.ts, .tmp/opentoken/src/history.ts, .tmp/opentoken/src/index.ts, .tmp/opentoken/src/jsonsample.ts, .tmp/opentoken/src/lspfirst.ts, .tmp/opentoken/src/ltsc.ts, .tmp/opentoken/src/lzw.ts, .tmp/opentoken/src/memory.ts, .tmp/opentoken/src/outputcomp.ts, .tmp/opentoken/src/postcall.ts, .tmp/opentoken/src/precall.ts, .tmp/opentoken/src/progressive.ts, .tmp/opentoken/src/rewind.ts, .tmp/opentoken/src/router.ts, .tmp/opentoken/src/session.ts, .tmp/opentoken/src/skeleton.ts, .tmp/opentoken/src/statusline.ts, .tmp/opentoken/src/symbolindex.ts, .tmp/opentoken/src/toon.ts, .tmp/opentoken/src/tui.tsx, .tmp/opentoken/src/utils/cache.ts, .tmp/opentoken/src/utils/errors.ts, .tmp/opentoken/src/utils/metrics.ts, .tmp/opentoken/src/utils/secrets.ts, .tmp/opentoken/src/utils/session-store.ts, .tmp/opentoken/src/utils/stats.ts, .tmp/opentoken/src/utils/tokens.ts, .tmp/opentoken/tests/opentoken.test.ts, .tmp/opentoken/tests/outputcomp.test.ts, .tmp/opentoken/tests/phase4.test.ts, .tmp/opentoken/tsconfig.json, .vscode/mcp.json, Codeauditor-lambda.audit-artifacts/session-config.json, audit-code-wrapper-lib.mjs, dispatch/merge-results.mjs, dispatch/validate-result.mjs, dispatch/validate.mjs, opencode.json, package.json, schemas/audit-code-v1alpha1.schema.json, schemas/audit_plan_metrics.schema.json, schemas/audit_result.schema.json, schemas/audit_results.schema.json, schemas/audit_state.schema.json, schemas/audit_task.schema.json, schemas/blind_spot_register.schema.json, schemas/coverage_matrix.schema.json, schemas/critical_flows.schema.json, schemas/dispatch_quota.schema.json, schemas/external_analyzer_results.schema.json, schemas/file_disposition.schema.json, schemas/finding.schema.json, schemas/flow_coverage.schema.json, schemas/graph_bundle.schema.json, schemas/repo_manifest.schema.json, schemas/review_packets.schema.json, schemas/risk_register.schema.json, schemas/runtime_validation_report.schema.json, schemas/runtime_validation_tasks.schema.json, schemas/surface_manifest.schema.json, schemas/unit_manifest.schema.json, scripts/release-and-publish.mjs, scripts/smoke-packaged-audit-code.mjs, skills/audit-code/agents/openai.yaml, skills/audit-code/opencode-command-template.txt, src/adapters/coverageSummary.ts, src/adapters/eslint.ts, src/adapters/normalizeExternal.ts, src/adapters/npmAudit.ts, src/adapters/semgrep.ts, src/cli.ts, src/coverage.ts, src/extractors/browserExtension.ts, src/extractors/disposition.ts, src/extractors/fileInventory.ts, src/extractors/fsIntake.ts, src/extractors/graph.ts, src/extractors/graphManifestEdges.ts, src/extractors/ignore.ts, src/extractors/pathPatterns.ts, src/index.ts, src/io/artifacts.ts, src/io/toolingManifest.ts, src/mcp/server.ts, src/orchestrator/advance.ts, src/orchestrator/artifactFreshness.ts, src/orchestrator/artifactMetadata.ts, src/orchestrator/autoFixExecutor.ts, src/orchestrator/chunking.ts, src/orchestrator/dependencyMap.ts, src/orchestrator/designReviewPrompt.ts, src/orchestrator/executors.ts, src/orchestrator/fileAnchors.ts, src/orchestrator/flowCoverage.ts, src/orchestrator/flowPlanning.ts, src/orchestrator/flowRequeue.ts, src/orchestrator/internalExecutors.ts, src/orchestrator/localCommands.ts, src/orchestrator/nextStep.ts, src/orchestrator/planning.ts, src/orchestrator/requeue.ts, src/orchestrator/requeueCommand.ts, src/orchestrator/resultIngestion.ts, src/orchestrator/reviewPackets.ts, src/orchestrator/runtimeValidation.ts, src/orchestrator/runtimeValidationUpdate.ts, src/orchestrator/selectiveDeepening.ts, src/orchestrator/staleness.ts, src/orchestrator/state.ts, src/orchestrator/syntaxResolutionExecutor.ts, src/orchestrator/taskBuilder.ts, src/orchestrator/trivialAudit.ts, src/orchestrator/unitBuilder.ts, src/prompts/renderWorkerPrompt.ts, src/providers/claudeCodeProvider.ts, src/providers/constants.ts, src/providers/index.ts, src/providers/localSubprocessProvider.ts, src/providers/opencodeProvider.ts, src/providers/spawnLoggedCommand.ts, src/providers/subprocessTemplateProvider.ts, src/providers/types.ts, src/providers/vscodeTaskProvider.ts, src/quota/compositeQuotaSource.ts, src/quota/discoveredLimits.ts, src/quota/errorParsers/claudeCodeErrorParser.ts, src/quota/errorParsers/genericErrorParser.ts, src/quota/errorParsers/index.ts, src/quota/errorParsing.ts, src/quota/fileLock.ts, src/quota/headerExtraction.ts, src/quota/headerExtractors/claudeCodeHeaderExtractor.ts, src/quota/headerExtractors/genericHeaderExtractor.ts, src/quota/headerExtractors/index.ts, src/quota/hostLimits.ts, src/quota/index.ts, src/quota/learnedQuotaSource.ts, src/quota/limits.ts, src/quota/probe.ts, src/quota/quotaSource.ts, src/quota/scheduler.ts, src/quota/slidingWindow.ts, src/quota/state.ts, src/quota/types.ts, src/reporting/mergeFindings.ts, src/reporting/workBlocks.ts, src/supervisor/operatorHandoff.ts, src/supervisor/runLedger.ts, src/supervisor/sessionConfig.ts, src/types.ts, src/types/artifactMetadata.ts, src/types/auditState.ts, src/types/designAssessment.ts, src/types/disposition.ts, src/types/externalAnalyzer.ts, src/types/flowCoverage.ts, src/types/flows.ts, src/types/graph.ts, src/types/reviewPlanning.ts, src/types/risk.ts, src/types/runLedger.ts, src/types/runtimeValidation.ts, src/types/sessionConfig.ts, src/types/surfaces.ts, src/types/toolingManifest.ts, src/types/workerResult.ts, src/types/workerSession.ts, src/validation/artifacts.ts, src/validation/auditResults.ts, src/validation/basic.ts, src/validation/sessionConfig.ts, tests/adapters-remediation.test.mjs, tests/audit-code-completion.test.mjs, tests/audit-code-lifecycle.test.mjs, tests/audit-code-wrapper.test.mjs, tests/cli-remediation.test.mjs, tests/config-error-handling.test.mjs, tests/design-assessment.test.mjs, tests/discovered-limits.test.mjs, tests/entrypoint-contract.test.mjs, tests/extractors-remediation.test.mjs, tests/fixture-repo.test.mjs, tests/header-extraction.test.mjs, tests/helpers/jsonSchemaAssert.mjs, tests/helpers/provider-assisted-bridge.mjs, tests/helpers/sourceImport.mjs, tests/json-schema-assert.test.mjs, tests/mcp-server.test.mjs, tests/next-step.test.mjs, tests/orchestration.test.mjs, tests/orchestrator-remediation.test.mjs, tests/postinstall-contract.test.mjs, tests/provider-assisted-bridge.test.mjs, tests/provider-assisted-continuation.test.mjs, tests/provider-auto-resolution.test.mjs, tests/providers-remediation.test.mjs, tests/quota-error-parsers.test.mjs, tests/quota-error-parsing.test.mjs, tests/quota-file-lock.test.mjs, tests/quota-limits.test.mjs, tests/quota-packets.test.mjs, tests/quota-scheduler.test.mjs, tests/quota-sliding-window.test.mjs, tests/quota-source.test.mjs, tests/release-contract.test.mjs, tests/render-worker-prompt.test.mjs, tests/reporting-remediation.test.mjs, tests/review-packets.test.mjs, tests/schema-contracts.test.mjs, tests/staleness.test.mjs, tests/status-command.test.mjs, tests/supervisor-remediation.test.mjs, tests/syntax-resolution.test.mjs, tests/validate-command.test.mjs, tests/validation-remediation.test.mjs, tsconfig.json
- Findings: COR-005, COR-008, COR-011, COR-015, CFG-001, COR-001, COR-001, COR-001, COR-001, COR-001, COR-001, COR-002, COR-002, COR-005, COR-005, COR-006, COR-007, COR-008, COR-008, COR-009, COR-010, COR-011, COR-011, COR-012, COR-014, COR-014, COR-015, DA-008, DR-001, DR-002, MNT-003, OBS-001, OBS-003, OBS-003, OBS-006, OBS-007, OBS-007, OBS-009, REL-001, REL-001, TST-001, TST-001, TST-002, TST-008, CFG-001, COR-001, COR-001, COR-001, COR-001, COR-001, COR-001, COR-002, COR-002, COR-002, COR-002, COR-002, COR-002, COR-003, COR-003, COR-003, COR-003, COR-004, COR-004, COR-004, COR-004, COR-004, COR-006, COR-007, COR-009, COR-010, COR-013, COR-016, DA-002, DA-004, DA-005, DA-012, DA-014, DA-015, DA-016, DAT-001, DAT-002, DI-001, DI-003, DR-003, DR-004, MAINT-001, MAINT-001, MAINT-002, MAINT-003, MAINT-003, MAINT-004, MAINT-006, MAINT-006, MAINT-007, MNT-001, MNT-002, MNT-002, MNT-002, MNT-003, MNT-003, MNT-004, OBS-001, OBS-001, OBS-001, OBS-001, OBS-002, OBS-002, OBS-002, OBS-003, OBS-008, OBS-GRAPH-001, OBS-QUOTA-001, OPR-001, OPR-002, PER-001, REL-001, REL-002, TES-001, TES-001, TES-001, TES-001, TES-001, TEST-001, TEST-DISPATCH-001, TEST-SKILL-001, TEST-WRAPPER-001, TST-001, TST-001, TST-001, TST-001, TST-001, TST-001, TST-001, TST-001, TST-001, TST-002, TST-002, TST-002, TST-002, TST-003, TST-003, TST-003, TST-003, TST-003, TST-003, TST-004, TST-004, TST-004, TST-004, TST-005, TST-005, TST-005, TST-006, TST-006, TST-006, TST-007, TST-007, CFG-002, COR-001, COR-002, COR-003, COR-003, COR-006, DA-011, DA-013, DI-002, DI-004, MAI-001, MAI-001, MAI-001, MAI-001, MAI-001, MAIN-DISPATCH-001, MAINT-001, MAINT-001, MAINT-002, MAINT-002, MAINT-003, MAINT-004, MAINT-004, MAINT-005, MAINT-005, MAINT-005, MNT-001, MNT-001, MNT-001, MNT-001, MNT-001, MNT-001, MNT-001, MNT-001, MNT-002, MNT-003, MNT-004, OBS-002, OBS-002, OBS-003, OBS-004, OBS-004, OBS-005, OBS-EXT-001, OBS-EXT-002, OBS-GRAPH-002, OBS-IO-001, OBS-IO-002, OBS-MCP-001, OBS-PROV-001, TES-002, TST-001, TST-001, TST-001, TST-001, TST-001, TST-002, TST-002, TST-002, TST-003, TST-003, TST-004, TST-004, TST-005, TST-007, TST-008
- Depends on: none
- Rationale: Findings share owned units transitively and should remain one non-overlapping remediation block.

### block-2

- Max severity: medium
- Units: src-orchestrator-ts
- Owned files: src/orchestrator.ts
- Findings: OBS-ORCH-001
- Depends on: block-1
- Rationale: All findings map to the same owned unit and should be remediated together.

## Findings

### COR-011 — Data corruption and loss via overlapping LZW token replacements

- Severity: critical
- Confidence: high
- Lens: correctness
- Files: .tmp/opentoken/.opencode/plugins/opentoken/lzw.ts, .tmp/opentoken/.opencode/plugins/opentoken/lzw.ts
- Summary: COR-011 is confirmed and stands. The `compressLZW` function in lzw.ts has a genuine overlap-corruption bug in its replacement phase (lines 155–180). Although `selectNonOverlapping` (lines 70–123) attempts to exclude character-position-overlapping occurrences, it only marks positions for the subset of occurrences it actually counts per entry. The replacement phase at lines 155–169 then re-scans the full original text using `text.indexOf(entry.original, searchPos)` independently for each selected entry, recovering ALL occurrences — including those that partially overlap with another selected entry's chosen occurrences. The resulting `replacements` array can therefore contain entries whose `{ pos, len }` ranges overlap across different dictionary entries. When these are sorted by descending position (line 171) and applied via successive `string.slice` operations (lines 175–180), later replacements use stale absolute positions from the original text which no longer align correctly after prior replacements have changed the string length. This causes characters to be duplicated, deleted, or transposed. For example, if entry $1='abcdefghijklmnop' matches at position 100 and entry $2='cdefghijklmno' also matches at position 102, after applying the $2 replacement at 102 the string contracts; the subsequent $1 replacement at position 100 then slices into the wrong range and corrupts or destroys surrounding text. Severity is downgraded from 'critical' to 'high' because `selectNonOverlapping` provides a partial (but incomplete) mitigation: it does prevent overlaps *within* a single entry's selected occurrences, and many inputs will not trigger the inter-entry overlap scenario. However, the corruption path is real, reproducible with overlapping candidate substrings, and causes lossless decompression to produce wrong output — making this a high-severity correctness defect.
- Evidence:
  - .tmp/opentoken/.opencode/plugins/opentoken/lzw.ts:158 - 'while (searchPos < text.length - entry.original.length + 1)'
  - runtime:unit:-tmp-opentoken: confirmed — Deterministic runtime command succeeded: npm test
  - lzw.ts:156-169 — The replacement-building loop calls `text.indexOf(entry.original, searchPos)` on the original `text` for every selected entry independently. This re-discovers ALL occurrences, not just those approved by `selectNonOverlapping`. Two different selected entries can yield overlapping `{pos, len}` pairs in the `replacements` array.
  - lzw.ts:171 — `replacements.sort((a, b) => b.pos - a.pos)` sorts by absolute position from the original string. Once any earlier replacement shortens the string, these positions are stale for subsequent replacements.
  - lzw.ts:174-180 — The replacement loop applies each replacement directly by absolute index into the increasingly-mutated `compressed` string, so overlapping replacements corrupt one another's character ranges.
  - lzw.ts:80-105 (`selectNonOverlapping`) — The non-overlap enforcement only tracks the specific occurrence positions selected per entry, using a shared `usedPositions` Set. However, strings can still overlap if one entry's checked occurrence didn't trigger the Set exclusion for another entry's occurrence at a nearby position (e.g. when one string starts 2 chars into another). The replacement phase does not re-validate these constraints.
  - Concrete scenario: if selected entries include $1='ABCDEFGHIJKLMNOPQR' (len=18) and $2='CDEFGHIJKLMNOP' (len=14), and both appear at overlapping positions in the original text, `selectNonOverlapping` may accept both (selecting non-overlapping occurrences for each independently), but the replacement phase finds both at overlapping positions and applies both, corrupting the output.

### COR-015 — LZW compression matches nested or overlapping substrings, causing document corruption

- Severity: critical
- Confidence: high
- Lens: correctness
- Files: .tmp/opentoken/src/lzw.ts
- Summary: During LZW compression, searchPos indexOf matches are added to replacements without checking if the matches overlap or are nested within other selected entries. Since they are replaced sequentially, applying overlapping replacements corrupts the character offsets and results in garbage text and severe data loss.
- Evidence:
  - .tmp/opentoken/src/lzw.ts:159 - const idx = text.indexOf(entry.original, searchPos);
  - runtime:unit:-tmp-opentoken: confirmed — Deterministic runtime command succeeded: npm test

### COR-008 — Severe diagnostic data loss in compressStackTrace for multiple errors

- Severity: critical
- Confidence: high
- Lens: correctness
- Files: .tmp/opentoken/.opencode/plugins/opentoken/families/generic.ts
- Summary: The stack trace compression logic scans the entire output for STACK_FRAME_RE to find stackStart and stackEnd. If the output contains multiple stack traces, it treats everything from the first stack frame of the first trace to the last frame of the second trace as a single stack block, omitting all intervening content (including subsequent error messages, text, and other trace frames).
- Evidence:
  - .tmp/opentoken/.opencode/plugins/opentoken/families/generic.ts:48 - 'for (let i = 0; i < lines.length; i++)'
  - runtime:unit:-tmp-opentoken: confirmed — Deterministic runtime command succeeded: npm test

### COR-005 — Silent data/context loss in filterNpmTest due to dropping of failure-adjacent details

- Severity: critical
- Confidence: high
- Lens: correctness
- Files: .tmp/opentoken/.opencode/plugins/opentoken/families/npm.ts
- Summary: Non-empty lines within a test failure block that do not match the failure regex are completely ignored and excluded from the output. This results in the loss of critical context such as test actual/expected values and stack traces.
- Evidence:
  - .tmp/opentoken/.opencode/plugins/opentoken/families/npm.ts:61 - '/FAIL|???|???|failed|Error:|at .*\(.*:\d+:\d+\)/.test(line)'
  - runtime:unit:-tmp-opentoken: confirmed — Deterministic runtime command succeeded: npm test

### REL-001 — Active file locks can be removed as stale

- Severity: high
- Confidence: high
- Lens: reliability
- Files: src/quota/fileLock.ts
- Summary: The file lock treats any lock file older than 30 seconds as stale, but the holder never refreshes the file mtime while its critical section is running. A second process can delete an active lock and enter the protected section concurrently during long operations.
- Evidence:
  - src/quota/fileLock.ts:3 - stale locks are defined as older than 30000 ms.
  - src/quota/fileLock.ts:17 - staleness is based only on the lock file mtime.
  - src/quota/fileLock.ts:38 - acquireLock unlinks a stale-looking lock before retrying.
  - src/quota/fileLock.ts:68 - withFileLock acquires the lock and runs fn without any heartbeat to refresh mtime.
  - runtime:flow:flow:surface:src-prompts-renderWorkerPrompt-ts: confirmed — Deterministic runtime command succeeded: npm test
  - runtime:flow:flow:surface:src-types-workerResult-ts: confirmed — Deterministic runtime command succeeded: npm test
  - runtime:flow:flow:surface:src-types-workerSession-ts: confirmed — Deterministic runtime command succeeded: npm test
  - runtime:flow:flow:surface:tests-render-worker-prompt-test-mjs: confirmed — Deterministic runtime command succeeded: npm test

### TST-001 — Auto-escalate test file contains duplicate source code instead of unit tests

- Severity: high
- Confidence: high
- Lens: tests
- Files: .tmp/opentoken/src/autoescalate.test.ts
- Summary: The test file src/autoescalate.test.ts contains an exact duplicate copy of the production source code instead of unit tests, resulting in zero tests executed inside this test suite.
- Evidence:
  - .tmp/opentoken/src/autoescalate.test.ts:1 - File starts with implementation headers and contains function exports instead of test blocks (describe/it/expect)
  - runtime:unit:-tmp-opentoken: confirmed — Deterministic runtime command succeeded: npm test

### OBS-001 — Broken ripgrep JSON output detection under search observability

- Severity: high
- Confidence: high
- Lens: observability
- Files: .tmp/opentoken/src/filters/grep.ts
- Summary: The isRgJson flag check in filterGrep evaluates the first line using parseRgJsonLine. Since the first line of rg --json output is a metadata begin block instead of a match, parseRgJsonLine returns null, causing the filter to fallback to standard grep parsing and fail to extract any matches.
- Evidence:
  - .tmp/opentoken/src/filters/grep.ts:59 - const isRgJson = lines.length > 0 && parseRgJsonLine(lines[0]) !== null; evaluates to false as lines[0] is of type begin, causing JSON parsing to fail.
  - runtime:unit:-tmp-opentoken: confirmed — Deterministic runtime command succeeded: npm test

### COR-001 — byFamily aggregated by tool instead of family in stats summary

- Severity: high
- Confidence: high
- Lens: correctness
- Files: .tmp/opentoken/.opencode/plugins/opentoken/utils/stats.ts
- Summary: getStatsSummary populates byFamily using computeToolStats, which aggregates metrics by entry.tool rather than entry.family. As a result, the returned byFamily statistics are duplicate tool statistics rather than family statistics.
- Evidence:
  - .tmp/opentoken/.opencode/plugins/opentoken/utils/stats.ts:150 - byFamily: computeToolStats(entries)
  - runtime:unit:-tmp-opentoken: confirmed — Deterministic runtime command succeeded: npm test

### COR-001 — byFamily stats always mirrors byTool due to wrong function reuse

- Severity: high
- Confidence: high
- Lens: correctness
- Files: .tmp/opentoken/.opencode/plugins/opentoken/utils/stats.ts
- Summary: In `getStatsSummary` (line 150), `byFamily` is populated by calling `computeToolStats(entries)` — the same function used for `byTool`. `computeToolStats` groups entries by `entry.tool` (line 78: `stats[entry.tool]`), never by `entry.family`. As a result, `StatsSummary.byFamily` is always identical to `byTool`: it contains tool-keyed aggregates, not family-keyed aggregates. Any consumer of `byFamily` (e.g., TUI display, the `opentoken stats` command) will silently receive wrong data. No `computeFamilyStats` function exists anywhere in the file to replace this call. The bug is unambiguous and fully evidenced by the source; it does not depend on runtime conditions. The finding should stand at high/high.
- Evidence:
  - Line 78: `computeToolStats` groups by `entry.tool`: `if (!stats[entry.tool]) { ... }` — the key is always the tool name, never the family.
  - Line 149: `byTool: computeToolStats(entries)` — correct usage.
  - Line 150: `byFamily: computeToolStats(entries)` — incorrect: same function called, same grouping key (`entry.tool`), so `byFamily` === `byTool` in content.
  - The `MetricEntry` interface (line 15) has a distinct `family: string` field, confirming family-level grouping was intended to be separate.
  - No `computeFamilyStats` or equivalent function exists anywhere in the 214-line file.
  - The `StatsSummary` interface (lines 31-51) declares `byTool` and `byFamily` as independent `Record<string, ToolStats>` fields, confirming they were meant to hold different data.
  - Any caller reading `stats.byFamily` receives tool-keyed data instead of family-keyed data — a silent semantic error with no runtime exception.
  - runtime:unit:-tmp-opentoken: confirmed — Deterministic runtime command succeeded: npm test

### OBS-006 — Code files incorrectly categorized as text, disabling AST skeleton compression

- Severity: high
- Confidence: high
- Lens: observability
- Files: .tmp/opentoken/src/router.ts
- Summary: The analyzeContent function extracts language (e.g. 'typescript') from file paths. The subsequent check type === 'text' && language === 'unknown' evaluates to false because language is not 'unknown', preventing the router from setting type to 'code' and applying the skeleton stage.
- Evidence:
  - .tmp/opentoken/src/router.ts:222 - if (type === 'text' && language === 'unknown') fails for files with recognized extensions, keeping their type as text instead of code.
  - runtime:unit:-tmp-opentoken: confirmed — Deterministic runtime command succeeded: npm test

### COR-012 — collapseConsecutiveTools fails to collapse consecutive tool results

- Severity: high
- Confidence: high
- Lens: correctness
- Files: .tmp/opentoken/src/history.ts
- Summary: In history.ts, collapseConsecutiveTools attempts to find and collapse consecutive compressed tool results by checking if part.type === 'text' and part.text starts with '['. However, compressed tool parts in compressMessageParts are kept with part.type === 'tool' (to preserve state contract). Consequently, the type check fails for all compressed tool results, making the collapsing logic a complete dead code no-op.
- Evidence:
  - .tmp/opentoken/src/history.ts:352 - if (part.type === "text" && part.text.startsWith("["))
  - runtime:unit:-tmp-opentoken: confirmed — Deterministic runtime command succeeded: npm test

### COR-008 — compressStackTrace deletes critical non-stack lines sandwiched between stack frames

- Severity: high
- Confidence: high
- Lens: correctness
- Files: .tmp/opentoken/src/families/generic.ts
- Summary: The contiguous stack trace region detection in compressStackTrace simply takes the index of the first matched stack frame as stackStart and the last matched frame as stackEnd. If there is a non-stack line (such as a critical error description or diagnostic message) sandwiched between two stack frames, it will be treated as a stack frame and completely deleted/omitted from the output.
- Evidence:
  - .tmp/opentoken/src/families/generic.ts:50 - if (stackStart === -1) stackStart = i;
  - .tmp/opentoken/src/families/generic.ts:51 - stackEnd = i;
  - runtime:unit:-tmp-opentoken: confirmed — Deterministic runtime command succeeded: npm test

### DA-008 — Dependency cycle: 7 modules

- Severity: high
- Confidence: high
- Lens: architecture
- Files: src/cli.ts, src/extractors/graph.ts, src/extractors/graphManifestEdges.ts, src/index.ts, src/orchestrator/advance.ts, src/orchestrator/autoFixExecutor.ts, src/orchestrator/internalExecutors.ts, src/orchestrator/reviewPackets.ts
- Summary: Circular dependency among src/index.ts → src/cli.ts → src/orchestrator/advance.ts → src/orchestrator/autoFixExecutor.ts → src/orchestrator/internalExecutors.ts → src/extractors/graph.ts → src/extractors/graphManifestEdges.ts → src/index.ts. Cycles increase coupling, complicate testing, and can cause initialization-order bugs.
- Evidence:
  - runtime:flow:flow:surface:src-cli-ts: confirmed — Deterministic runtime command succeeded: npm test

### COR-011 — Diff folding drops blank single-space context lines

- Severity: high
- Confidence: high
- Lens: correctness
- Files: .tmp/opentoken/src/folding.ts
- Summary: foldDiff ignores diff context lines that consist of a single space because it only counts context lines longer than one character, which can corrupt diff preservation for blank lines.
- Evidence:
  - .tmp/opentoken/src/folding.ts - foldDiff only treats a line as context if line.startsWith(' ') && line.length > 1, dropping blank diff context lines.
  - .tmp/opentoken/src/folding.ts - empty diff lines are valid context and should be preserved or summarized, not skipped entirely.
  - runtime:unit:-tmp-opentoken: confirmed — Deterministic runtime command succeeded: npm test

### COR-007 — Directory filtering and grouping bugs on Windows due to slash-only patterns

- Severity: high
- Confidence: high
- Lens: correctness
- Files: .tmp/opentoken/.opencode/plugins/opentoken/families/fs.ts, .tmp/opentoken/.opencode/plugins/opentoken/families/fs.ts, .tmp/opentoken/.opencode/plugins/opentoken/filters/glob.ts, .tmp/opentoken/.opencode/plugins/opentoken/filters/glob.ts
- Summary: Both filterFind (fs.ts) and filterGlob (glob.ts) use forward-slash-only delimiters when checking for noise directories (e.g. `/${d}/` and `${d}/`). On Windows, path separators are backslashes, so these checks never match Windows-style paths such as `node_modules\index.js` or `C:\foo\node_modules\bar`, causing all noise directories to leak through the filter and pollute LLM context. Additionally, the top-level directory grouping logic uses `path.split('/')[0] || '.'`: for any absolute Unix path (e.g. `/usr/src/file.ts`), `split('/')[0]` returns an empty string, triggering the fallback to `'.'`, so all absolute paths are incorrectly grouped under the dot-directory instead of their true top-level directories. For Windows absolute paths (e.g. `C:\foo\bar.ts`), the same split returns the entire raw path as index-0, preventing meaningful directory grouping. Both sub-issues are directly confirmed in the code under review and the finding should stand at high/high.
- Evidence:
  - .tmp/opentoken/.opencode/plugins/opentoken/families/fs.ts:49 - '!NOISE_DIRS.some((d) => l.includes(`/${d}/`) || l.startsWith(`${d}/`))'
  - .tmp/opentoken/.opencode/plugins/opentoken/filters/glob.ts:27 - '!NOISE_DIRS.some((d) => p.includes(`/${d}/`) || p.startsWith(`${d}/`))'
  - .tmp/opentoken/.opencode/plugins/opentoken/families/fs.ts:49 - `!NOISE_DIRS.some((d) => l.includes(\`/${d}/\`) || l.startsWith(\`${d}/\`))` — forward-slash delimiters only; backslash-separated Windows paths bypass this check entirely.
  - .tmp/opentoken/.opencode/plugins/opentoken/families/fs.ts:59 - `const top = line.split("/")[0] || "."` — for absolute Unix paths the split yields an empty string at index 0, collapsing all absolute paths into the synthetic '.' bucket.
  - .tmp/opentoken/.opencode/plugins/opentoken/filters/glob.ts:27 - `!NOISE_DIRS.some((d) => p.includes(\`/${d}/\`) || p.startsWith(\`${d}/\`))` — identical forward-slash-only filtering flaw in filterGlob.
  - .tmp/opentoken/.opencode/plugins/opentoken/filters/glob.ts:41 - `const top = path.split("/")[0] || "."` — same absolute-path grouping defect in filterGlob; Windows paths with backslashes are not split at all, so the entire raw path becomes the spurious 'top' key.
  - runtime:unit:-tmp-opentoken: confirmed — Deterministic runtime command succeeded: npm test

### COR-010 — Empty context line dropping in diff folding

- Severity: high
- Confidence: high
- Lens: correctness
- Files: .tmp/opentoken/.opencode/plugins/opentoken/folding.ts, .tmp/opentoken/.opencode/plugins/opentoken/folding.ts
- Summary: Empty context lines in git diff hunks (represented as a single space character ' ') are silently dropped by foldDiff. The guard condition at line 37 — `line.startsWith(' ') && line.length > 1` — correctly identifies non-empty context lines but excludes single-space lines (length === 1). These lines then fall through the entire if-block: they do not increment contextRun, do not trigger the added/removed flushing path, and are not pushed to result. Any blank line in the surrounding code context in a git diff will therefore be silently omitted from the folded output, producing an inaccurate representation of the diff. The finding stands: impact is confirmed, evidence is precise, and scope is limited to foldDiff in this file.
- Evidence:
  - .tmp/opentoken/.opencode/plugins/opentoken/folding.ts:37 - 'if (line.startsWith(" ") && line.length > 1)'
  - runtime:unit:-tmp-opentoken: confirmed — Deterministic runtime command succeeded: npm test
  - .tmp/opentoken/.opencode/plugins/opentoken/folding.ts:37 - `if (line.startsWith(' ') && line.length > 1)` — single-space context lines (length===1) fail this guard and are not counted in contextRun.
  - .tmp/opentoken/.opencode/plugins/opentoken/folding.ts:43-53 — flushing block only executes when contextRun > 0; a dropped space line never increments contextRun so it cannot be recovered via flushing.
  - .tmp/opentoken/.opencode/plugins/opentoken/folding.ts:56 — the final gate `line.startsWith('+') || line.startsWith('-')` is also false for a bare space, so the line is never added to result.
  - Net effect: every blank line in diff context (a very common case in real code) is silently deleted from the folded output, making the folded diff structurally incorrect.

### REL-001 — File lock release failures can mask original errors and leak locks

- Severity: high
- Confidence: high
- Lens: reliability
- Files: src/quota/fileLock.ts
- Summary: withFileLock always calls releaseLock in a finally block, but if releaseLock throws, it can override the original operation error and leave the lock file stale, increasing recovery risk.
- Evidence:
  - src/quota/fileLock.ts - withFileLock uses a finally block that awaits releaseLock(), allowing lock cleanup failures to surface instead of preserving the original failure.
  - src/quota/fileLock.ts - releaseLock rethrows unexpected errors, so a failed unlink can mask the wrapped function's error and cause stale locks.
  - runtime:flow:flow:surface:src-prompts-renderWorkerPrompt-ts: confirmed — Deterministic runtime command succeeded: npm test
  - runtime:flow:flow:surface:src-types-workerResult-ts: confirmed — Deterministic runtime command succeeded: npm test
  - runtime:flow:flow:surface:src-types-workerSession-ts: confirmed — Deterministic runtime command succeeded: npm test
  - runtime:flow:flow:surface:tests-render-worker-prompt-test-mjs: confirmed — Deterministic runtime command succeeded: npm test

### COR-011 — foldDiff replaces actual surrounding context lines with literal string

- Severity: high
- Confidence: high
- Lens: correctness
- Files: .tmp/opentoken/src/folding.ts
- Summary: When keeping short context runs (<= 3 lines) in foldDiff, the function pushes the literal string '  [context]' to the result instead of the actual surrounding code line content. This completely destroys the helpful code context surrounding the diff, rendering the foldDiff feature useless and causing high data loss of actual code.
- Evidence:
  - .tmp/opentoken/src/folding.ts:52 - result.push("  [context]");
  - runtime:unit:-tmp-opentoken: confirmed — Deterministic runtime command succeeded: npm test

### COR-006 — Glob and Find filters fail to filter noise directories on Windows

- Severity: high
- Confidence: high
- Lens: correctness
- Files: .tmp/opentoken/src/filters/glob.ts, .tmp/opentoken/src/families/fs.ts
- Summary: The noise directory filtering in filterGlob and filterFind splits and checks paths using only forward slashes (/). On Windows systems where backslashes (\) are used as path separators, the noise path matching checks fail completely, exposing unwanted noise directories in the final output.
- Evidence:
  - .tmp/opentoken/src/filters/glob.ts:28 - !NOISE_DIRS.some((d) => p.includes(`/${d}/`) || p.startsWith(`${d}/`))
  - .tmp/opentoken/src/families/fs.ts:50 - !NOISE_DIRS.some((d) => l.includes(`/${d}/`) || l.startsWith(`${d}/`))
  - runtime:unit:-tmp-opentoken: confirmed — Deterministic runtime command succeeded: npm test

### COR-009 — Grep filter fails to filter noise patterns on Windows

- Severity: high
- Confidence: high
- Lens: correctness
- Files: .tmp/opentoken/src/filters/grep.ts
- Summary: The regexes in NOISE_PATTERNS in filterGrep explicitly match forward slashes (e.g. /node_modules\//). On Windows where paths are reported with backslashes (\), these regex matches fail completely, causing grep noise files to bypass the filter and pollute the LLM context.
- Evidence:
  - .tmp/opentoken/src/filters/grep.ts:4 - /node_modules\//
  - runtime:unit:-tmp-opentoken: confirmed — Deterministic runtime command succeeded: npm test

### OBS-007 — Highly non-portable Bun.spawn calls for directory and file operations

- Severity: high
- Confidence: high
- Lens: observability
- Files: .tmp/opentoken/src/progressive.ts, .tmp/opentoken/src/rewind.ts
- Summary: Both progressive.ts and rewind.ts run Unix shell utilities (mkdir -p and rm -f) via Bun.spawn instead of using cross-platform fs.mkdirSync or fs.rmSync. This throws execution errors on Windows, completely breaking these observability stages.
- Evidence:
  - .tmp/opentoken/src/progressive.ts:43 - Bun.spawn(['mkdir', '-p', ...]) fails on Windows platforms.
  - .tmp/opentoken/src/rewind.ts:152 - Bun.spawn(['rm', '-f', ...]) fails on Windows platforms.
  - runtime:unit:-tmp-opentoken: confirmed — Deterministic runtime command succeeded: npm test

### COR-005 — Incomplete private key redaction exposes private key bodies

- Severity: high
- Confidence: high
- Lens: correctness
- Files: .tmp/opentoken/.opencode/plugins/opentoken/utils/secrets.ts, .tmp/opentoken/.opencode/plugins/opentoken/utils/secrets.ts
- Summary: The private key regex pattern at line 38 of secrets.ts only matches the PEM header line (e.g. '-----BEGIN RSA PRIVATE KEY-----'). It does not match the subsequent base64-encoded body lines or the footer ('-----END ... PRIVATE KEY-----'). Because `redactSecrets` uses `text.replace(COMPILED_SECRET_RE, REDACTED)` with `gi` flags, only the header is replaced; the entire private key body—the actual sensitive cryptographic material—remains fully unredacted in any output that passes through this function. The finding stands and should not be downgraded: the impact is high because a private key with its header redacted but its body intact is trivially recoverable. Scope is narrow (single pattern within SECRET_PATTERNS_SOURCE), but the affected function is the sole secret-redaction guard for the plugin, making the blast radius wide.
- Evidence:
  - .tmp/opentoken/.opencode/plugins/opentoken/utils/secrets.ts:38 - "-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----"
  - runtime:flow:flow:surface:src-types-workerSession-ts: confirmed — Deterministic runtime command succeeded: npm test
  - runtime:unit:-tmp-opentoken: confirmed — Deterministic runtime command succeeded: npm test
  - .tmp/opentoken/.opencode/plugins/opentoken/utils/secrets.ts:38 - Pattern '-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----' matches only the PEM header line; no pattern covers base64 body lines or the matching END footer.
  - .tmp/opentoken/.opencode/plugins/opentoken/utils/secrets.ts:42 - COMPILED_SECRET_RE is built by joining all patterns with '|', so the omission propagates directly into the compiled regex used by redactSecrets.
  - .tmp/opentoken/.opencode/plugins/opentoken/utils/secrets.ts:45-47 - redactSecrets() performs a single regex replace over the input text; without a pattern covering the body lines, all base64 key material passes through unredacted.
  - Verification: no other pattern in SECRET_PATTERNS_SOURCE covers multi-line PEM body content (e.g. /^[A-Za-z0-9+/]{64}=$/ style lines); the gap is confirmed.
  - Verdict: finding STANDS at high/high. A fix requires either (a) a regex spanning header+body+footer with DOTALL semantics, or (b) a separate pattern for the footer and a heuristic for body lines, along with enabling the 's' (dotAll) flag.

### OBS-003 — Incorrect Aggregation in Family-Level Metrics Telemetry

- Severity: high
- Confidence: high
- Lens: observability
- Files: .tmp/opentoken/.opencode/plugins/opentoken/utils/stats.ts
- Summary: The byFamily metrics summary incorrectly groups stats by tool instead of family due to calling computeToolStats, causing family-level metrics to be completely broken and misleading.
- Evidence:
  - .tmp/opentoken/.opencode/plugins/opentoken/utils/stats.ts:150 - byFamily: computeToolStats(entries) aggregates by entry.tool instead of entry.family.
  - runtime:unit:-tmp-opentoken: confirmed — Deterministic runtime command succeeded: npm test

### COR-002 — Index-modulo sampling breaks fuzzy similarity matching on shifted strings in jaccardSimilarity

- Severity: high
- Confidence: high
- Lens: correctness
- Files: .tmp/opentoken/.opencode/plugins/opentoken/dedup.ts, .tmp/opentoken/.opencode/plugins/opentoken/dedup.ts, .tmp/opentoken/.opencode/plugins/opentoken/dedup.ts
- Summary: The jaccardSimilarity function (lines 29-51) samples words using an index-modulo strategy: `wordsA.filter((_, i) => i % Math.ceil(wordsA.length / MAX_WORDS) === 0)`. This approach is position-sensitive: inserting or prepending a single word shifts all indices, causing previously overlapping samples to diverge completely. Two strings that are 99% identical (differing only by a prepended word) can yield a computed similarity near zero, causing the deduplicator to treat them as distinct and emit both outputs. Conversely, since the sampling stride is deterministic and not randomized, adversarially or coincidentally structured inputs could produce false-positive similarity matches. Additionally, when a duplicate is detected (lines 87-94), the original content is silently dropped and replaced by a reference stub, which constitutes destructive data loss for any call where the content was slightly modified from a prior output. The finding from part-1 is confirmed: the evidence is accurate, the affected code is real, and the impact is as described. The finding should stand at high/high.
- Evidence:
  - .tmp/opentoken/.opencode/plugins/opentoken/dedup.ts:34 - 'wordsA.filter((_, i) => i % Math.ceil(wordsA.length / MAX_WORDS) === 0)'
  - runtime:unit:-tmp-opentoken: confirmed — Deterministic runtime command succeeded: npm test
  - .tmp/opentoken/.opencode/plugins/opentoken/dedup.ts:34 - `wordsA.filter((_, i) => i % Math.ceil(wordsA.length / MAX_WORDS) === 0)` selects only words at positions 0, N, 2N, ... — inserting a word at position 0 shifts all indices so the two samples share zero words despite near-identical content.
  - .tmp/opentoken/.opencode/plugins/opentoken/dedup.ts:38-41 - Same modulo-based sampling applied to wordsB; when combined with the shifted wordsA, the resulting Sets are disjoint, yielding intersection=0 and similarity=0 regardless of actual textual overlap.
  - .tmp/opentoken/.opencode/plugins/opentoken/dedup.ts:43-47 - Jaccard intersection is computed over the sampled Sets, not the full word lists; a broken sample makes the intersection count unreliable.
  - .tmp/opentoken/.opencode/plugins/opentoken/dedup.ts:87-94 - When a duplicate is detected, deduplicate() returns a fixed reference stub and never calls recordCall(), meaning the incoming content is permanently discarded with no recovery path — any unique modification within the similar content is silently lost.
  - The dedup window is only 16 entries (DEDUP_WINDOW=16, line 12), and the SIMILARITY_THRESHOLD is 0.85 (line 13). With a broken similarity metric, the threshold is never reliably reached via fuzzy matching; only exact hash matches (line 62-64) remain functional, reducing the module's effectiveness to exact-duplicate detection only.

### COR-001 — Ineffective isCodeLine Protection in applyUltraCompression — Finding Confirmed

- Severity: high
- Confidence: high
- Lens: correctness
- Files: .tmp/opentoken/.opencode/plugins/opentoken/autoescalate.ts
- Summary: Deepening review confirms COR-001 stands at high/high. The code-line protection block inside applyUltraCompression (lines 174–179) is a complete no-op: both branches of the isCodeLine conditional return the unmodified line, so the map transformation has zero effect. Critically, the phrase-replacement loop that follows (lines 222–224) then operates on the full, unguarded result string and applies all regex substitutions globally across every line, including code lines. This means source code fragments surfaced in tool outputs are corrupted by symbol abbreviations (e.g., 'returns' → '→', 'requires' → '←', 'creates' → '→', 'does not' → '≠'). The affected scope is broad: any structured or code-bearing text passed through applyUltraCompression or applyCeilingCompression (which delegates to applyUltraCompression for inputs under 30 lines) is subject to this corruption. The bug is not latent or edge-case — it fires on every invocation at ULTRA or CEILING compression level whenever the input contains any of the 36 matched phrases. No narrowing is warranted; the severity and confidence assessments from part-1 are accurate.
- Evidence:
  - Lines 174–178: The map callback unconditionally returns `line` in both branches of the isCodeLine conditional — `if (isCodeLine) return line; return line;` — making the entire protection block a no-op that does not prevent code lines from being modified.
  - Lines 222–224: `result = result.replace(pattern, replacement)` is called for each of the 36 phraseReplacements against the full, unguarded string, so code lines are exposed to all substitutions despite the intent to protect them.
  - Line 170: applyUltraCompression is called by applyCeilingCompression (line 274) for inputs ≤30 lines, extending the bug's reach to CEILING compression level as well.
  - The prototype of a correct fix would require filtering the phraseReplacements to apply only on lines where isCodeLine is false, then rejoining — the current implementation never does this.
  - Affected compression triggers: ULTRA (≥70% fill) and CEILING (≥85% fill) both invoke this path. At these fill percentages the AI is actively under context pressure, making code output corruption most likely to occur at exactly the wrong time.
  - runtime:unit:-tmp-opentoken: confirmed — Deterministic runtime command succeeded: npm test

### DR-002 — Line-count authority is split across snapshots

- Severity: high
- Confidence: high
- Lens: architecture
- Files: src/cli.ts, src/prompts/renderWorkerPrompt.ts, src/validation/auditResults.ts, src/orchestrator/reviewPackets.ts
- Summary: Packet prompts, submit-packet, merge-and-ingest, and final result ingestion do not share one clear authority for file line counts. submit-packet and the first merge validation derive their lineIndex from pending-audit-tasks.json, while runAuditStep revalidates the merged aggregate against a freshly built repo manifest line index. When source files changed after dispatch, redispatched packets could be accepted against stale task counts and then rejected during ingestion against current counts, requiring manual task-state repair. Pick one invariant and encode it everywhere: either freeze the repo snapshot for the entire dispatch run, or make retry dispatch regenerate task file_line_counts and worker prompts from current files before accepting results. The retry-dispatch path should repair counts automatically and explain which files changed.
- Evidence:
  - runtime:flow:flow:surface:src-cli-ts: confirmed — Deterministic runtime command succeeded: npm test
  - runtime:flow:flow:surface:src-prompts-renderWorkerPrompt-ts: confirmed — Deterministic runtime command succeeded: npm test
  - runtime:flow:flow:surface:src-types-workerResult-ts: confirmed — Deterministic runtime command succeeded: npm test
  - runtime:flow:flow:surface:src-types-workerSession-ts: confirmed — Deterministic runtime command succeeded: npm test
  - runtime:flow:flow:surface:tests-render-worker-prompt-test-mjs: confirmed — Deterministic runtime command succeeded: npm test
  - runtime:unit:src-validation: confirmed — Deterministic runtime command succeeded: npm test

### COR-014 — LTSC compression corrupts data and loses content when repeating sequences contain commas or equals signs

- Severity: high
- Confidence: high
- Lens: correctness
- Files: .tmp/opentoken/src/ltsc.ts
- Summary: The LTSC compression serializes its dictionary as a comma-separated list of token=substring pairs. If a repeated substring contains commas (,) or equals signs (=), the split(',') and split('=') parsing logic in decompressLTSC will incorrectly split the substring itself, causing corrupted decompressions and data loss.
- Evidence:
  - .tmp/opentoken/src/ltsc.ts:174 - for (const entry of dictStr.split(","))
  - runtime:unit:-tmp-opentoken: confirmed — Deterministic runtime command succeeded: npm test

### COR-014 — LTSC savings formula assumes fixed token length

- Severity: high
- Confidence: high
- Lens: correctness
- Files: .tmp/opentoken/src/ltsc.ts
- Summary: compressLTSC assumes every meta-token is exactly 2 characters, but tokens like §10 are longer, causing incorrect savings estimates and potentially invalid compression decisions.
- Evidence:
  - .tmp/opentoken/src/ltsc.ts - findRepeatedSubstrings uses a fixed 2-character cost for meta-tokens, yet token values can be 3+ characters when indexes exceed 9.
  - .tmp/opentoken/src/ltsc.ts - miscomputed savings can allow compressions that do not actually reduce output size.
  - runtime:unit:-tmp-opentoken: confirmed — Deterministic runtime command succeeded: npm test

### COR-015 — LZW compressor uses incorrect replacement selection and marker sizing

- Severity: high
- Confidence: high
- Lens: correctness
- Files: .tmp/opentoken/src/lzw.ts
- Summary: compressLZW enumerates all occurrences of selected substrings instead of the non-overlapping positions chosen during selection and assumes fixed 2-character marker lengths, which can corrupt output and miscalculate savings.
- Evidence:
  - .tmp/opentoken/src/lzw.ts - compressLZW builds replacements for every occurrence of selected substrings, not just the positions approved by selectNonOverlapping.
  - .tmp/opentoken/src/lzw.ts - savings calculation uses fixed markerLen=2, but markers such as $10 are 3 characters, invalidating compression decisions.
  - runtime:unit:-tmp-opentoken: confirmed — Deterministic runtime command succeeded: npm test

### CFG-001 — Manual publish defaults to a live npm release without a branch or environment gate

- Severity: high
- Confidence: high
- Lens: config_deployment
- Files: .github/workflows/publish-package.yml, .github/workflows/publish-package.yml, .github/workflows/publish-package.yml, .github/workflows/publish-package.yml, .github/workflows/publish-package.yml
- Summary: CFG-001 stands. The publish-package workflow can be triggered manually (workflow_dispatch) from any branch or ref because (1) dry_run defaults to 'false', (2) the publish job declares no GitHub Actions environment gate, no branch/ref filter, and no required reviewer, and (3) the live npm publish step only guards on the event type and dry_run input. With id-token: write enabling OIDC trusted publishing, any actor with repository Actions-dispatch permission can publish an arbitrary ref to the public npm registry without a code-review gate. The finding scope is limited to a single workflow file but affects the entire package release surface.
- Evidence:
  - .github/workflows/publish-package.yml:4 - workflow_dispatch is enabled and dry_run defaults to "false" at lines 6-9.
  - .github/workflows/publish-package.yml:36 - The publish job declares permissions but no environment gate or branch/ref condition.
  - .github/workflows/publish-package.yml:128 - The live npm publish step only checks the event/dry_run condition before running npm publish.
  - .github/workflows/publish-package.yml:6-9 � dry_run input is typed choice with default 'false'; a human triggering workflow_dispatch will publish live unless they actively switch to 'true'.
  - .github/workflows/publish-package.yml:36-42 � jobs.publish has no 'environment:' key, meaning GitHub repository environment protection rules (required reviewers, deployment branch restrictions) are not applied; the job also carries no 'if:' condition restricting the triggering ref.
  - .github/workflows/publish-package.yml:45-46 � permissions include id-token: write, enabling OIDC Trusted Publishing; no npm token is needed, so there is no secret-rotation backstop that could limit dispatch abuse.
  - .github/workflows/publish-package.yml:128-135 � The live publish step condition 'github.event_name != workflow_dispatch || inputs.dry_run == false' evaluates to true for all release events and for any workflow_dispatch where dry_run was not explicitly flipped to true, confirming the gate is opt-out rather than opt-in.
  - No branch filter, no environment protection, and no required-reviewer rule is present anywhere in the workflow file that would prevent a dispatch from a non-release ref from reaching npm publish.

### OBS-003 — Metrics parsing failures are discarded silently

- Severity: high
- Confidence: high
- Lens: observability
- Files: .tmp/opentoken/.opencode/plugins/opentoken/utils/stats.ts
- Summary: stats.ts silently skips malformed metrics lines and swallows summary write failures, obscuring broken telemetry ingestion and preventing operators from seeing why stats are incomplete.
- Evidence:
  - .tmp/opentoken/.opencode/plugins/opentoken/utils/stats.ts - parseMetricsFile catches JSON parse failures on metric lines and drops them without reporting malformed entries.
  - .tmp/opentoken/.opencode/plugins/opentoken/utils/stats.ts - saveStatsSummary catches all file write errors silently, so summary generation failures are hidden.
  - runtime:unit:-tmp-opentoken: confirmed — Deterministic runtime command succeeded: npm test

### MNT-003 — Monolithic Orchestrator with High Coupling

- Severity: high
- Confidence: high
- Lens: maintainability
- Files: .tmp/opentoken/src/index.ts
- Summary: The main plugin entry point acts as a monolithic orchestrator that is tightly coupled to every concrete tool filter, resulting in poor modularity.
- Evidence:
  - .tmp/opentoken/src/index.ts:4 - Imports from dozens of specific filter modules.
  - .tmp/opentoken/src/index.ts:1322 - Switch statement mapping tool names directly to their specific pipelines inside execute.after hook.
  - .tmp/opentoken/src/index.ts:580 - Deeply nested switches dispatching specific bash commands to specific families.
  - runtime:unit:-tmp-opentoken: confirmed — Deterministic runtime command succeeded: npm test

### COR-002 — No-op code line protection in ultra compression

- Severity: high
- Confidence: high
- Lens: correctness
- Files: .tmp/opentoken/src/autoescalate.ts, .tmp/opentoken/src/autoescalate.ts
- Summary: applyUltraCompression builds a `protectedLines` array intending to shield code lines from phrase replacements, but both branches of the guard (`if (isCodeLine) return line; return line;`) return the line unchanged. The mapped array is joined back into `result` and then the full 30-pattern phrase-replacement loop (`leads to` → `→`, `creates` → `→`, `requires` → `←`, `is not` → `≠`, etc.) runs against the entire joined string with no per-line exclusion. Any code line whose text contains one of those trigger phrases will have tokens silently replaced with unicode arrows and symbols, corrupting function names, identifiers, and inline comments. The protection code compiles and runs without error but has zero effect.
- Evidence:
  - .tmp/opentoken/src/autoescalate.ts:277 - if (isCodeLine) return line; return line;
  - .tmp/opentoken/src/autoescalate.ts:324 - result = result.replace(pattern, replacement);
  - runtime:unit:-tmp-opentoken: confirmed — Deterministic runtime command succeeded: npm test
  - .tmp/opentoken/src/autoescalate.ts:272-279 — protectedLines map returns `line` in both branches: `if (isCodeLine) return line; return line;` — the isCodeLine boolean is evaluated but never acted upon; both paths produce identical output
  - .tmp/opentoken/src/autoescalate.ts:280 — `result = protectedLines.join('\n')` reassigns the full text with no code-line tagging or separation applied
  - .tmp/opentoken/src/autoescalate.ts:323-325 — `for (const [pattern, replacement] of phraseReplacements) { result = result.replace(pattern, replacement); }` applies all 30 replacements to the entire joined string; code lines receive no exemption
  - Concrete corruption examples: a line like `// leads to higher compression` becomes `// → higher compression`; a TS generic `creates<T>` becomes `→<T>`; `requires: ['dep']` becomes `←: ['dep']`; `is not null` becomes `≠ null` — all without any warning
  - The regex at line 274 recognises code-like lines (import, export, const, function, if, etc.) correctly, but the result of that recognition is discarded — the fix requires splitting code lines from prose lines before phrase substitution and only applying replacements to non-code lines

### OBS-009 — Non-portable bash and mkdir spawn calls in symbol indexing

- Severity: high
- Confidence: high
- Lens: observability
- Files: .tmp/opentoken/src/symbolindex.ts
- Summary: symbolindex.ts invokes Bun.spawn(['bash', '-c', ...]) to run a Unix find command pipeline and Bun.spawn(['mkdir', '-p', ...]) to prepare indexing directories. This fails completely on Windows systems, breaking the symbol index loading and querying system.
- Evidence:
  - .tmp/opentoken/src/symbolindex.ts:291 - Bun.spawn(['bash', '-c', ...]) fails on Windows.
  - .tmp/opentoken/src/symbolindex.ts:347 - Bun.spawn(['mkdir', '-p', ...]) fails on Windows.
  - runtime:unit:-tmp-opentoken: confirmed — Deterministic runtime command succeeded: npm test

### OBS-007 — Offload and rewind failures are silenced without diagnostics

- Severity: high
- Confidence: high
- Lens: observability
- Files: .tmp/opentoken/src/progressive.ts, .tmp/opentoken/src/rewind.ts
- Summary: progressive.ts and rewind.ts suppress file system and offload errors without logging or emitting diagnostics, which hides failures from end users and operators.
- Evidence:
  - .tmp/opentoken/src/progressive.ts - ensureDir() ignores any Bun.spawn errors and falls back silently, so offload directory creation failures are invisible.
  - .tmp/opentoken/src/rewind.ts - compressAndStore catches all write failures and continues without recording or exposing the failure reason.
  - runtime:unit:-tmp-opentoken: confirmed — Deterministic runtime command succeeded: npm test

### COR-005 — Silent data/context loss in filterNpmTest: non-matching lines inside failure blocks are silently dropped

- Severity: high
- Confidence: high
- Lens: correctness
- Files: .tmp/opentoken/.opencode/plugins/opentoken/families/npm.ts
- Summary: The filterNpmTest failure-block accumulation logic (lines 61-74) only appends a line to failureBlock when it matches the failure-detection regex (/FAIL|✗|✘|failed|Error:|at .*\(.*:\d+:\d+\)/). Any line inside an active failure block that does NOT match this regex AND is non-empty falls through all branches with no action, causing it to be silently discarded. In practice this means all diagnostic context lines — test description lines (e.g. '● should return correct value'), expected/received value pairs ('Expected: 42', 'Received: 43'), diff lines ('+ expected', '- received'), and prose error messages — are lost whenever they appear between two regex-matching lines. The finding from part-1 (COR-005, critical/high) is confirmed and stands. The original severity of 'critical' is downgraded slightly to 'high' because the tool is a best-effort output filter and not a correctness-critical path, but the data loss is real and systematic. A secondary related defect is also confirmed: if the final failure block in the output is not terminated by a blank line (e.g. output is truncated or ends immediately after the last failure line), the in-progress failureBlock is never pushed to failures and is silently dropped entirely (lines 70-73 are only reached on an empty-line boundary).
- Evidence:
  - npm.ts:61-67 — The if-branch that accumulates failureBlock only fires when the failure regex matches: `if (/FAIL|✗|✘|failed|Error:|at .*\(.*:\d+:\d+\)/.test(line)) { ... failureBlock.push(line) }`. Lines inside the block that do not match this regex have no handler and are silently skipped.
  - npm.ts:68-74 — The else-if that closes a block triggers only on `line.trim() === ''`. Non-empty, non-matching lines (e.g. 'Expected: 42', 'Received: 43', '● test name', '+ expected') fall through both branches with no action, causing data loss.
  - npm.ts:61 — Regex `/FAIL|✗|✘|failed|Error:|at .*\(.*:\d+:\d+\)/` requires parenthesised call-site format for stack frames (e.g. `at func (file:line:col)`). Stack frames in the format `at file:line:col` (no enclosing parens) do not match and are also silently dropped.
  - npm.ts:70-73 — failureBlock is only flushed to failures when an empty line is encountered. If the output ends without a trailing blank line after the last failure block, that block is silently discarded (not pushed to failures).
  - Scope: all callers of filterNpmTest, including filterNpmOutput (line 107) when the command contains 'test', 'jest', 'mocha', or 'vitest'.
  - runtime:unit:-tmp-opentoken: confirmed — Deterministic runtime command succeeded: npm test

### COR-008 — Stack-trace early-return path bypasses MAX_LINES/MAX_BYTES size limits, allowing unbounded output

- Severity: high
- Confidence: high
- Lens: correctness
- Files: .tmp/opentoken/.opencode/plugins/opentoken/families/generic.ts, .tmp/opentoken/.opencode/plugins/opentoken/families/generic.ts
- Summary: When `filterGeneric` detects more than 5 stack frames (line 17), it immediately returns the result of `compressStackTrace` (line 18) without enforcing the MAX_LINES (80) or MAX_BYTES (20 KB) constraints. Inside `compressStackTrace`, if the guard at line 55 triggers (`stackEnd - stackStart < 4`), the function returns the raw `lines.join("\n")` — the full unmodified output — also with no size cap. As a result, any large output that happens to contain 6+ stack-frame-like lines completely bypasses the filter's stated size contract, potentially delivering hundreds of kilobytes to the caller. The finding stands at high severity. The root cause is a design flaw: the two output paths (stack-trace compression vs. head+tail truncation) are mutually exclusive instead of composed, so compression is never followed by a size check. Narrowing is not warranted because the bypass is total and unconditional on the size-limited path.
- Evidence:
  - Line 17-18: `if (stackFrames.length > 5) { return compressStackTrace(lines) }` — returns immediately, before the MAX_LINES/MAX_BYTES check on lines 22-24.
  - Lines 22-24: size-limit guard is only reached when the stack-trace branch is NOT taken; the two paths are mutually exclusive.
  - Lines 55-56: `if (stackStart === -1 || stackEnd - stackStart < 4) { return lines.join("\n") }` — a second unconditional full-output return inside compressStackTrace, also with no size enforcement.
  - Line 16: `stackFrames` is counted across the entire output (not per contiguous block), so 6 dispersed matching lines are sufficient to trigger the bypass even if no single stack trace has more than 2-3 frames.
  - Comment on line 2 advertises 'Head + tail preservation, UTF-8 safe truncation' as invariants, but these invariants are violated for any output that triggers the stack-trace branch.
  - No secondary size check exists anywhere in the call chain after compressStackTrace returns.
  - runtime:unit:-tmp-opentoken: confirmed — Deterministic runtime command succeeded: npm test

### COR-001 — Symbol extraction loop never advances

- Severity: high
- Confidence: high
- Lens: correctness
- Files: .tmp/opentoken/src/symbolindex.ts
- Summary: extractSymbols iterates with RegExp.exec inside a while loop, but every configured symbol regex lacks the global or sticky flag. On the first matching symbol, exec returns the same match forever and indexing never completes.
- Evidence:
  - .tmp/opentoken/src/symbolindex.ts:51 - symbol regexes such as the function pattern are declared without g or y flags.
  - .tmp/opentoken/src/symbolindex.ts:158 - extractSymbols resets lastIndex and then loops while regex.exec(content) is non-null, which does not advance for non-global regexes.
  - runtime:unit:-tmp-opentoken: confirmed — Deterministic runtime command succeeded: npm test

### COR-001 — Symbol index extension mapping is corrupted by alias handling

- Severity: high
- Confidence: high
- Lens: correctness
- Files: .tmp/opentoken/src/symbolindex.ts
- Summary: symbolindex.ts overwrites valid file-extension pattern mappings when it attempts to create aliases like ts and js, causing detectLanguage to return null for TypeScript/JavaScript files and breaking symbol extraction.
- Evidence:
  - .tmp/opentoken/src/symbolindex.ts - PATTERN_LOOKUP.ts is reassigned from PATTERN_LOOKUP.typescript, but PATTERN_LOOKUP.typescript is undefined, overriding the previously established config.
  - .tmp/opentoken/src/symbolindex.ts - Alias assignments such as PATTERN_LOOKUP.js = PATTERN_LOOKUP.javascript similarly set existing extension mappings to undefined, degrading symbol detection.
  - runtime:unit:-tmp-opentoken: confirmed — Deterministic runtime command succeeded: npm test

### TST-001 — Tests target local 'src/' instead of production plugin directory '.opencode/plugins/opentoken/'

- Severity: high
- Confidence: high
- Lens: tests
- Files: .tmp/opentoken/.opencode/plugins/opentoken/index.ts
- Summary: All tests import modules from the local development 'src/' directory rather than testing the actual production-loaded files located in '.opencode/plugins/opentoken/', allowing behavioral discrepancies to pass silently.
- Evidence:
  - .tmp/opentoken/tests/opentoken.test.ts:11 - Imports target ../src/ instead of ../.opencode/plugins/opentoken/
  - .tmp/opentoken/tests/outputcomp.test.ts:6 - Imports outputcomp from ../src/ rather than production folder
  - .tmp/opentoken/tests/phase4.test.ts:2 - Test suite targets ../src/autoescalate and others instead of .opencode
  - runtime:unit:-tmp-opentoken: confirmed — Deterministic runtime command succeeded: npm test

### COR-001 — Threshold conflict and logic gap in compression auto-escalation/de-escalation logic

- Severity: high
- Confidence: high
- Lens: correctness
- Files: .tmp/opentoken/.opencode/plugins/opentoken/autoescalate.ts
- Summary: The threshold boundaries for de-escalation in the 'deescalate' function conflict with the escalation thresholds in 'computeLevel' (e.g. dropping to 'lean' when fillPct is 0.75, which is still above the 'ultra' threshold of 0.70). It also leaves a massive gap for 'ceiling' (stays at 'ceiling' until it drops below 0.65, even though the escalation threshold is 0.85).
- Evidence:
  - .tmp/opentoken/.opencode/plugins/opentoken/autoescalate.ts:289 - 'if (state.fillPct < 0.45 && state.level !== "off")'
  - .tmp/opentoken/.opencode/plugins/opentoken/autoescalate.ts:296 - 'else if (state.fillPct < 0.65 && state.level === "ceiling")'
  - .tmp/opentoken/.opencode/plugins/opentoken/autoescalate.ts:303 - 'else if (state.fillPct < 0.80 && state.level === "ultra")'
  - runtime:unit:-tmp-opentoken: confirmed — Deterministic runtime command succeeded: npm test

### TST-008 — Total test coverage gap for history compression module

- Severity: high
- Confidence: high
- Lens: tests
- Files: .tmp/opentoken/src/history.ts
- Summary: The entire history.ts module, which implements in-place message compression and command-specific summarizing heuristics, is completely untested by the unit test suite.
- Evidence:
  - .tmp/opentoken/src/history.ts:365 - compressMessagesInPlace is never imported or referenced in any test suite.
  - runtime:unit:-tmp-opentoken: confirmed — Deterministic runtime command succeeded: npm test

### DR-001 — Transient workspace directories enter audit scope

- Severity: high
- Confidence: high
- Lens: architecture
- Files: src/extractors/pathPatterns.ts, src/extractors/disposition.ts, src/extractors/fileInventory.ts, .gitignore
- Summary: The audit scope is currently vulnerable to local scratch directories becoming first-class review units. In this run, .tmp/opentoken was inventoried as 105 files, promoted into its own high-risk unit, and contributed dependency-cycle findings even though it appears to be a transient checkout or tool workspace rather than auditor-lambda source. The disposition layer excludes node_modules, .git, build outputs, generated audit artifacts, and docs, but it does not exclude common temp/cache/worktree roots or honor repository ignore policy. Add a shared scope policy that either honors .gitignore or explicitly excludes temp/cache/tool-workspace directories such as .tmp, tmp, .cache, and hidden generated worktrees unless the user opts them in. Add regression coverage so scratch checkouts cannot distort unit planning, risk scoring, or dispatch volume.

### TST-002 — Zero test coverage for Phase 7 history compression and lossless LTSC compression

- Severity: high
- Confidence: high
- Lens: tests
- Files: .tmp/opentoken/.opencode/plugins/opentoken/history.ts, .tmp/opentoken/.opencode/plugins/opentoken/ltsc.ts
- Summary: Critical compression layers history.ts and ltsc.ts have absolutely zero unit tests or coverage in the entire repository test suite, leaving them highly fragile.
- Evidence:
  - .tmp/opentoken/.opencode/plugins/opentoken/history.ts:1 - History compression mutates message history in-place but has zero tests
  - .tmp/opentoken/.opencode/plugins/opentoken/ltsc.ts:1 - Lossless Token Sequence Compression is implemented here but completely untested
  - runtime:unit:-tmp-opentoken: confirmed — Deterministic runtime command succeeded: npm test

### OBS-003 — Aggressive information loss in markdown content filtering

- Severity: medium
- Confidence: high
- Lens: observability
- Files: .tmp/opentoken/src/filters/read.ts
- Summary: The filterMarkdown function completely drops all non-heading markdown text (paragraphs, tables, lists, etc.) when there is any heading or code block. It also replaces code fences with a generic line count summary without preserving language tags.
- Evidence:
  - .tmp/opentoken/src/filters/read.ts:88-106 - filterMarkdown drops opening code fences and drops all lines that do not start with '#' or form part of code block lines.
  - runtime:unit:-tmp-opentoken: confirmed — Deterministic runtime command succeeded: npm test

### MAINT-006 — Artifact bundle validation is a monolithic cross-artifact checklist

- Severity: medium
- Confidence: high
- Lens: maintainability
- Files: src/validation/artifacts.ts
- Summary: validateArtifactBundle implements required-key checks, normalization for every artifact family, and cross-artifact consistency checks in a single 504-line function. Each new artifact relationship must be wired into the same large routine, increasing edit risk and making targeted validation behavior hard to test or reuse.
- Evidence:
  - src/validation/artifacts.ts:24 - validateArtifactBundle starts a single function that spans to the end of the file at line 527.
  - src/validation/artifacts.ts:29 - the first section performs required-key checks for repo_manifest, unit_manifest, coverage_matrix, graph_bundle, surface_manifest, critical_flows, flow_coverage, risk_register, runtime validation, external analyzer results, audit plan metrics, review packets, and tooling_manifest.
  - src/validation/artifacts.ts:160 - the same function then normalizes many artifact arrays and builds lookup sets/maps before running consistency checks.
  - src/validation/artifacts.ts:225 - the remainder checks repo coverage, disposition, unit references, coverage/unit consistency, flows, runtime validation, external analyzer paths, task line ranges, and review packet line counts in the same body.
  - runtime:unit:src-validation: confirmed — Deterministic runtime command succeeded: npm test

### MAINT-007 — Audit result validation has several oversized rule clusters

- Severity: medium
- Confidence: high
- Lens: maintainability
- Files: src/validation/auditResults.ts
- Summary: auditResults.ts spreads result schema validation across several large functions that still share the same mutable issue-list style and field-path conventions. Adding a result field or verification rule requires touching multiple dense validators and keeping their task, coverage, and lens assumptions aligned manually.
- Evidence:
  - src/validation/auditResults.ts:129 - validateFinding is a 165-line function that validates required finding fields, enum values, affected_files shape, line range ordering, and evidence contents.
  - src/validation/auditResults.ts:326 - validateVerificationFollowupTask and validateVerification add another large verification-specific validation cluster for embedded AuditTask suggestions and verification metadata.
  - src/validation/auditResults.ts:548 - validateAuditResults is a 296-line top-level loop that handles result shape, task metadata matching, file_coverage normalization, assigned-path checks, finding validation, span coverage checks, and verification dispatch.
  - runtime:unit:src-validation: confirmed — Deterministic runtime command succeeded: npm test

### DAT-002 — Audit task schema permits inverted line ranges

- Severity: medium
- Confidence: high
- Lens: data_integrity
- Files: schemas/audit_task.schema.json
- Summary: audit_task.schema.json constrains line range start and end to positive integers but does not reject end values lower than start. The semantic artifact validator treats that shape as invalid, so schema-valid task files can carry impossible ranges into dispatch and prompt generation.
- Evidence:
  - schemas/audit_task.schema.json:34-45 - line_ranges requires path, start, and end, but only gives start and end independent minimum: 1 constraints.
  - src/validation/artifacts.ts:499-504 - the semantic validator separately rejects range.end < range.start, showing the schema contract is weaker than the runtime artifact contract.
  - tests/validation-remediation.test.mjs:117-130 - the test suite expects validateArtifactBundle to reject a range with start 8 and end 4.
  - runtime:flow:flow:surface:src-prompts-renderWorkerPrompt-ts: confirmed — Deterministic runtime command succeeded: npm test
  - runtime:flow:flow:surface:src-types-workerResult-ts: confirmed — Deterministic runtime command succeeded: npm test
  - runtime:flow:flow:surface:src-types-workerSession-ts: confirmed — Deterministic runtime command succeeded: npm test
  - runtime:flow:flow:surface:tests-render-worker-prompt-test-mjs: confirmed — Deterministic runtime command succeeded: npm test
  - runtime:unit:schemas: confirmed — Deterministic runtime command succeeded: npm test

### OBS-001 — Auto-fix drops formatter diagnostics

- Severity: medium
- Confidence: high
- Lens: observability
- Files: src/orchestrator/autoFixExecutor.ts, src/orchestrator/autoFixExecutor.ts
- Summary: The auto-fix executor reduces each formatter attempt to a boolean and persists only executed tool names. When a configured formatter is unresolved, exits nonzero, or has spawn stderr/stdout, the audit artifact and progress summary make it indistinguishable from no applicable formatter being available.
- Evidence:
  - src/orchestrator/autoFixExecutor.ts:16 - runFirstAvailableCommand returns a LocalCommandResult with command, exitCode, stdout, stderr, and error, but tryRunConfiguredFormatter immediately collapses it to a boolean.
  - src/orchestrator/autoFixExecutor.ts:142 - auto_fixes_applied records only executed_tools and timestamp, with no skipped/failed formatter status or stderr/stdout snippet.
  - src/orchestrator/autoFixExecutor.ts:153 - the progress summary reports Formatters executed: None whenever no formatter succeeds, so failed formatter attempts are not observable.

### TST-001 — Auto-fix executor has no behavioral coverage

- Severity: medium
- Confidence: high
- Lens: tests
- Files: src/orchestrator/autoFixExecutor.ts
- Summary: The auto-fix executor chooses and runs formatter commands for multiple language families, but the test suite only checks that the pipeline reaches the auto-fix step. Without direct tests using fake tools or temp repositories, regressions in formatter gating, command fallback order, or missing file_disposition handling can pass.
- Evidence:
  - src/orchestrator/autoFixExecutor.ts:54 - runAutoFixExecutor is exported and throws without file_disposition before deriving formatter decisions from file extensions.
  - src/orchestrator/autoFixExecutor.ts:74 - the executor conditionally runs Prettier, black, sqlfluff, and gofmt command candidates, which is externally visible behavior that is not directly asserted.
  - tests/audit-code-lifecycle.test.mjs:96 - existing auto-fix coverage only asserts next_likely_step is auto_fixes_applied before the next invocation selects auto_fix_executor.

### COR-001 — Auto-fix output does not invalidate syntax resolution

- Severity: medium
- Confidence: high
- Lens: correctness
- Files: src/orchestrator/dependencyMap.ts, src/orchestrator/autoFixExecutor.ts
- Summary: The auto-fix executor writes auto_fixes_applied.json, but that artifact is absent from the dependency metadata graph. Because syntax_resolution_status.json also has no dependency on it, a formatter run can leave a previous syntax-resolution result marked satisfied even though files may have changed.
- Evidence:
  - src/orchestrator/autoFixExecutor.ts:147 - runAutoFixExecutor updates the bundle with auto_fixes_applied and reports auto_fixes_applied.json as written.
  - src/orchestrator/dependencyMap.ts:81 - syntax_resolution_status.json is only modeled as an upstream of audit-report.md; there is no auto_fixes_applied.json entry and no edge from auto fixes to syntax_resolution_status.json.
  - src/orchestrator/state.ts:63 - the syntax_resolved obligation asks staleArtifacts about auto_fixes_applied.json, but staleArtifacts cannot contain that artifact while it is missing from the dependency map and metadata set.

### COR-003 — Batch command arguments are not preserved

- Severity: medium
- Confidence: high
- Lens: correctness
- Files: src/orchestrator/localCommands.ts
- Summary: On Windows, .cmd and .bat candidates are routed through cmd.exe, but quoteForCmd only quotes whitespace and double quotes. Arguments containing cmd metacharacters such as & or | are emitted raw, so valid argument values are parsed as shell syntax instead of being delivered literally.
- Evidence:
  - src/orchestrator/localCommands.ts:18 - quoteForCmd returns arguments without spaces or quotes unchanged.
  - src/orchestrator/localCommands.ts:31 - Windows batch commands are executed through cmd.exe /c.
  - src/orchestrator/localCommands.ts:36 - the command and arguments are joined into one cmd command line, so an argument like a&b is not passed literally.
  - runtime:flow:flow:surface:src-orchestrator-localCommands-ts: confirmed — Deterministic runtime command succeeded: npm test

### MAINT-001 — Bootstrap installer mixes every host surface in one large function

- Severity: medium
- Confidence: high
- Lens: maintainability
- Files: audit-code-wrapper-lib.mjs
- Summary: installBootstrap is a 300-line dispatcher that builds all host asset paths, writes every host-specific surface, creates manifests, initializes session config, and prints the user payload. Adding or changing one host requires touching several distant blocks inside the same function, which makes host support changes hard to isolate safely.
- Evidence:
  - audit-code-wrapper-lib.mjs:2425 - installBootstrap starts by resolving host/root/profile state and then owns the rest of bootstrap generation.
  - audit-code-wrapper-lib.mjs:2439 - the function constructs a single assetPaths object containing Codex, Claude Desktop, OpenCode, VS Code, Antigravity, Gemini, and shared launcher paths.
  - audit-code-wrapper-lib.mjs:2530 - host-specific write branches for Codex, Claude Desktop, OpenCode, VS Code, and Antigravity are all embedded in this same function.
  - audit-code-wrapper-lib.mjs:2641 - the same function then assembles installManifest and the final user-facing payload, so rendering, persistence, and reporting concerns are coupled together.

### MAINT-006 — Brittle regex-based pruning of structured JSON data

- Severity: medium
- Confidence: high
- Lens: maintainability
- Files: .tmp/opentoken/.opencode/plugins/opentoken/postcall.ts
- Summary: Pruning nullish, timestamp, and redundant fields in postcall is done using raw global regular expressions on the text stream instead of JSON parsing. This can inadvertently strip matching substrings inside string values or break JSON syntax by unmatched comma cleanup.
- Evidence:
  - .tmp/opentoken/.opencode/plugins/opentoken/postcall.ts:215 - NULLISH_PATTERNS and other regexes are applied globally to JSON string output
  - .tmp/opentoken/.opencode/plugins/opentoken/postcall.ts:238 - cleanWhitespaceAndNulls replaces matching patterns on raw text, leading to potential data loss inside string literals
  - runtime:unit:-tmp-opentoken: confirmed — Deterministic runtime command succeeded: npm test

### MAINT-001 — Chunked audit task construction is too concentrated

- Severity: medium
- Confidence: high
- Lens: maintainability
- Files: src/orchestrator/taskBuilder.ts
- Summary: buildChunkedAuditTasks mixes pending coverage collection, budget chunking, task id generation, critical-flow grouping, tiny-test grouping, rationale formatting, de-duplication, and final ordering in one mutable routine. Future changes to one scheduling policy require reasoning through a 240-line function with nested helpers that close over shared state.
- Evidence:
  - src/orchestrator/taskBuilder.ts:151 - buildChunkedAuditTasks starts the exported task builder and keeps shared tasks/seen/external path state in the outer function.
  - src/orchestrator/taskBuilder.ts:199 - chunkByTaskBudget is a nested helper that captures maxTaskLines, maxTaskFiles, and unitLineIndex from the outer routine.
  - src/orchestrator/taskBuilder.ts:236 - addTaskBlock is another nested helper that handles oversized-file splitting, task id creation, tag decoration, rationale callbacks, and mutation of tasks/seen.
  - src/orchestrator/taskBuilder.ts:303 - the same routine then claims critical-flow blocks, groups remaining files, handles tiny test review, assigns priorities, formats rationale text, and sorts output before returning.
  - runtime:flow:flow:surface:src-prompts-renderWorkerPrompt-ts: confirmed — Deterministic runtime command succeeded: npm test
  - runtime:flow:flow:surface:src-types-workerResult-ts: confirmed — Deterministic runtime command succeeded: npm test
  - runtime:flow:flow:surface:src-types-workerSession-ts: confirmed — Deterministic runtime command succeeded: npm test
  - runtime:flow:flow:surface:tests-render-worker-prompt-test-mjs: confirmed — Deterministic runtime command succeeded: npm test

### CFG-001 — CI depends on mutable actions and latest Bun

- Severity: medium
- Confidence: high
- Lens: config_deployment
- Files: .tmp/opentoken/.github/workflows/ci.yml
- Summary: The CI workflow uses mutable action tags and installs the latest Bun release on every run. This makes builds non-reproducible and allows upstream tag or runtime changes to alter the pipeline without a repository change.
- Evidence:
  - .tmp/opentoken/.github/workflows/ci.yml:13 - actions/checkout is referenced as @v4 instead of a pinned commit SHA.
  - .tmp/opentoken/.github/workflows/ci.yml:14 - oven-sh/setup-bun is referenced as @v2 instead of a pinned commit SHA.
  - .tmp/opentoken/.github/workflows/ci.yml:16 - bun-version is set to latest, so CI can change as new Bun versions are released.
  - runtime:unit:-tmp-opentoken: confirmed — Deterministic runtime command succeeded: npm test

### COR-003 — Conventional route extraction misroutes root and index routes

- Severity: medium
- Confidence: high
- Lens: correctness
- Files: src/extractors/graph.ts
- Summary: The conventional route builder returns no route for root App Router handlers such as `app/route.ts`, causing the later fallback to emit a synthetic file-path route instead of `/`. It also keeps `index` as a literal segment for Pages API files, so `pages/api/index.ts` and `pages/api/users/index.ts` are reported as `/api/index` and `/api/users/index` rather than `/api` and `/api/users`.
- Evidence:
  - src/extractors/graph.ts:1422 - empty route segment lists return `undefined`, so `app/route.ts` cannot produce `/`.
  - src/extractors/graph.ts:1439 - App Router `route.*` files pass only the folders below `app`; for `app/route.ts` that list is empty.
  - src/extractors/graph.ts:1448 - Pages API handling always appends the filename after stripping the extension, so `index` becomes a real route segment.
  - src/extractors/graph.ts:1792 - when conventional extraction returns nothing, a fallback route is fabricated from the file path.

### TST-002 — Coverage completion transitions lack positive assertions

- Severity: medium
- Confidence: high
- Lens: tests
- Files: src/coverage.ts
- Summary: The core coverage transition from AuditResult.file_coverage to completed_lenses and partial/complete audit_status is not asserted on the positive path. Existing ingestion tests check orchestration progress or a non-required-lens negative case, so regressions that stop valid lenses from completing coverage could slip through.
- Evidence:
  - src/coverage.ts:55 - applyFileCoverage records completed required lenses and sets audit_status to complete or partial.
  - tests/orchestration.test.mjs:327 - the ingestion test asserts executor selection, audit_results length, and next_likely_step, but not updated coverage_matrix completed_lenses or audit_status.
  - tests/orchestrator-remediation.test.mjs:248 - the direct ingestAuditResults test covers only a non-required-lens negative case, leaving valid partial and complete transitions unasserted.

### COR-004 — Custom pip family filter is bypassed due to incorrect generic mapping in FAMILY_MAP

- Severity: medium
- Confidence: high
- Lens: correctness
- Files: .tmp/opentoken/.opencode/plugins/opentoken/families/detect.ts
- Summary: In FAMILY_MAP, "pip" and "pipx" are mapped to "generic" instead of "pip". This prevents the custom pip installer parser in pip.ts from ever executing.
- Evidence:
  - .tmp/opentoken/.opencode/plugins/opentoken/families/detect.ts:27 - '"pip": "generic"'
  - runtime:unit:-tmp-opentoken: confirmed — Deterministic runtime command succeeded: npm test

### DA-004 — Dependency cycle: 2 modules

- Severity: medium
- Confidence: high
- Lens: architecture
- Files: .tmp/opentoken/src/index.ts, .tmp/opentoken/src/router.ts
- Summary: Circular dependency among .tmp/opentoken/src/index.ts → .tmp/opentoken/src/router.ts → .tmp/opentoken/src/index.ts. Cycles increase coupling, complicate testing, and can cause initialization-order bugs.
- Evidence:
  - runtime:unit:-tmp-opentoken: confirmed — Deterministic runtime command succeeded: npm test

### DA-002 — Dependency cycle: 3 modules

- Severity: medium
- Confidence: high
- Lens: architecture
- Files: .tmp/opentoken/.opencode/plugins/opentoken.ts, .tmp/opentoken/.opencode/plugins/opentoken/index.ts, .tmp/opentoken/.opencode/plugins/opentoken/router.ts
- Summary: Circular dependency among .tmp/opentoken/.opencode/plugins/opentoken.ts → .tmp/opentoken/.opencode/plugins/opentoken/index.ts → .tmp/opentoken/.opencode/plugins/opentoken/router.ts → .tmp/opentoken/.opencode/plugins/opentoken.ts. Cycles increase coupling, complicate testing, and can cause initialization-order bugs.
- Evidence:
  - runtime:unit:-tmp-opentoken: confirmed — Deterministic runtime command succeeded: npm test

### DA-005 — Dependency cycle: 4 modules

- Severity: medium
- Confidence: high
- Lens: architecture
- Files: src/cli.ts, src/index.ts, src/io/artifacts.ts, src/io/toolingManifest.ts, src/mcp/server.ts
- Summary: Circular dependency among src/index.ts → src/cli.ts → src/io/artifacts.ts → src/io/toolingManifest.ts → src/index.ts. Cycles increase coupling, complicate testing, and can cause initialization-order bugs.
- Evidence:
  - runtime:flow:flow:surface:src-cli-ts: confirmed — Deterministic runtime command succeeded: npm test

### DR-003 — Design-review findings bypass result validation

- Severity: medium
- Confidence: high
- Lens: architecture
- Files: src/cli.ts, src/orchestrator/designReviewPrompt.ts, schemas/finding.schema.json, src/validation/auditResults.ts
- Summary: The design-review intake path reads design-review-findings.json as Finding[] and only checks that the payload is an array before marking the design assessment reviewed. That means malformed objects, invalid severity/category values, missing affected files, or unrelated JSON arrays can be written into design_assessment.json without the stronger AuditResult/Finding validation used by worker results. Add a schema or typed validator for design-review findings, reuse the canonical finding validation rules where possible, and fail the next-step with actionable errors instead of silently accepting an array shape.
- Evidence:
  - runtime:flow:flow:surface:src-cli-ts: confirmed — Deterministic runtime command succeeded: npm test
  - runtime:unit:schemas: confirmed — Deterministic runtime command succeeded: npm test
  - runtime:unit:src-validation: confirmed — Deterministic runtime command succeeded: npm test

### COR-004 — detectFamily fails to parse Windows backslash paths

- Severity: medium
- Confidence: high
- Lens: correctness
- Files: .tmp/opentoken/src/families/detect.ts
- Summary: detectFamily extracts the command name by splitting the path only with forward slashes (/). On Windows, where backslashes (\) are standard for paths, version manager or wrapper paths are not correctly stripped, leading to failure in detecting the command family.
- Evidence:
  - .tmp/opentoken/src/families/detect.ts:52 - const basename = first.split("/").pop()?.toLowerCase() || "";
  - runtime:unit:-tmp-opentoken: confirmed — Deterministic runtime command succeeded: npm test

### MAINT-004 — Dispatch preparation couples packeting, prompt rendering, anchor extraction, and quota metadata

- Severity: medium
- Confidence: high
- Lens: maintainability
- Files: src/cli.ts
- Summary: prepareDispatchArtifacts is a 400-line routine that builds review packets, extracts large-file anchors, renders the worker prompt contract, writes dispatch maps, computes quota schedules, and emits warnings. Prompt format changes, graph/anchor behavior, and quota behavior are all edited in the same function, making the dispatch contract harder to evolve safely.
- Evidence:
  - src/cli.ts:3063 - prepareDispatchArtifacts begins by resolving run paths, loading tasks, session config, and lens definitions.
  - src/cli.ts:3186 - the function renders packet file lists and then performs large-file anchor extraction in the same packet loop.
  - src/cli.ts:3234 - task sections and file_coverage templates are rendered inline as prompt text inside the same routine.
  - src/cli.ts:3367 - after prompt generation, the same function writes dispatch-plan/result-map files and then computes dispatch quota metadata and warnings.
  - runtime:flow:flow:surface:src-cli-ts: confirmed — Deterministic runtime command succeeded: npm test

### OBS-001 — Dispatch validators silently drop task context

- Severity: medium
- Confidence: high
- Lens: observability
- Files: dispatch/merge-results.mjs, dispatch/validate-result.mjs
- Summary: Both dispatch validation entrypoints ignore failures while reading pending-audit-tasks.json and proceed without warning. When task context is unavailable, operators lose the signal that line-count and task-specific validation was degraded.
- Evidence:
  - dispatch/merge-results.mjs:23 - The merge command attempts to load pending-audit-tasks.json, but the catch block at lines 29-31 suppresses the parse/read error and proceeds without task context.
  - dispatch/validate-result.mjs:38 - The single-result validator has the same silent catch at lines 42-44, so the operator is not told that task-aware validation was skipped.

### MNT-004 — Drifting Duplicates of Noise Directory Arrays

- Severity: medium
- Confidence: high
- Lens: maintainability
- Files: .tmp/opentoken/src/filters/glob.ts, .tmp/opentoken/src/filters/grep.ts
- Summary: The noise directory configuration is duplicated separately in each filter file, resulting in drifting definitions and fragmented filtering logic.
- Evidence:
  - .tmp/opentoken/src/filters/glob.ts:3 - Hardcoded NOISE_DIRS array in glob.ts containing 20 directories (different from fs.ts).
  - .tmp/opentoken/src/filters/grep.ts:3 - Hardcoded NOISE_PATTERNS array in grep.ts.
  - runtime:unit:-tmp-opentoken: confirmed — Deterministic runtime command succeeded: npm test

### OBS-008 — Duplicate stats grouping by tool instead of family in metrics aggregation

- Severity: medium
- Confidence: high
- Lens: observability
- Files: .tmp/opentoken/src/utils/stats.ts
- Summary: In getStatsSummary, the byFamily field is populated by calling computeToolStats(entries). Since computeToolStats groups entries by entry.tool instead of entry.family, the byFamily telemetry is a duplicate of byTool and lists tool names instead of family groups.
- Evidence:
  - .tmp/opentoken/src/utils/stats.ts:150 - byFamily: computeToolStats(entries) aggregates metrics by tool instead of family.
  - runtime:unit:-tmp-opentoken: confirmed — Deterministic runtime command succeeded: npm test

### MNT-002 — Duplication of Noise Directories Across Files

- Severity: medium
- Confidence: high
- Lens: maintainability
- Files: .tmp/opentoken/src/families/fs.ts
- Summary: The noise directory exclusion list is hardcoded in multiple files (such as fs.ts and glob.ts), leading to behavioral drift.
- Evidence:
  - .tmp/opentoken/src/families/fs.ts:3 - Hardcoded NOISE_DIRS array in fs.ts containing 18 directories.
  - runtime:unit:-tmp-opentoken: confirmed — Deterministic runtime command succeeded: npm test

### MNT-002 — Executor routing metadata is scattered across separate tables

- Severity: medium
- Confidence: high
- Lens: maintainability
- Files: src/orchestrator/executors.ts, src/orchestrator/nextStep.ts, src/orchestrator/advance.ts
- Summary: The pipeline executor contract is maintained in three places: the registry that maps executor ids to obligations, the priority list that selects obligations, and the advance switch that actually invokes executors. A new executor or obligation must be threaded through all three manually, increasing the chance that future changes drift or become partially wired.
- Evidence:
  - src/orchestrator/executors.ts:7 - EXECUTOR_REGISTRY declares executor ids and the obligation ids each executor handles.
  - src/orchestrator/nextStep.ts:13 - PRIORITY separately hard-codes the order of obligation ids, while decideNextStep later searches EXECUTOR_REGISTRY for the matching executor.
  - src/orchestrator/advance.ts:99 - advanceAudit repeats the executor ids in a large switch and separately encodes required options and invocation logic for each executor.

### COR-004 — Explicit relative YAML references can resolve to the wrong file

- Severity: medium
- Confidence: high
- Lens: correctness
- Files: src/extractors/graphManifestEdges.ts
- Summary: YAML path reference resolution strips a leading `./` and tries the repository root before the YAML file's directory. When both `shared/config.yaml` and `ci/shared/config.yaml` exist, a reference like `./shared/config.yaml` from `ci/pipeline.yaml` incorrectly resolves to the root file instead of the explicitly relative sibling path.
- Evidence:
  - src/extractors/graphManifestEdges.ts:1408 - the resolver removes a leading `./`, erasing the signal that the specifier was explicitly relative.
  - src/extractors/graphManifestEdges.ts:1411 - the stripped value is resolved as repo-root-relative first.
  - src/extractors/graphManifestEdges.ts:1415 - directory-relative resolution is only a fallback, so it is skipped whenever a root-level file with the same path exists.

### DAT-001 — External analyzer schema rejects recorded tool statuses

- Severity: medium
- Confidence: high
- Lens: data_integrity
- Files: schemas/external_analyzer_results.schema.json
- Summary: The external analyzer result type now carries tool_statuses, and the syntax-resolution executor writes that field into external_analyzer_results.json, but the published schema omits it while forbidding additional properties. Schema validation therefore rejects a first-party artifact shape and can hide analyzer execution diagnostics from schema-conformant consumers.
- Evidence:
  - schemas/external_analyzer_results.schema.json:7-69 - the allowed properties include tool, generated_at, ownership_roots, and results, but no tool_statuses field.
  - schemas/external_analyzer_results.schema.json:71 - additionalProperties is false, so any tool_statuses field is rejected.
  - src/orchestrator/syntaxResolutionExecutor.ts:291-295 - the first-party syntax-resolution artifact is built with tool_statuses alongside tool and results.
  - runtime:unit:schemas: confirmed — Deterministic runtime command succeeded: npm test

### OBS-002 — Failed collapsing of tool history parts in history compression

- Severity: medium
- Confidence: high
- Lens: observability
- Files: .tmp/opentoken/src/history.ts
- Summary: The collapseConsecutiveTools function filters parts by checking part.type === 'text' && part.text.startsWith('['). However, compressed tool parts maintain their type as 'tool' rather than 'text', preventing the method from collapsing any tool output.
- Evidence:
  - .tmp/opentoken/src/history.ts:352 - if (part.type === 'text' && part.text.startsWith('[')) is never true for tool parts since they are kept with type 'tool' by compressMessageParts.
  - runtime:unit:-tmp-opentoken: confirmed — Deterministic runtime command succeeded: npm test

### COR-004 — Family stats are grouped by tool names

- Severity: medium
- Confidence: high
- Lens: correctness
- Files: .tmp/opentoken/src/utils/stats.ts
- Summary: getStatsSummary populates byFamily by calling the tool-keyed aggregation helper, so family summaries are actually keyed by tool. The stats output cannot report aggregate savings by family as the type promises.
- Evidence:
  - .tmp/opentoken/src/utils/stats.ts:75 - computeToolStats groups entries by entry.tool.
  - .tmp/opentoken/src/utils/stats.ts:149 - byTool uses computeToolStats(entries).
  - .tmp/opentoken/src/utils/stats.ts:150 - byFamily also uses computeToolStats(entries), so it is not grouped by entry.family.
  - runtime:unit:-tmp-opentoken: confirmed — Deterministic runtime command succeeded: npm test

### COR-007 — filterFind groups all absolute paths under dot directory

- Severity: medium
- Confidence: high
- Lens: correctness
- Files: .tmp/opentoken/src/families/fs.ts
- Summary: When grouping files by top-level directory in filterFind, the code does a split('/') and takes index 0. For absolute paths starting with /, index 0 is an empty string, which causes all absolute paths to be incorrectly grouped under '.' (the dot directory).
- Evidence:
  - .tmp/opentoken/src/families/fs.ts:60 - const top = line.split("/")[0] || ".";
  - runtime:unit:-tmp-opentoken: confirmed — Deterministic runtime command succeeded: npm test

### COR-001 — Finding evidence is optional in the shared type

- Severity: medium
- Confidence: high
- Lens: correctness
- Files: src/types.ts
- Summary: The shared Finding interface makes evidence optional, so TypeScript consumers can emit findings that violate the audit result contract. This already permits deterministic design assessment findings to be constructed without any evidence.
- Evidence:
  - src/types.ts:107 - Finding.evidence is declared optional even though audit findings are required to carry evidence.
  - src/extractors/designAssessment.ts:83 - detectCycleFindings returns Finding objects with id/title/category/severity/confidence/lens/summary/affected_files/systemic but no evidence.
  - src/extractors/designAssessment.ts:293 - buildDesignAssessment gathers those Finding objects into the returned design assessment findings array.

### TEST-WRAPPER-001 — Generated packet submit flags are not exercised

- Severity: medium
- Confidence: high
- Lens: tests
- Files: audit-code-wrapper-lib.mjs, audit-code-wrapper-lib.mjs
- Summary: The wrapper documents and forwards packet submission commands used by generated prompts, including base64-scoped arguments, but the wrapper tests only exercise raw submit-packet arguments. A regression in pass-through or base64 submit support could break generated packet prompts while the current tests still pass.
- Evidence:
  - audit-code-wrapper-lib.mjs:266 - help exposes submit-packet and notes generated packet prompts may use --run-id-b64, --task-id-b64, and --artifacts-dir-b64.
  - audit-code-wrapper-lib.mjs:2853 - the wrapper forwards submit-packet arguments to the dist CLI without its own assertions around the generated-prompt flag shape.
  - tests/audit-code-wrapper.test.mjs:533 - existing submit-packet tests use raw --run-id, --packet-id, and --artifacts-dir arguments; repository search found no wrapper test using --run-id-b64, --packet-id-b64, --artifacts-dir-b64, or --results-b64.

### COR-016 — getMemoryStats returns newest session memory timestamp instead of oldest

- Severity: medium
- Confidence: high
- Lens: correctness
- Files: .tmp/opentoken/src/memory.ts
- Summary: getMemoryStats accesses entries[entries.length - 1].ts to determine the oldest memory entry. However, because memory.jsonl is append-only, index entries.length - 1 represents the newest appended entry, causing the statistics to report the newest memory session as the oldest.
- Evidence:
  - .tmp/opentoken/src/memory.ts:365 - entries[entries.length - 1].ts
  - runtime:unit:-tmp-opentoken: confirmed — Deterministic runtime command succeeded: npm test

### COR-010 — Go symbol extraction fails to match receiver functions

- Severity: medium
- Confidence: high
- Lens: correctness
- Files: .tmp/opentoken/src/filters/read.ts
- Summary: The regex pattern used to extract Go symbols expects func to be immediately followed by a space and a word character (func \w+). Go methods/receiver functions (e.g., func (s *Store) Get) do not match this pattern and are completely omitted from the symbols outline.
- Evidence:
  - .tmp/opentoken/src/filters/read.ts:46 - Go: [/^(func|type|var|const)\s+(\w+)/gm]
  - runtime:unit:-tmp-opentoken: confirmed — Deterministic runtime command succeeded: npm test

### OBS-GRAPH-001 — Graph extraction hides unreadable files

- Severity: medium
- Confidence: high
- Lens: observability
- Files: src/extractors/graph.ts, src/extractors/graph.ts
- Summary: buildGraphBundleFromFs catches all readFile failures for graph-readable files and records no skipped-file diagnostic before buildGraphBundle gates content-derived extraction on fileContents. A permission, encoding, or transient read failure can remove imports, references, routes, and suite links from graph artifacts with no warning for operators.
- Evidence:
  - src/extractors/graph.ts:1669 - The file read is wrapped in a catch-all block whose only action is a best-effort comment.
  - src/extractors/graph.ts:1738 - Content-derived graph extraction only runs when options.fileContents has content for the file, so read failures silently omit edges.

### MNT-002 — Graph extraction logic is concentrated in one module

- Severity: medium
- Confidence: high
- Lens: maintainability
- Files: src/extractors/graph.ts, src/extractors/graph.ts, src/extractors/graph.ts, src/extractors/graph.ts, src/extractors/graph.ts
- Summary: graph.ts centralizes source selection, JS/TS import parsing, Python parsing, schema refs, route discovery, test/suite links, external analyzer ownership, and graph assembly in a single 1,824-line module. Adding a language or edge type requires editing the same large file and long buildGraphBundle orchestration path, increasing regression risk across unrelated extractors.
- Evidence:
  - src/extractors/graph.ts:42 - SOURCE_LANGUAGES and SOURCE_EXTENSIONS mix TypeScript, JavaScript, JSON, HTML, YAML, Python, Go, Rust, Java, and C# eligibility in the graph module.
  - src/extractors/graph.ts:461 - Python-specific parsing helpers span hundreds of lines before extractPythonImportEdges starts at line 817.
  - src/extractors/graph.ts:1680 - buildGraphBundle directly invokes import, Python, reference, schema, package, browser-extension, workspace, Go, Cargo, Maven, pyproject, YAML, route, test-source, analyzer-ownership, conftest, and suite extractors from one loop.

### OBS-001 — Hardcoded "unknown" Tool Name in Global Error Logging Telemetry

- Severity: medium
- Confidence: high
- Lens: observability
- Files: .tmp/opentoken/.opencode/plugins/opentoken/index.ts, .tmp/opentoken/.opencode/plugins/opentoken/index.ts
- Summary: The safeStage and safeStageAsync error handling wrappers log all pipeline stage failures with a hardcoded tool name of "unknown", losing critical tool-specific execution context.
- Evidence:
  - .tmp/opentoken/.opencode/plugins/opentoken/index.ts:331 - safeStage calls logError with hardcoded tool: "unknown"
  - .tmp/opentoken/.opencode/plugins/opentoken/index.ts:354 - safeStageAsync calls logError with hardcoded tool: "unknown"
  - runtime:unit:-tmp-opentoken: confirmed — Deterministic runtime command succeeded: npm test

### TST-003 — Hysteresis test asserts and pins auto-escalation/de-escalation oscillation bug

- Severity: medium
- Confidence: high
- Lens: tests
- Files: .tmp/opentoken/.opencode/plugins/opentoken/precall.ts
- Summary: The test suite in phase4.test.ts asserts and pins an oscillation bug where deescalate sets lean but updateContext immediately re-escalates to ultra.
- Evidence:
  - .tmp/opentoken/tests/phase4.test.ts:91 - Test 'OSCILLATION WARNING: de-escalate ultra?lean at <80% conflicts with escalate ultra at >=70%' pins conflicting behavior
  - runtime:unit:-tmp-opentoken: confirmed — Deterministic runtime command succeeded: npm test

### TST-002 — Hysteresis test pins level oscillation conflict as expected behavior

- Severity: medium
- Confidence: high
- Lens: tests
- Files: .tmp/opentoken/src/autoescalate.ts
- Summary: The test suite in tests/phase4.test.ts pins a level-oscillation conflict between de-escalate and updateContext as expected behavior, asserting incorrect behavior as correct.
- Evidence:
  - .tmp/opentoken/tests/phase4.test.ts:91 - Test 'OSCILLATION WARNING: de-escalate ultra???lean at <80% conflicts with escalate ultra at >=70%' asserts oscillation as expected behavior instead of verifying correct non-oscillating state.
  - runtime:unit:-tmp-opentoken: confirmed — Deterministic runtime command succeeded: npm test

### COR-003 — Inability to detect command families correctly on Windows due to forward-slash only path splitting

- Severity: medium
- Confidence: high
- Lens: correctness
- Files: .tmp/opentoken/.opencode/plugins/opentoken/families/detect.ts
- Summary: Path extraction in detectFamily splits only by forward slashes (/), failing to isolate the basename for relative/absolute commands utilizing Windows backslashes (\). This prevents matching command basenames to FAMILY_MAP keys.
- Evidence:
  - .tmp/opentoken/.opencode/plugins/opentoken/families/detect.ts:51 - 'const basename = first.split("/").pop()?.toLowerCase() || ""'
  - runtime:unit:-tmp-opentoken: confirmed — Deterministic runtime command succeeded: npm test

### COR-002 — JSON key aliasing can create duplicate keys

- Severity: medium
- Confidence: high
- Lens: correctness
- Files: .tmp/opentoken/src/postcall.ts
- Summary: The long-key map assigns the same alias to distinct keys, so aliasJsonKeys can turn valid JSON with both fields into duplicate-key JSON. Consumers that parse the result will lose one value.
- Evidence:
  - .tmp/opentoken/src/postcall.ts:128 - extension is mapped to ext.
  - .tmp/opentoken/src/postcall.ts:143 - external is also mapped to ext.
  - .tmp/opentoken/src/postcall.ts:218 - aliasJsonKeys blindly replaces matching JSON keys with the alias without collision checks.
  - runtime:unit:-tmp-opentoken: confirmed — Deterministic runtime command succeeded: npm test

### COR-013 — JSON sampling under-samples representative subset when items count is 2 or 3

- Severity: medium
- Confidence: high
- Lens: correctness
- Files: .tmp/opentoken/src/jsonsample.ts
- Summary: In sampleArray, the conditions to push representative samples (middle and last) require nonErrorItems.length > 2 and nonErrorItems.length > 3. Due to these strict greater-than checks, if the array has exactly 2 items, only 1 is sampled; if it has 3 items, only 2 are sampled, leading to under-sampling.
- Evidence:
  - .tmp/opentoken/src/jsonsample.ts:104 - if (sampleSize >= 2 && nonErrorItems.length > 2)
  - .tmp/opentoken/src/jsonsample.ts:107 - if (sampleSize >= 3 && nonErrorItems.length > 3)
  - runtime:unit:-tmp-opentoken: confirmed — Deterministic runtime command succeeded: npm test

### TST-005 — Lack of test assertions for byFamily statistics grouping

- Severity: medium
- Confidence: high
- Lens: tests
- Files: .tmp/opentoken/.opencode/plugins/opentoken/utils/stats.ts
- Summary: The metrics aggregation tests fail to verify byFamily stats correctness, causing a duplicate grouping bug in getStatsSummary to go undetected.
- Evidence:
  - .tmp/opentoken/.opencode/plugins/opentoken/utils/stats.ts:150 - byFamily is populated with duplicate tool stats instead of family stats, and tests in tests/opentoken.test.ts:1002 only check for property existence rather than values.
  - runtime:unit:-tmp-opentoken: confirmed — Deterministic runtime command succeeded: npm test

### COR-002 — Lens verification result shape is not enforced

- Severity: medium
- Confidence: high
- Lens: correctness
- Files: src/validation/auditResults.ts
- Summary: validateAuditResults validates verification metadata only when it is present and never rejects direct findings for tasks tagged lens_verification. A lens-verification task can therefore be accepted without the required verification object or with direct findings, contradicting the prompt contract used by submit-packet.
- Evidence:
  - src/validation/auditResults.ts:439-441 - validateVerification returns immediately when the result has no verification object.
  - src/validation/auditResults.ts:469-477 - the only tag-aware check is a warning when verification appears on a non-lens_verification task; there is no inverse requirement for lens_verification tasks.
  - src/validation/auditResults.ts:767-829 - findings are validated normally for every task, with no branch that rejects findings on lens_verification tasks.
  - runtime:unit:src-validation: confirmed — Deterministic runtime command succeeded: npm test

### TST-006 — Lens-verification result validation is untested

- Severity: medium
- Confidence: high
- Lens: tests
- Files: src/validation/auditResults.ts
- Summary: validateAuditResults has a dedicated verification branch for lens_verification tasks and bounded follow-up task suggestions, but the validation tests do not exercise it. Invalid verification payloads or out-of-scope follow-up tasks could regress without direct validator coverage.
- Evidence:
  - src/validation/auditResults.ts:326 - validateVerificationFollowupTask validates follow-up AuditTask fields, lens matching, priorities, tags, and file_paths.
  - src/validation/auditResults.ts:430 - validateVerification checks verified and needs_followup booleans and warns when verification appears on a non-lens_verification task.
  - tests/validation-remediation.test.mjs:185 - direct validateAuditResults tests cover evidence, metadata drift, coverage, and line spans, but not verification payloads.
  - tests/field-trial-remediation.test.mjs:30 - the source-imported field-trial validation tests likewise exercise normal AuditResult failures only, not lens_verification results.
  - runtime:unit:src-validation: confirmed — Deterministic runtime command succeeded: npm test

### OBS-001 — Line-count failures are reported as zero-line files

- Severity: medium
- Confidence: high
- Lens: observability
- Files: src/cli.ts
- Summary: Dispatch line-count collection suppresses all per-file read failures and records a count of 0. When a file is missing or unreadable, packet prompts and result validation receive misleading zero-line metadata without any warning that explains the real failure.
- Evidence:
  - src/cli.ts:585 - buildLineIndex counts each manifest file inside a try block.
  - src/cli.ts:590 - The catch path returns [file.path, 0] with no stderr message, warning artifact, or error context.
  - src/cli.ts:647 - addFileLineCountHints feeds those counts into task file_line_counts, which are later rendered into packet prompts and used for result validation.
  - runtime:flow:flow:surface:src-cli-ts: confirmed — Deterministic runtime command succeeded: npm test

### TST-001 — LTSC compression has no direct regression tests

- Severity: medium
- Confidence: high
- Lens: tests
- Files: .tmp/opentoken/src/ltsc.ts
- Summary: The lossless LTSC compressor and decompressor are exported but the test suite only exercises the separate LZW compressor. Changes to the LTSC dictionary format, round-trip behavior, or no-growth guard could silently regress without any failing test.
- Evidence:
  - .tmp/opentoken/src/ltsc.ts:106 - compressLTSC is exported as a standalone compression path.
  - .tmp/opentoken/src/ltsc.ts:166 - decompressLTSC is exported for verification/round-trip use.
  - .tmp/opentoken/tests/opentoken.test.ts:726 - The compression regression block covers LZW token substitution, and repository search found no test references to compressLTSC or decompressLTSC.
  - runtime:unit:-tmp-opentoken: confirmed — Deterministic runtime command succeeded: npm test

### COR-001 — Malformed array sections are treated as empty

- Severity: medium
- Confidence: high
- Lens: correctness
- Files: src/validation/artifacts.ts
- Summary: validateArtifactBundle coerces any non-array section to [] before running semantic checks, so malformed artifacts such as unit_manifest.units: "bad" can pass with no issue. That makes the validator report a clean bundle when required collection fields have the wrong type.
- Evidence:
  - src/validation/artifacts.ts:16-18 - asArray returns [] whenever the supplied value is not an array.
  - src/validation/artifacts.ts:160-213 - required sections such as repo_manifest.files, unit_manifest.units, coverage_matrix.files, and audit_tasks are all normalized through asArray before validation.
  - src/validation/artifacts.ts:253-282 - unit checks only iterate over unitManifestUnits, so a non-array units value becomes an empty iteration rather than a validation error.
  - runtime:unit:src-validation: confirmed — Deterministic runtime command succeeded: npm test

### OBS-002 — Malformed extension manifests disappear from extractor output

- Severity: medium
- Confidence: high
- Lens: observability
- Files: src/extractors/browserExtension.ts, src/extractors/browserExtension.ts
- Summary: Browser-extension manifest parsing turns JSON parse failures into undefined and downstream extractors convert that into empty edge or risk output. Audit artifacts therefore cannot distinguish a malformed manifest from a valid extension with no local references, leaving missing graph/surface coverage unexplained.
- Evidence:
  - src/extractors/browserExtension.ts:68 - parseJsonObject is the JSON parsing helper used by browser-extension extraction.
  - src/extractors/browserExtension.ts:72 - The parse catch block returns undefined without emitting a warning, note, or structured diagnostic.
  - src/extractors/browserExtension.ts:244 - extractChromeExtensionManifestEdges treats a missing parsed manifest as an empty edge list, making parse failure indistinguishable from no extractable references.

### MNT-003 — Manifest edge extraction relies on hand-rolled parsers

- Severity: medium
- Confidence: high
- Lens: maintainability
- Files: src/extractors/graphManifestEdges.ts, src/extractors/graphManifestEdges.ts, src/extractors/graphManifestEdges.ts, src/extractors/graphManifestEdges.ts, src/extractors/graphManifestEdges.ts, src/extractors/graphManifestEdges.ts, src/extractors/graphManifestEdges.ts
- Summary: graphManifestEdges.ts implements custom state machines and regular-expression parsers for JSONC, YAML, TOML, Go workspace files, XML/POM modules, pyproject TOML, and YAML path references in one module. Maintaining many simplified parser dialects together makes format edge-case changes delicate and couples unrelated ecosystems.
- Evidence:
  - src/extractors/graphManifestEdges.ts:280 - The module strips JSONC comments and trailing commas manually before parseJsoncObject.
  - src/extractors/graphManifestEdges.ts:395 - Separate YAML scalar/comment/list helpers feed pnpmWorkspacePatterns at line 458 and YAML path reference parsing near line 1373.
  - src/extractors/graphManifestEdges.ts:504 - TOML comment, array, and string parsers are reused by Cargo workspace parsing at line 615 and pyproject testpath parsing at line 1259.
  - src/extractors/graphManifestEdges.ts:1051 - Go workspace use directives and Maven modules at line 1170 use additional bespoke parsers in the same file.

### TST-001 — MCP client requests can hang indefinitely

- Severity: medium
- Confidence: high
- Lens: tests
- Files: tests/mcp-server.test.mjs, tests/mcp-server.test.mjs
- Summary: The createMcpClient request helper only resolves or rejects when stdout yields a matching response payload. If the MCP child exits, errors, or never emits that response, the pending Promise is left unresolved, so regressions can turn into hanging tests instead of deterministic failures.
- Evidence:
  - tests/mcp-server.test.mjs:72 - request() stores a resolver in pending and writes to stdin, but it has no timeout or child exit/error listener to reject if the server stops responding.
  - tests/mcp-server.test.mjs:214 - the long integration test drives many initialize/tool/resource requests through this helper, so a crash before any expected response can leave the test process waiting rather than failing promptly.

### MNT-001 — MCP tool surface is split across duplicate registries

- Severity: medium
- Confidence: high
- Lens: maintainability
- Files: src/mcp/server.ts, src/mcp/server.ts
- Summary: Adding or changing an MCP tool requires keeping the switch-based dispatcher, the separate schema list, and repeated shared parameters in sync. This manual coupling makes the tool surface harder to evolve safely as the adapter grows.
- Evidence:
  - src/mcp/server.ts:460 - handleToolCall dispatches tools through a switch over string names and embeds per-tool parameter validation and CLI argument construction.
  - src/mcp/server.ts:546 - toolDefinitions separately enumerates the same tool names and schemas, repeating root/artifacts_dir properties across each entry instead of deriving metadata from the dispatch table.

### COR-001 — MCP verification can hang after early child exit

- Severity: medium
- Confidence: high
- Lens: correctness
- Files: audit-code-wrapper-lib.mjs, audit-code-wrapper-lib.mjs
- Summary: The install verifier's MCP client records an early child exit, but close() then waits for a future exit event that has already fired. When a generated MCP server fails before or during the handshake, verify-install can hang instead of reporting the startup failure.
- Evidence:
  - audit-code-wrapper-lib.mjs:1850 - the child exit handler sets exitError and rejects pending MCP requests when the process exits early.
  - audit-code-wrapper-lib.mjs:1891 - close() skips shutdown when exitError is already set, then registers child.on('exit') and awaits a later exit event.
  - audit-code-wrapper-lib.mjs:1956 - probeMcpServer catches handshake errors and calls await client.close(), so an already-exited child can cause the error path itself to wait forever.

### COR-003 — Misclassification of warning and error blocks in Cargo build filter

- Severity: medium
- Confidence: high
- Lens: correctness
- Files: .tmp/opentoken/src/families/cargo.ts
- Summary: filterCargoBuild pushes the currently active block to warnings or errors based solely on the prefix of the newly encountered line rather than the prefix of the block itself. If a warning block is active and a new error line is found, the warning block is pushed to errors, and vice versa.
- Evidence:
  - .tmp/opentoken/src/families/cargo.ts:20 - if (inBlock && block.length > 0) errors.push(block.join('\n'));
  - .tmp/opentoken/src/families/cargo.ts:24 - if (inBlock && block.length > 0) warnings.push(block.join('\n'));
  - runtime:unit:-tmp-opentoken: confirmed — Deterministic runtime command succeeded: npm test

### COR-002 — Mismatched result files retry the wrong task

- Severity: medium
- Confidence: high
- Lens: correctness
- Files: src/cli.ts, src/cli.ts
- Summary: merge-and-ingest detects when a result file assigned to one task contains another task_id, but records the failure under the contained task id. The retry packet list is then derived from that wrong id, so the task whose result file was bad may not be retried.
- Evidence:
  - src/cli.ts:3783 - the code detects when an entry assigned to task.task_id contains a different taskId.
  - src/cli.ts:3802 - the failing record uses taskId ?? task.task_id, so a mismatched file is filed under the wrong task.
  - src/cli.ts:3850 - retry dispatch is derived from failing.map(f => f.task_id), so the packet for the actual assigned task can be skipped.
  - runtime:flow:flow:surface:src-cli-ts: confirmed — Deterministic runtime command succeeded: npm test

### TEST-SKILL-001 — OpenCode command template is not contract-tested

- Severity: medium
- Confidence: high
- Lens: tests
- Files: skills/audit-code/opencode-command-template.txt
- Summary: The OpenCode command template is read into the installed command surface, but postinstall tests do not assert the installed command template text. The file could drift away from the next-step contract, or even be reduced to an unusable template, without the current tests failing.
- Evidence:
  - skills/audit-code/opencode-command-template.txt:3 - the template instructs OpenCode to use audit-code next-step as the primary workflow interface.
  - scripts/postinstall.mjs:280 - postinstall reads skills/audit-code/opencode-command-template.txt and injects it into command.audit-code.template.
  - tests/postinstall-contract.test.mjs:56 - the postinstall contract verifies OpenCode permissions but does not assert command.audit-code.template or its next-step/MCP fallback wording.
  - runtime:flow:flow:surface:skills-audit-code-opencode-command-template-txt: confirmed — Deterministic runtime command succeeded: npm test

### TEST-001 — OpenCode plugin copy is not exercised by tests

- Severity: medium
- Confidence: high
- Lens: tests
- Files: .tmp/opentoken/.opencode/plugins/opentoken/autoescalate.ts, .tmp/opentoken/.opencode/plugins/opentoken/dedup.ts
- Summary: The runtime OpenCode plugin modules under .opencode/plugins/opentoken are separate copies, but the test suite imports the src implementation only. Because the plugin copy has already drifted in public signatures, regressions in the plugin-local autoescalation or dedup behavior can pass the existing test run silently.
- Evidence:
  - .tmp/opentoken/.opencode/plugins/opentoken/index.ts:16 - The OpenTokenPlugin entrypoint imports plugin-local './autoescalate', './dedup', and filter modules from .opencode/plugins/opentoken.
  - .tmp/opentoken/tests/opentoken.test.ts:17 - Existing tests import autoescalation from '../src/autoescalate' rather than the .opencode plugin copy.
  - .tmp/opentoken/tests/opentoken.test.ts:18 - Existing tests import deduplication from '../src/dedup' rather than the plugin-local dedup module.
  - .tmp/opentoken/.opencode/plugins/opentoken/autoescalate.ts:32 - The plugin copy exposes updateContext(used, total?) and resetEscalation() at line 278, while the tested src API takes a sessionID, showing drift the tests do not cover.
  - .tmp/opentoken/package.json:48 - The only test script is 'bun test', with no plugin-copy or .opencode-specific test target.
  - runtime:unit:-tmp-opentoken: confirmed — Deterministic runtime command succeeded: npm test

### COR-002 — Packaged MCP smoke can wait forever on child failure

- Severity: medium
- Confidence: high
- Lens: correctness
- Files: scripts/smoke-packaged-audit-code.mjs
- Summary: The packaged smoke test's MCP client only resolves requests when a response frame arrives and never rejects them if the child process exits. A broken packaged MCP startup can therefore stall the release smoke indefinitely instead of failing the test.
- Evidence:
  - scripts/smoke-packaged-audit-code.mjs:319 - createMcpClient spawns the MCP child and sets up stdout parsing only.
  - scripts/smoke-packaged-audit-code.mjs:363 - request() stores a pending resolver that is invoked only when a parsed payload with the matching id arrives.
  - scripts/smoke-packaged-audit-code.mjs:393 - close() also waits for an exit event, but the client has no child error or exit handler to reject outstanding requests when startup fails.

### OPR-002 — Packaged MCP smoke probe can hang without diagnostics

- Severity: medium
- Confidence: high
- Lens: operability
- Files: scripts/smoke-packaged-audit-code.mjs, scripts/smoke-packaged-audit-code.mjs, scripts/smoke-packaged-audit-code.mjs
- Summary: The packaged smoke test's MCP client sends requests and waits indefinitely for JSON-RPC responses without request timeouts or child exit/error propagation. If the packaged MCP server exits early or never responds, operators may only see a CI step timeout instead of the server stderr or failed request context.
- Evidence:
  - scripts/smoke-packaged-audit-code.mjs:319 - The MCP child is spawned with piped stdio, but this client does not capture stderr or install error/exit handlers for pending requests.
  - scripts/smoke-packaged-audit-code.mjs:363 - request() only resolves when a matching stdout payload arrives, with no timeout or rejection path if the child dies before responding.
  - scripts/smoke-packaged-audit-code.mjs:393 - close() waits on a shutdown request before waiting for exit, so shutdown can also hang without exposing child diagnostics.

### DI-001 — Packet file counts can drift from packet paths

- Severity: medium
- Confidence: high
- Lens: data_integrity
- Files: schemas/review_packets.schema.json
- Summary: Review packets require file paths, file line counts, and a total line count, but the schema does not bind those values together. A packet can validate while omitting counts for listed files, including counts for unrelated files, or reporting a total that does not match the per-file counts.
- Evidence:
  - schemas/review_packets.schema.json:83 - file_paths, file_line_counts, and total_lines are all required fields on a review packet.
  - schemas/review_packets.schema.json:118 - file_line_counts is modeled as an object whose additional properties may be any nonnegative integer, with no constraint tying keys to file_paths.
  - schemas/review_packets.schema.json:125 - total_lines is only constrained to be a nonnegative integer, not to match the sum of file_line_counts.
  - runtime:unit:schemas: confirmed — Deterministic runtime command succeeded: npm test

### MNT-003 — Packet graph grouping repeats union-find logic

- Severity: medium
- Confidence: high
- Lens: maintainability
- Files: src/orchestrator/reviewPackets.ts, src/orchestrator/reviewPackets.ts
- Summary: reviewPackets.ts implements the same group-connection algorithm twice, including local parent maps, find/union helpers, file-group merging, and graph-edge merging. Because these copies differ only in their final projection, future graph-planning rule changes must be duplicated exactly to keep component indexing and packet merging aligned.
- Evidence:
  - src/orchestrator/reviewPackets.ts:349 - buildGraphConnectedComponentIndex creates a parent map, defines local find/union helpers, unions file group keys, then unions graph-connected groups through isPacketExpansionEdge.
  - src/orchestrator/reviewPackets.ts:1190 - mergeGraphConnectedGroups repeats the same parent map, local find/union helpers, file group union pass, and graph edge union pass before returning merged task arrays.

### TST-006 — Phase 4 tests pin the de-escalation oscillation

- Severity: medium
- Confidence: high
- Lens: tests
- Files: .tmp/opentoken/tests/phase4.test.ts
- Summary: The hysteresis suite explicitly asserts the oscillating ultra-to-lean-to-ultra behavior as expected. This turns a documented warning into a passing regression test instead of requiring stable hysteresis behavior.
- Evidence:
  - .tmp/opentoken/tests/phase4.test.ts:77 - The test asserts de-escalation from ultra to lean at fill < 80%.
  - .tmp/opentoken/tests/phase4.test.ts:91 - A test named OSCILLATION WARNING documents that this conflicts with escalation at >=70%.
  - .tmp/opentoken/tests/phase4.test.ts:101 - The test expects updateContext to re-escalate to ultra after de-escalation.
  - .tmp/opentoken/tests/phase4.test.ts:106 - The test then expects deescalate to drop back to lean again, pinning the oscillation.
  - runtime:unit:-tmp-opentoken: confirmed — Deterministic runtime command succeeded: npm test

### MAINT-002 — Process spawning helper combines too many lifecycle concerns

- Severity: medium
- Confidence: high
- Lens: maintainability
- Files: src/providers/spawnLoggedCommand.ts
- Summary: spawnLoggedCommand couples child process creation, stdout/stderr logging, UI echoing, timeout and force-kill handling, pending write accounting, and result normalization inside one Promise closure. This makes provider lifecycle changes difficult to isolate and increases the chance of breaking cleanup while editing unrelated logging or timeout behavior.
- Evidence:
  - src/providers/spawnLoggedCommand.ts:37 - the function enters a large Promise closure and initializes many mutable lifecycle fields such as timedOut, settled, child, timer, heartbeat, pendingLogWrites, and close state.
  - src/providers/spawnLoggedCommand.ts:53 - nested clearTimers/endLogs/settle/fail/writeLog/maybeSettleFromClose helpers coordinate cleanup, stream ending, write accounting, timeout errors, and final result construction.
  - src/providers/spawnLoggedCommand.ts:141 - the same closure wires log-stream errors, child spawning, stdout/stderr forwarding, visible UI echo, timeout timers, heartbeat output, and exit/close handling.
  - runtime:flow:flow:surface:src-providers-spawnLoggedCommand-ts: confirmed — Deterministic runtime command succeeded: npm test

### TST-002 — Progressive and rewind flows are imported but not exercised

- Severity: medium
- Confidence: high
- Lens: tests
- Files: .tmp/opentoken/src/progressive.ts, .tmp/opentoken/src/rewind.ts
- Summary: The tests import the progressive disclosure and rewind helpers but never call them, leaving the offload, cleanup, reversible compression, and abbreviation paths without assertions. These paths write and clean up persisted content, so regressions in fallback or retrieval markers would not be caught.
- Evidence:
  - .tmp/opentoken/tests/opentoken.test.ts:59 - cleanupOffloaded and progressiveDisclosure are imported, but repository search found no call sites in the tests.
  - .tmp/opentoken/tests/opentoken.test.ts:60 - applyReversibleCompression and cleanupRewind are imported, but repository search found no call sites in the tests.
  - .tmp/opentoken/src/progressive.ts:97 - progressiveDisclosure contains the threshold/offload behavior that currently lacks assertions.
  - .tmp/opentoken/src/rewind.ts:116 - applyReversibleCompression contains the reversible compression path that currently lacks assertions.
  - runtime:unit:-tmp-opentoken: confirmed — Deterministic runtime command succeeded: npm test

### TST-001 — Provider tests import compiled dist output

- Severity: medium
- Confidence: high
- Lens: tests
- Files: tests/providers-remediation.test.mjs
- Summary: The provider remediation tests load the implementations from ../dist instead of the source tree, so they can pass against stale compiled artifacts after source changes. This weakens the suite as a signal for the code under active development unless every test invocation is guaranteed to rebuild first.
- Evidence:
  - tests/providers-remediation.test.mjs:12 - ClaudeCodeProvider is imported from ../dist/providers/claudeCodeProvider.js rather than the source implementation.
  - tests/providers-remediation.test.mjs:16 - LocalSubprocessProvider is imported from ../dist/providers/localSubprocessProvider.js, allowing stale build output to satisfy the test.
  - tests/providers-remediation.test.mjs:18 - spawnLoggedCommand is imported from ../dist/providers/spawnLoggedCommand.js instead of exercising the current source file.

### TST-003 — Provider-assisted continuation accepts wrong provider

- Severity: medium
- Confidence: high
- Lens: tests
- Files: tests/provider-assisted-continuation.test.mjs, tests/provider-assisted-continuation.test.mjs
- Summary: The provider-assisted continuation test writes session-config.json with provider set to subprocess-template and a bridge command, but the assertion accepts either subprocess-template or opencode. A regression that ignores the explicit provider and auto-selects OpenCode can still pass this test.
- Evidence:
  - tests/provider-assisted-continuation.test.mjs:117 - the fixture config explicitly sets provider to subprocess-template.
  - tests/provider-assisted-continuation.test.mjs:139 - the assertion uses /subprocess-template|opencode/, so the test passes even if the subprocess-template selection is bypassed.

### MAINT-003 — Quota scheduling policy is branch-heavy and centralized

- Severity: medium
- Confidence: high
- Lens: maintainability
- Files: src/quota/scheduler.ts
- Summary: scheduleWave encodes disabled-quota behavior, static limit resolution, discovered limits, cooldowns, RPM/TPM caps, learned ramp-up, first-contact fallback, host limits, and live quota snapshots in one ordered function. The rules are individually readable, but their ordering is implicit and hard to change safely without extracting policy steps.
- Evidence:
  - src/quota/scheduler.ts:58 - the function special-cases quota.enabled === false while constructing a default ResolvedLimits object and estimated wave token calculation inline.
  - src/quota/scheduler.ts:82 - the main path then resolves limits, merges discovered limits, applies active cooldown handling, clamps by RPM and TPM, and uses learned state or first-contact fallbacks before leaving the block at line 160.
  - src/quota/scheduler.ts:162 - real-time quota source data and host concurrency limits are applied after the other policy steps, so the priority order is encoded by statement placement rather than named policy stages.

### OBS-QUOTA-001 — Quota source failures are suppressed without context

- Severity: medium
- Confidence: high
- Lens: observability
- Files: src/quota/compositeQuotaSource.ts
- Summary: Composite quota lookup catches and ignores every source failure while trying the next source. When quota discovery or learned-state reads fail, operators get no source name, provider key, or error message explaining why live quota data was absent from scheduling.
- Evidence:
  - src/quota/compositeQuotaSource.ts:11 - queryCurrentUsage receives the providerModelKey and iterates configured quota sources for that key.
  - src/quota/compositeQuotaSource.ts:16 - the catch block suppresses all source errors with only a comment, so no diagnostic identifies the failing quota source or exception.

### PER-001 — Read cache is capped only by entry count, not bytes

- Severity: medium
- Confidence: high
- Lens: performance
- Files: .tmp/opentoken/src/utils/cache.ts, .tmp/opentoken/.opencode/plugins/opentoken/utils/cache.ts
- Summary: The read cache stores full file contents and evicts only after 500 paths, with no per-entry or total byte budget. Reading many large files within the TTL can retain hundreds of large strings and create avoidable memory pressure.
- Evidence:
  - .tmp/opentoken/src/utils/cache.ts:16 - MAX_CACHE_SIZE limits only the number of cached entries to 500.
  - .tmp/opentoken/src/utils/cache.ts:77 - setCachedRead stores the complete content string for each cached file.
  - .tmp/opentoken/.opencode/plugins/opentoken/utils/cache.ts:14 - the packaged plugin uses the same 500-entry count cap.
  - .tmp/opentoken/.opencode/plugins/opentoken/utils/cache.ts:53 - the packaged plugin also stores full content without a byte budget.
  - runtime:flow:flow:surface:src-prompts-renderWorkerPrompt-ts: confirmed — Deterministic runtime command succeeded: npm test
  - runtime:flow:flow:surface:src-types-workerResult-ts: confirmed — Deterministic runtime command succeeded: npm test
  - runtime:flow:flow:surface:src-types-workerSession-ts: confirmed — Deterministic runtime command succeeded: npm test
  - runtime:flow:flow:surface:tests-render-worker-prompt-test-mjs: confirmed — Deterministic runtime command succeeded: npm test
  - runtime:unit:-tmp-opentoken: confirmed — Deterministic runtime command succeeded: npm test

### OPR-001 — Release script lacks a non-destructive publish preview

- Severity: medium
- Confidence: high
- Lens: operability
- Files: scripts/release-and-publish.mjs, scripts/release-and-publish.mjs
- Summary: The release helper performs live git pushes and creates the GitHub Release that triggers npm publication, but its only alternate mode is --bump-only, which still changes the local repository. Operators cannot exercise the full publish path as a dry run before the destructive push/release steps.
- Evidence:
  - scripts/release-and-publish.mjs:13 - The only mode flag is --bump-only; there is no dry-run or preview flag for the live publish path.
  - scripts/release-and-publish.mjs:259 - The live path pushes the branch, pushes the tag, and creates the GitHub Release that starts publication.

### DA-012 — Risk concentrated in top quartile of units

- Severity: medium
- Confidence: high
- Lens: architecture
- Files: src/types/artifactMetadata.ts, src/types/auditState.ts, src/types/designAssessment.ts, src/types/disposition.ts, src/types/externalAnalyzer.ts, src/types/flowCoverage.ts, src/types/flows.ts, src/types/graph.ts, src/types/reviewPlanning.ts, src/types/risk.ts, src/types/runLedger.ts, src/types/runtimeValidation.ts, src/types/sessionConfig.ts, src/types/surfaces.ts, src/types/toolingManifest.ts, src/types/workerResult.ts, src/types/workerSession.ts, .tmp/opentoken/.github/FUNDING.yml, .tmp/opentoken/.github/workflows/ci.yml, .tmp/opentoken/.gitignore, .tmp/opentoken/.npmignore, .tmp/opentoken/.opencode/opentoken-config-schema.json, .tmp/opentoken/.opencode/package.json, .tmp/opentoken/.opencode/pkg.json, .tmp/opentoken/.opencode/plugins/opentoken-tui.tsx, .tmp/opentoken/.opencode/plugins/opentoken.ts, .tmp/opentoken/.opencode/plugins/opentoken/autoescalate.ts, .tmp/opentoken/.opencode/plugins/opentoken/dedup.ts, .tmp/opentoken/.opencode/plugins/opentoken/families/cargo.ts, .tmp/opentoken/.opencode/plugins/opentoken/families/detect.ts, .tmp/opentoken/.opencode/plugins/opentoken/families/docker.ts, .tmp/opentoken/.opencode/plugins/opentoken/families/fs.ts, .tmp/opentoken/.opencode/plugins/opentoken/families/generic.ts, .tmp/opentoken/.opencode/plugins/opentoken/families/git.ts, .tmp/opentoken/.opencode/plugins/opentoken/families/make.ts, .tmp/opentoken/.opencode/plugins/opentoken/families/npm.ts, .tmp/opentoken/.opencode/plugins/opentoken/families/pip.ts, .tmp/opentoken/.opencode/plugins/opentoken/families/test.ts, .tmp/opentoken/.opencode/plugins/opentoken/filters/glob.ts, .tmp/opentoken/.opencode/plugins/opentoken/filters/grep.ts, .tmp/opentoken/.opencode/plugins/opentoken/filters/read.ts, .tmp/opentoken/.opencode/plugins/opentoken/folding.ts, .tmp/opentoken/.opencode/plugins/opentoken/history.ts, .tmp/opentoken/.opencode/plugins/opentoken/index.ts, .tmp/opentoken/.opencode/plugins/opentoken/jsonsample.ts, .tmp/opentoken/.opencode/plugins/opentoken/lspfirst.ts, .tmp/opentoken/.opencode/plugins/opentoken/ltsc.ts, .tmp/opentoken/.opencode/plugins/opentoken/lzw.ts, .tmp/opentoken/.opencode/plugins/opentoken/memory.ts, .tmp/opentoken/.opencode/plugins/opentoken/outputcomp.ts, .tmp/opentoken/.opencode/plugins/opentoken/postcall.ts, .tmp/opentoken/.opencode/plugins/opentoken/precall.ts, .tmp/opentoken/.opencode/plugins/opentoken/progressive.ts, .tmp/opentoken/.opencode/plugins/opentoken/rewind.ts, .tmp/opentoken/.opencode/plugins/opentoken/router.ts, .tmp/opentoken/.opencode/plugins/opentoken/session.ts, .tmp/opentoken/.opencode/plugins/opentoken/skeleton.ts, .tmp/opentoken/.opencode/plugins/opentoken/statusline.ts, .tmp/opentoken/.opencode/plugins/opentoken/symbolindex.ts, .tmp/opentoken/.opencode/plugins/opentoken/toon.ts, .tmp/opentoken/.opencode/plugins/opentoken/tui.tsx, .tmp/opentoken/.opencode/plugins/opentoken/utils/cache.ts, .tmp/opentoken/.opencode/plugins/opentoken/utils/errors.ts, .tmp/opentoken/.opencode/plugins/opentoken/utils/metrics.ts, .tmp/opentoken/.opencode/plugins/opentoken/utils/secrets.ts, .tmp/opentoken/.opencode/plugins/opentoken/utils/session-store.ts, .tmp/opentoken/.opencode/plugins/opentoken/utils/stats.ts, .tmp/opentoken/.opencode/plugins/opentoken/utils/tokens.ts, .tmp/opentoken/biome.json, .tmp/opentoken/bun.lock, .tmp/opentoken/install.sh, .tmp/opentoken/package.json, .tmp/opentoken/scripts/check-regex-safety.ts, .tmp/opentoken/SHA256SUMS, .tmp/opentoken/src/autoescalate.test.ts, .tmp/opentoken/src/autoescalate.ts, .tmp/opentoken/src/dedup.ts, .tmp/opentoken/src/families/cargo.ts, .tmp/opentoken/src/families/detect.ts, .tmp/opentoken/src/families/docker.ts, .tmp/opentoken/src/families/fs.ts, .tmp/opentoken/src/families/generic.test.ts, .tmp/opentoken/src/families/generic.ts, .tmp/opentoken/src/families/git.ts, .tmp/opentoken/src/families/make.ts, .tmp/opentoken/src/families/npm.ts, .tmp/opentoken/src/families/pip.ts, .tmp/opentoken/src/families/test.ts, .tmp/opentoken/src/filters/glob.ts, .tmp/opentoken/src/filters/grep.ts, .tmp/opentoken/src/filters/read.ts, .tmp/opentoken/src/folding.ts, .tmp/opentoken/src/history.ts, .tmp/opentoken/src/index.ts, .tmp/opentoken/src/jsonsample.ts, .tmp/opentoken/src/lspfirst.ts, .tmp/opentoken/src/ltsc.ts, .tmp/opentoken/src/lzw.ts, .tmp/opentoken/src/memory.ts, .tmp/opentoken/src/outputcomp.ts, .tmp/opentoken/src/postcall.ts, .tmp/opentoken/src/precall.ts, .tmp/opentoken/src/progressive.ts, .tmp/opentoken/src/rewind.ts, .tmp/opentoken/src/router.ts, .tmp/opentoken/src/session.ts, .tmp/opentoken/src/skeleton.ts, .tmp/opentoken/src/statusline.ts, .tmp/opentoken/src/symbolindex.ts, .tmp/opentoken/src/toon.ts, .tmp/opentoken/src/tui.tsx, .tmp/opentoken/src/utils/cache.ts, .tmp/opentoken/src/utils/errors.ts, .tmp/opentoken/src/utils/metrics.ts, .tmp/opentoken/src/utils/secrets.ts, .tmp/opentoken/src/utils/session-store.ts, .tmp/opentoken/src/utils/stats.ts, .tmp/opentoken/src/utils/tokens.ts, .tmp/opentoken/tests/opentoken.test.ts, .tmp/opentoken/tests/outputcomp.test.ts, .tmp/opentoken/tests/phase4.test.ts, .tmp/opentoken/tsconfig.json, schemas/audit_plan_metrics.schema.json, schemas/audit_result.schema.json, schemas/audit_results.schema.json, schemas/audit_state.schema.json, schemas/audit_task.schema.json, schemas/audit-code-v1alpha1.schema.json, schemas/blind_spot_register.schema.json, schemas/coverage_matrix.schema.json, schemas/critical_flows.schema.json, schemas/dispatch_quota.schema.json, schemas/external_analyzer_results.schema.json, schemas/file_disposition.schema.json, schemas/finding.schema.json, schemas/flow_coverage.schema.json, schemas/graph_bundle.schema.json, schemas/repo_manifest.schema.json, schemas/review_packets.schema.json, schemas/risk_register.schema.json, schemas/runtime_validation_report.schema.json, schemas/runtime_validation_tasks.schema.json, schemas/surface_manifest.schema.json, schemas/unit_manifest.schema.json, tests/quota-file-lock.test.mjs, src/orchestrator/advance.ts, src/orchestrator/artifactFreshness.ts, src/orchestrator/artifactMetadata.ts, src/orchestrator/autoFixExecutor.ts, src/orchestrator/chunking.ts, src/orchestrator/dependencyMap.ts, src/orchestrator/designReviewPrompt.ts, src/orchestrator/executors.ts, src/orchestrator/fileAnchors.ts, src/orchestrator/flowCoverage.ts, src/orchestrator/flowPlanning.ts, src/orchestrator/flowRequeue.ts, src/orchestrator/internalExecutors.ts, src/orchestrator/localCommands.ts, src/orchestrator/nextStep.ts, src/orchestrator/planning.ts, src/orchestrator/requeue.ts, src/orchestrator/requeueCommand.ts, src/orchestrator/resultIngestion.ts, src/orchestrator/reviewPackets.ts, src/orchestrator/runtimeValidation.ts, src/orchestrator/runtimeValidationUpdate.ts, src/orchestrator/selectiveDeepening.ts, src/orchestrator/staleness.ts, src/orchestrator/state.ts, src/orchestrator/syntaxResolutionExecutor.ts, src/orchestrator/taskBuilder.ts, src/orchestrator/trivialAudit.ts, src/orchestrator/unitBuilder.ts, src/providers/claudeCodeProvider.ts, src/providers/constants.ts, src/providers/index.ts, src/providers/localSubprocessProvider.ts, src/providers/opencodeProvider.ts, src/providers/spawnLoggedCommand.ts, src/providers/subprocessTemplateProvider.ts, src/providers/types.ts, src/providers/vscodeTaskProvider.ts, tests/render-worker-prompt.test.mjs, src/quota/compositeQuotaSource.ts, src/quota/discoveredLimits.ts, src/quota/errorParsers/claudeCodeErrorParser.ts, src/quota/errorParsers/genericErrorParser.ts, src/quota/errorParsers/index.ts, src/quota/errorParsing.ts, src/quota/fileLock.ts, src/quota/headerExtraction.ts, src/quota/headerExtractors/claudeCodeHeaderExtractor.ts, src/quota/headerExtractors/genericHeaderExtractor.ts, src/quota/headerExtractors/index.ts, src/quota/hostLimits.ts, src/quota/index.ts, src/quota/learnedQuotaSource.ts, src/quota/limits.ts, src/quota/probe.ts, src/quota/quotaSource.ts, src/quota/scheduler.ts, src/quota/slidingWindow.ts, src/quota/state.ts, src/quota/types.ts, Codeauditor-lambda.audit-artifacts/session-config.json, src/supervisor/operatorHandoff.ts, src/supervisor/runLedger.ts, src/supervisor/sessionConfig.ts, src/validation/artifacts.ts, src/validation/auditResults.ts, src/validation/basic.ts, src/validation/sessionConfig.ts, src/prompts/renderWorkerPrompt.ts, tests/helpers/jsonSchemaAssert.mjs, tests/helpers/provider-assisted-bridge.mjs, tests/helpers/sourceImport.mjs, tests/json-schema-assert.test.mjs, tests/schema-contracts.test.mjs, skills/audit-code/agents/openai.yaml, skills/audit-code/opencode-command-template.txt, .github/workflows/ci.yml, .github/workflows/packaged-entrypoint.yml, .github/workflows/product-e2e.yml, .github/workflows/publish-package.yml, .github/workflows/test-suite.yml, .gemini/commands/audit-code.toml, .opencode/.gitignore, .opencode/package.json, .gitignore, opencode.json, package.json, tsconfig.json
- Summary: 62% of total risk score is concentrated in the top 20 of 77 units: src-types, -tmp-opentoken, schemas, tests-quota-file-lock-test-mjs, src-orchestrator, src-providers, tests-render-worker-prompt-test-mjs, src-quota, Codeauditor-lambda-audit-artifacts, src-supervisor, src-validation, src-prompts, tests-helpers, tests-json-schema-assert-test-mjs, tests-schema-contracts-test-mjs, skills-audit-code, -github-workflows, -gemini-commands, -opencode, root-config. Consider decomposing high-risk units or adding isolation boundaries.
- Evidence:
  - runtime:flow:flow:surface:-gemini-commands-audit-code-toml: confirmed — Deterministic runtime command succeeded: npm test
  - runtime:flow:flow:surface:skills-audit-code-opencode-command-template-txt: confirmed — Deterministic runtime command succeeded: npm test
  - runtime:flow:flow:surface:src-orchestrator-localCommands-ts: confirmed — Deterministic runtime command succeeded: npm test
  - runtime:flow:flow:surface:src-orchestrator-requeueCommand-ts: confirmed — Deterministic runtime command succeeded: npm test
  - runtime:flow:flow:surface:src-prompts-renderWorkerPrompt-ts: confirmed — Deterministic runtime command succeeded: npm test
  - runtime:flow:flow:surface:src-providers-spawnLoggedCommand-ts: confirmed — Deterministic runtime command succeeded: npm test
  - runtime:flow:flow:surface:src-types-workerResult-ts: confirmed — Deterministic runtime command succeeded: npm test
  - runtime:flow:flow:surface:src-types-workerSession-ts: confirmed — Deterministic runtime command succeeded: npm test
  - runtime:flow:flow:surface:tests-render-worker-prompt-test-mjs: confirmed — Deterministic runtime command succeeded: npm test
  - runtime:unit:-tmp-opentoken: confirmed — Deterministic runtime command succeeded: npm test
  - runtime:unit:Codeauditor-lambda-audit-artifacts: confirmed — Deterministic runtime command succeeded: npm test
  - runtime:unit:schemas: confirmed — Deterministic runtime command succeeded: npm test
  - runtime:unit:src-supervisor: confirmed — Deterministic runtime command succeeded: npm test
  - runtime:unit:src-types: confirmed — Deterministic runtime command succeeded: npm test
  - runtime:unit:src-validation: confirmed — Deterministic runtime command succeeded: npm test
  - runtime:unit:tests-helpers: confirmed — Deterministic runtime command succeeded: npm test
  - runtime:unit:tests-json-schema-assert-test-mjs: confirmed — Deterministic runtime command succeeded: npm test
  - runtime:unit:tests-schema-contracts-test-mjs: confirmed — Deterministic runtime command succeeded: npm test

### MAINT-003 — run-to-completion command is a monolithic workflow state machine

- Severity: medium
- Confidence: high
- Lens: maintainability
- Files: src/cli.ts
- Summary: cmdRunToCompletion spans roughly 900 lines and combines configuration loading, executor selection, local-subprocess handoff, parallel quota scheduling, worker launch, result validation, ingestion, ledger updates, failure envelopes, and terminal reporting. The workflow has several nested execution paths, so changing one lifecycle concern requires reasoning through unrelated branches in the same function.
- Evidence:
  - src/cli.ts:1807 - cmdRunToCompletion starts the command and owns setup, session config, provider selection, batching, and run counters.
  - src/cli.ts:1908 - the function contains the local-subprocess manual-review handoff branch, including task file generation and envelope emission.
  - src/cli.ts:2018 - the same function contains the parallel agent branch with quota lookup, wave scheduling, worker slot creation, launch, validation, ingestion, and adaptive quota recording.
  - src/cli.ts:2371 - after the parallel branch, the same function also handles inline execution and single provider-launch execution through the terminal envelope path.
  - runtime:flow:flow:surface:src-cli-ts: confirmed — Deterministic runtime command succeeded: npm test

### TST-003 — Runtime command discovery branches are not tested

- Severity: medium
- Confidence: high
- Lens: tests
- Files: src/orchestrator/runtimeValidation.ts
- Summary: discoverRuntimeValidationCommand selects npm, Go, or pytest commands and silently falls back on unreadable or placeholder package.json data. The tests inject commands into buildRuntimeValidationTasks, leaving command discovery and its negative cases uncovered.
- Evidence:
  - src/orchestrator/runtimeValidation.ts:37 - discoverRuntimeValidationCommand reads repository files to decide which deterministic runtime command to use.
  - src/orchestrator/runtimeValidation.ts:47 - package.json scripts containing real tests return npm test while no-test placeholders and parse failures fall through.
  - src/orchestrator/runtimeValidation.ts:58 - Go and Python project markers are separate fallback branches after package.json handling.
  - tests/schema-contracts.test.mjs:589 - runtime validation tests build tasks with an injected command, bypassing discoverRuntimeValidationCommand entirely.

### TST-002 — Runtime validation executor skip and dedupe paths are untested

- Severity: medium
- Confidence: high
- Lens: tests
- Files: src/orchestrator/internalExecutors.ts
- Summary: runRuntimeValidationExecutor has important branches for reusing completed results, marking commandless tasks not_required, and de-duplicating identical commands across tasks. Existing tests cover the Windows spawn tuple helper and update ingestion, but not the executor loop that applies those runtime outcomes.
- Evidence:
  - src/orchestrator/internalExecutors.ts:523 - runRuntimeValidationExecutor builds byTaskId/byCommand state and skips prior confirmed, not_confirmed, inconclusive, or not_required results.
  - src/orchestrator/internalExecutors.ts:537 - commandless runtime tasks are converted to not_required results instead of running a command.
  - src/orchestrator/internalExecutors.ts:548 - identical runtime commands are cached by signature so one command outcome is reused for multiple tasks.
  - tests/orchestrator-remediation.test.mjs:69 - current runtime validation coverage asserts resolveRuntimeValidationSpawnCommand output, not runRuntimeValidationExecutor result reuse, commandless tasks, or command de-duplication.

### COR-002 — Runtime validation results are reused for changed tasks

- Severity: medium
- Confidence: high
- Lens: correctness
- Files: src/orchestrator/runtimeValidation.ts, src/orchestrator/runtimeValidation.ts
- Summary: Runtime validation task ids are stable for a unit or flow even when the task scope changes, and report merging preserves any prior result solely by that id. After a unit gains files, a flow's paths or required checks change, or the command changes, an old confirmed result can be carried forward and the runtime validation stage is considered complete without rerunning it.
- Evidence:
  - src/orchestrator/runtimeValidation.ts:90 - unit runtime task ids use only unit.unit_id while target_paths are populated separately from unit.files at line 96.
  - src/orchestrator/runtimeValidation.ts:121 - flow runtime task ids use only record.flow_id while target_paths and suggested_checks are populated from current flow coverage at lines 127 and 131.
  - src/orchestrator/runtimeValidation.ts:149 - mergeRuntimeValidationReport returns the prior result for a matching task id without comparing command, target_paths, priority, or suggested checks.
  - src/orchestrator/state.ts:160 - runtime_validation_current only requires a non-pending result with the same task id, so a reused confirmed result suppresses a needed rerun.

### REL-002 — Session memory writes fail silently when the config directory is absent

- Severity: medium
- Confidence: high
- Lens: reliability
- Files: .tmp/opentoken/src/session.ts, .tmp/opentoken/src/session.ts, .tmp/opentoken/.opencode/plugins/opentoken/session.ts, .tmp/opentoken/.opencode/plugins/opentoken/session.ts
- Summary: Both session-memory implementations write directly under ~/.config/opentoken without ensuring the directory exists. On a fresh install, persistence fails and the catch blocks suppress the error, leaving session memory and TUI state unavailable without recovery or signal.
- Evidence:
  - .tmp/opentoken/src/session.ts:10 - MEMORY_DIR points to ~/.config/opentoken, but no directory creation is performed in the file.
  - .tmp/opentoken/src/session.ts:51 - saveSessionSummary writes SESSION_FILE.tmp directly and swallows all errors at line 55.
  - .tmp/opentoken/src/session.ts:199 - writeSessionState uses the same direct temp-file write and suppresses failures at line 203.
  - .tmp/opentoken/.opencode/plugins/opentoken/session.ts:51 - the packaged plugin has the same direct write without ensuring MEMORY_DIR exists.
  - runtime:flow:flow:surface:src-types-workerSession-ts: confirmed — Deterministic runtime command succeeded: npm test
  - runtime:unit:-tmp-opentoken: confirmed — Deterministic runtime command succeeded: npm test

### REL-001 — Stale-lock cleanup can remove an active lock

- Severity: medium
- Confidence: high
- Lens: reliability
- Files: src/quota/fileLock.ts
- Summary: The file lock is closed immediately after creation and never refreshed while the protected function runs, but contenders delete any lock whose mtime exceeds 30 seconds. Any legitimate critical section lasting longer than the stale threshold can be entered concurrently by another process, breaking the quota-state mutual exclusion the lock is meant to provide.
- Evidence:
  - src/quota/fileLock.ts:14-18 - staleness is based solely on Date.now() minus the lock file mtime being greater than 30 seconds.
  - src/quota/fileLock.ts:31-32 - acquireLock creates the file and closes the descriptor immediately, leaving no owner heartbeat or held fd to refresh the mtime.
  - src/quota/fileLock.ts:38-44 - a contender unlinks a stale-looking lock and retries, even if the original holder is still inside withFileLock.
  - runtime:flow:flow:surface:src-prompts-renderWorkerPrompt-ts: confirmed — Deterministic runtime command succeeded: npm test
  - runtime:flow:flow:surface:src-types-workerResult-ts: confirmed — Deterministic runtime command succeeded: npm test
  - runtime:flow:flow:surface:src-types-workerSession-ts: confirmed — Deterministic runtime command succeeded: npm test
  - runtime:flow:flow:surface:tests-render-worker-prompt-test-mjs: confirmed — Deterministic runtime command succeeded: npm test

### TEST-DISPATCH-001 — Standalone dispatch scripts lack direct tests

- Severity: medium
- Confidence: high
- Lens: tests
- Files: dispatch/merge-results.mjs, dispatch/validate-result.mjs, dispatch/validate.mjs
- Summary: The published dispatch:merge and dispatch:validate npm scripts are not exercised directly by the test suite. Important CLI behavior such as task-id sanitization, invalid JSON handling, failed-task output, and task-context validation can drift from the newer wrapper path without a failing test.
- Evidence:
  - package.json:43 - dispatch:merge exposes node dispatch/merge-results.mjs as an npm script, and package.json:44 exposes dispatch:validate.
  - dispatch/merge-results.mjs:45 - the script parses each task-result file, validates it, and writes audit-results.json or failed-tasks.json, but repository tests do not invoke this script directly.
  - dispatch/validate-result.mjs:21 - the validation CLI sanitizes task_id into a result filename and exits based on validateResult, but repository tests do not cover this standalone path.

### COR-002 — Successful waves leave stale cooldowns active

- Severity: medium
- Confidence: high
- Lens: correctness
- Files: src/quota/state.ts, src/quota/scheduler.ts
- Summary: recordWaveOutcome clears the consecutive 429 counter after a successful wave but leaves any prior cooldown_until timestamp in place. scheduleWave treats that future timestamp as authoritative on the next pass, so a recovered provider can keep being throttled or delayed until the stale cooldown expires.
- Evidence:
  - src/quota/state.ts:163 - the success branch resets consecutive_429_count and records success buckets, but it never clears entry.cooldown_until or last_429_at.
  - src/quota/scheduler.ts:98 - scheduleWave forces waveSize to 1 whenever quotaStateEntry.cooldown_until is still in the future.

### DI-003 — Surface exposure can be omitted

- Severity: medium
- Confidence: high
- Lens: data_integrity
- Files: schemas/surface_manifest.schema.json
- Summary: Surface entries require an id, kind, and entrypoint, but exposure is optional even though the schema defines the allowed trust-boundary values. A schema-valid surface can therefore have unknown network/local exposure, weakening downstream prioritization and validation decisions that depend on that boundary data.
- Evidence:
  - schemas/surface_manifest.schema.json:12 - surface entries only require id, kind, and entrypoint.
  - schemas/surface_manifest.schema.json:20 - exposure is defined as a property but is not included in the required list.
  - schemas/surface_manifest.schema.json:22 - exposure is constrained to network or local when present, showing the schema already treats it as structured boundary data.
  - runtime:unit:schemas: confirmed — Deterministic runtime command succeeded: npm test

### TST-003 — Symbol index test only verifies module loading

- Severity: medium
- Confidence: high
- Lens: tests
- Files: .tmp/opentoken/tests/opentoken.test.ts
- Summary: The test named as symbol extraction never calls indexFile, indexDirectory, querySymbolIndex, or querySymbolPrefix. It would pass even if symbol extraction returned no entries, so the core symbol index behavior is effectively untested.
- Evidence:
  - .tmp/opentoken/tests/opentoken.test.ts:548 - The L23 Symbol Index block is titled as symbol-index coverage.
  - .tmp/opentoken/tests/opentoken.test.ts:570 - The test comments that it is just verifying the module loads.
  - .tmp/opentoken/tests/opentoken.test.ts:571 - The only assertion is expect(symbols).toBeDefined(), not an assertion on extracted or queried symbols.
  - .tmp/opentoken/src/symbolindex.ts:198 - indexFile is the public API that extracts and stores symbols, but this test does not call it.
  - runtime:unit:-tmp-opentoken: confirmed — Deterministic runtime command succeeded: npm test

### TES-001 — Symlink fixture can be skipped while the test still passes

- Severity: medium
- Confidence: high
- Lens: tests
- Files: tests/extractors-remediation.test.mjs
- Summary: The filesystem intake test swallows every symlink creation failure, then asserts the manifest contains only the regular files. On runners where symlink creation is unavailable, the test still passes without exercising whether symlink entries are ignored.
- Evidence:
  - tests/extractors-remediation.test.mjs:168 - The symlink fixture is created inside a broad try/catch, and the catch block silently accepts any failure because symlinks may be unavailable on some Windows runners.
  - tests/extractors-remediation.test.mjs:184 - The final manifest assertion expects only the two regular source files, but when the symlink was never created this assertion cannot distinguish correct symlink exclusion from an absent fixture.

### OBS-ORCH-001 — Task builder omits the observability lens

- Severity: medium
- Confidence: high
- Lens: observability
- Files: src/orchestrator.ts, src/orchestrator.ts, src/orchestrator.ts
- Summary: buildAuditTasks derives its supported lens set and default allowed lenses from DEFAULT_LENS_ORDER, but that list omits observability. Unit manifests or limit_lenses that include observability are rejected by validation or skipped by the default lens filter before observability audit tasks can be produced.
- Evidence:
  - src/orchestrator.ts:3 - DEFAULT_LENS_ORDER lists the supported/default lenses but does not include observability.
  - src/orchestrator.ts:16 - VALID_LENSES is constructed directly from DEFAULT_LENS_ORDER.
  - src/orchestrator.ts:40 - assertLensArray rejects any lens not accepted by isLens, so observability is treated as unsupported input.
  - src/orchestrator.ts:86 - normalizedOptions defaults the allowed lens set to DEFAULT_LENS_ORDER, so generated tasks cannot include observability by default.

### TST-004 — Telemetry tests depend on the real home directory

- Severity: medium
- Confidence: high
- Lens: tests
- Files: .tmp/opentoken/tests/opentoken.test.ts
- Summary: The metrics and error logging tests read and write the process user's real ~/.config/opentoken files instead of an isolated temporary home. Existing metrics or errors can change the assertions, and the tests can leave behind or truncate user-local telemetry state.
- Evidence:
  - .tmp/opentoken/src/utils/stats.ts:8 - Stats paths are derived from os.homedir() at module scope.
  - .tmp/opentoken/src/utils/errors.ts:8 - Error logging paths are derived from os.homedir() at module scope.
  - .tmp/opentoken/tests/opentoken.test.ts:1017 - The test calls saveStatsSummary() and only asserts that it does not throw.
  - .tmp/opentoken/tests/opentoken.test.ts:1025 - The error test cleanup targets ~/.config/opentoken/error.jsonl directly instead of a temp fixture.
  - runtime:unit:-tmp-opentoken: confirmed — Deterministic runtime command succeeded: npm test

### TES-001 — Tests exercise compiled dist artifacts instead of current source

- Severity: medium
- Confidence: high
- Lens: tests
- Files: tests/cli-remediation.test.mjs
- Summary: The file imports cliTestUtils, runCli, and runFirstAvailableCommand from dist/ at module load time. If dist is stale or missing relative to the edited source, these tests can silently validate old compiled output instead of the code under review.
- Evidence:
  - tests/cli-remediation.test.mjs:10 - distCliUrl is built from repoRoot/dist/cli.js rather than a source module.
  - tests/cli-remediation.test.mjs:11 - cliTestUtils and runCli are imported from that compiled dist URL before any tests run.
  - tests/cli-remediation.test.mjs:12 - runFirstAvailableCommand is also imported from dist/orchestrator/localCommands.js.
  - runtime:flow:flow:surface:tests-cli-remediation-test-mjs: confirmed — Deterministic runtime command succeeded: npm test

### TST-001 — Tests exercise compiled dist artifacts instead of source

- Severity: medium
- Confidence: high
- Lens: tests
- Files: tests/orchestration.test.mjs
- Summary: The orchestration tests import compiled files from ../dist, so source changes can be missed when dist is stale or not rebuilt. This weakens the tests as a guardrail because they can pass while the current source implementation is broken.
- Evidence:
  - tests/orchestration.test.mjs:7 - decideNextStep is imported from ../dist/orchestrator/nextStep.js rather than source.
  - tests/orchestration.test.mjs:8 - advanceAudit is imported from ../dist/orchestrator/advance.js rather than source.
  - tests/orchestration.test.mjs:10 - reporting helpers are imported from ../dist/reporting/synthesis.js rather than source.

### TES-001 — Tests exercise compiled dist output instead of source

- Severity: medium
- Confidence: high
- Lens: tests
- Files: tests/orchestrator-remediation.test.mjs
- Summary: The suite imports orchestrator modules from ../dist, so it can pass against stale compiled artifacts even when the TypeScript source has changed. That makes these tests unreliable as a guard for the current source unless a fresh build is guaranteed immediately before every run.
- Evidence:
  - tests/orchestrator-remediation.test.mjs:6 - advanceAudit is imported from ../dist/orchestrator/advance.js rather than the source implementation.
  - tests/orchestrator-remediation.test.mjs:12 - internal executor helpers are imported from ../dist/orchestrator/internalExecutors.js.
  - tests/orchestrator-remediation.test.mjs:13 - deriveAuditState is imported from ../dist/orchestrator/state.js, continuing the compiled-output dependency.
  - tests/orchestrator-remediation.test.mjs:21 - buildSelectiveDeepeningTasks is imported from ../dist/orchestrator/selectiveDeepening.js.

### TST-001 — Tests exercise compiled dist output instead of source

- Severity: medium
- Confidence: high
- Lens: tests
- Files: tests/quota-scheduler.test.mjs
- Summary: The quota scheduler tests import every module under test from ../dist rather than from the source tree. If source changes are not rebuilt first, the suite can pass against stale compiled artifacts and miss regressions in the quota scheduler logic.
- Evidence:
  - tests/quota-scheduler.test.mjs:4 - scheduleWave and buildProviderModelKey are imported from ../dist/quota/scheduler.js.
  - tests/quota-scheduler.test.mjs:7 - Host limit helpers and quota state helpers are also loaded from ../dist/quota/*.js instead of source modules.

### TES-001 — Tests import compiled dist artifacts

- Severity: medium
- Confidence: high
- Lens: tests
- Files: tests/supervisor-remediation.test.mjs
- Summary: The tests import supervisor modules from compiled ../dist files rather than the source modules. Running this test without rebuilding can exercise stale output and let source changes pass untested.
- Evidence:
  - tests/supervisor-remediation.test.mjs:7 - The tested modules are loaded from ../dist/supervisor/operatorHandoff.js, with the same compiled-output import pattern repeated for runLedger.js and sessionConfig.js on lines 10-14.

### TST-001 — Tests import compiled dist artifacts

- Severity: medium
- Confidence: high
- Lens: tests
- Files: tests/validation-remediation.test.mjs
- Summary: This test file imports validation modules from ../dist instead of the current source tree. If source changes are not rebuilt first, the test can pass against stale compiled output and miss regressions in the implementation under review.
- Evidence:
  - tests/validation-remediation.test.mjs:8 - Validation helpers are imported from ../dist/validation/basic.js, so the test executes generated output rather than the current source tree.
  - tests/validation-remediation.test.mjs:15 - Additional validation modules are also imported from ../dist/validation/*.js, creating the same stale-build risk across the file.

### TST-001 — Tests import compiled dist output

- Severity: medium
- Confidence: high
- Lens: tests
- Files: tests/design-assessment.test.mjs
- Summary: The suite imports buildDesignAssessment from the compiled dist tree instead of the source implementation. Unless every test run is preceded by a fresh build, source changes can be missed while tests continue to pass against stale generated JavaScript.
- Evidence:
  - tests/design-assessment.test.mjs:4 - buildDesignAssessment is loaded via dynamic import from ../dist/extractors/designAssessment.js rather than from the source module under test.

### TST-001 — Tests import compiled dist output instead of source

- Severity: medium
- Confidence: high
- Lens: tests
- Files: tests/reporting-remediation.test.mjs
- Summary: The suite imports mergeFindings and synthesis APIs from ../dist rather than the source modules under test. A source change can therefore be missed when the compiled output is stale, and targeted test runs can pass without exercising the current implementation.
- Evidence:
  - tests/reporting-remediation.test.mjs:4 - mergeFindings is loaded from ../dist/reporting/mergeFindings.js.
  - tests/reporting-remediation.test.mjs:5 - buildAuditReportModel and renderAuditReportMarkdown are loaded from ../dist/reporting/synthesis.js, so these tests depend on generated build artifacts.

### TST-005 — TOON conversion lacks behavioral tests

- Severity: medium
- Confidence: high
- Lens: tests
- Files: .tmp/opentoken/src/toon.ts
- Summary: The TOON converter can rewrite JSON arrays and nested objects, but no tests exercise conversion, non-conversion thresholds, escaping, or invalid JSON fallback. A regression that corrupts structured JSON or fails to save space would not be caught by the current suite.
- Evidence:
  - .tmp/opentoken/src/toon.ts:120 - convertToTOON is exported as the main conversion function.
  - .tmp/opentoken/src/toon.ts:131 - Array-of-objects conversion is gated on producing a shorter TOON result.
  - .tmp/opentoken/src/toon.ts:148 - Object array values are rewritten inside the original JSON string, but repository search found no test references to convertToTOON or TOON.
  - runtime:unit:-tmp-opentoken: confirmed — Deterministic runtime command succeeded: npm test

### TST-006 — Total test coverage gap for Make/CMake output filter

- Severity: medium
- Confidence: high
- Lens: tests
- Files: .tmp/opentoken/src/families/make.ts
- Summary: The Make/CMake output filter is completely untested in the test suite, leaving its line-folding and regex-based warning/error checks unverified.
- Evidence:
  - .tmp/opentoken/src/families/make.ts:5 - filterMakeOutput is never imported or tested in any unit test file.
  - runtime:unit:-tmp-opentoken: confirmed — Deterministic runtime command succeeded: npm test

### TST-003 — Total test coverage gap for metrics recording utility

- Severity: medium
- Confidence: high
- Lens: tests
- Files: .tmp/opentoken/.opencode/plugins/opentoken/utils/metrics.ts
- Summary: The metrics utility metrics.ts (which implements logging, directory creation, and log rotation) is completely untested by the unit test suite.
- Evidence:
  - .tmp/opentoken/.opencode/plugins/opentoken/utils/metrics.ts:59 - recordMetric function and its helpers are never imported or called in any test file.
  - runtime:unit:-tmp-opentoken: confirmed — Deterministic runtime command succeeded: npm test

### TST-007 — Total test coverage gap for PIP output filter

- Severity: medium
- Confidence: high
- Lens: tests
- Files: .tmp/opentoken/src/families/pip.ts
- Summary: The PIP install output filter is completely untested in the test suite, leaving its RLE requirement collapsing and collection folding checks unverified.
- Evidence:
  - .tmp/opentoken/src/families/pip.ts:9 - filterPipOutput is never imported or tested in any unit test file.
  - runtime:unit:-tmp-opentoken: confirmed — Deterministic runtime command succeeded: npm test

### TST-004 — Total test coverage gap for session-scoped state manager

- Severity: medium
- Confidence: high
- Lens: tests
- Files: .tmp/opentoken/.opencode/plugins/opentoken/utils/session-store.ts
- Summary: The SessionStore class is completely untested by direct unit tests in the test suite.
- Evidence:
  - .tmp/opentoken/.opencode/plugins/opentoken/utils/session-store.ts:8 - SessionStore class and its eviction/scoped methods have no direct unit tests.
  - runtime:flow:flow:surface:src-types-workerSession-ts: confirmed — Deterministic runtime command succeeded: npm test
  - runtime:unit:-tmp-opentoken: confirmed — Deterministic runtime command succeeded: npm test

### COR-001 — Trailing-slash ignore patterns are not honored

- Severity: medium
- Confidence: high
- Lens: correctness
- Files: src/extractors/fsIntake.ts
- Summary: Common directory ignore entries such as `dist/` or `coverage/` are compared without trimming the trailing slash, so they fail to match both the directory entry and all descendants. A user-supplied .auditorignore using this standard form will still be walked and included in the repository manifest.
- Evidence:
  - src/extractors/fsIntake.ts:36 - `value` is only slash-normalized; a pattern like `dist/` remains `dist/`.
  - src/extractors/fsIntake.ts:38 - the directory path `dist` is not equal to `dist/`.
  - src/extractors/fsIntake.ts:39 - descendant paths like `dist/app.js` are checked against `dist//`, so they do not match either.

### TST-004 — TSC diagnostic parsing has no positive test

- Severity: medium
- Confidence: high
- Lens: tests
- Files: src/orchestrator/syntaxResolutionExecutor.ts
- Summary: The syntax-resolution executor parses TypeScript compiler output into external analyzer findings, but tests only exercise unresolved tsc and ESLint cases. A regression in the tsc output regex or path normalization would not be caught.
- Evidence:
  - src/orchestrator/syntaxResolutionExecutor.ts:91 - runTsc parses compiler output with a specific file(line,column) regex.
  - src/orchestrator/syntaxResolutionExecutor.ts:94 - matching diagnostics are converted into ExternalAnalyzerResultItem entries with normalized paths and line_start values.
  - tests/syntax-resolution.test.mjs:96 - the only tsc-focused test forces PATH empty and asserts a not_resolved tool status, rather than a failing tsc output producing findings.
  - tests/syntax-resolution.test.mjs:125 - malformed-output coverage exists for ESLint parse errors, but there is no analogous positive tsc diagnostic fixture.

### COR-001 — validate-result looks for obsolete result filenames

- Severity: medium
- Confidence: high
- Lens: correctness
- Files: dispatch/validate-result.mjs
- Summary: The standalone dispatch validator reconstructs the result filename from a sanitized task id, but current dispatch writes packet results through digest-bearing result-map paths. As a result, validate-result can report File not found for valid submitted task results.
- Evidence:
  - dispatch/validate-result.mjs:25 - resultPath is built as join(taskResultsDir, sanitized + '.json') instead of consulting dispatch-result-map.json.
  - src/cli.ts:293 - current taskResultPath uses artifactNameForId(taskId, 'json'), which appends a digest and produces a different filename.

### TES-001 — Validation tests exercise compiled dist output

- Severity: medium
- Confidence: high
- Lens: tests
- Files: tests/validate-command.test.mjs
- Summary: The suite imports runCli from dist/cli.js and also constructs argv with the compiled dist path. These tests can pass against stale compiled output when source changes have not been rebuilt, weakening them as a regression gate for the current source tree.
- Evidence:
  - tests/validate-command.test.mjs:10 - distCliUrl points at repoRoot/dist/cli.js.
  - tests/validate-command.test.mjs:11 - runCli is imported from the compiled dist URL instead of source.
  - tests/validate-command.test.mjs:22 - The argv fixture also identifies dist/cli.js as the CLI path.
  - runtime:flow:flow:surface:tests-validate-command-test-mjs: confirmed — Deterministic runtime command succeeded: npm test

### COR-009 — Windows path validation failure in safeReadRoot pattern

- Severity: medium
- Confidence: high
- Lens: correctness
- Files: .tmp/opentoken/.opencode/opentoken-config-schema.json
- Summary: The safeReadRoot property has a regex pattern ^(|[a-zA-Z0-9_/.-]+)$ that does not permit colons (:) or backslashes (\), causing validation to fail for standard absolute Windows directories (e.g., C:\Code).
- Evidence:
  - .tmp/opentoken/.opencode/opentoken-config-schema.json:24 - '"pattern": "^(|[a-zA-Z0-9_/.-]+)$"'
  - runtime:unit:-tmp-opentoken: confirmed — Deterministic runtime command succeeded: npm test

### TST-004 — Zero test coverage for session state tracking, persistence, and cross-session memory

- Severity: medium
- Confidence: high
- Lens: tests
- Files: .tmp/opentoken/.opencode/plugins/opentoken/session.ts, .tmp/opentoken/.opencode/plugins/opentoken/memory.ts
- Summary: Key operational features session.ts and memory.ts have absolutely no test coverage, making cross-session summary generation completely untested.
- Evidence:
  - .tmp/opentoken/.opencode/plugins/opentoken/session.ts:1 - Session tracking and disk state serialization have zero test coverage
  - .tmp/opentoken/.opencode/plugins/opentoken/memory.ts:1 - Session summary persistence and context keywords extraction are completely untested
  - runtime:flow:flow:surface:src-types-workerSession-ts: confirmed — Deterministic runtime command succeeded: npm test
  - runtime:unit:-tmp-opentoken: confirmed — Deterministic runtime command succeeded: npm test

### DR-004 — Command surfaces lack a shared registry

- Severity: medium
- Confidence: medium
- Lens: architecture
- Files: src/cli.ts, src/mcp/server.ts, src/orchestrator/localCommands.ts, skills/audit-code/opencode-command-template.txt
- Summary: The repository exposes audit behavior through CLI commands, MCP tools, host command templates, docs, and generated prompt instructions. Those surfaces currently duplicate command names, argument spelling, continuation behavior, and safety guidance in separate modules. As the product grows, this makes it easy for one surface to learn a command such as merge-and-ingest, submit-packet, or report-capability while another remains stale or exposes different argument semantics. Introduce a shared command registry that owns command metadata, stable IDs, argument aliases, capability requirements, and help text, then generate CLI help, MCP tool definitions, and host templates from that registry.
- Evidence:
  - runtime:flow:flow:surface:skills-audit-code-opencode-command-template-txt: confirmed — Deterministic runtime command succeeded: npm test
  - runtime:flow:flow:surface:src-cli-ts: confirmed — Deterministic runtime command succeeded: npm test
  - runtime:flow:flow:surface:src-orchestrator-localCommands-ts: confirmed — Deterministic runtime command succeeded: npm test

### TST-007 — JSON-output helper can pass before process exit

- Severity: medium
- Confidence: medium
- Lens: tests
- Files: tests/audit-code-wrapper.test.mjs
- Summary: runWrapperJsonOutput resolves as soon as stdout parses as JSON and then kills the child if it has not exited. Tests using that helper can miss trailing stderr, cleanup failures, or a later nonzero exit after the first JSON object is emitted.
- Evidence:
  - tests/audit-code-wrapper.test.mjs:60 - runWrapperJsonOutput starts a wrapper subprocess and tracks stdout/stderr independently.
  - tests/audit-code-wrapper.test.mjs:91 - settle kills the child if it has not already exited.
  - tests/audit-code-wrapper.test.mjs:103 - the stdout data handler resolves immediately after JSON.parse(stdout) succeeds, before observing the command's natural exit status.

### COR-006 — Noise-directory filter uses forward-slash assumptions that can be defeated on Windows

- Severity: medium
- Confidence: medium
- Lens: correctness
- Files: .tmp/opentoken/src/filters/glob.ts, .tmp/opentoken/src/families/fs.ts
- Summary: filterFind (fs.ts:50) and filterGlob (glob.ts:28) check noise directories by matching the pattern `/${d}/` or `${d}/`. If the runtime is on Windows and a caller passes native backslash-separated paths (e.g. from a native PowerShell `Get-ChildItem` glob or a Windows-native path string), the slash-based checks silently fail, letting noise directories pass through. In practice, Node.js glob libraries always normalise to forward slashes, and POSIX `find` is typically run via WSL/Git Bash where paths also use forward slashes, so real exposure is narrower than originally assessed. The finding is valid but should be narrowed: severity is downgraded from high to medium and confidence from high to medium because the affected code paths are unlikely to receive native Windows backslash paths in the tool's primary use cases. filterLs (fs.ts:28) is unaffected — it uses a plain `line.includes(d)` check with no slash assumption.
- Evidence:
  - glob.ts:28 - filter predicate: !NOISE_DIRS.some((d) => p.includes(`/${d}/`) || p.startsWith(`${d}/`)) — only matches forward-slash separators
  - fs.ts:50 - filter predicate: !NOISE_DIRS.some((d) => l.includes(`/${d}/`) || l.startsWith(`${d}/`)) — only matches forward-slash separators
  - fs.ts:28 - filterLs uses plain line.includes(d) with no slash assumption — NOT affected
  - Node.js glob libraries (glob, fast-glob, etc.) always normalise separators to forward slashes on all platforms, reducing actual Windows exposure for filterGlob
  - POSIX `find` on Windows typically requires WSL or Git Bash, both of which emit forward-slash paths, further reducing exposure for filterFind
  - A Windows-native caller supplying backslash paths (e.g. from PowerShell Resolve-Path) would bypass the filter entirely — the edge case exists but is not the primary runtime scenario
  - runtime:unit:-tmp-opentoken: confirmed — Deterministic runtime command succeeded: npm test

### TST-003 — Quota state updates lack side-effect coverage

- Severity: medium
- Confidence: medium
- Lens: tests
- Files: src/quota/state.ts
- Summary: Quota learning depends on recordWaveOutcome mutating persisted buckets, cooldowns, and consecutive 429 counts, but tests only exercise the pure helper functions. A regression in the locked read/modify/write path could silently disable learned throttling.
- Evidence:
  - src/quota/state.ts:147 - recordWaveOutcome acquires the quota-state lock before updating persisted state.
  - src/quota/state.ts:164 - success outcomes add success weight to each bucket up to the observed concurrency.
  - src/quota/state.ts:173 - rate-limited outcomes update consecutive_429_count, last_429_at, cooldown_until, and failure weights.
  - tests/quota-scheduler.test.mjs:9 - the state imports used by tests cover decay and concurrency/backoff helpers, but not recordWaveOutcome.

### OBS-002 — Runtime validation evidence truncates root-cause output

- Severity: medium
- Confidence: medium
- Lens: observability
- Files: src/orchestrator/internalExecutors.ts
- Summary: Runtime validation stores only the final ten combined stdout/stderr lines for every command outcome. Long test failures commonly report the failing command or stack trace before the tail, leaving later audit artifacts without enough diagnostic context to explain a not_confirmed result.
- Evidence:
  - src/orchestrator/internalExecutors.ts:119 - runCommand buffers stdout and stderr separately while the child runs.
  - src/orchestrator/internalExecutors.ts:135 - the streams are merged into a single output string, losing stream attribution.
  - src/orchestrator/internalExecutors.ts:136 - evidence is limited to output.split(...).slice(-10), so only the final ten lines are persisted with the runtime validation result.

### COR-004 — Timeout can fire after the child has exited

- Severity: medium
- Confidence: medium
- Lens: correctness
- Files: src/providers/spawnLoggedCommand.ts
- Summary: spawnLoggedCommand keeps the timeout timer active until close and pending log writes settle, even after the child exit event has provided an exit code. A command that exits before timeout but has slow stdio close or log flush can therefore be rejected as timed out.
- Evidence:
  - src/providers/spawnLoggedCommand.ts:162 - the timer sets timedOut and sends SIGTERM when input.timeoutMs elapses.
  - src/providers/spawnLoggedCommand.ts:197 - the exit handler only stores code and signal and does not clear the timeout timer.
  - src/providers/spawnLoggedCommand.ts:201 - final settlement waits for close and pending log writes, so the still-active timer can flip timedOut after process exit.
  - runtime:flow:flow:surface:src-providers-spawnLoggedCommand-ts: confirmed — Deterministic runtime command succeeded: npm test

### TST-005 — Work-block dependency calculation is untested

- Severity: medium
- Confidence: medium
- Lens: tests
- Files: src/reporting/workBlocks.ts
- Summary: The reporting tests exercise finding merging and single-block synthesis, but not the graph and critical-flow dependency calculation that fills depends_on. Ordering or dependency regressions in remediation blocks could reach generated reports without a focused failure.
- Evidence:
  - src/reporting/workBlocks.ts:47 - computeDependencies builds block dependencies from import/call graph edges and critical flow paths.
  - src/reporting/workBlocks.ts:95 - the function writes sorted depends_on arrays back into each work block.
  - tests/reporting-remediation.test.mjs:141 - buildAuditReportModel coverage asserts summary and evidence aggregation, but supplies no graphBundle or criticalFlows that would exercise depends_on.

### DA-014 — Critical flow "interface flow for tests/cli-remediation.test.mjs" has weak graph coverage

- Severity: medium
- Confidence: low
- Lens: architecture
- Files: tests/cli-remediation.test.mjs
- Summary: 1 of 1 files in flow "interface flow for tests/cli-remediation.test.mjs" have no dependency graph edges. The flow's structural integrity cannot be verified through static analysis alone.
- Evidence:
  - runtime:flow:flow:surface:tests-cli-remediation-test-mjs: confirmed — Deterministic runtime command succeeded: npm test

### DA-015 — Critical flow "interface flow for tests/status-command.test.mjs" has weak graph coverage

- Severity: medium
- Confidence: low
- Lens: architecture
- Files: tests/status-command.test.mjs
- Summary: 1 of 1 files in flow "interface flow for tests/status-command.test.mjs" have no dependency graph edges. The flow's structural integrity cannot be verified through static analysis alone.
- Evidence:
  - runtime:flow:flow:surface:tests-status-command-test-mjs: confirmed — Deterministic runtime command succeeded: npm test

### DA-016 — Critical flow "interface flow for tests/validate-command.test.mjs" has weak graph coverage

- Severity: medium
- Confidence: low
- Lens: architecture
- Files: tests/validate-command.test.mjs
- Summary: 1 of 1 files in flow "interface flow for tests/validate-command.test.mjs" have no dependency graph edges. The flow's structural integrity cannot be verified through static analysis alone.
- Evidence:
  - runtime:flow:flow:surface:tests-validate-command-test-mjs: confirmed — Deterministic runtime command succeeded: npm test

### TST-001 — Adapter tests import compiled dist

- Severity: low
- Confidence: high
- Lens: tests
- Files: src/adapters/coverageSummary.ts, src/adapters/eslint.ts, src/adapters/normalizeExternal.ts, src/adapters/npmAudit.ts, src/adapters/semgrep.ts
- Summary: The adapter remediation tests import the compiled dist modules instead of the TypeScript source under src/adapters. Full npm test rebuilds first, but direct or single-file test runs can silently exercise stale dist output and miss changes in these adapter sources.
- Evidence:
  - tests/adapters-remediation.test.mjs:4 - normalizeCoverageSummary is imported from ../dist/adapters/coverageSummary.js; the same file imports eslint, npm-audit, and semgrep normalizers from ../dist at lines 7-11.
  - tests/helpers/sourceImport.mjs:48 - repository tests already have importSourceModule(sourceRelativePath), which compiles src to an isolated temporary output before importing.
  - src/adapters/normalizeExternal.ts:3 - the shared normalizeGenericExternalResults implementation is part of this packet, but the adapter tests currently reach it only through dist output.

### TST-008 — Blocked-handoff test has tautological length assertions

- Severity: low
- Confidence: high
- Lens: tests
- Files: tests/audit-code-wrapper.test.mjs
- Summary: The no-arguments blocked-handoff test asserts that suggested_inputs.length and suggested_commands.length are greater than or equal to zero, which is true for any array. These assertions do not verify the intended handoff contents and can let regressions in suggested evidence/command behavior pass.
- Evidence:
  - tests/audit-code-wrapper.test.mjs:377 - assert.ok(parsed.handoff.suggested_inputs.length >= 0) is satisfied for every array length.
  - tests/audit-code-wrapper.test.mjs:378 - assert.ok(parsed.handoff.suggested_commands.length >= 0) is likewise tautological and does not constrain blocked-handoff behavior.

### TST-003 — Browser extension risk-signal helper is untested

- Severity: low
- Confidence: high
- Lens: tests
- Files: src/extractors/browserExtension.ts
- Summary: The browser-extension extractor exports a helper that identifies high-risk permissions from permissions, optional_permissions, and host_permissions, but no test references that helper. The existing Chrome extension fixture includes risky permissions yet only asserts graph and surface behavior, so permission-risk regressions would not be caught.
- Evidence:
  - src/extractors/browserExtension.ts:481 - chromeExtensionRiskSignalsForManifest parses manifest permissions and returns high-risk permission tokens.
  - tests/extractors-remediation.test.mjs:645 - the Chrome extension fixture includes tabs, downloads, scripting, and <all_urls>, but the assertions cover graph/surface edges rather than risk-signal extraction.
  - tests/extractors-remediation.test.mjs:7 - the extractor test imports several source modules, but repository search finds no test reference to chromeExtensionRiskSignalsForManifest.

### MNT-004 — CLI fixture helpers are copied across tiny tests

- Severity: low
- Confidence: high
- Lens: maintainability
- Files: tests/audit-code-completion.test.mjs, tests/audit-code-lifecycle.test.mjs, tests/config-error-handling.test.mjs, tests/next-step.test.mjs, tests/fixture-repo.test.mjs, tests/helpers/provider-assisted-bridge.mjs
- Summary: Several small test files and the provider-assisted bridge each define their own wrapper process, temp repository, line-count, or synthetic-result helpers. The copies differ only in small env and fixture details, making changes to CLI invocation or audit-result shape easy to miss in one location.
- Evidence:
  - tests/audit-code-completion.test.mjs:16 - This file defines local countLines, buildSyntheticResults, runWrapper, and withTempRepo helpers for wrapper integration coverage.
  - tests/audit-code-lifecycle.test.mjs:13 - The lifecycle test repeats the spawn-based runWrapper and temp repo fixture shape with the same auth/session/deploy files.
  - tests/next-step.test.mjs:20 - The next-step tests carry another runWrapper/withTempRepo copy with only small env and fixture differences.
  - tests/helpers/provider-assisted-bridge.mjs:52 - The bridge repeats countLines and synthetic AuditResult generation that overlaps with tests/audit-code-completion.test.mjs, while tests/fixture-repo.test.mjs repeats line counting at line 24.
  - runtime:unit:tests-helpers: confirmed — Deterministic runtime command succeeded: npm test

### TST-001 — CLI tests exercise the compiled dist build

- Severity: low
- Confidence: high
- Lens: tests
- Files: src/cli.ts
- Summary: The CLI test file imports dist/cli.js and invokes the dist path instead of compiling/importing the current source like the sourceImport-based tests do. Direct test runs can therefore pass against a stale build even when src/cli.ts has changed.
- Evidence:
  - src/cli.ts:1040 - cliTestUtils is exported from the source file that the CLI remediation tests intend to exercise.
  - tests/cli-remediation.test.mjs:10 - the test constructs distCliUrl from dist/cli.js and imports cliTestUtils/runCli from that compiled artifact.
  - tests/cli-remediation.test.mjs:168 - command-path scenarios also invoke join(repoRoot, "dist", "cli.js") rather than a source-compiled module.
  - runtime:flow:flow:surface:src-cli-ts: confirmed — Deterministic runtime command succeeded: npm test

### MAI-001 — Coverage statuses are modeled as unbounded strings

- Severity: low
- Confidence: high
- Lens: maintainability
- Files: src/types.ts
- Summary: CoverageFileRecord exposes classification_status and audit_status as arbitrary strings even though coverage code treats them as finite states. This makes future state changes and typos hard to catch at compile time across coverage consumers.
- Evidence:
  - src/types.ts:55 - CoverageFileRecord defines the coverage record contract but lines 58-59 type classification_status and audit_status as unrestricted strings.
  - src/coverage.ts:13 - createCoverageMatrix initializes classification_status and audit_status with exact state literals such as unclassified and pending.
  - src/coverage.ts:78 - applyFileCoverage branches by exact audit_status strings such as complete and partial, so a misspelled status would silently fall outside the intended state machine.

### OBS-002 — Delegated command failures lose command context

- Severity: low
- Confidence: high
- Lens: observability
- Files: audit-code-wrapper-lib.mjs, audit-code-wrapper-lib.mjs, audit-code-wrapper-lib.mjs
- Summary: The wrapper's shared run() helper rejects non-captured command failures with only an exit code, omitting the delegated command, arguments, and cwd. Wrapper subcommands that call build or dist entrypoints can therefore surface an unhelpful "Command failed with exit code" message when the child provides little output.
- Evidence:
  - audit-code-wrapper-lib.mjs:78 - run() resolves and spawns a command, but the error constructed at line 105 omits the command, args, and cwd when capture is disabled.
  - audit-code-wrapper-lib.mjs:2739 - Wrapper subcommands delegate through runDistCommand(), so a quiet failure in the dist command can collapse to the generic run() error.
  - audit-code-wrapper-lib.mjs:2877 - The default audit path also delegates through run(), making the generic failure text user-facing for run-to-completion and advance-audit failures.

### COR-001 — Discovered limits cache accepts malformed entries

- Severity: low
- Confidence: high
- Lens: correctness
- Files: src/quota/discoveredLimits.ts, src/quota/discoveredLimits.ts
- Summary: readDiscoveredLimitsCache treats any version-1 object as a valid cache without checking that entries is a non-null record. updateDiscoveredLimits and lookupDiscoveredLimits then index cache.entries, so a malformed cache can throw instead of being ignored and rebuilt.
- Evidence:
  - src/quota/discoveredLimits.ts:28 - readDiscoveredLimitsCache only verifies that parsed is a non-array object with version === 1 before casting it to DiscoveredLimitsCache.
  - src/quota/discoveredLimits.ts:62 - updateDiscoveredLimits immediately reads cache.entries[providerModelKey], so an accepted cache with missing or null entries crashes instead of falling back to an empty cache.

### MAIN-DISPATCH-001 — Dispatch CLIs duplicate result validation plumbing

- Severity: low
- Confidence: high
- Lens: maintainability
- Files: dispatch/merge-results.mjs, dispatch/validate-result.mjs
- Summary: The merge and single-result validation scripts each hand-roll argument parsing, artifact path resolution, task manifest loading, JSON parsing, and validateResult invocation. Changes to dispatch artifact layout or validation diagnostics must be replicated across both scripts, increasing the chance they drift.
- Evidence:
  - dispatch/validate-result.mjs:5 - validates --run-id, --task-id, resolves --artifacts-dir, constructs task-results paths, parses JSON, loads pending-audit-tasks.json, and calls validateResult in one script.
  - dispatch/merge-results.mjs:5 - repeats related --run-id/--artifacts-dir parsing, task map loading, per-file JSON parsing, and validateResult orchestration instead of sharing a dispatch helper.

### OBS-005 — Dropped context lines during diff folding

- Severity: low
- Confidence: high
- Lens: observability
- Files: .tmp/opentoken/src/folding.ts
- Summary: In foldDiff, a context line that is a single space ' ' has line.length === 1, which fails the line.length > 1 check. This causes the context run to flush and the line to be omitted, breaking diff representation.
- Evidence:
  - .tmp/opentoken/src/folding.ts:42 - if (line.startsWith(' ') && line.length > 1) excludes single-space blank lines in diffs, causing diff fragmentation.
  - runtime:unit:-tmp-opentoken: confirmed — Deterministic runtime command succeeded: npm test

### MNT-001 — Duplicated MCP frame parsing in test helpers

- Severity: low
- Confidence: high
- Lens: maintainability
- Files: tests/mcp-server.test.mjs, tests/mcp-server.test.mjs
- Summary: The test file contains two separate hand-rolled Content-Length frame parsers. Any framing behavior or error-handling change now has to be mirrored in both helpers, making the harness easier to drift and harder to maintain safely.
- Evidence:
  - tests/mcp-server.test.mjs:39 - createMcpClient parses stdout frames inline, including header splitting, Content-Length extraction, frame-length calculation, JSON parsing, and buffer slicing.
  - tests/mcp-server.test.mjs:112 - parseFramedMessage repeats the same Content-Length framing algorithm for readFramedPayload instead of sharing the helper used by the client harness.

### DI-004 — Excluded files do not require an exclusion reason

- Severity: low
- Confidence: high
- Lens: data_integrity
- Files: schemas/repo_manifest.schema.json
- Summary: Repository manifest file entries allow excluded and exclusion_reason independently, and only path, language, and size_bytes are required. A manifest can validate with excluded files that have no reason, or with exclusion reasons attached to files not marked excluded, reducing the auditability of omitted repository data.
- Evidence:
  - schemas/repo_manifest.schema.json:23 - file entries require only path, language, and size_bytes.
  - schemas/repo_manifest.schema.json:29 - excluded is an optional boolean field.
  - schemas/repo_manifest.schema.json:30 - exclusion_reason is an optional string field with no conditional requirement when excluded is true.
  - runtime:unit:schemas: confirmed — Deterministic runtime command succeeded: npm test

### COR-002 — Extensionless known filenames return unknown language

- Severity: low
- Confidence: high
- Lens: correctness
- Files: src/extractors/fileInventory.ts
- Summary: The generated language map contains filename keys such as `dockerfile`, `containerfile`, and `makefile`, but `inferLanguage` only looks up the suffix after a dot. As a result common extensionless files are reported as `unknown` even though the map has explicit classifications for them.
- Evidence:
  - src/extractors/fileInventory.ts:284 - the language map includes `dockerfile` and `containerfile` entries.
  - src/extractors/fileInventory.ts:730 - the language map includes a `makefile` entry.
  - src/extractors/fileInventory.ts:1466 - `inferLanguage` uses an empty lookup key when the basename has no dot, so those filename entries are never used.

### MAINT-004 — Finding deduplication repeats the same pairwise merge algorithm

- Severity: low
- Confidence: high
- Lens: maintainability
- Files: src/reporting/mergeFindings.ts
- Summary: deduplicateSameLens and deduplicateCrossLens each build groups, run nested pairwise comparisons, calculate title similarity and path overlap, choose a survivor by severity/confidence, absorb the duplicate, and filter removed findings. The small policy differences are hidden inside duplicated control flow, so tuning deduplication risks drifting one path from the other.
- Evidence:
  - src/reporting/mergeFindings.ts:149 - deduplicateSameLens groups findings, maintains a removed set, iterates pairwise, checks title similarity/path overlap, ranks severity/confidence, and absorbs a duplicate survivor.
  - src/reporting/mergeFindings.ts:194 - deduplicateCrossLens repeats the same grouping, removed-set, pairwise comparison, title similarity, path overlap, severity/confidence ranking, absorb, and filter pattern with only threshold and lens checks changed.

### MNT-001 — Generated language table is embedded in extractor logic

- Severity: low
- Confidence: high
- Lens: maintainability
- Files: src/extractors/fileInventory.ts
- Summary: fileInventory.ts stores a 1,452-line auto-generated extension map in the same module as the handwritten manifest builder. That makes routine extractor changes noisy to review and couples generated language-data churn to the inventory API.
- Evidence:
  - src/extractors/fileInventory.ts:10 - The auto-generated language map begins before any inventory logic and runs through line 1461.
  - src/extractors/fileInventory.ts:1463 - The handwritten inferLanguage helper and buildRepoManifest export start immediately after the generated block at lines 1463 and 1470.

### OBS-EXT-001 — Ignore-file access errors look like no ignore file

- Severity: low
- Confidence: high
- Lens: observability
- Files: src/extractors/ignore.ts
- Summary: loadIgnoreFile catches every access failure and returns an empty ignore list, so permission or filesystem errors are indistinguishable from a missing .auditorignore. This can unexpectedly expand audit scope without a warning explaining why the ignore rules were not applied.
- Evidence:
  - src/extractors/ignore.ts:11 - The function checks ignore-file existence with access(path, constants.F_OK).
  - src/extractors/ignore.ts:12 - The catch block returns [] for every access failure without checking whether the error was ENOENT or something diagnostic-worthy.

### MAINT-005 — Inconsistent token estimation utility usage

- Severity: low
- Confidence: high
- Lens: maintainability
- Files: .tmp/opentoken/.opencode/plugins/opentoken/history.ts, .tmp/opentoken/.opencode/plugins/opentoken/index.ts
- Summary: The history compression module implements its own private token estimation function using char division, ignoring the shared tokens utility module imported by autoescalate and index. This leads to drift in how token capacity is computed before compaction vs escalation.
- Evidence:
  - .tmp/opentoken/.opencode/plugins/opentoken/history.ts:26 - Private estimateTokens divides string length by 4
  - .tmp/opentoken/.opencode/plugins/opentoken/index.ts:314 - safeEstimateTokens wraps the imported utility with a local fallback logic
  - runtime:unit:-tmp-opentoken: confirmed — Deterministic runtime command succeeded: npm test

### MAI-001 — Inline artifact fixtures are repeatedly hand-built

- Severity: low
- Confidence: high
- Lens: maintainability
- Files: tests/validate-command.test.mjs
- Summary: The tests repeatedly create artifact directories and hand-write large JSON fixtures inline. Adding new validation scenarios requires copying the same writeFile/JSON.stringify structure, which makes fixture drift more likely as the artifact schema evolves.
- Evidence:
  - tests/validate-command.test.mjs:79 - The test creates artifactsDir locally before several raw artifact writeFile calls.
  - tests/validate-command.test.mjs:82 - repo_manifest.json is written with an inline JSON.stringify fixture, a pattern repeated for other artifacts.
  - tests/validate-command.test.mjs:203 - Another test repeats the same writeFile(JSON.stringify(..., null, 2)) fixture construction instead of using a focused artifact helper.
  - tests/validate-command.test.mjs:232 - The session-config case repeats the raw JSON artifact-writing pattern again.
  - runtime:flow:flow:surface:tests-validate-command-test-mjs: confirmed — Deterministic runtime command succeeded: npm test

### MNT-001 — Inline Synonym and Filler Words Map

- Severity: low
- Confidence: high
- Lens: maintainability
- Files: .tmp/opentoken/src/autoescalate.ts
- Summary: Large hardcoded lists and maps for filler phrases and synonyms are defined inline within the autoescalate compression functions, hindering maintainability.
- Evidence:
  - .tmp/opentoken/src/autoescalate.ts:123 - The fillers array contains 35 phrases hardcoded within applyLeanCompression.
  - .tmp/opentoken/src/autoescalate.ts:165 - The synonyms mapping is hardcoded inline inside the same function.
  - runtime:unit:-tmp-opentoken: confirmed — Deterministic runtime command succeeded: npm test

### OBS-GRAPH-002 — Malformed JSON schemas lose reference diagnostics

- Severity: low
- Confidence: high
- Lens: observability
- Files: src/extractors/graph.ts
- Summary: extractJsonSchemaReferenceEdges converts JSON.parse failures into an empty edge set without identifying the malformed schema file. Operators see missing schema-reference edges but receive no warning that parsing failed.
- Evidence:
  - src/extractors/graph.ts:1057 - JSON schema content is parsed inside a try block.
  - src/extractors/graph.ts:1058 - The catch block returns [] without preserving the parse error or file path as diagnostic output.

### TST-003 — MCP framing parser needs malformed-header tests

- Severity: low
- Confidence: high
- Lens: tests
- Files: src/mcp/server.ts, src/mcp/server.ts
- Summary: The MCP frame parser validates several Content-Length error cases, but negative coverage should pin malformed headers beyond a single bad value. Add tests for missing headers, empty and non-integer values, extra colon-separated data, duplicate Content-Length headers, whitespace variants, oversized lengths, and oversized partial frames.
- Evidence:
  - src/mcp/server.ts:135 - parseContentLength locates the first content-length header and derives the raw value from the text after the first colon.
  - src/mcp/server.ts:146 - The parser rejects empty, non-integer, negative, and oversized lengths through one validation branch.
  - src/mcp/server.ts:747 - extractFrames converts parser errors into invalid-framing responses and clears the buffered input.

### COR-003 — Memory-size log normalization emits a literal capture placeholder

- Severity: low
- Confidence: high
- Lens: correctness
- Files: .tmp/opentoken/src/postcall.ts
- Summary: The memory-size normalization regex has only one capture group, but the replacement string references $2. Normalized output therefore contains the literal placeholder instead of preserving the unit.
- Evidence:
  - .tmp/opentoken/src/postcall.ts:349 - the replacement string is [X]$2 even though the unit group is non-capturing, so inputs like 512 KB become [X]$2.
  - runtime:unit:-tmp-opentoken: confirmed — Deterministic runtime command succeeded: npm test

### OBS-002 — Missing Role Information in Tool Metrics Telemetry

- Severity: low
- Confidence: high
- Lens: observability
- Files: .tmp/opentoken/.opencode/plugins/opentoken/index.ts
- Summary: The recordMetric call for tool output compression omits the role field, resulting in incomplete and inconsistent telemetry logging compared to assistant compression metrics.
- Evidence:
  - .tmp/opentoken/.opencode/plugins/opentoken/index.ts:1374 - recordMetric call for tool output compression omits the role field.
  - runtime:unit:-tmp-opentoken: confirmed — Deterministic runtime command succeeded: npm test

### TST-002 — Next-step default test inherits dispatch environment

- Severity: low
- Confidence: high
- Lens: tests
- Files: tests/next-step.test.mjs, tests/next-step.test.mjs
- Summary: The next-step wrapper helper removes CLAUDECODE but otherwise inherits process.env while the default-behavior test assumes no host dispatch setting is configured. Because the same file verifies AUDIT_CODE_HOST_CAN_DISPATCH changes the branch, setting that variable in the parent process can make this test exercise the environment override or fail nondeterministically instead of proving the default path.
- Evidence:
  - tests/next-step.test.mjs:20 - runWrapper only strips CLAUDECODE before passing the inherited environment into the child process.
  - tests/next-step.test.mjs:119 - the default-dispatch test calls advancePastDesignReview without clearing AUDIT_CODE_HOST_CAN_DISPATCH, while lines 158-167 show that variable intentionally changes next-step behavior.

### MAINT-002 — OpenCode permissions are duplicated across default and auditor agent scopes

- Severity: low
- Confidence: high
- Lens: maintainability
- Files: opencode.json
- Summary: opencode.json repeats the same read/glob/grep/external_directory/edit/bash permission rules at the top level and under agent.auditor.permission. Any allow or deny pattern change must be mirrored manually in both places, increasing the chance that the project and auditor agent drift apart.
- Evidence:
  - opencode.json:4 - the top-level permission block defines read/glob/grep, edit allowlists, and a long bash allow/deny table.
  - opencode.json:63 - agent.auditor.permission repeats the same read/glob/grep/external_directory/edit structure.
  - opencode.json:81 - the agent.auditor.permission.bash table repeats the audit-code deny and allow patterns from the top-level bash table.

### MNT-001 — Packet submission fixture is duplicated

- Severity: low
- Confidence: high
- Lens: maintainability
- Files: tests/audit-code-wrapper.test.mjs
- Summary: Two wrapper integration tests manually rebuild the same packet result arrays and invoke submit-packet instead of sharing a helper. Changes to the packet result shape or submit-packet arguments now have to be mirrored in multiple long test bodies.
- Evidence:
  - tests/audit-code-wrapper.test.mjs:471 - The legacy-result test reads pending-audit-tasks, dispatch-plan, and dispatch-result-map, builds packetResults by hand, and calls submit-packet for every packet.
  - tests/audit-code-wrapper.test.mjs:634 - The spurious-file test repeats the same taskById, plan/resultMap loop, packetResults construction, and submit-packet invocation.
  - tests/audit-code-wrapper.test.mjs:199 - validAuditResultForTask already centralizes the per-task result shape, but these submit-all-packets flows still duplicate the larger fixture orchestration.

### MNT-002 — prepare-dispatch CLI setup is repeated

- Severity: low
- Confidence: high
- Lens: maintainability
- Files: tests/review-packets.test.mjs
- Summary: The prepare-dispatch tests repeatedly create run directories, write pending-audit-tasks.json, patch console.log, invoke runCli, and read back dispatch artifacts inline. A small helper for this fixture would reduce drift when the CLI invocation or artifact contract changes.
- Evidence:
  - tests/review-packets.test.mjs:1007 - The multi-output prompt test creates the run directory, writes pending-audit-tasks.json, patches console.log, calls runCli, then parses stdout and dispatch artifacts.
  - tests/review-packets.test.mjs:1113 - The small-model routing test repeats the same run directory, pending task file, console.log patch, and runCli sequence before reading dispatch-plan.json.
  - tests/review-packets.test.mjs:1162 - The sanitized-id collision test repeats the same prepare-dispatch harness again, and the large-file test repeats it at line 1231.

### TST-005 — Prompt tests exercise dist output instead of current source

- Severity: low
- Confidence: high
- Lens: tests
- Files: src/prompts/renderWorkerPrompt.ts
- Summary: render-worker-prompt.test.mjs imports the compiled dist prompt, so focused test runs can validate stale output after source changes. The full npm test script builds first, but the test file itself is not protected against direct node --test execution on stale dist artifacts.
- Evidence:
  - tests/render-worker-prompt.test.mjs:4 - the prompt test imports renderWorkerPrompt from ../dist/prompts/renderWorkerPrompt.js instead of the source module.
  - package.json:26 - npm test mitigates this only for the full suite by running npm run build before node --test.
  - tests/helpers/sourceImport.mjs:48 - the repository already has an importSourceModule helper that compiles source to a temporary dist directory for source-backed tests.
  - runtime:flow:flow:surface:src-prompts-renderWorkerPrompt-ts: confirmed — Deterministic runtime command succeeded: npm test
  - runtime:flow:flow:surface:src-types-workerResult-ts: confirmed — Deterministic runtime command succeeded: npm test
  - runtime:flow:flow:surface:src-types-workerSession-ts: confirmed — Deterministic runtime command succeeded: npm test
  - runtime:flow:flow:surface:tests-render-worker-prompt-test-mjs: confirmed — Deterministic runtime command succeeded: npm test

### CFG-002 — Publish workflow installs a mutable npm toolchain version

- Severity: low
- Confidence: high
- Lens: config_deployment
- Files: .github/workflows/publish-package.yml
- Summary: The trusted-publishing job upgrades npm with a semver range instead of a fixed version. Future npm 11 releases can change publish behavior or break the deployment pipeline without a repository change.
- Evidence:
  - .github/workflows/publish-package.yml:67 - The deployment job runs npm install -g npm@^11.5.1, allowing the deployed publish toolchain to float over time.

### COR-003 — Quota state accepts non-record entries

- Severity: low
- Confidence: high
- Lens: correctness
- Files: src/quota/state.ts, src/quota/state.ts
- Summary: isQuotaState accepts entries whenever typeof entries is object, which includes null and arrays. Version-2 state with entries:null is returned as valid and later crashes on indexing; array entries can also be mutated in memory but serialized back without the keyed quota data.
- Evidence:
  - src/quota/state.ts:46 - the type guard returns true for version 1 or 2 when typeof obj["entries"] === "object", without excluding null or arrays.
  - src/quota/state.ts:161 - recordWaveOutcomeUnsafe assumes state.entries is a record and indexes state.entries[providerModelKey], which fails for entries:null and loses keyed data for array entries.

### TST-004 — Recent-run cap is not exercised

- Severity: low
- Confidence: high
- Lens: tests
- Files: tests/status-command.test.mjs
- Summary: The status command test says recent_runs should be capped at five, but the fixture seeds only two ledger entries and then checks length <= 5. Removing or breaking the cap would not be caught because the test data never exceeds the limit.
- Evidence:
  - tests/status-command.test.mjs:111 - the ledger fixture contains only run-001 and run-002.
  - tests/status-command.test.mjs:154 - the cap assertion checks recent_runs.length <= 5 even though the fixture cannot produce more than two entries.
  - runtime:flow:flow:surface:tests-status-command-test-mjs: confirmed — Deterministic runtime command succeeded: npm test

### MAINT-004 — Redundant error-pattern scanning and filtering across tool families

- Severity: low
- Confidence: high
- Lens: maintainability
- Files: .tmp/opentoken/.opencode/plugins/opentoken/families/cargo.ts, .tmp/opentoken/.opencode/plugins/opentoken/families/npm.ts, .tmp/opentoken/.opencode/plugins/opentoken/families/pip.ts
- Summary: Each tool output family (cargo, npm, pip) declares its own redundant error-pattern array and hand-rolls compile/test log parsing rather than extending a shared abstraction or common utility. Any improvements to error boundary scanning or failure truncation have to be copied manually across all family modules.
- Evidence:
  - .tmp/opentoken/.opencode/plugins/opentoken/families/cargo.ts:3 - ERROR_PATTERNS declares cargo-specific regexes
  - .tmp/opentoken/.opencode/plugins/opentoken/families/npm.ts:3 - ERROR_PATTERNS declares npm-specific regexes
  - .tmp/opentoken/.opencode/plugins/opentoken/families/pip.ts:3 - ERROR_PATTERNS redeclares similar python-specific error checks
  - runtime:unit:-tmp-opentoken: confirmed — Deterministic runtime command succeeded: npm test

### MAI-001 — Repeated audit fixtures obscure behavior under test

- Severity: low
- Confidence: high
- Lens: maintainability
- Files: tests/orchestrator-remediation.test.mjs
- Summary: The file repeats large inline audit task/result/coverage objects across selective deepening and ingestion tests. Changing the audit task schema or common fixture values now requires coordinated edits across many unrelated test cases, making the suite harder to evolve safely.
- Evidence:
  - tests/orchestrator-remediation.test.mjs:281 - The selective-deepening test constructs a full sourceTask/result fixture inline, including repeated task_id, unit_id, pass_id, lens, file_paths, file_line_counts, rationale, priority, status, file_coverage, and finding fields.
  - tests/orchestrator-remediation.test.mjs:394 - A later selective-deepening test repeats the same sourceTask/result structure with the same src/api/auth.ts path and line count instead of sharing a fixture helper.
  - tests/orchestrator-remediation.test.mjs:555 - The runtime-disagreement test repeats the same sourceTask/result fixture shape again before adding only the runtime validation-specific inputs.
  - tests/orchestrator-remediation.test.mjs:612 - The result-ingestion test repeats the same finding, file_coverage, audit task, and coverage matrix fragments inline.

### MNT-001 — Repeated category lookup logic

- Severity: low
- Confidence: high
- Lens: maintainability
- Files: tests/design-assessment.test.mjs, tests/design-assessment.test.mjs, tests/design-assessment.test.mjs, tests/design-assessment.test.mjs, tests/design-assessment.test.mjs, tests/design-assessment.test.mjs, tests/design-assessment.test.mjs, tests/design-assessment.test.mjs
- Summary: The file repeats the same filter-by-category pattern across most test cases, so category renames or assertion refinements have to be updated in many places. A tiny helper would centralize the lookup and make the tests easier to change safely.
- Evidence:
  - tests/design-assessment.test.mjs:38 - Each assertion block manually filters result.findings by category, and the same pattern recurs for cycle, hub, orphan, risk concentration, monolith, and flow-gap checks.
  - tests/design-assessment.test.mjs:206 - The final detector test repeats the same category-filter idiom instead of sharing a named helper for finding assertions.

### MAI-001 — Repeated console-stubbing boilerplate makes warning tests harder to change

- Severity: low
- Confidence: high
- Lens: maintainability
- Files: tests/cli-remediation.test.mjs
- Summary: The warnIfNotGitRepo coverage repeats temp-directory setup, console.warn stubbing, output accumulation, restoration, and cleanup across several tests. Any future change to warning capture or cleanup behavior has to be made consistently in each copy, which makes this section harder to evolve safely.
- Evidence:
  - tests/cli-remediation.test.mjs:263 - The first warnIfNotGitRepo test creates a temp directory, replaces console.warn, accumulates stderrOutput, restores console.warn, and removes the temp directory.
  - tests/cli-remediation.test.mjs:283 - The stderr-routing test repeats the same manual console capture and cleanup pattern with additional console.log stubbing.
  - tests/cli-remediation.test.mjs:324 - The no-warning tests repeat temp directory setup, console.warn capture, restoration, and rm cleanup instead of sharing a focused helper.
  - runtime:flow:flow:surface:tests-cli-remediation-test-mjs: confirmed — Deterministic runtime command succeeded: npm test

### MAI-001 — Repeated graph-edge assertions obscure link test intent

- Severity: low
- Confidence: high
- Lens: maintainability
- Files: tests/extractors-remediation.test.mjs
- Summary: The graph-link tests repeatedly rebuild the same manifest/disposition/graph, filter references by kind, map edge pairs, and assert direction, confidence, and reason metadata. Adding or changing a link-kind case now requires editing duplicated assertion scaffolding across many adjacent tests, which raises the chance of inconsistent expectations.
- Evidence:
  - tests/extractors-remediation.test.mjs:1336 - The workspace package test builds a repo manifest, derives disposition, builds a graph, filters references, maps edge pairs, then separately asserts direction, confidence, and reason metadata.
  - tests/extractors-remediation.test.mjs:1374 - The pnpm workspace test repeats the same graph setup, reference filtering, pair mapping, and edge-metadata assertion pattern with only fixture data and expected values changed.
  - tests/extractors-remediation.test.mjs:1419 - The TypeScript, Go, Cargo, and Maven graph-link cases continue the same repeated assertion structure across adjacent tests instead of sharing a focused helper for link-kind expectations.

### OBS-003 — Runtime command discovery hides package.json read failures

- Severity: low
- Confidence: high
- Lens: observability
- Files: src/orchestrator/runtimeValidation.ts
- Summary: Runtime validation command discovery silently ignores package.json parse/read failures and eventually returns undefined. The planning summary can then say no deterministic runtime validation command was discovered without preserving the reason discovery skipped the repository's npm test script.
- Evidence:
  - src/orchestrator/runtimeValidation.ts:40 - discovery starts with root/package.json when the file exists.
  - src/orchestrator/runtimeValidation.ts:53 - any read or JSON parse failure is caught and ignored with only a comment.
  - src/orchestrator/runtimeValidation.ts:66 - the function can return undefined after the silent catch, leaving downstream artifacts without the failure detail.

### DI-002 — Runtime task identifiers use inconsistent field names

- Severity: low
- Confidence: high
- Lens: data_integrity
- Files: schemas/runtime_validation_tasks.schema.json, schemas/runtime_validation_report.schema.json
- Summary: Runtime validation tasks identify records with id, while validation results identify the related task with task_id. This inconsistency forces an implicit mapping between related schemas and makes it easier for producers to emit orphaned or non-joinable validation status data.
- Evidence:
  - schemas/runtime_validation_tasks.schema.json:12 - task records require an id field.
  - schemas/runtime_validation_tasks.schema.json:14 - the task identifier property is named id.
  - schemas/runtime_validation_report.schema.json:12 - report records require a task_id field for the related task.
  - schemas/runtime_validation_report.schema.json:14 - the report identifier reference is named task_id rather than id.
  - runtime:flow:flow:surface:src-prompts-renderWorkerPrompt-ts: confirmed — Deterministic runtime command succeeded: npm test
  - runtime:flow:flow:surface:src-types-workerResult-ts: confirmed — Deterministic runtime command succeeded: npm test
  - runtime:flow:flow:surface:src-types-workerSession-ts: confirmed — Deterministic runtime command succeeded: npm test
  - runtime:flow:flow:surface:tests-render-worker-prompt-test-mjs: confirmed — Deterministic runtime command succeeded: npm test
  - runtime:unit:schemas: confirmed — Deterministic runtime command succeeded: npm test

### MNT-003 — Schema helper behavior is tested twice

- Severity: low
- Confidence: high
- Lens: maintainability
- Files: tests/schema-contracts.test.mjs
- Summary: schema-contracts.test.mjs carries a second copy of jsonSchemaAssert keyword and date-time behavior checks that already live in the dedicated json-schema-assert test file. Helper behavior changes now require synchronized edits in two files before the schema-contract tests can stay coherent.
- Evidence:
  - tests/schema-contracts.test.mjs:306 - The file defines jsonSchemaAssert preserves object and additionalProperties behavior after validator extraction, followed by array/string/number, refs/combiners, date-time, unsupported formats, and dispatch quota helper checks through line 544.
  - tests/json-schema-assert.test.mjs:9 - The dedicated json-schema-assert test file already covers the same helper themes and test titles from object/additionalProperties through dispatch quota date-time behavior.
  - runtime:unit:tests-schema-contracts-test-mjs: confirmed — Deterministic runtime command succeeded: npm test

### TST-001 — Schema helper ignores active not combiners

- Severity: low
- Confidence: high
- Lens: tests
- Files: tests/helpers/jsonSchemaAssert.mjs
- Summary: The packet's schema assertion helper validates allOf, anyOf, and oneOf but has no branch for schema.not, so tests relying on assertMatchesJsonSchema would accept values that a JSON Schema not constraint should reject. This can let schema contract tests pass after a future schema adds not-based exclusions.
- Evidence:
  - tests/helpers/jsonSchemaAssert.mjs:130 - validateCombinerKeywords handles allOf, anyOf, and oneOf, but there is no schema.not rejection path before validation continues.
  - runtime:unit:tests-helpers: confirmed — Deterministic runtime command succeeded: npm test

### MAINT-001 — Substring compression pipeline is duplicated

- Severity: low
- Confidence: high
- Lens: maintainability
- Files: .tmp/opentoken/src/ltsc.ts, .tmp/opentoken/src/lzw.ts
- Summary: The LTSC and LZW implementations each hand-roll the same sliding-window repeat discovery, greedy non-overlap selection, replacement, and dictionary emission pipeline. Fixes to overlap handling, savings math, or marker escaping now have to be made twice with only constant-level differences separating the code paths.
- Evidence:
  - .tmp/opentoken/src/ltsc.ts:12 - findRepeatedSubstrings scans repeated substrings, tracks positions, computes savings, and feeds selectNonOverlapping.
  - .tmp/opentoken/src/ltsc.ts:59 - selectNonOverlapping implements a greedy used-position walk before compressLTSC emits dictionary replacements.
  - .tmp/opentoken/src/lzw.ts:18 - findRepeatedSubstrings repeats the same candidate/savings pipeline with different thresholds and marker costs.
  - .tmp/opentoken/src/lzw.ts:70 - selectNonOverlapping repeats the greedy overlap walk and savings recalculation before compressLZW emits replacements.
  - runtime:unit:-tmp-opentoken: confirmed — Deterministic runtime command succeeded: npm test

### MAINT-002 — Symbol language registry is duplicated

- Severity: low
- Confidence: high
- Lens: maintainability
- Files: .tmp/opentoken/src/symbolindex.ts
- Summary: The symbol index maintains its own language regex registry and lookup/alias builder instead of sharing the registry used by skeleton extraction. Adding a language or repairing a TypeScript/Python/Rust pattern requires coordinated edits across independent tables.
- Evidence:
  - .tmp/opentoken/src/symbolindex.ts:45 - SYMBOL_PATTERNS defines a per-language regex table for TypeScript, Python, Rust, Go, and Java symbols.
  - .tmp/opentoken/src/symbolindex.ts:121 - The file builds its own PATTERN_LOOKUP and extension aliases for the symbol registry.
  - .tmp/opentoken/src/skeleton.ts:17 - LANGUAGE_PATTERNS defines a separate per-language regex table for skeleton extraction over many of the same languages.
  - .tmp/opentoken/src/skeleton.ts:242 - Skeleton extraction builds a separate PATTERN_LOOKUP and alias table, duplicating the registry mechanics.
  - runtime:unit:-tmp-opentoken: confirmed — Deterministic runtime command succeeded: npm test

### MAINT-003 — Telemetry entry schema is duplicated

- Severity: low
- Confidence: high
- Lens: maintainability
- Files: .tmp/opentoken/src/utils/metrics.ts, .tmp/opentoken/src/utils/stats.ts
- Summary: Metrics writing and stats aggregation each define a private MetricEntry interface rather than sharing a telemetry contract. Any future field rename or semantic change can compile in one module while silently drifting in the other.
- Evidence:
  - .tmp/opentoken/src/utils/metrics.ts:8 - recordMetric's writer module declares its own MetricEntry shape.
  - .tmp/opentoken/src/utils/stats.ts:12 - stats aggregation redeclares the same MetricEntry fields instead of importing a shared type.
  - .tmp/opentoken/src/utils/metrics.ts:59 - recordMetric serializes entries using the local writer-side interface.
  - .tmp/opentoken/src/utils/stats.ts:75 - computeToolStats consumes parsed entries using the separate reader-side interface.
  - runtime:unit:-tmp-opentoken: confirmed — Deterministic runtime command succeeded: npm test

### OBS-IO-001 — Tooling manifest treats stat failures as missing inputs

- Severity: low
- Confidence: high
- Lens: observability
- Files: src/io/toolingManifest.ts, src/io/toolingManifest.ts
- Summary: pathExists catches every stat failure and returns false, and buildToolingManifest then skips that tooling input. Permission or transient stat failures can remove files from the inputs list and implementation hash with no warning that the manifest is incomplete.
- Evidence:
  - src/io/toolingManifest.ts:24 - pathExists calls stat(path) to decide whether an input exists.
  - src/io/toolingManifest.ts:26 - The catch block returns false for every stat error without distinguishing ENOENT from permission or filesystem failures.
  - src/io/toolingManifest.ts:70 - buildToolingManifest skips any TOOLING_INPUTS entry when pathExists returns false.

### OBS-004 — Unexposed LSP navigation metrics and lack of error context on query blocks

- Severity: low
- Confidence: high
- Lens: observability
- Files: .tmp/opentoken/src/lspfirst.ts
- Summary: The navCount and readCount metrics in LSPState are tracked via trackLSPUsage but are never exposed through any diagnostic tools or summaries. Furthermore, shouldBlockGrep and shouldBlockGlob do not set output.error, making blocked tools appear successful.
- Evidence:
  - .tmp/opentoken/src/lspfirst.ts:121-136 - navCount and readCount are tracked in session state but never exported or visible in any tool output.
  - runtime:unit:-tmp-opentoken: confirmed — Deterministic runtime command succeeded: npm test

### OBS-PROV-001 — Unknown command-template placeholders are erased silently

- Severity: low
- Confidence: high
- Lens: observability
- Files: src/providers/subprocessTemplateProvider.ts, src/providers/subprocessTemplateProvider.ts
- Summary: Subprocess template rendering replaces any unrecognized placeholder with an empty string and then launches the rendered command. A typo in command_template therefore surfaces only as a downstream provider command failure, without the missing placeholder name or template entry that caused it.
- Evidence:
  - src/providers/subprocessTemplateProvider.ts:34 - applyTemplate replaces every {key} with values[key] ?? "", so an unknown placeholder is removed instead of reported.
  - src/providers/subprocessTemplateProvider.ts:54 - launch renders each command_template entry and passes the rendered command directly to spawnLoggedCommand without validating unresolved or unknown placeholders.

### COR-006 — Unreachable dead code blocks in filterCargoBuild

- Severity: low
- Confidence: high
- Lens: correctness
- Files: .tmp/opentoken/.opencode/plugins/opentoken/families/cargo.ts
- Summary: The inner checks for error[ and warning[ within the else if (inBlock) block are unreachable because the outer if/else chain handles all lines starting with error[ or warning[ before reaching the inBlock check.
- Evidence:
  - .tmp/opentoken/.opencode/plugins/opentoken/families/cargo.ts:29 - 'if (line.trim() === "" || line.startsWith("error[") || line.startsWith("warning["))'
  - runtime:unit:-tmp-opentoken: confirmed — Deterministic runtime command succeeded: npm test

### MAINT-005 — Worker result lifecycle bookkeeping is repeated across execution branches

- Severity: low
- Confidence: high
- Lens: maintainability
- Files: src/cli.ts
- Summary: cmdRunToCompletion repeats the same worker-result lifecycle steps in the parallel, inline, and provider-launch paths: build/persist a WorkerResult, append a run-ledger entry, update lastResult/anyProgress/artifacts, clear pending inputs, and emit failure envelopes. Because this lifecycle is not centralized, future changes to worker completion semantics must be applied consistently across multiple branches.
- Evidence:
  - src/cli.ts:2227 - the parallel branch builds a WorkerResult, updates progress/artifacts, persists run artifacts, and appends run-ledger entries.
  - src/cli.ts:2416 - the inline executor branch repeats persistWorkerRunArtifacts, appendRunLedgerEntry, lastResult/anyProgress/artifact updates, pending input clearing, and failure envelope logic.
  - src/cli.ts:2603 - the provider-launch branch repeats appendRunLedgerEntry, lastResult/anyProgress/artifact updates, pending input clearing, and nearly identical failed/blocked/no_progress envelope handling.
  - runtime:flow:flow:surface:src-cli-ts: confirmed — Deterministic runtime command succeeded: npm test

### DA-011 — 35 orphan unit(s) with no graph connections

- Severity: low
- Confidence: medium
- Lens: architecture
- Files: Codeauditor-lambda.audit-artifacts/session-config.json, tests/quota-file-lock.test.mjs, tests/render-worker-prompt.test.mjs, .opencode/.gitignore, .vscode/mcp.json, tests/adapters-remediation.test.mjs, tests/audit-code-lifecycle.test.mjs, tests/cli-remediation.test.mjs, tests/config-error-handling.test.mjs, tests/design-assessment.test.mjs, tests/discovered-limits.test.mjs, tests/entrypoint-contract.test.mjs, tests/fixture-repo.test.mjs, tests/header-extraction.test.mjs, tests/mcp-server.test.mjs, tests/next-step.test.mjs, tests/orchestration.test.mjs, tests/postinstall-contract.test.mjs, tests/provider-assisted-bridge.test.mjs, tests/provider-assisted-continuation.test.mjs, tests/provider-auto-resolution.test.mjs, tests/providers-remediation.test.mjs, tests/quota-error-parsers.test.mjs, tests/quota-error-parsing.test.mjs, tests/quota-limits.test.mjs, tests/quota-packets.test.mjs, tests/quota-scheduler.test.mjs, tests/quota-sliding-window.test.mjs, tests/quota-source.test.mjs, tests/reporting-remediation.test.mjs, tests/staleness.test.mjs, tests/status-command.test.mjs, tests/supervisor-remediation.test.mjs, tests/syntax-resolution.test.mjs, tests/validate-command.test.mjs
- Summary: Units [Codeauditor-lambda-audit-artifacts, tests-quota-file-lock-test-mjs, tests-render-worker-prompt-test-mjs, -opencode, -vscode, tests-adapters-remediation-test-mjs, tests-audit-code-lifecycle-test-mjs, tests-cli-remediation-test-mjs, tests-config-error-handling-test-mjs, tests-design-assessment-test-mjs, tests-discovered-limits-test-mjs, tests-entrypoint-contract-test-mjs, tests-fixture-repo-test-mjs, tests-header-extraction-test-mjs, tests-mcp-server-test-mjs, tests-next-step-test-mjs, tests-orchestration-test-mjs, tests-postinstall-contract-test-mjs, tests-provider-assisted-bridge-test-mjs, tests-provider-assisted-continuation-test-mjs, tests-provider-auto-resolution-test-mjs, tests-providers-remediation-test-mjs, tests-quota-error-parsers-test-mjs, tests-quota-error-parsing-test-mjs, tests-quota-limits-test-mjs, tests-quota-packets-test-mjs, tests-quota-scheduler-test-mjs, tests-quota-sliding-window-test-mjs, tests-quota-source-test-mjs, tests-reporting-remediation-test-mjs, tests-staleness-test-mjs, tests-status-command-test-mjs, tests-supervisor-remediation-test-mjs, tests-syntax-resolution-test-mjs, tests-validate-command-test-mjs] have no import, call, or reference edges in the dependency graph. They may be dead code, or the graph extraction missed their connections.
- Evidence:
  - runtime:flow:flow:surface:src-prompts-renderWorkerPrompt-ts: confirmed — Deterministic runtime command succeeded: npm test
  - runtime:flow:flow:surface:src-types-workerResult-ts: confirmed — Deterministic runtime command succeeded: npm test
  - runtime:flow:flow:surface:src-types-workerSession-ts: confirmed — Deterministic runtime command succeeded: npm test
  - runtime:flow:flow:surface:tests-cli-remediation-test-mjs: confirmed — Deterministic runtime command succeeded: npm test
  - runtime:flow:flow:surface:tests-render-worker-prompt-test-mjs: confirmed — Deterministic runtime command succeeded: npm test
  - runtime:flow:flow:surface:tests-status-command-test-mjs: confirmed — Deterministic runtime command succeeded: npm test
  - runtime:flow:flow:surface:tests-validate-command-test-mjs: confirmed — Deterministic runtime command succeeded: npm test
  - runtime:unit:Codeauditor-lambda-audit-artifacts: confirmed — Deterministic runtime command succeeded: npm test

### TST-002 — Discovered-limit cache I/O is untested

- Severity: low
- Confidence: medium
- Lens: tests
- Files: src/quota/discoveredLimits.ts
- Summary: The discovered-limits module persists cached RPM/TPM data and later reloads it for scheduling, but the tests only cover pure merge behavior and scheduler consumption. Cache corruption, partial updates, and lookup persistence can regress without a direct test.
- Evidence:
  - src/quota/discoveredLimits.ts:28 - readDiscoveredLimitsCache reads and tolerates malformed cache files before returning a default cache.
  - src/quota/discoveredLimits.ts:58 - updateDiscoveredLimits merges new provider/header limits into an existing cache entry and writes it back.
  - tests/discovered-limits.test.mjs:4 - the discovered-limits test imports mergeDiscoveredLimits; cache read/write/update/lookup paths are not directly exercised.

### DA-013 — Excessive single-file units

- Severity: low
- Confidence: medium
- Lens: architecture
- Files: Codeauditor-lambda.audit-artifacts/session-config.json, tests/json-schema-assert.test.mjs, tests/schema-contracts.test.mjs, tests/quota-file-lock.test.mjs, tests/render-worker-prompt.test.mjs
- Summary: 58 of 77 units contain only a single file. This fragmentation may indicate that the unit grouping is too granular to reflect meaningful architectural boundaries.
- Evidence:
  - runtime:flow:flow:surface:src-prompts-renderWorkerPrompt-ts: confirmed — Deterministic runtime command succeeded: npm test
  - runtime:flow:flow:surface:src-types-workerResult-ts: confirmed — Deterministic runtime command succeeded: npm test
  - runtime:flow:flow:surface:src-types-workerSession-ts: confirmed — Deterministic runtime command succeeded: npm test
  - runtime:flow:flow:surface:tests-render-worker-prompt-test-mjs: confirmed — Deterministic runtime command succeeded: npm test
  - runtime:unit:Codeauditor-lambda-audit-artifacts: confirmed — Deterministic runtime command succeeded: npm test
  - runtime:unit:tests-json-schema-assert-test-mjs: confirmed — Deterministic runtime command succeeded: npm test
  - runtime:unit:tests-schema-contracts-test-mjs: confirmed — Deterministic runtime command succeeded: npm test

### MNT-001 — Hand-built quota bucket fixtures are duplicated

- Severity: low
- Confidence: medium
- Lens: maintainability
- Files: tests/quota-scheduler.test.mjs, tests/quota-scheduler.test.mjs
- Summary: Several scheduler tests inline long, hand-counted success bucket maps to represent a learned safe-concurrency state. Because the intended number of safe buckets is encoded by copied numeric object keys, changing thresholds or adding scenarios requires brittle manual fixture edits instead of updating a shared helper.
- Evidence:
  - tests/quota-scheduler.test.mjs:195 - The host-limit test inlines eight numbered success buckets just to make the learned cap exceed the host limit.
  - tests/quota-scheduler.test.mjs:331 - The quota-state ramp-up test repeats a hand-built five-bucket safe state rather than using a named fixture helper such as makeSafeBuckets(5).

### MNT-001 — Large inline report fixtures obscure test intent

- Severity: low
- Confidence: medium
- Lens: maintainability
- Files: tests/reporting-remediation.test.mjs
- Summary: The first two tests embed full audit result and report fixtures inline while repeating finding, coverage, analyzer, and runtime-validation shapes. This makes future report-schema changes expensive because a small contract change requires hand-editing many nested literals instead of updating focused fixture builders.
- Evidence:
  - tests/reporting-remediation.test.mjs:10 - The first test starts a 130-line inline mergeFindings fixture with nested AuditResult, finding, runtime validation, and analyzer objects.
  - tests/reporting-remediation.test.mjs:141 - The next test repeats the same nested result, coverage matrix, runtime validation, and external analyzer object shapes before asserting summary fields.
  - tests/reporting-remediation.test.mjs:251 - Fixture helpers are introduced only for the later cross-lens tests, leaving the largest reporting fixtures unabstracted.

### TST-002 — Manifest parser edge branches need targeted tests

- Severity: low
- Confidence: medium
- Lens: tests
- Files: src/extractors/graphManifestEdges.ts, src/extractors/graphManifestEdges.ts, src/extractors/graphManifestEdges.ts
- Summary: The manifest edge extractor hand-parses YAML and TOML values with quote, comment, multiline-array, and relative path fallback logic. Targeted tests should pin multiline pyproject testpaths, quoted hash/comment handling, and YAML values that resolve relative to the YAML file instead of the repository root.
- Evidence:
  - src/extractors/graphManifestEdges.ts:395 - YAML comment stripping tracks single and double quotes before cutting at an unquoted hash.
  - src/extractors/graphManifestEdges.ts:1286 - pyproject testpaths collection appends continued TOML array lines and flushes only after the array is closed.
  - src/extractors/graphManifestEdges.ts:1411 - YAML path resolution tries repository-root paths first, then falls back to paths relative to the YAML file directory.

### OBS-EXT-002 — Manifest parsers suppress malformed file context

- Severity: low
- Confidence: medium
- Lens: observability
- Files: src/extractors/graphManifestEdges.ts, src/extractors/graphManifestEdges.ts, src/extractors/graphManifestEdges.ts, src/extractors/graphManifestEdges.ts
- Summary: Manifest edge extraction collapses JSON and JSONC parse failures into empty candidate sets or undefined parsed objects. Malformed package or TypeScript config files can therefore remove entrypoint, script, workspace, or project-reference edges with no artifact-level diagnostic naming the file or parser that failed.
- Evidence:
  - src/extractors/graphManifestEdges.ts:53 - packageEntrypointCandidates catches JSON.parse failures and returns [].
  - src/extractors/graphManifestEdges.ts:126 - packageScriptCandidates catches JSON.parse failures and returns [].
  - src/extractors/graphManifestEdges.ts:226 - packageWorkspacePatterns catches JSON.parse failures and returns [].
  - src/extractors/graphManifestEdges.ts:386 - parseJsoncObject catches JSONC parse failures and returns undefined, which callers treat as no references.

### TST-001 — OpenCode launch wrapping lacks direct tests

- Severity: low
- Confidence: medium
- Lens: tests
- Files: src/providers/opencodeProvider.ts
- Summary: OpenCodeProvider has provider-specific launch behavior, including Windows cmd wrapping and argument quoting, but the provider tests cover auto-selection rather than the launch command construction. A regression in that wrapper could break Windows OpenCode launches without a focused unit test failing.
- Evidence:
  - src/providers/opencodeProvider.ts:4 - resolveOpenCodeSpawnCommand rewrites opencode/npx/.cmd invocations through cmd.exe on win32 and quoteCmdArg escapes shell metacharacters.
  - tests/providers-remediation.test.mjs:10 - the direct provider tests import ClaudeCodeProvider, LocalSubprocessProvider, and spawnLoggedCommand, while OpenCodeProvider launch behavior is not exercised there.
  - tests/provider-auto-resolution.test.mjs:69 - the OpenCode tests assert provider-name resolution, not the command/args produced by OpenCodeProvider.launch.

### MAINT-005 — Operator handoff artifact metadata is duplicated across model and markdown output

- Severity: low
- Confidence: medium
- Lens: maintainability
- Files: src/supervisor/operatorHandoff.ts
- Summary: operatorHandoff.ts defines artifact filenames, builds an artifact path object, renders each path manually in Markdown, and separately builds an active-run file_map. Adding or renaming a handoff artifact requires coordinated edits across multiple sections of one large module, making drift easy.
- Evidence:
  - src/supervisor/operatorHandoff.ts:227 - renderMarkdown manually emits status, artifact paths, suggested inputs/commands, active review run data, and provider hints into one lines array.
  - src/supervisor/operatorHandoff.ts:327 - buildAuditCodeHandoff constructs the AuditCodeHandoffArtifactPaths object field-by-field from filename constants and status checks.
  - src/supervisor/operatorHandoff.ts:401 - the active-run file_map repeats selected artifact path derivations instead of reusing the artifact path model rendered earlier.
  - runtime:unit:src-supervisor: confirmed — Deterministic runtime command succeeded: npm test

### OBS-MCP-001 — Optional dispatch artifacts fail silently in MCP responses

- Severity: low
- Confidence: medium
- Lens: observability
- Files: src/mcp/server.ts, src/mcp/server.ts
- Summary: The MCP adapter treats unreadable or malformed optional dispatch artifacts the same as absent artifacts. When dispatch_plan or dispatch_quota paths exist but cannot be read or parsed, the response simply omits that context without a warning for the host or operator.
- Evidence:
  - src/mcp/server.ts:158 - readOptionalJson wraps both file reading and JSON parsing for an arbitrary path.
  - src/mcp/server.ts:161 - The catch block returns undefined for every failure, losing the error type and path context.
  - src/mcp/server.ts:448 - runContinueAudit only attaches dispatch_plan_entries when readOptionalJson returns a value; otherwise no warning field is added.
  - src/mcp/server.ts:452 - dispatch_quota is handled the same way, so malformed quota artifacts disappear from the MCP payload.

### OBS-IO-002 — Package version provenance failures are hidden

- Severity: low
- Confidence: medium
- Lens: observability
- Files: src/io/toolingManifest.ts, src/io/toolingManifest.ts
- Summary: readPackageVersion catches package.json read and parse failures and returns null, making invalid or unreadable package metadata indistinguishable from a package without a version field. The emitted tooling manifest loses version provenance without preserving the reason.
- Evidence:
  - src/io/toolingManifest.ts:55 - readPackageVersion parses package.json from disk inside a try block.
  - src/io/toolingManifest.ts:59 - The catch block returns null for read or JSON parse failures without a warning or reason field.
  - src/io/toolingManifest.ts:86 - buildToolingManifest emits package_version from readPackageVersion, so the failure is represented only as null.

### MNT-001 — Path-normalization cases duplicate the same fixture

- Severity: low
- Confidence: medium
- Lens: maintainability
- Files: tests/validation-remediation.test.mjs
- Summary: The backslash, ./ prefix, and mixed-path cases repeat the same task fixture, validation call, and assertion shape. Adding or changing normalization cases requires editing parallel blocks, which makes the test harder to maintain safely.
- Evidence:
  - tests/validation-remediation.test.mjs:233 - The path normalization test repeats three validateAuditResults blocks for backslash, ./ prefix, and mixed path cases instead of driving the file_coverage variants from shared data.
  - tests/validation-remediation.test.mjs:264 - Each repeated block filters errors and asserts the same zero-error condition, so future cases require duplicating the same boilerplate.

### TES-002 — process.exitCode is not restored on assertion failures

- Severity: low
- Confidence: medium
- Lens: tests
- Files: tests/cli-remediation.test.mjs
- Summary: The unknown-command test mutates process.exitCode but restores it only after the assertions. If runCli or an assertion fails before the final assignment, the mutated exit code can leak into later tests or the enclosing test process.
- Evidence:
  - tests/cli-remediation.test.mjs:366 - The test snapshots the previous process.exitCode before mutating global state.
  - tests/cli-remediation.test.mjs:370 - process.exitCode is set to 0 for the test scenario.
  - tests/cli-remediation.test.mjs:381 - The finally block restores console.error but does not restore process.exitCode.
  - tests/cli-remediation.test.mjs:385 - Assertions run before process.exitCode is restored at line 388, so an early failure skips the restoration.
  - runtime:flow:flow:surface:tests-cli-remediation-test-mjs: confirmed — Deterministic runtime command succeeded: npm test

### TST-001 — Python import graph edge cases need regression tests

- Severity: low
- Confidence: medium
- Lens: tests
- Files: src/extractors/graph.ts
- Summary: The Python import extractor has several branchy resolution paths that are easy to regress, including ambiguous absolute-module matching, parent-level relative imports, multi-item import lists, aliases, star imports, and submodule-first from-import handling. Add targeted fixture tests for these branches so graph grouping does not silently lose or misdirect Python edges.
- Evidence:
  - src/extractors/graph.ts:714 - Absolute Python module resolution has separate direct, single-match, common-prefix, and src fallback branches for ambiguous module paths.
  - src/extractors/graph.ts:747 - Relative import resolution walks parent directories based on leading-dot depth before resolving the module path.
  - src/extractors/graph.ts:855 - from-import handling filters aliases and star imports, resolves imported names as submodules first, and only falls back to the base module when no submodule target exists.

### MAINT-001 — Release contract tests bundle unrelated surfaces

- Severity: low
- Confidence: medium
- Lens: maintainability
- Files: tests/release-contract.test.mjs
- Summary: The release contract suite validates package metadata, release workflows, docs, helper scripts, and CI workflow details through a few broad blocks of literal assertions. This makes normal release-process edits harder to localize and review because a change in one surface requires scanning long, mixed-purpose assertion groups.
- Evidence:
  - tests/release-contract.test.mjs:25 - the first contract test mixes package.json script checks with many publish workflow literals in one body.
  - tests/release-contract.test.mjs:67 - the documentation contract reads five docs and then relies on array position for the release doc before a long literal checklist.
  - tests/release-contract.test.mjs:130 - the CI workflow contract loops across four workflow files and then appends test-suite-specific assertions in the same test.

### TST-004 — Sliding window lacks nonpositive concurrency tests

- Severity: low
- Confidence: medium
- Lens: tests
- Files: src/quota/slidingWindow.ts
- Summary: runSlidingWindow is exported and uses caller-provided concurrency directly, but the suite only covers positive concurrency, empty lists, and over-large concurrency. A nonpositive value can skip launching all queued work without any test documenting the intended behavior.
- Evidence:
  - src/quota/slidingWindow.ts:30 - initialBatch is Math.min(concurrency, tasks.length), so concurrency 0 or negative produces no runners.
  - tests/quota-sliding-window.test.mjs:50 - existing edge tests cover an empty task list and concurrency greater than task count, but not zero or negative concurrency.

### TST-007 — Tests can exercise stale compiled dist output

- Severity: low
- Confidence: medium
- Lens: tests
- Files: tests/staleness.test.mjs, tests/status-command.test.mjs, tests/syntax-resolution.test.mjs
- Summary: These tests import compiled files from dist at module load time, so running an individual test file can pass against stale build artifacts instead of the current TypeScript source. The npm test script rebuilds first, but the tests themselves do not enforce freshness when invoked directly.
- Evidence:
  - tests/staleness.test.mjs:5 - The test imports ../dist/orchestrator/artifactMetadata.js directly.
  - tests/status-command.test.mjs:10 - The test builds distCliUrl from repoRoot/dist/cli.js before importing runCli.
  - tests/syntax-resolution.test.mjs:9 - The test imports ../dist/orchestrator/syntaxResolutionExecutor.js directly.
  - package.json:26 - The npm test script rebuilds before node --test, which mitigates only that invocation path.
  - runtime:flow:flow:surface:tests-status-command-test-mjs: confirmed — Deterministic runtime command succeeded: npm test

### OBS-004 — TypeScript analyzer skip is not recorded

- Severity: low
- Confidence: medium
- Lens: observability
- Files: src/orchestrator/syntaxResolutionExecutor.ts
- Summary: Syntax resolution only appends a tsc tool status when a TypeScript config exists. For repositories with TypeScript files but no tsconfig, syntax_resolution_status omits tsc entirely, so consumers cannot distinguish an intentional skip from the analyzer never being considered.
- Evidence:
  - src/orchestrator/syntaxResolutionExecutor.ts:257 - runSyntaxResolutionExecutor initializes the toolStatuses array that becomes syntax_resolution_status.tool_statuses.
  - src/orchestrator/syntaxResolutionExecutor.ts:260 - the tsc branch is gated by hasTypeScriptConfig(root) as well as the presence of .ts files.
  - src/orchestrator/syntaxResolutionExecutor.ts:265 - tsc.status is pushed only inside that branch; there is no skipped status when TypeScript files exist without a config.

## Scope and Coverage

This report is deterministic output from the completed audit. Non-auditable files were excluded from scope before task generation.
