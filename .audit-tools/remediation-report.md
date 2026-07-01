# Remediation Report

## Review

All code changes were applied on the dedicated branch `remediation/remaining-backlog-2026-07-01` — your base branch was left untouched. Review the diff and merge `remediation/remaining-backlog-2026-07-01` into your base branch (or re-run with the `merge-to-base` closing action to land it automatically).

## Resolved — Changed Files

- **CP-NODE-2**: Register jscpd as a new external analyzer candidate
  - *Verification*: Verified claim before fixing: src/audit/extractors/analyzers/candidates.ts had exactly gitleaksCandidate/semgrepCandidate/eslintCandidate/knipCandidate and no jscpd entry -- claim grounded.
  - *Verification*: Added jscpdCandidate (id 'jscpd', runner 'npx', spec 'jscpd@4', defaultRun: false, detect: detectNodeEcosystem, buildArgv emits '--reporters json --output <per-process dir> --silent <root>', reportFile points at '<per-process dir>/jscpd-report.json' matching jscpd's own json-reporter output filename) appended after the four existing entries in EXTERNAL_ANALYZER_CANDIDATES (order-preserving).
  - *Verification*: Added parseJscpd parsing jscpd's raw JSON reporter output ({ duplicates: [{firstFile,secondFile,lines,...}] }) into the same generic finding-item shape parseKnip/parseEslint/parseSemgrep return; degrades to [] on malformed/empty/missing-'duplicates' input (verified: '', 'not json', '{}', and duplicates-as-non-array all return []).
  - *Verification*: parseJscpd never calls normalizeGenericExternalResults (grep-confirmed: only acquisitionEngine.ts and src/audit/adapters/* call that function; candidates.ts parse functions do not).
  - *Verification*: Re-exported jscpdCandidate and parseJscpd alongside the existing exports.
  - *Verification*: Did not modify acquisitionEngine.ts and did not add src/audit/adapters/jscpd.ts.
  - *Verification*: Added co-located tests in tests/audit/analyzer-candidates.test.mjs: registration/consent-gating/argv shape for jscpdCandidate, and parseJscpd mapping + degrade-to-empty cases.
  - *Verification*: Command: npm run check (from repo root, build-free typecheck) -> exit 0, no errors.
  - *Verification*: Command: node --import tsx/esm --test tests/audit/analyzer-candidates.test.mjs -> 12/12 pass, 0 fail (includes the 3 new jscpd tests).
- **CP-NODE-3**: Record consent-gate-for-proposed-analyzers confirmation and defer the LLM-proposal-channel gap to the backlog
  - *Verification*: Verified claim (1): admitSpawn in src/audit/extractors/analyzers/acquisitionEngine.ts:196-205 denies any candidate with defaultRun !== true unless a non-empty consentToken is supplied; jscpd candidate (src/audit/extractors/analyzers/candidates.ts:357-378) has defaultRun: false, confirming it is already gated -- no gap.
  - *Verification*: Verified claim (2): EXTERNAL_ANALYZER_CANDIDATES (src/audit/extractors/analyzers/registry.ts, defined in candidates.ts) is a static array with no runtime append/proposal path; grepped registry.ts and acquisitionEngine.ts, found no LLM-driven candidate-injection mechanism -- confirmed out of scope, tracked as forward item.
  - *Verification*: Verified claim (3): ExternalAcquisitionConfig in src/shared/types/sessionConfig.ts:311-314 declares consent_token?: string with no schema-level stripping; no persistSessionConfig/writeSessionConfig round-trip of SessionConfig to a shared/committed artifact was found in src/audit/supervisor -- latent, not exercised. Recorded as a forward flag.
  - *Verification*: Added docs/backlog.md entry under 'Open bugs / frictions' recording all three points per the finding's instructions (no source change required).
  - *Verification*: npm run check (tsc -p tsconfig.json --noEmit) passes clean post-edit.

## Verified Already Correct (no changes made)

- **CP-NODE-1**: Render graph-context section in renderWorkerPrompt for external_analyzer_signal-tagged tasks
  - *Verification*: Verified against src/audit/prompts/renderWorkerPrompt.ts (worktree HEAD): renderWorkerPrompt(task: WorkerTask) is a synchronous, pure string-building function with no file I/O and a single call site (materializeReviewRun in src/audit/cli/reviewRun.ts:167), which invokes it synchronously immediately after building pendingTasks.
  - *Verification*: The finding's premise is factually wrong on two counts: (1) WorkerTask (src/audit/types/workerSession.ts) has no file_paths field -- file_paths lives on AuditTask, and task.pending_audit_tasks_path (workerSession.ts:24) points to a JSON file containing AuditTask[], not a single AuditTask, so 'task.pending_audit_tasks_path resolves an AuditTask' does not hold; (2) 'external_analyzer_signal' is an AuditTask.tags value (confirmed via grep across src/audit/orchestrator/{taskBuilder,requeue,auditTaskUtils,selectiveDeepening/lensVerification}.ts and src/audit/extractors/risk.ts), never present on WorkerTask.
  - *Verification*: Architectural check: ArtifactBundle (src/audit/io/artifacts.ts:120) already loads graph_bundle.json into memory as bundle.graph_bundle before materializeReviewRun runs, and the established codebase pattern (src/audit/cli/dispatch.ts:217,274,287 passing graphBundle: bundle.graph_bundle into buildReviewPackets/buildReviewPacketsFromPartition, and reviewPackets.ts's buildPacket) is to thread the already-loaded GraphBundle through as a parameter -- never to re-read graph_bundle.json from disk inside a leaf renderer. Adding a fresh withFsRetry(() => readFile(...)) + JSON.parse + GraphBundleSchema.strict().parse inside renderWorkerPrompt would (a) require making the currently-synchronous renderWorkerPrompt async, breaking its only call site's synchronous usage at reviewRun.ts:167, and (b) duplicate a disk read of data already available in-memory via params.bundle.graph_bundle, contradicting the codebase's own established graph-context-threading pattern.
  - *Verification*: Per the VERIFY BEFORE FIX instruction: claim does not hold against cited code, so no fix applied.
  - *Verification*: npm run check: passed (tsc -p tsconfig.json --noEmit, zero errors) on the unmodified worktree.

## Closing Action

Action: none
Status: skipped

## Remediation Outcomes

Of 3 finding(s): 2 resolved, 1 verified already correct, 0 deemed inappropriate, 0 ignored, 0 blocked.

By lens:
- security: resolved 2, verified_no_change 1
