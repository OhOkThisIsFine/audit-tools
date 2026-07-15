# Remediation Report

## Resolved — Changed Files

None.

## Verified Already Correct (no changes made)

- **CP-NODE-6**: Remediate remediate (remediate)

## Ignored

- **CP-NODE-1**: Retry budget exhausted; closing out run.
- **CP-NODE-2**: Retry budget exhausted; closing out run.
- **CP-NODE-3**: Retry budget exhausted; closing out run.
- **CP-NODE-4**: Retry budget exhausted; closing out run.
- **CP-NODE-5**: Retry budget exhausted; closing out run.
- **CP-NODE-7**: Retry budget exhausted; closing out run.
- **CP-NODE-8**: Retry budget exhausted; plan/drive inconsistency — never dispatched.
- **CP-NODE-9**: Retry budget exhausted; closing out run.
- **CP-NODE-10**: Retry budget exhausted; closing out run.
- **CP-NODE-11**: Retry budget exhausted; closing out run.
- **CP-NODE-12**: Retry budget exhausted; closing out run.
- **CP-NODE-13**: Retry budget exhausted; closing out run.
- **CP-NODE-14**: Retry budget exhausted; closing out run.
- **CP-NODE-15**: Retry budget exhausted; closing out run.
- **CP-NODE-16**: User-deferred for this run: Codex worker (with file access) could not substantiate the claimed audit/remediate host-installer duplication — the cited files already single-source via scripts/shared/install-host-assets.mjs. Deferring this run rather than rejecting outright, pending owner confirmation that it is a false-positive from the force-synth slice.

## Skipped by Intent Checkpoint

174 finding(s) were excluded from remediation by the intent checkpoint (severity/lens/package/theme filters or excluded scope):
- **COR-e73c2ea8**: A corrupt (unparseable) audit_state.json makes cleanup throw before the force branch, so even --force cannot clear the directory
- **COR-ee5cf7e5**: advanceAudit drain loop uses WeakMap for derivation cache but bundle identity changes each iteration
- **COR-55debab0**: Antigravity manifest version is permanently pinned to 1.0.0
- **COR-8229c789**: applyDisposition calls handoffInFlight with toNodeId ?? nodeId but handoffInFlight returns early if fromNodeId === toNodeId
- **COR-d81b6e22**: applyTemplate doesn't handle missing placeholders correctly
- **COR-f5884e25**: artifactMetadata computeArtifactMetadata carries forward baselines from bundle.artifact_metadata without checking if it's current
- **DAT-78b9b908**: audit_results.schema.json duplicates audit_result.schema.json instead of using $ref
- **COR-5d482d67**: Bare command assumes PATH availability
- **COR-1cb44163**: brokeredDispatch.ts broker() persists cooldown best-effort but doesn't await it, creating race with subsequent broker() calls
- **COR-a983aa02**: buildWaveSlotEntry doesn't validate required fields in slot.paths
- **COR-f5becf1f**: charterClarificationExecutor uses bundle.intent_checkpoint without null check
- **COR-39b7a31b**: claimAmendment checks contractScopes with _scopeHasCanonical but amendmentClaims with _amendmentClaimantByCanonical - both use canonical comparison but amendmentClaims stored by original path
- **COR-39b7a31b-2**: claimInFlight throws on foreign owner but claimAmendment returns 'contended' for same condition
- **COR-6c938bd8**: claimRegistry.heartbeat does not verify poolId matches
- **COR-d5e9b0fb**: clampPerspectiveCount allows count=1 when requested=1 but DEFAULT_CONCEPTUAL_PERSPECTIVES=5
- **COR-64fbd57a**: classifyObligationChange uses baselineSymbols from finalizedModuleContracts but the corpus includes the module's own name
- **COR-ced44dad**: claudeOAuthQuotaSource.readAccountId returns null when using default credentials path under test runner
- **COR-5d482d67-2**: Complex JSON escaping in --host-models example is error-prone
- **COR-a1a68c78**: compositeQuotaSource.probeUsage treats throw from source as degraded but continues cascade
- **COR-f5884e25-2**: computeArtifactMetadata treats missing previousEntry as revision 0 for dependencyRevisions
- **COR-0b199e07**: computeDesignReReviewDelta compares projections but doesn't handle missing keys in prior snapshot
- **COR-fecc410a**: designReviewProjection projectUnitManifest uses deriveUnitScopeDisposition which may not be imported
- **COR-1e0d0b17**: Documented cross-lens finding override is hard-rejected by validateAuditResults
- **REL-b4f75d6f**: Duplicate release-bump skip logic across workflows creates inconsistency risk
- **COR-9de0ca43**: edgeReasoningContentHash includes reason field which changes after rewrite, breaking cache invalidation
- **COR-c295047f**: ensureNodeId uses index-based fallback but index may not be stable across re-runs
- **DAT-78b9b908-2**: Enum definitions inlined across multiple schema files instead of using $ref
- **COR-23881647**: errorParsing.extractResetsAtClockMs doesn't handle timezone or cross-day correctly for 'resets at 3:30pm'
- **COR-a0227a1d**: Failed tasks search uses same flawed logic as pending tasks
- **REL-ec916126**: Git operations in acceptNodeWorktree lack timeouts, can hang indefinitely
- **COR-ddea7bf5**: groundExtractedFindings repairZeroPathFindings callback receives phantom paths but returns corrected paths without re-grounding
- **COR-395fc426**: Hardcoded blend weights must match costRank.ts but lack cross-validation
- **COR-ed04d382**: Hardcoded fixture data may drift from actual auditor contract
- **COR-ddb2e650**: Hardcoded line count in sample result file_coverage
- **COR-952b075b**: hostSessionQuotaSource.probeUsage returns not_applicable when window is open and no tracker, masking learned source
- **COR-5c6716e5**: hostSessionQuotaSource.recordLimit uses nowMs for cooldown calculation but tracker.last_reset_ms for priorResetElapsed check
- **COR-18641b6d**: httpQuotaSource.shouldSkipNetwork returns true under test runner when using default fetch, but fetchImpl could be a test double
- **COR-1e8b3dc0**: Incorrect conflict counting in update-languages.mjs
- **COR-3a1a4cf9**: Incorrect fallback in lineCountForPath when all sources are undefined
- **COR-d40c6447**: Incorrect handling of `hostMaxConcurrent` when explicitly set to 0
- **COR-3b739e20**: Incorrect package_counts behavior in buildFindingsDigest drops empty-string bucket
- **COR-89aad51b**: Incorrect regex pattern in EVIDENCE_PATH_TOKEN_RE misses Windows paths with drive letters
- **COR-cec8b8d0**: Incorrect roster comparison in sharedProviderConfirmation.ts
- **COR-22ded017**: Incorrect tier ordering in finalizeDispatchQuota
- **COR-f6961f6f**: Incorrect variable name in `forceAddNewSourceFiles` - uses `worktreeRoot` as root for `toRepoRelative`
- **COR-8c497987**: isBuildFreeVerifyCommand uses incorrect case for --noEmit flag check
- **COR-41672e2c**: isDesignReviewStale uses stableStringifyProjection but doesn't check if input exists in snapshot
- **COR-0632768a**: isDirectCliExecution compares resolved paths but import.meta.url may be file:// URL
- **COR-b6f5d040**: isPathExcluded returns true if ANY file matches exclusion, but comment says 'ANY-file aggregation (vs audit's every-file)'
- **COR-e0f110ff**: isSignificantLineCountDivergence treats expected=0 as always significant
- **COR-74b18d12-3**: lineIndex built from matchingTasks[0] only, ignores other tasks with same taskId
- **COR-58feaccc**: Misplaced regression test for jsonc.ts in graph-framework-routes test file
- **DAT-cdf53569-2**: Missing cross-field validation: line_end >= line_start in affected_files
- **COR-1c87775c**: Missing error handling for readJson in buildMergedOpenCodeProjectConfig when existing config is invalid
- **COR-c8830f3e**: Missing error handling for runAuditStep failures
- **COR-792f4c0b**: Missing error handling for writeJsonFile in mergeOperatorForcedTerminal
- **COR-f727ae98**: Missing error handling in readRemediationAccessMemory for malformed JSON
- **COR-d2f789db**: Missing null check for bundle.repo_manifest before accessing properties
- **COR-6511699f**: Missing null check for sessionConfig in resolveContextBudgetFromConfig
- **COR-eb09e01e**: Missing null check for sessionConfig.claude_code in hasConfiguredClaudeCode
- **COR-9783421f**: Missing null check for task.file_paths in buildHighRiskCleanFollowupTask
- **REL-9bbe9c24**: Missing timeout on async operations in test helpers
- **COR-a8e30413**: Missing validation for command_template in SubprocessTemplateProvider constructor
- **COR-9f45969d**: Missing validation for empty file_paths in buildFindingFollowupTask
- **COR-27f0f33c-2**: Missing validation for empty findings array when computing scorecard
- **COR-b85ed67b**: Missing validation for quota.max_concurrent in buildSourcePool
- **COR-dfe4bd73**: Missing validation of required --updates flag
- **COR-d6b4a996-3**: Missing validation of workerTask.repo_root before use in groundPassingFindings
- **COR-12eb6366**: nextStepPausesForHostInput checks graph_enrichment_executor but doesn't verify it's actually the next step
- **COR-564a6137**: No gh auth pre-check before release operations
- **REL-eb3aeddf-3**: No retry logic for transient network failures
- **DAT-c5ea3938**: No shape validation at the vendored-snapshot trust boundary; nested tables and entry fields are blind casts
- **COR-6a531492**: Numeric CLI flags silently swallow malformed values instead of failing loudly
- **COR-a0227a1d-2**: Obligation state counting assumes all states are known keys in obligationStates
- **COR-95ccec0b**: OpenCodeQuotaSource reads auth file synchronously in async method
- **COR-d2f789db-2**: Orphaned audit results bypass the validation gate entirely yet still flow into the persistent ledger
- **COR-3b739e20-2**: package_counts in buildFindingsDigest uses firstFile.split()[0] ?? "(root)" but split on empty string returns ["\u0022] so nullish coalescing never triggers
- **COR-a0227a1d-3**: Pending tasks summary only checks first run directory with pending-audit-tasks.json
- **COR-76686cbb**: phaseOrdinalForObligations uses longest-slug prefix match but slugs can be prefixes of each other
- **COR-641d1d9f**: Potential undefined access in buildPrioritizedReadingList when unitFiles.get returns undefined
- **COR-d2f789db-3**: Potential undefined access in partitionOrphanedAuditResults result handling
- **COR-f614205f**: Potential undefined access in runHostVerifyChecks when hostDefinition.verify is missing
- **COR-c2c7d80e-2**: prepareDispatchArtifacts called with providerName but hostModel from sessionConfig.block_quota
- **COR-07afed57-2**: probeQuotaSource does not catch errors from a native probeUsage implementation
- **COR-eefa6f69-2**: process.exitCode reset to 0 in readRequiredSource masks prior failures
- **COR-85a995a0**: profile.mjs spawnSync has no timeout
- **COR-d8a3c152**: Provider-stated cooldown is unreachable for rate_limited outcomes; exponential backoff always overrides it
- **COR-d9ab52ec**: quotaCoverageNudge.ts shouldEmitQuotaNudge has race condition between existsSync and writeFileSync
- **REL-144082fa**: Race condition in credential file access between read and refresh
- **REL-7957ede5**: Registry propagation verification treats timeout as success, masking potential installability issues
- **COR-cc11e3d0**: releaseInFlight releases inFlightClaims but not amendmentClaims, while applyDisposition for releasing dispositions calls both
- **COR-96f1b917**: releaseLock check-then-unlink is non-atomic and mutual exclusion is bounded by STALE_LOCK_MS with no heartbeat
- **COR-dc847788**: reservationLedger.ts admit() uses cost <= 0 check but cost could be NaN
- **COR-d0ed5f79**: resolveAnalyzerPlan returns 'absent' for auto setting when dependency missing, but executor only installs for ephemeral/permanent
- **COR-1610e49f**: resolveCandidate doesn't validate resolved command exists before returning
- **COR-2dbb2e8e-2**: resolvedProvider logic has unreachable branch for sessionConfigErrorCount > 0
- **COR-741fe35d**: resolveFromPath returns null for commands with path separators that don't exist
- **COR-87a3ac29**: runCli catches errors but only logs message, losing stack trace
- **COR-63fd326d**: runFindingFilterPass order: no-evidence drop before cross-lens dedup means dedup never sees no-evidence findings
- **COR-de0d5e79**: runFirstAvailableCommand treats spawnSync error as non-fatal
- **COR-bc56edbf**: runGraphEnrichmentExecutor uses floor.analyzers_used but floor may not have analyzers_used field
- **COR-357ae017**: runSingleAdvanceStep adds tooling_manifest.json and AGENT_FEEDBACK_FILENAME to metadata unconditionally
- **COR-dc524856**: Same JSON escaping fragility in --host-models example
- **COR-ddb2e650-2**: Sample runtime validation report marks all tasks as confirmed without actual validation
- **COR-f62fb0d4**: scheduler.ts scheduleWave token-budget gate uses calibrating flag incorrectly across windows
- **REL-c245f968**: Schema regeneration can leave a partially updated set
- **COR-4baae04e**: semanticProjection for finalized_module_contracts doesn't include seam_adjustments in projection
- **DAT-a010c231**: Silent data loss on malformed model entries
- **COR-f4ce746e**: Silent error swallowing in provider limits query and cached limits lookup
- **REL-64a4f332**: Single retry on 401 with no backoff or jitter
- **COR-bb95612b**: smoke-linked-remediate-code.mjs doesn't validate next-step JSON structure beyond basic fields
- **COR-b019d3b9**: Stale result detection in deriveAuditState doesn't handle missing result_baselines
- **COR-d8a3c152-2**: state.ts recordWaveOutcome clears cooldown on success only if cooldown not active, but doesn't clear last_429_at
- **COR-e1b4fc3d-2**: submitPacketCommand doesn't validate result file paths against packet boundary
- **REL-48407592-3**: Test pollution - shared mutable state across tests
- **REL-afc4a1d5**: test.concurrent tests race on the shared process.exitCode global (assert-then-reset interleaving)
- **DAT-551cdff2**: The zod line_ranges refinement (end >= start) is silently dropped from the generated worker-facing JSON schema
- **COR-20949223**: TOCTOU race condition in writeGeneratedFile and installMergedJson
- **COR-f62fb0d4-2**: Token-budget gate floors at one full slot with no cooldown when the remaining budget is positive but smaller than any slot
- **REL-482762b6**: Unbounded cumulative wall time in host session quota source
- **REL-097a6957**: Unhandled promise rejection in async test callbacks
- **REL-9bbe9c24-2**: Unhandled promise rejection in test cleanup - temp directory not cleaned on test failure
- **COR-7a8c84b2**: validateArtifactBundle throws TypeError on malformed nested entries instead of reporting issues
- **COR-e0f110ff-2**: validateAuditResults uses task.file_line_counts for lineIndex but task may not have it
- **COR-0dda78fe**: validateCycleBreak replaces all cycle-member needs with mediator but doesn't handle mediator needing cycle members
- **COR-d44dd747**: validateSessionConfig re-exported but validateConfiguredProviderEnvironment not validated for all providers
- **COR-176bf609-2**: validateTaskLineRanges allows line_end < line_start check but doesn't validate against file length
- **COR-182085b7**: verifyFindingAnchor doesn't handle missing confirm_if.text for output_includes/excludes
- **COR-985e8187**: verifyRunnerForTestFile only recognizes test files under tests/ directory
- **COR-1bc4c271**: weightedGraph pair key uses a space separator, corrupting edges for paths containing spaces
- **COR-1051c193**: Windows tree-kill uses taskkill /F at the graceful SIGTERM stage, collapsing the escalation contract
- **REL-de2e6540**: Worktree creation in prepareHostRollingDispatch lacks rollback on partial failure
- **COR-84c6817f**: buildAnalyzerSignalAnchorIndex lowercases path keys but analyzerSignalAnchorsForPath also lowercases
- **COR-2195bf1d**: buildExcludedSummary only collapses the single majority group; a second equally-homogeneous group is emitted as duplicate individual rows
- **COR-5e99b254**: buildFlowRequeueTasks skips unsupported lenses silently instead of logging
- **DAT-eff086cb**: buildWorkerRepairContract marks every validation error required:true, contradicting its documented optional-field mapping
- **COR-2b2406c5**: chunkLineCount returns empty array for totalLines <= 0 but doesn't validate chunkSize
- **COR-5e2e1429**: claimRegistry.mintOwnerToken uses Math.random() which is not cryptographically secure
- **REL-4fdc9a58**: cmdScoreTokens silently overwrites the JSON scorecard with the markdown summary when --out does not end in .json
- **COR-c4268aa3**: codexQuotaSource.readCredentials does not validate account_id presence before returning
- **COR-073d8483-2**: conflictGroups spread gate mixes intra-task variance with inter-task disagreement, flagging non-conflicts
- **COR-6ba55c63**: Confusing variable naming: 'complexity' field is a priority score
- **COR-85133d90**: crossLensDedup uses process.stderr.write for logging which is not testable
- **COR-9726005c**: Default-exported declarations and assignment-form route registrations are misclassified, skewing symbol spans and route counts — advisory impact only
- **COR-7afdd110**: Drain cap off-by-one: MAX_DRAIN_STEPS permits MAX_DRAIN_STEPS+1 executed steps before the graceful emit
- **COR-2575e3f7**: Duplicate countLines implementation in smoke-packaged-audit-code.mjs
- **COR-b2cc5f69**: Edges lacking a confidence value are treated as confidence 0 and become rewrite candidates; kind-less rewrites bind to an arbitrary first edge — recommend downgrade from high
- **COR-be35f910**: fileLock.generateOwnerToken uses same weak randomness as claimRegistry
- **COR-2fd5edc6**: findingIntentWeight adds PRIORITY_SIGNAL_BOOST for ANY priority signal, not per signal
- **COR-56006ec4**: getFlag treats a flag whose value is missing (next token is another --flag) as absent rather than an error
- **COR-6a5b35d7**: graphEnrichmentUnresolvedAnalyzers returns empty array when root or repo_manifest missing
- **COR-b15957d3-2**: Inconsistent newline normalization in skill source reading
- **COR-5bc008f3-2**: Incorrect error message in verifyInstalledBootstrap for missing host manifest entry
- **COR-9a7a9790-2**: Incorrect handling of empty pendingItemTokens in computeDispatchCapacity
- **COR-4f140255**: Incorrect tier escalation logic in escalateRiskSignal - rationale array not copied when tier unchanged
- **COR-dced63f7**: isLockfilePath matches by raw suffix without a path/basename boundary
- **COR-b7fcf3d1**: Missing validation for empty findings array in buildReviewRequest
- **COR-91b56f2e**: normalizeExistingFindingsReport drops refuted findings from the grounding breakdown
- **COR-578fc35a**: pathTokensInCommand regex misses relative paths starting with ./ or ../
- **COR-a33fa075**: Prose references are treated as manifest entries
- **REL-b4f75d6f-2**: Release-bump skip guard only matches single-digit major versions (v0-v9)
- **COR-0343202d**: resolveWorkerTaskTimeoutMs doesn't handle negative timeout_ms
- **COR-49b807bd**: routeAmendmentRequest logs to process.stderr for each path, creating noisy output
- **REL-4b0f91e1**: Schema-generation tests leak a temporary artifacts directory
- **REL-be769857**: session-start-hook test derives the hook path from URL.pathname without percent-decoding, breaking under checkout paths containing spaces or non-ASCII
- **COR-06c4649f**: slidingWindow.ts runSlidingWindow doesn't handle concurrency=0 or negative
- **COR-c0c7b68d-2**: spawnSync sqlite3 token read has no timeout and can block the event loop indefinitely
- **COR-462472e5**: StepProgressSchema allows negative numbers for count fields
- **COR-7a747303**: Successful non-JSON responses escape the provider result contract
- **COR-abd3e3d9**: tokenBudgetView.ts renderTokenBudgetView accesses p.quota_source_snapshot.windows without checking if windows exists
- **REL-c5ea3938**: Transient snapshot read failure is cached as permanent for the process lifetime, silently
- **COR-e4f9c18a**: Unguarded array access in buildFindingEnumeration when findings array is empty
- **COR-985e8187-2**: verifyRunnerForTestFile does not handle .spec. test files
- **COR-a983aa02-2**: writeWaveManifest doesn't ensure parent directory exists

## Dropped by Grounding

1 extracted finding(s) were dropped because every cited path was phantom (does not exist in this repository):
- **COR-00ebc99d**: Potential division by zero in applyVcsIgnoreRule share guard (cited: src/audit/orchestrator/extractors/disposition.ts)

## Ungrounded Evidence

2 planned finding(s) carried no evidence citing a real repo path and were downgraded to low confidence:
- **COR-4cbd9207**: $ARGUMENTS variable uses Claude Code convention in Gemini/Antigravity command
- **MNT-5d482d67**: Duplicated loader workflow and capability handshake between audit-code and remediate-code

## Closing Action

Action: none
Status: skipped

## Remediation Outcomes

Of 16 finding(s): 0 resolved, 1 verified already correct, 0 deemed inappropriate, 15 ignored, 0 blocked.

By lens:
- security: verified_no_change 1, ignored 15
