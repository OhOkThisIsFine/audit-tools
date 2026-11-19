# Simplify sweep — items not implemented (2026-11-16)

<!-- review-routing: backlog-forward -->

The simplify sweep ([partition record](simplify-partition-2026-11-15.md)) lands each part as a
behavior-neutral cleanup. A finding that needed more than that was skipped. This record is the one
home of those skips: what each item is, why its part did not do it, and what would unblock it.
Each part adds its own skips here when it lands.

Leads that one part hands to a LATER part stay in the partition record, under *Leads and skips*,
because the later part reads them there first.

The P01 and P02 items are copied from their landing records. They were not re-verified against the
current tree: check an item against the code before you act on it.

## How to read an item

Each item names its part, the code, the gain, the blocker, and the **unblock**: the condition or
the work that would make it a plain cleanup.

## 1. Blocked by a test or a test pin (a test change unblocks it)

- **P01 — `persistAnalyzerConsent`.** Blocker: the shared fixture creators of ten test files call
  it. **Unblock:** move those fixtures to the production write path first; then the function can
  be simplified or removed.
- **P03 — one shared ending for `runRuntimeValidationExecutor` and
  `runRuntimeValidationUpdateExecutor`** in `src/audit/orchestrator/ingestionExecutors.ts`. Gain:
  about 20 duplicated lines (base bundle, selective deepening, artifact list). Blocker:
  `scripts/shared/executor-write-sites.mjs` reads each executor's artifact literals from that
  executor's own function body, so a shared helper reds
  `tests/audit/executor-artifact-production-declaration.test.ts` and
  `tests/audit/seam-dependency-map-executor-writeset-parity.test.ts`. **Unblock:** teach the
  extractor to follow a call into a same-file helper, so both executors still get their own
  write set. Pointing both rows at the helper instead would lose that per-executor attribution.
- **P04 — text refactors in `designReviewPrompt.ts`** (the example finding object, the output
  format block, `conceptualBody`). Blocker: the prompt bytes feed the prompt digests, and no test
  compares the four rendered prompts byte for byte. **Unblock:** add a byte-pin test of the four
  prompts over one fixture bundle; then refactor against it.
- **P04 — named options for `buildPacket`** in `reviewPackets.ts`. Blocker: tests call it with
  positional arguments. **Unblock:** change those tests in the same commit.
- **P05 — unused names that tests still use:** the unused guard parameters in
  `nextStepHelpers.ts`, the `args.ts` option aliases, the `synthesize` / `forceSynthesis` alias,
  `NextStepParams.selfCliPath`, the re-exports that only tests import, the home of
  `renderIntentEquivalencePrompt`, and the unused argument of `charterExtractionKindsForCeiling`.
  **Unblock:** change the tests that name them in the same commit.
- **P05 — files with no `// sites-pinned:` declaration.** `check:sites-pinned` refuses a changed
  line that no declaration covers. So `outputJson` was not applied in `planCommand.ts`,
  `ingestResultsCommand.ts` (two sites), `importExternalAnalyzerCommand.ts` and
  `validateCommand.ts`, and `sampleRunCommand.ts` keeps its `audit_state.json` literal (the other
  three cli sites read `ARTIFACT_DEFINITIONS.audit_state.fileName`). **Unblock:** add a declaration
  with the test that pins each file's sites.
- **P05 — one lane-projection helper for the five `renderFanoutExecutionLines` calls** in
  `nextStepCommand.ts` that drop `resultPath`. Blocker: `tests/shared/lane-demand.test.ts` reads
  each call's source text and requires the literal `demand: lane.demand` in it. **Unblock:** let
  that test accept a call through the helper when the helper body carries `demand`.
- **P05 — one `loadResultJudgmentContext` for `submit` and `validate-results`.** Not done in the
  P05 lap. **Unblock:** check the sites-pinned declarations and the tests of both commands first.
- **P06 — the four manifest-predicate re-exports in `graphManifestEdges/index.ts`**
  (`isCargoManifestPath`, `isGoWorkspaceManifestPath`, `isMavenPomPath`, `isPyprojectPath`).
  `graph.ts` imports them through the index, and four tests in
  `tests/audit/graph-manifest-edges.test.ts` assert the re-export. **Unblock:** import them in
  `graph.ts` from `graphPathUtils.ts` and delete those four tests in the same commit.
- **P06 — `stripJsonComments` in `graphManifestEdges/jsonc.ts`** stays exported only for
  `tests/audit/graph-framework-routes.test.ts`. **Unblock:** test it through the public jsonc
  reader in the same commit.
- **P07 — files with no `// sites-pinned:` declaration** (the P05 rule). Not applied:
  `errorMessage` and the next-step command that is built twice (once near the top, once in the
  handoff text) in `supervisor/operatorHandoff.ts`; `uniqueSorted` for `allSignatures` and one
  `knownTpTotal` for its three sums in `reporting/scoreAudit.ts`; `uniqueSorted`, a weight helper,
  a double compare and the stale comment "First-appearance order, as before" in
  `decompose/sources.ts`; the duplicate `AuditStateStatusSchema` / `AuditStateViewSchema` /
  `ObligationViewSchema` in `contracts/wrapperResponse.ts` (the regenerated
  `schemas/audit-code-v1alpha1.schema.json` must stay byte-identical); the 14-block
  `validateTopLevelShapes` table, the double shape read in `BundleIndexes` and the no-op thunk in
  `validatePathsCoveredBySet` in `validation/artifacts.ts`; `LENS_ID_PREFIX` through
  `LENS_METADATA.id_prefix` in `reporting/findingIdentity.ts` (a plain-object lookup of the key
  `constructor` also differs, so that one is a behavior change too). **Unblock:** add a
  declaration with the test that pins each file's sites.
- **P08 — files with no `// sites-pinned:` declaration** (the P05 rule). Not applied: the
  `FindingClassification` doc in `steps/stepUtils.ts` describes the `reason` field, not the
  interface; `loadRemediateSessionConfig` in `steps/sessionConfigLoad.ts` is a single-use
  indirection. **Unblock:** add a declaration with the test that pins each file's sites.
- **P08 — the unused `_path` parameter of `validateSuppliedInput`** (`steps/intakeResolver.ts`).
  Four calls in `tests/remediate/intake-resolver.test.ts` pass it. **Unblock:** change those
  calls in the same commit.
- **P08 — `reviewRequirementForRole(role: string, …)` as `PlanReviewRole`**
  (`steps/contractPipelinePrompts.ts`). `tests/remediate/adversarial-depth-dial.test.ts` passes
  the elements of a `string[]`, so the narrower type fails `check:tests`. **Unblock:** type that
  test array `as const`.
- **P09 — files with no `// sites-pinned:` declaration** (the P05 rule). Not applied: the
  `errorMessage` site in `phases/grounding.ts`; a point-free `map` in `review/autonomousGate.ts`;
  a `matchPathRisks` helper for the two path-risk loops in the loop-core `riskSignal.ts`; one
  partition pass in `review/findingFilter.ts`. **Unblock:** add a declaration with the test that
  pins each file's sites.
- **P09 — rename `cleanupTempBranchesAndArtifacts`** (`phases/close.ts`; it no longer touches
  branches). `tests/remediate/host-handoff-corroboration-obligations.test.ts` imports it by name. **Unblock:** change those imports in the same commit.
- **P09 — the `wordJaccard` re-export in `dedup/crossLensDedup.ts`.** Only a test imports it
  from there. **Unblock:** point that test at the shared module in the same commit.

## 2. Blocked by a behavior or ordering change (needs `/design-check` first)

Each of these changes an error, a throw order, a lock, a spawn order or an output value. Each is a
real change, not a cleanup.

- **P01:** a precomputed O(g^2) dedupe pair table; parallel git spawns; a batched ledger append; a
  lazy obligation derive; `gitTrackedPaths` on the `git.ts` transport. Each changes error, lock or
  ordering behavior.
- **P02:** `resolveBinaryCandidates` in parallel, and a split of `runExternalAnalyzer`: each changes
  the spawn order or the error order.
- **P02:** `lockedJsonMutate` in `src/shared/io/fileLock.ts`: lock-critical, and a test pins its
  snapshot behavior.
- **P02:** hoisting `scaledDegree` in `src/shared/decompose/modularity.ts`: it moves which input
  throws first.
- **P04 — per-bundle `WeakMap` memos** (the design-review projection, the systemic premise token,
  the charter read set). The full fold drains on one carried bundle, and the P03 lead on the
  derive cache found that a cache on that bundle needs a clone first. **Unblock:** that P03 lead.
- **P04 — `{ ...bundle }` to `bundle`** in `systemicChallengeExecutor.ts`. The `updated` object
  becomes the caller's own bundle object, which changes object identity for every reader of the
  result. **Unblock:** show that no caller keys on or changes `updated`.
- **P04 — the `critical_flow:` and `external_tool:` prefix arms** in the deepening strategies.
  Removing them depends on a producer rule (every task carries the tag form) that resumed and
  host-supplied tasks do not follow. **Unblock:** a validator that enforces the tag form at
  ingestion.
- **P04 — an exhaustive table for the optional-lens switch.** Custom lens names reach the switch,
  so its default arm is live. **Unblock:** prove that no custom lens name reaches it.
- **P05 — one quarantine-and-reject helper** for the submission consumers in
  `nextStepHelpers.ts`. An independent refuter found that the sites differ: some write to stderr
  and some do not, and the issue codes differ. **Unblock:** decide one stderr rule and one code
  set for all the sites, as a behavior change.
- **P05 — the line-index option for `runAuditStepUnlocked`** and wider `manifestIndexes` routing.
  A shared index changes which call prints the duplicate stderr diagnostics.
- **P05 — the fold's manifest index cache for `ingestAvailableInspectionResults`** in
  `nextStepHelpers.ts`. The first deterministic dispatch of the fold would reuse the ingest's line
  index, so a `[lineIndex]` warning for a file that is not on disk would print once per fold, not
  twice. The index content is the same, and one disk pass is saved. **Unblock:** accept the
  stderr change, together with the `runAuditStepUnlocked` item above.
- **P05 — read the cheap skip checks first in `readPublishedAuditTaskIds`.** A missing
  `sourceRoot` is not typed, so the new order can change which error shows.
- **P05 — narrow `submit` and `validate-results` to `buildLineIndexForPaths`.** A narrower index
  can change a verdict.
- **P04 — the "unreachable" `??` fallbacks** in `intentEquivalenceExecutor.ts` (`?? Math.max(...)`)
  and `intentScopeDisposition.ts` (`?? "out of scope"`). Each is unreachable only by an invariant
  that the type does not state. **Unblock:** narrow the type so the compiler proves it.
- **P06 — `normalizeWorkspacePattern` in `graphManifestEdges/workspace.ts` through
  `normalizeRepoRelPath`.** Not shown to give the same output for every glob pattern (`./`, `..`,
  trailing `/**`). **Unblock:** a table test of both functions over the pattern forms.
- **P07 — remove `merge_edge_kind_counts`** (the P04 lead). It is always `{}`
  (`reviewPacketMetrics.ts` in P03, loop-core), it is a required field in
  `types/reviewPlanning.ts`, and it is persisted in `audit_plan_metrics.json`, so the removal
  changes that artifact's bytes and hash once. Two test fixtures carry it. **Unblock:** a lap that
  removes the writer, the type field and the fixtures together, with the loop-core attestation.
- **P08 — the emitted wording of the block-contract refusals** (`steps/dispatch/hostHandoff.ts`).
  The `BlockContractError` messages say `touched_files` and `targeted_commands`, but the fields
  are `allowed_files` and `required_tests`. The command-shape message says that the boundary runs
  commands "through a shell", but `runRequiredTest` splits the argv with no shell. Tests pin the
  text. **Unblock:** a wording decision, with the pinned tests changed in the same commit.
- **P08 — `"audit-findings/v1alpha1"` in `KNOWN_SCHEMA_VERSIONS`** (`steps/intakeResolver.ts`)
  matches no producer: the audit report stamps `contract_version`
  (`AUDIT_FINDINGS_CONTRACT_VERSION`), not `schema_version`. Removing the entry changes which
  supplied files are accepted. **Unblock:** an owner decision.
- **P08 — the `options.root === undefined` and `options.artifactsDir` fallback arms of
  `recoverIngestHostResults`** (`steps/recoverIngest.ts`) are dead by type only.
  **Unblock:** show that the CLI caller `recoverIngestVerb` (`src/remediate/index.ts`) always
  supplies defined, non-empty values.
- **P08 — the default runner in `steps/finalGate.ts` spreads `spec.argv` again.** Passing
  `spec.argv` directly differs only for an empty argv (`[undefined]` against `[]`), and no
  producer makes one today. **Unblock:** a type or a check that makes an empty gate argv
  impossible.
- **P09 — the second `validateRemediationPlan(state.plan)` call in `validation/artifacts.ts`**
  repeats a check that `loadState` already ran, but a caller that builds `state` without
  `loadState` loses it. **Unblock:** show that every caller passes a loaded state.
- **P09 — the try/catch around `hashAffectedPath` in `utils/fileIntegrity.ts`**
  (`checkAffectedFileIntegrity`). `hashAffectedPath` catches its own errors, so the catch looks
  unreachable, but removing it removes a failure path. **Unblock:** show that
  `resolveAffectedPath` cannot throw.
- **P09 — one map for the plan ledger** (`phases/plan.ts`). It is equal only when ids are
  unique, and no check makes them unique there. **Unblock:** a uniqueness check or a proof.

## 3. Design changes (larger than a cleanup; worth a lap of their own)

- **P03 — a PRIORITY-keyed derivation table for `deriveAuditState`** in
  `src/audit/orchestrator/state.ts`. About twelve rows have the same
  `obligation(id, staleOrSatisfied(stale, [artifact], has(bundle.x)))` shape. The open property
  (an id that `deriveAuditState` does not emit reads as satisfied in `deriveObligationState`) is
  now held by `tests/audit/obligation-emission-covers-priority.test.ts`, which found and closed
  the one gap (`audit_tasks_completed` on a bundle with no task plan). What remains is the shape
  gain: a `Record<PriorityId, Derivation>` with `PRIORITY` declared `as const` makes a missing
  row a type error for every bundle, not only for the bundles that test builds.
- **P01 — `classifyRead` delegation, a private `runGit` wrapper, an artifact-freshness policy
  table.** Small gain; part of it is loop-core.
- **P05 — a derive cache for the audit state** (the P03 lead). `ingestBatchAuditResults` in
  `auditStep.ts` would also use it, but it differs on the `complete` status.
- **P05 — a `Pick` type for `HostInputPauseInputs`**: the source types are in P03 and P07.
  P07 checked it: the type is in `orchestrator/hostInputPause.ts` (P03), and its two callers
  (`advance.ts`, `cli/nextStepHelpers.ts`) are loop-core. No P07 file changes. The pins are
  `tests/audit/analyzer-consent-offer.test.ts` and `analyzer-run-consent.test.ts`.
- **P06 — rule tables for `bucketFile` (`bucketing.ts`) and the disposition classifiers**
  (`disposition.ts`, `inferDisposition`). About twelve `if` blocks each are rows of
  `[predicate, bucket or status, reason]`. The blocks mix accumulate-all and first-match-wins, and
  the output order is persisted. **Unblock:** a table form that states each rule's mode, with a
  test that pins the output order over a mixed path corpus.
- **P06 — split `graphRoutes.ts` by concern** (per-framework route discovery, route-path
  normalization, call extraction; about 880 lines). A move of that size is a lap of its own, and
  the module is in the `GRAPH_EDGE_CACHE_KEY_VERSION` digest, so the split also bumps the version.
- **P06 — derive `TIER_S_ANALYZER_IDS` in `analyzers/registry.ts`** from the shared candidate
  table. The table has no tier field. **Unblock:** add the field to the table first.
- **P05 — one render per step of the design-review file map and input revision**, and of the
  structural context in deep `conceptualDispatch` (the P04 lead). Each needs a new optional
  parameter on the P04 prompt modules.
- **P05 — a prepared validator for `validateOneAuditResult`** (P07 validation; see the P05
  leads in the partition record). P07 checked it: each call runs `normalizeValidationInputs`,
  which builds the task map and a line index over all repo files. The callers are
  `evictInvalidatedEntries` (once per ledger entry) and `judgeAuditHostSubmission` in the
  loop-core `cli/dispatch/hostHandoff.ts`. A new export with no adopter fails `check:deadcode`, so
  the validator and its adopter must land together. **Unblock:** one loop-core lap for both.
- **P07 — retire `access_memory.json`** (the P01 lead). `deriveAccessMemory`
  (`ingestionExecutors.ts`) writes it and no code reads it; the spec calls it write-only.
  Removal retires a persisted artifact across the registry, rollover, the dependency map,
  artifact freshness, the spec and the tests. **Unblock:** an owner decision to retire it.
- **P07 — one lens policy on `LENS_METADATA`** (the P04 lead). At least five lens sets exist:
  `SENSITIVE_LENS_IDS` (security, data integrity, reliability), `MANDATORY_LENSES` (security,
  correctness, reliability, data integrity), the high-risk-clean pair (security, data integrity)
  in `highRiskClean.ts` and `taskBuilder.ts`, the critical-flow set (security, reliability,
  correctness) in `taskBuilder.ts`, and the ranked runtime follow-up order in
  `runtimeValidation.ts`. **Unblock:** about three flags and a rank on `LENS_METADATA`, with a
  test that pins each derived set and order to today's value.
- **P07 — move `isDocIntentFile` to the extractors** (the P06 lead). The import
  `extractors/docsDigest.ts` → `decompose` → `extractors/commentDecomposition.ts` is a cycle at
  the directory level. The move also touches the loop-core `orchestrator/charterPackets.ts`.
  **Unblock:** a lap with the loop-core attestation.
- **P07 — split `io/artifacts.ts` (promotion half to `io/promotion.ts`) and `io/runSnapshot.ts`.**
  `tests/audit/io-remediation.test.ts` reads the source text of `artifacts.ts`, and
  `runSnapshot.ts` is loop-core. **Unblock:** move the source-text pins with the code.
- **P01 — public barrel narrowing** (unused exported types, `lensOutcome`): an owner decision on
  the public surface of `audit-tools/shared`.
- **P08 — the rationale of the two-phase `recover-ingest`** (`steps/recoverIngest.ts`). Its doc
  says that a required-test rerun is a `spawnSync`, which is false now: the reruns are awaited
  (`runRequiredTest`). The doc uses that fact as the reason for the unlocked-test, locked-write
  split, and part of the phase machinery (`tree_moved_between_phases`,
  `state_moved_between_phases`) may now rest only on lock hold time. **Unblock:** the owner states
  the current rationale; then the comment fix is a plain cleanup.
- **P08 — tested-but-unwired prompts** in `steps/prompts.ts`: `ambiguityReviewPrompt` and
  `extractedPlanDiscardedPrompt` lost their callers in `3f73d24f`. Only
  `tests/shared/driverPromptFixtures.ts` and the "17a" block of
  `tests/remediate/clarification-round-contract.test.ts` use them. After the deletion,
  `intakePaths().extractedPlan` has no reader. **Unblock:** an owner-approved deletion (the
  CLAUDE.md "tested-but-unwired class" audit).
- **P08 — one tail helper** for `outputTail` (`steps/finalGate.ts`) and `tail`
  (`steps/dispatch/requiredTests.ts`). The limits differ, and so does the result for an empty
  input (`undefined` against `""`). **Unblock:** a home in `src/shared` with a parameter for the
  empty case.
- **P08 — rename `steps/frictionCloseout.ts`** (it holds only `presentReportStep`; the friction
  check is retired). The rename touches its importers and the sites-pinned test lists.
- **P08 — one role-keyed parse in `reviewStep`** (`steps/contractPipeline.ts`). The
  `CritiqueSchema`, `CriticSchema` and `PlanJudgeSchema` parses of an already parsed payload exist
  only to narrow the type. **Unblock:** a parse that returns a discriminated union by role.
- **P09 — one `backtickList` helper** for the backticked id list (16 copies in six remediate
  and shared files). **Unblock:** a home in `src/shared`, adopted in all six files at once.
- **P09 — a `DECISION_INPUT_FILENAMES` constant** for `clarification_resolution.json` and
  `triage_resolution.json` (`phases/triage.ts`, `state/decisionConsumption.ts`, P08's
  `steps/submitGateResult.ts`). `generate-runtime-artifact-names.mjs` reads quoted `join(`
  literals, so a constant changes its source set. **Unblock:** a generator rule for the
  constant, or a decision to keep the literals.
- **P09 — the `conformance-review` paths in `phases/triageConformance.ts`** belong to
  `conformanceReviewPaths` in `steps/` (P08, landed), with an `observation` member, a
  `conformanceSubjectsDir` export and the `conformanceIssue` export. **Unblock:** one change
  across both parts.
- **P09 — an exported `IntakePaths` type** (`intake.ts`). Its only users are the
  `ReturnType<typeof intakePaths>` sites in `steps/` and tests; adding the export with no adopter
  fails `check:deadcode`. **Unblock:** add it with its `steps/` adopters in one commit. The same
  holds for `intentInterpretationPath` (`intent/intentPersistence.ts`, private now) and the
  `executionPlanPaths(...).ownerDecision` adoption in `steps/`.
- **P09 — export `STATE_FILENAME` and `PHASE_LOCK_FILENAME`** (`state/store.ts`); their other
  users are `steps/` files. **Unblock:** the same as above.
- **P09 — one shared `Sha256HexSchema`.** `state/types.ts` has a local `Sha256Hex`; the same
  regex is in `state/decisionConsumption.ts`, `contractPipeline/executionPlan.ts`,
  `steps/dispatch/contractConformanceReview.ts` and three shared charter schemas.
  **Unblock:** a home in `src/shared`, adopted at every site in one commit.

## 4. Efficiency items with no measured cost

No part measured these costs. Each item needs a measurement that shows the cost before it is
worth a change.

- **P01 — a quote and citation memo in `findingGrounding`.** Also needs a second per-pass object
  next to the exported `SourceReader`, which is an API change in other parts.
- **P02:** `Map` lookups in `charterExtraction.ts` and `charterClarification.ts`, a composite
  triage key, a `Set` in `frictionRecord.ts`, a `GO_OS_NAMES` table. Small inputs.
- **P03 — the selective-deepening path of result ingestion** builds an affinity graph and plan
  metrics that `finalBundle` then overwrites. The same path is live for the two runtime-validation
  executors, so a conditional would add more code than it removes. Worth it only if a measurement
  shows deepening-heavy ingestion is slow.
- **P03:** two `interpretFreeFormIntentForAudit` calls on one short string and two reads of the
  coverage-element baselines in `planningExecutors.ts`; nested runtime-task scans in `state.ts`;
  small `includes` lists in `ingestionExecutors.ts` and `architectureDiscovery.ts`.
- **P04 — inverted indexes for `buildTaskAffinityGraph`** (file, directory and unit to tasks).
  The `same_dir` and `same_unit` buckets can be dense, so the worst case stays quadratic.
- **P04 — `Promise.all` for independent reads** (manifest and snapshot reads, the member files of
  a packet, the kinds of the charter packet archive, a `mkdir` per kind in its loop). Each must
  keep its output order.
- **P04 — one pass for the three verdict filters** in `charterFidelityExecutor.ts`. Small inputs.
- **P05:** a path-to-hash map in `toAuditHostTask`; a memo of the generated fanout context in
  `fanoutLanes.ts`; one partition pass in `dropAcceptedResults`.
- **P06:** a memo for the `pathPatterns.ts` predicates; one mask and parse for
  `extractRegisteredRouteEvidence` and `extractFrameworkRouteEvidence`, which `graph.ts` calls back
  to back; a cheap pre-check before the Python router scan; `detectCycles` in `graphSignals.ts`;
  one `buildDispositionMap` passed down (it is built in five extractors and four orchestrator
  files, a signature change across parts); the window strings in `complexityDuplication.ts`; the
  token scan in `commentDecomposition.ts`; the per-call `RegExp` in
  `extractHtmlAttributeReferences` (`browserExtension.ts`).
- **P07 — concurrent reads in `hashToolingInputs` (`io/toolingManifest.ts`).** This one has a
  measurement. Each `loadArtifactBundle` calls `buildToolingManifest`, which reads about 1,798
  files (9.5 MB, mostly under `dist/`) one at a time. Measured while a suite ran: 7.9–10.6 s
  serial, 0.33–0.36 s with `Promise.all` over the reads; the walk itself (`collectFilesSorted`,
  P10) takes 4–7 s of that. An unbounded `Promise.all` can exhaust file handles (1,024 by default
  on Linux), and a per-process memo is not neutral (`dist/` is rebuilt while a process runs).
  **Unblock:** a concurrency cap set from a measurement, with the hash input order kept.
- **P07:** the flow loop in `relationshipsForFindings` (`reporting/workBlocks.ts`, flows ×
  findings × files; a by-file index would change no output, medium confidence); the per-unit
  filters in the loop-core `systemic/reviewFileMap.ts` and `secondOrderAdversaryPrompt.ts` (tens
  of units); the `find` per path in `markExcludedPath` / `applyUnitCoverage` (`coverage.ts`, no
  declaration, and the index belongs in `planning.ts`, P03; keep first-wins); one build of
  `adversaryReviewScope` and `summarizeCoveredThemes` per render in the loop-core
  `secondOrderAdversaryPrompt.ts` (the prompt bytes must not change).
- **P08:** one `discoverLandingGates` read per workload build instead of one per work item
  (`steps/dispatch/hostHandoff.ts`; the hoist needs a parameter through four functions); a `Set`
  for the command list in `precomputeRecoveryTestVerdicts`; the per-unit lower-phase filter in
  `hostDependencyLevels` and `permanentlyDeadPendingUnits`; the `includes` scans over obligation
  ids in `parseResult` and `conformanceObligationsMatch`; one partition pass for the two
  `pathIsAllowedByWriteScope` filters in `corroborateNoChangeClaim`; a map for the unit lookup per
  blocked item in `triagePrompt`; the repeated `readPlanReviewHistory` reads in
  `buildNextContractPipelineStep` (the read after the write must stay fresh); the second parse of
  a supplied file in the `resolveIntakeStep` fast path. Plan sizes are tens of units.
- **P09:** one build of the verification report in `buildVerificationReport` (`phases/close.ts`);
  one partition pass for the `present` and `absent` lists in `close.ts`; a hoist of `knownIds`,
  of the comparator and of the `checkpointFilter` `affectedPaths`; one read of `review-history`
  where two reads run; one `sourceSha` per source in `contractPipeline/executionPlan.ts`. Plan
  sizes are tens of units.

## 5. Low value (do it only when you are already in the file)

- **P03 — `hasPackageJsonEslintConfig`** in `syntaxResolutionExecutor.ts` could call
  `readPackageJson` from `intakeExecutors.ts`. That needs `readPackageJson` exported and an
  `eslintConfig?: unknown` field on its shape. Edge cases checked: identical for a missing file,
  bad JSON, `null`, an array and a primitive.
- **P03 — the keyed dedupe loop in `syntaxResolutionExecutor.ts`** could use a `dedupeBy` helper.
  `requeueCommand.ts` has a private one; a shared home would be needed first.
- **P04 — `stopNote` and `registerBase`** in `systemicChallengeExecutor.ts`: a nested ternary and
  a repeated literal. Readability only; leave them to the work that owns the convergence wording.
- **P04 — a fallback chain for `fallbackLineIndex`.** `LineCountSources` takes one index, so a
  chain needs an API change.
- **P04 — the `.has` guard in `shouldBuildLensVerificationTask`** repeats the caller's lens filter.
  It keeps the function safe on its own input; removing it saves one lookup.
- **P05:** a local `rejectEdgeReasoning` helper for the two edge-reasoning arms in
  `nextStepHelpers.ts`; one remaining `mergeFoldAdvisoriesInto` cleanup; the rest of the misplaced
  JSDoc blocks in `nextStepHelpers.ts`; a `gatePromptWithShortfall` helper for the four gate
  emitters in `nextStepCommand.ts`; the `BranchResult` aliases; the private `fileExists` copies;
  `resultPathFor` (kept for parity with the remediate twin); the sample `total_lines` of 100 in
  `sampleRunCommand.ts`; a `Set` in `explainTaskCommand.ts`; the hoist of the systemic lane in
  `auditStep.ts`; a shared `PROVENANCE_KINDS` list.
- **P06 — a required `pathIndex` for the `graphPythonImports.ts` extractors.** Each one builds an
  index when the caller passes none. **Unblock:** check that every caller has an index to pass.
- **P06 — one `isExcludedByDisposition(map, path)` helper** for the nine
  `status && isAuditExcludedStatus(status)` guards (`flows.ts`, `browserExtension.ts`,
  `gitHistory.ts`, `surfaces.ts`, `graph.ts`, and orchestrator files in P03). Each site composes
  the guard with its own `file.excluded` term, so the gain is small.
- **P07:** one grounding/verification breakdown helper for `buildAuditReportModel` and
  `normalizeExistingFindingsReport` (`reporting/synthesis.ts`; the key insertion order of the
  output must stay); the dead `"."` branch and the single-assignment `let` in
  `findingContractPrompt.ts` (prompt bytes); the five label ternaries in `decompose/findings.ts`
  (no declaration); the duplicate arms of the default in `clarification` `blastRadius` and the
  unreachable `?? 1` / `Math.max` in `clarification/partition.ts` (narrow the `Map.get` type
  first); an `edgelessCount(slice, anchors)` helper for the two edgeless counts in the loop-core
  `systemic/reviewFileMap.ts`; the judge schema in `types/conceptualAdjudication.ts` as
  `ConceptualRoundContributorSchema.omit({ perspective: true })` (check the generated JSON schema
  and the error text first).
- **P08 — `resultPathFor` and the `BoundaryPaths` alias** in `steps/dispatch/hostHandoff.ts`: a
  pure pass-through and a type alias. The audit twin keeps its `resultPathFor` for parity (the P05
  item above), so remove both twins' wrappers together or neither.
- **P08:** one closing-action predicate for the two copies in `steps/nextStep.ts` (the confirm
  step and the obligation; not shown character-identical, one copy casts the checkpoint); inlining
  the `origin` argument of `handleReadyIntakeContractPipeline` (always `"new_pre_edit_run"`);
  moving the import above the sites-pinned line in `steps/intakeResolver.ts` (it changes module
  evaluation order); a closed-set line helper for the three prompt sites in `steps/prompts.ts`; a
  read-and-join helper for `ensureSource` and `writePathASeedFromFindings`; the
  `persistedWorkloadAllowsRebind` check through `idsAreStrictlyAscending`; a helper for the
  repeated `conformance_review` and `started_at` lines in `commitRemediationStateUpdates` (a
  module-level helper would move state writes outside the phase functions); one
  `identityFailureDiagnostic` for both `parseResult` branches; the indentation of the
  `store.mutate` body in `recoverIngest.ts`; importing `readApprovedExecutionPlan` in
  `nextStep.ts` from `contractPipeline/executionPlan.ts` and deleting the re-export in
  `steps/contractPipeline.ts` (check the namespace import in
  `tests/remediate/dirty-baseline-capture.test.ts` first).
- **P09:** `finding?.` where `finding` is never undefined (`close.ts`); a `timestamped` helper
  for the `close.ts` records; a `recordContext` spread in `phases/closeAcceptance.ts`; a hoist of
  `reviewRequired` and its `context ?` test in `phases/triage.ts`; a requirement and
  counterexample helper; a `conversationSourceEntry` helper in `intake.ts`; the declaration
  reflow in `index.ts`; the empty ` *` line in the `autonomousGate.ts` doc. Also the delete of
  `REMEDIATION_HOST_HANDOFF_RECORD_V1ALPHA1` (`state/types.ts`): it names the retired version,
  and tests use its literal.

## 6. Rejected — do not re-propose

Each of these was checked and is NOT behavior-neutral, or is correct as it stands.

- **P01:** `aggregateReflections` zero-init from the enum options needs a cast for no gain.
- **P01:** `isRecord` in `isLegacyDraftCheckpoint` and one `submissionLedger` check is not
  identical (those accept arrays; the narrowed type rejects the cast).
- **P03:** merging the three `taskPriority` functions (`requeue.ts`, `flowRequeue.ts`,
  `taskBuilder.ts`): their rules differ on purpose (`requeueUtils.ts` says so). Only the lens set
  was shared (`SENSITIVE_LENSES`).
- **P03:** the `ARTIFACT_DEPENDENCIES_MAP` aliases in `staleness.ts` and `artifactMetadata.ts`
  widen the literal key type of `ARTIFACT_DEPENDS_ON_MAP` for string lookups; they are not
  redundant.
- **P03:** the unreachable missing-executor arms in `nextStep.ts` and `obligationPolicy.ts` are
  fail-closed guards behind a load-time assertion; keep them.
- **P03:** the `artifact_metadata.json` filters over `ALL_DAG_ARTIFACTS` and
  `ARTIFACT_DEPENDS_ON_MAP` guard declared data; removing them would move an unchecked invariant
  into the map.
- **P03:** `resolveFromPath` → `resolveExecutableFile` and `resolveRuntimeValidationSpawnCommand`
  → `resolveExecArgv` change spawn resolution and argv quoting.
- **P03:** `errorMessage` at the `advance.ts` and `graphEnrichmentExecutor.ts` error sites changes
  the text for a thrown `null`, or drops the error name and stack.
- **P03:** `structuredClone` for the `JSON.parse(JSON.stringify(...))` copy in
  `resultIngestion.ts` keeps `undefined` fields that the JSON round trip drops.
- **P03:** the `pathExists` helper in `autoFixExecutor.ts` duplicates one in
  `src/audit/io/toolingManifest.ts`, but neither is exported and there is no shared helper to
  call.
- **P04:** `countBy` for the language and category counts in `designReviewPrompt.ts` and the key
  and directory counts in `intentCheckpointExecutor.ts`. Those are open vocabularies, and `countBy`
  counts on a plain `{}` (the P01 lead), which also moves integer-like keys first.
- **P04:** `sliceFor` in `charterPackets.ts` through `renderExcerptBody`: the line-number padding
  width differs (the end line versus the widest line), so the packet bytes and its revision hash
  change.
- **P04:** removing the options of `computeGateVersion` in `intentCheckpointGate.ts`: a test uses
  them to prove that each component invalidates the version. The default is now computed once.
- **P06:** `errorMessage` for the `(error as Error).message ?? String(error)` sites (`fsIntake.ts`,
  `graphSuites.ts`, `analyzers/treeSitter.ts`, `treeSitterBatch.ts`, `typescript.ts`): the text
  differs for a thrown `null` and for a non-`Error` object that has a `message`.
- **P06:** `graphLookupKey` at the `normalizeGraphPath(x).toLowerCase()` sites in the analyzers,
  `browserExtension.ts`, `graphPathIndex.ts`, `graphRoutes.ts` and others. None of them is a
  `pathLookup` key: each is a case-insensitive match, so the name would mislead.
- **P06:** one resolver for `graphManifestEdges/go.ts` and `maven.ts`: they differ (the Maven one
  has a `..` guard).
- **P06:** removing the `if (complexity)` / `if (duplication)` guards in
  `computeNodeMetricsForFile`: both are always true at run time, but the types are
  `NodeMetric | undefined`, so the removal needs non-null assertions.
- **P06:** the `has` guard in `addBucket` (`bucketing.ts`): no bucket is added twice today, but
  the guard keeps a later rule from adding one twice, at no cost.
- **P06:** dropping `export` from the confidence constants that only their own file reads
  (`graphManifestEdges/*`): `knip.json` sets `ignoreExportsUsedInFile`, so they are not dead
  exports.
- **P07:** deriving `CARRIED_ARTIFACTS` (`io/runSnapshot.ts`) from the registry: it is a
  deliberate allow-list.
- **P07:** `writeTextFile` for the `writeFile` in `markRunEnded` (`io/rollover.ts`), and
  `readOptionalJsonFile` in `readPackageVersion` (`io/toolingManifest.ts`): the write and the
  stderr text differ.
- **P07:** one flow-status rule for `validation/artifacts.ts` and `orchestrator/flowCoverage.ts`:
  they differ on edge cases (an empty `required_lenses`).
- **P07:** the shared `countBy` for the private one in `systemic/coveredThemes.ts`: the private
  one trims, sorts and returns an array.
- **P07:** removing the second validation in `writeCoreArtifacts` (deliberate), a memo for the
  `reaches` search in `blockDependencies` (`reporting/workBlocks.ts`; it changes the semantics),
  `findingReEmissionKey` for the `priorFindings` key in `secondOrderAdversaryPrompt.ts` (that key
  uses `normalizeText` and a `|` separator), and one `mkdir` in `operatorHandoff.ts` (the error
  path text differs).
- **P08:** the `unit_id` set in `unresolvedFrontierWorkItemIds` and the sort in
  `workloadBindingIdentity` (`steps/dispatch/hostHandoff.ts`): the recovery caller passes
  `currentHostBoundaryState(...)`, a cast and not a parse, so neither the key match nor the
  ascending order is guaranteed there.
- **P08:** folding the two `isGitRepo` probes in `validateHostResultBundle` (it changes the number
  of git spawns); hoisting `resolveAdversarialDepth` out of the per-role `reviewStep` (it can write
  an escalated risk signal, so the hoist moves a write).
- **P08:** the second `admitRemediationDirtyBaseline` in `runTouchedPaths` (`steps/gateCommands.ts`;
  it fixes the throw order before the git spawns, and it is the only call in
  `writeFinalGateRedRecord` when `failed` is undefined); the `headCommit` guard in
  `worktreeContentId` (without it, a repository with no commit gets the empty tree); spreads in
  the key-by-key persisted literals (`writeFinalGateVerdict`, the `runRequiredTest` returns, the
  conformance `request` and `content`), which risk the key order.
- **P08:** dropping `export` from symbols that only their own file reads
  (`CONFORMANCE_REVIEW_ISSUES`, `GATE_ATTRIBUTION_SAMPLE_LIMIT`, `isTestFilePath`,
  `carriesEnvironmentVerdict`, `FinalGateRedRecord`, `FinalGateVerdictRecord`, `WriteStepInput`,
  and the `isTerminalStatus` / `isVerifiedCompleteStatus` re-export in `nextStep.ts`): knip's
  `ignoreExportsUsedInFile` already ignores them.
