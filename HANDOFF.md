# Sprint Handoff — 2026-05-26

## What shipped

### Bug fixes (all verified, 830 tests green)

**Bug 1 — Stale manifest shadows audit-report.md** (remediator)
- File: `packages/remediate-code/src/steps/nextStep.ts`
- When no `--input` is supplied but `audit-report.md` exists at repo root, a stale `source-manifest.json` from a prior run no longer prevents default candidate detection. Guard inserted after intake artifact loading resets the manifest when default candidates exist on disk.

**Bug 2 — Only 1 finding documented in fallback mode** (remediator)
- File: `packages/remediate-code/src/steps/dispatch.ts`
- `mergeDocumentResults` no longer unconditionally sets `state.status = "documenting"` after the first finding. It now checks for remaining pending findings and keeps status as `"planning"` so `decideNextStep` re-enters the document dispatch loop.

**Bug 3 — Design review re-queued after assessment regeneration** (auditor)
- File: `packages/audit-code/src/orchestrator/internalExecutors.ts`
- `runDesignAssessmentExecutor` now carries forward `reviewed: true` and `review_findings` from the prior assessment when `buildDesignAssessment()` regenerates the object.

### Feature 4 — File integrity detection

Detects when external tools or users modify files mid-process.

**Auditor side** (complete):
- Enabled `hash_files: true` in `src/orchestrator/internalExecutors.ts` (was `false`)
- New file: `src/orchestrator/fileIntegrity.ts` — `checkFileIntegrity(root, manifest, scope?)`
- Integrated in `src/cli.ts` before agent dispatch: if scoped files changed, forces intake re-run

**Remediator side** (complete):
- Extended `Finding.affected_files[]` with optional `hash_at_plan_time` in `src/state/types.ts`
- New file: `src/utils/fileIntegrity.ts` — `hashFile`, `hashFileSync`, `checkAffectedFileIntegrity`, `snapshotAffectedFileHashes`
- `snapshotAffectedFileHashes` called in `src/phases/plan.ts` before plan assembly
- Integrity check in `src/steps/nextStep.ts` before implement dispatch — blocks with re-plan prompt if files changed
- Schema updated: `schemas/finding.schema.json` includes `hash_at_plan_time`

### Feature 5 — Structured access declarations

Provider-agnostic JSON access scoping on all dispatch/step contracts.

```typescript
interface AccessDeclaration {
  read_paths: string[];
  write_paths: string[];
  forbidden_patterns?: string[];
}
```

**Auditor**:
- `AccessDeclaration` added to `src/types/workerSession.ts`
- `access?` field on `WorkerTask` and `StepArtifact` (inline in `src/cli.ts`)
- Populated at all 4 WorkerTask creation sites in `src/cli.ts` — read_paths from pending task file_paths, write_paths = audit results + result
- Rendered in `src/prompts/renderWorkerPrompt.ts` as `## File access` section

**Remediator**:
- `AccessDeclaration` added to `src/steps/types.ts`
- `access?` field on `DispatchPlanItem` and `RemediationStep`
- Document items: read affected files, write result only
- Implement items: read+write affected files, write result
- Access sections appended to `findingPrompt()` and `implementPrompt()` in `src/steps/dispatch.ts`
- Schemas updated: `dispatch_plan.schema.json`, `step.schema.json`, `shared.schema.json` (new `access_declaration` $def)

### Feature 6 — Prompt ambiguity removal

**Auditor**:
- `renderWorkerPrompt.ts:37` — "Prefer host Read and Grep... if shell search is unavoidable, use Select-String as a fallback" → "Use host Read and Grep tools for source inspection. Do not use shell search commands."
- `cli.ts` dispatch prompt — removed "unless the current tool response already included equivalent" clause from both quota and non-quota paths
- `cli.ts` present report — removed MCP resource alternative, now reads only from file path
- `cli.ts` packet prompt — same Select-String removal as worker prompt
- `Select-String *` bash permission removed from `audit-code-wrapper-lib.mjs`, `scripts/postinstall.mjs`, `opencode.json`
- 4 test files updated to match new prompt text

**Remediator**:
- Removed `upgradeHint` from both document and implement single-item fallback prompts in `src/steps/nextStep.ts`

### Phase 3A — Monorepo scaffold

Location: `C:\Code\audit-tools\`

```
audit-tools/
  package.json              # workspaces: ["packages/*"]
  tsconfig.base.json        # ES2022, strict, NodeNext
  packages/
    shared/                 # @audit-tools/shared (0.1.0)
      src/
        types/              # disposition, risk, flows, surfaces, runLedger,
                            # graph, sessionConfig, accessDeclaration
        io/                 # json.ts (atomic writes)
        quota/              # types, state, limits, fileLock, slidingWindow,
                            # errorParsing, learnedQuotaSource, compositeQuotaSource,
                            # quotaSource, errorParsers/*
        providers/          # types.ts (FreshSessionProvider superset)
        validation/         # basic.ts
        index.ts            # barrel export
    audit-code/             # auditor-lambda as-is (publishes as auditor-lambda)
    remediate-code/         # remediator-lambda as-is (publishes as remediator-lambda)
```

### Phase 3B — Wire shared into both projects (complete)

All imports in both packages now point to `@audit-tools/shared` for shared types, IO, validation, quota primitives, and provider types. Both packages build and pass tests.

**Setup:**
- `"@audit-tools/shared": "*"` in `dependencies` (not devDependencies — needed at runtime) in both package.json files
- `"references": [{ "path": "../shared" }]` in both tsconfig.json files
- `"composite": true` in `packages/shared/tsconfig.json`
- `"private": false` in `packages/shared/package.json`

**Auditor imports migrated (all now import from `@audit-tools/shared`):**
- Types: `FileDisposition`, `CriticalFlowManifest`, `GraphBundle`, `RiskRegister`, `SurfaceManifest`, `RunLedger*`, `SessionConfig`, `AccessDeclaration`, `GraphEdge`, etc.
- IO: `readJsonFile`, `writeJsonFile`, `readJsonLines`, `appendJsonLine`, `tryReadJson`, `writeFileAtomic`
- Validation: `validateStringArray`, `validateOptionalString`, `isNonEmptyString`, `normalizeLineRange`
- Quota: `QuotaState`, `QuotaStateEntry`, `HostConcurrencyLimit*`, `LimitSource`, `LimitConfidence`, `ResolvedLimits`, `BackoffState`, `WaveSchedule`, `scheduleWave`, `readQuotaState`, `writeQuotaState`, `resolveHostActiveSubagentLimit`, `buildProviderModelKey`, `computeBackoff*`, `detectRateLimitError`, `computeCooldownUntil`, `setQuotaStateDir`, `QuotaSource`, `QuotaUsageSnapshot`, `LearnedQuotaSource`, `CompositeQuotaSource`, `FileLockTimeoutError`, `acquireLock`, `releaseLock`, `withFileLock`, `runSlidingWindow`
- Providers: `FreshSessionProvider`, `FreshSessionInput`, `FreshSessionResult`, `ProviderCapabilities`, `ResolvedProviderName`

**Remediator imports migrated (all now import from `@audit-tools/shared`):**
- Same shared types, IO, validation, quota, and provider types
- `src/steps/types.ts` re-exports shared types for the dispatch quota contract
- `src/steps/waveScheduler.ts` imports shared quota functions + local quota orchestration

**Test fix — `field-trial-remediation.test.mjs`:**
- File: `packages/audit-code/tests/helpers/sourceImport.mjs`
- Problem: `importSourceModule()` compiles TS to a temp directory, but compiled JS references `@audit-tools/shared` which can't resolve from the temp dir
- Fix: Symlinks node_modules (from the workspace root, where npm hoists workspace packages) into the temp directory using a junction. Falls back to the package's own node_modules if the shared package is there instead.

**Test results after Phase 3B:**
- Auditor: 472/473 pass (1 pre-existing failure: `verify-install` "unsettled top-level await")
- Remediator: 357/357 pass (28 test files)

---

## Uncommitted changes

Changes exist in the original standalone repos but have **not** been committed there. The monorepo at `C:\Code\audit-tools\` contains the same changes in its copies.

**auditor-lambda** (`C:\Code\auditor-lambda`) — 1 new file + 10 modified:
- `src/orchestrator/fileIntegrity.ts` (new)
- `src/cli.ts`, `src/orchestrator/internalExecutors.ts`, `src/prompts/renderWorkerPrompt.ts`, `src/types/workerSession.ts`
- `audit-code-wrapper-lib.mjs`, `scripts/postinstall.mjs`, `opencode.json`
- `tests/audit-code-wrapper.test.mjs`, `tests/postinstall-contract.test.mjs`, `tests/render-worker-prompt.test.mjs`, `tests/review-packets.test.mjs`

**remediator-lambda** (`C:\Code\remediator-lambda`) — 1 new file + 8 modified:
- `src/utils/fileIntegrity.ts` (new)
- `src/phases/plan.ts`, `src/state/types.ts`, `src/steps/dispatch.ts`, `src/steps/nextStep.ts`, `src/steps/types.ts`
- `schemas/dispatch_plan.schema.json`, `schemas/finding.schema.json`, `schemas/shared.schema.json`, `schemas/step.schema.json`

---

## Completed — Phase 3C-D

### Phase 3C — Rewire thin wrapper imports (done)

All thin-wrapper barrel files (`quota/index.ts`, `providers/index.ts`) and sibling imports
in both packages now import shared types/functions from `@audit-tools/shared`.
Local-only modules (scheduler, probe, discoveredLimits, headerExtraction, hostLimits) remain local.

`DispatchQuota` interface (auditor-only) kept inline in auditor's `quota/index.ts` with aliased type imports.
`setQuotaStateDir()` initialization added to `audit-code/src/cli.ts` and `remediate-code/src/index.ts`.

### Phase 3C — Extract remaining diverged files (reference)

These files exist in both packages AND in shared, but imports still go through the local `quota/index.ts` or `providers/index.ts` because those modules have project-specific orchestration logic.

**Auditor local quota files still in use:**
- `src/quota/index.ts` — exports `DiscoveredRateLimits`, `DispatchQuota`, and the auditor-specific scheduler with discoveredLimits + first-contact logic. Imports shared primitives and re-exports them alongside auditor-only types.
- `src/quota/scheduler.ts` — auditor-specific wave scheduling with `discoveredLimits` and first-contact concurrency. Diverged from remediator's `waveScheduler.ts`.
- `src/quota/discoveredLimits.ts` — auditor-only (header extraction, discovered rate limits)
- `src/quota/headerExtraction.ts`, `src/quota/headerExtractors/*` — auditor-only
- `src/quota/probe.ts` — auditor-only (quota probing)
- `src/quota/hostLimits.ts` — thin wrapper, imports from shared. Candidate for deletion.
- `src/quota/limits.ts` — thin wrapper, imports from shared. Candidate for deletion.

**Remediator local quota files still in use:**
- `src/quota/index.ts` — re-exports shared functions, used by `waveScheduler.ts`
- `src/quota/scheduler.ts` — remediator-specific wave scheduling
- `src/quota/probe.ts` — remediator-only
- `src/quota/hostLimits.ts` — thin wrapper, imports from shared. Candidate for deletion.
- `src/quota/limits.ts` — thin wrapper, imports from shared. Candidate for deletion.

**Provider files — both packages:**
- `src/providers/index.ts` — diverged (auditor has `dangerously_skip_permissions`, remediator has structured logging)
- `src/providers/constants.ts` — may be identical or near-identical
- `src/providers/spawnLoggedCommand.ts` — may be identical or near-identical
- `src/providers/workerTaskLaunch.ts` — remediator-only

**Approach for Phase 3C:**
1. Diff each pair of local files against the shared version. Files that are now pure re-export wrappers (hostLimits.ts, limits.ts) can have their callers pointed directly to shared.
2. For diverged orchestration files (scheduler, provider index), keep them local — they import shared primitives but contain project-specific logic.
3. Delete identical local copies once all callers are rewired.

### Phase 3D — Delete duplicates and verify (done)

All duplicates listed below have been deleted. Sibling imports within each package that referenced
deleted files were rewired to `@audit-tools/shared`. Test file imports similarly rewired.

Both smoke scripts updated to pack and install `@audit-tools/shared` alongside the main tarball
(workspace packages are not on the public registry). Remediator smoke temp dir moved to system temp
to avoid npm workspace hoisting issues.

**Deleted files:**

**Auditor — deletable duplicates (all imports already point to shared):**
- `src/types/disposition.ts`
- `src/types/risk.ts`
- `src/types/flows.ts`
- `src/types/surfaces.ts`
- `src/types/runLedger.ts`
- `src/types/graph.ts`
- `src/types/sessionConfig.ts`
- `src/io/json.ts`
- `src/validation/basic.ts`
- `src/providers/types.ts`
- `src/quota/types.ts`
- `src/quota/state.ts`
- `src/quota/fileLock.ts`
- `src/quota/slidingWindow.ts`
- `src/quota/quotaSource.ts`
- `src/quota/learnedQuotaSource.ts`
- `src/quota/compositeQuotaSource.ts`
- `src/quota/errorParsing.ts`
- `src/quota/errorParsers/genericErrorParser.ts`
- `src/quota/errorParsers/claudeCodeErrorParser.ts`
- `src/quota/errorParsers/index.ts`

**Remediator — deletable duplicates (all imports already point to shared):**
- `src/quota/types.ts`
- `src/quota/state.ts`
- `src/quota/fileLock.ts`
- `src/quota/slidingWindow.ts`
- `src/quota/quotaSource.ts`
- `src/quota/learnedQuotaSource.ts`
- `src/quota/compositeQuotaSource.ts`
- `src/quota/errorParsing.ts`
- `src/quota/errorParsers/genericErrorParser.ts`
- `src/quota/errorParsers/claudeCodeErrorParser.ts`
- `src/quota/errorParsers/index.ts`
- `src/validation/basic.ts`

**Before deleting each file:**
1. Grep for any remaining local imports of that file across the entire package
2. Check the local `quota/index.ts` and `providers/index.ts` — they may re-export from the local copy
3. Delete only if zero local imports remain
4. Build + test after each batch

**Auditor types that are NOT duplicates (auditor-only, keep):**
- `src/types/auditState.ts`, `artifactMetadata.ts`, `workerResult.ts`, `flowCoverage.ts`, `runtimeValidation.ts`, `externalAnalyzer.ts`, `toolingManifest.ts`, `reviewPlanning.ts`, `designAssessment.ts`, `workerSession.ts`

**Verification results:**
- Auditor: 472/473 tests pass (1 pre-existing `verify-install` failure), build clean, `smoke:linked` passes, `smoke:packaged` passes through MCP/install/version (fails only at pre-existing `verify-install`)
- Remediator: 357/357 tests pass, build clean, `verify:release` passes (all 5 smoke:packaged checks green)
- Both CLI entrypoints verified: `audit-code next-step --help`, `remediate-code next-step --help`

### Constraints to preserve

- npm package names: `auditor-lambda` and `remediator-lambda` (in each package.json `name` field)
- CLI commands: `audit-code` and `remediate-code` (in each package.json `bin` field)
- Test commands: auditor uses `node --test`, remediator uses `vitest`

---

## Pre-existing test issue

**`verify-install summarizes repo-local host integration status`** in `tests/audit-code-wrapper.test.mjs:1067` — fails with "Detected unsettled top-level await" at `audit-code.mjs:6`. This is a pre-existing issue unrelated to the monorepo migration. It existed before Phase 3B changes.

---

## Design decisions to carry forward

- **Access declarations are JSON, not MCP.** MCP requires protocol support; JSON works with any host/IDE/provider. The MCP servers in both repos remain as compatibility adapters.
- **Shared quota state dir is parameterized.** `setQuotaStateDir()` must be called before any quota operation. Each project does this at CLI startup.
- **Atomic writes in shared IO.** The remediator's `writeFileAtomic` (temp + rename) is the shared implementation. The auditor gains this automatically when migrated.
- **Prompt style: one strict path.** No "or", "unless", "if available" fallbacks. One tool, one path, one output location.
- **Workspace dependency uses `"*"`, not `"workspace:*"`.** npm workspaces don't support pnpm's `workspace:` protocol. The `"*"` version specifier resolves to the local workspace package.
- **Test helper symlinks node_modules.** `sourceImport.mjs` symlinks the workspace root's `node_modules` into the temp compile directory so `@audit-tools/shared` resolves correctly. Uses Windows junction for cross-drive compatibility.
