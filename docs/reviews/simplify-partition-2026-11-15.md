# Simplify sweep — codebase partition (2026-11-15)

<!-- review-routing: backlog-forward -->

A `/simplify` pass (reuse, simplification, efficiency, altitude — quality only, not bugs) over the
whole codebase, one part per chat. Base: `494d10df` (v0.55.20).

## Rules

- **Disjoint by construction.** Every tracked code file outside `tests/` and `.audit-tools/` belongs
  to exactly one part: the parts are tested in the order below and the first match wins. Verified
  with 0 unassigned files at the base commit.
- **Review scope** is the part's non-test source. A fix may change a test or a caller in another
  part only when the fix needs it; it never starts a cleanup there.
- **Out of scope:** `tests/**` as a review target, `.audit-tools/nightly/proposals/**` (unrun
  drafts), and non-code files (docs, schemas, skills, examples, spec, JSON config).
- Each chat works in its own worktree and lands through the normal gate. Its landing commit sets
  the row's Status to `landed` (a commit cannot name its own hash: `git log -L` on the row finds
  it). Parts land one at a time; a later part rebases onto the earlier landings.
- Each landing adds its leads for later parts to *Leads and skips* below, and its skips (what it
  chose not to do, why, and what would unblock it) to
  [`simplify-deferred-items-2026-11-16.md`](simplify-deferred-items-2026-11-16.md). A later chat
  reads the leads for its own part first.

## Parts

Lines are whole-file line counts at the base. "Churn" is added + deleted non-test lines over the
35 commits `ef848183..494d10df` (v0.55.17 – v0.55.20): newer code has more cleanup potential.

| Part | Rule (first match wins) | Files | Lines | Churn | Status |
| --- | --- | ---: | ---: | ---: | --- |
| P01 shared contracts | `src/shared/{types,validation,submission,intent,findings,steps,engine,mcp,reporting,parsing,reReview}/**` and the top-level files `src/shared/*` | 87 | 17,715 | 175 | landed |
| P02 shared infrastructure | the rest of `src/shared/**` (`analyzers`, `tooling`, `io`, `decompose`, `friction`, `graph`, `observability`, `measurement`) | 58 | 15,569 | 66 | landed |
| P03 audit orchestrator core | `src/audit/orchestrator/**` except the P04 names | 55 | 12,438 | 47 | landed |
| P04 audit orchestrator review and charter | `src/audit/orchestrator/` files that start with `designReview`, `charter`, `reviewPacket`, `intent`, `systemicChallenge`, `taskAffinityGraph`, `dependencySlices`, plus `selectiveDeepening/**` | 34 | 8,113 | 8 | landed |
| P05 audit cli | `src/audit/cli/**` | 50 | 16,203 | 594 | landed |
| P06 audit extractors | `src/audit/extractors/**` | 51 | 12,039 | 29 | landed |
| P07 audit other | the rest of `src/audit/**` (`reporting`, `io`, `validation`, `types`, `systemic`, `contracts`, `decompose`, `clarification`, `supervisor`, top-level files) | 55 | 12,499 | 160 | landed |
| P08 remediate steps | `src/remediate/steps/**` | 21 | 10,858 | 527 | landed |
| P09 remediate other | the rest of `src/remediate/**` | 40 | 11,197 | 66 | landed |
| P10 scripts shared | `scripts/shared/**` | 69 | 14,406 | 269 | landed |
| P11 scripts other | the rest of `scripts/**` | 63 | 18,357 | 82 | landed |
| P12 wrapper, hooks, entries, root config | `wrapper/**`, `.claude/hooks/**`, `.githooks/**`, `audit-code.mjs`, `remediate-code.mjs`, `eslint.config.js`, `vitest.config.ts`, `.dependency-cruiser.cjs` | 34 | 10,747 | 113 | landed |

## Leads and skips

### From P01

Cross-part touches that P01 made because its fix needed them: `src/audit/reporting/workBlocks.ts`
(P07) now takes its owned files, role and highest severity from `deriveWorkBlockFacts`;
`tests/audit/continuity-score.test.ts` lost the tests of the deleted continuity scorer module.

Leads for later parts (not fixed, not verified as defects):

- **P04:** `BuildReviewPacketOptions.continuityScores` in `reviewPackets.ts` and the rest parameter
  of `orderReviewPackets` have no producer now that the continuity scorer is deleted. Two tests
  assert only that the scores cannot reorder packets.
- **P07:** the continuity scorer was the only reader found for `access_memory.json`. Check whether
  the artifact is now written but never read.
- **P09:** in `closeVerifyAnalyzerLeads.ts`, the spread of `persistedAnalyzerPolicy.analyzer_consent`
  is always undefined, because `loadAnalyzerPolicy` strips the field. The `overrides` half is live.
- **Any part:** `countBy` builds its counts on a plain `{}`, so a key such as `constructor` reads an
  inherited value. P01 kept the `Map` counters for custom lens names for that reason.

P01 skips are in
[`simplify-deferred-items-2026-11-16.md`](simplify-deferred-items-2026-11-16.md), with what would
unblock each.

### From P02

Cross-part touches: `src/shared/index.ts` lost the barrel line of the deleted
`graph/directedCycles.ts`. That module had no consumer after commit 3f73d24f.

Leads for later parts (not fixed, not verified as defects):

- **P05, P09:** about ten analyzer parsers repeat one "parse JSON, degrade to `[]`" prologue. A
  shared `parseJsonPayload` needs each parser's degrade report kept, so it is a design change.
- **P05, P09:** three callers supervise an owned process with the same term-then-kill sequence. One
  `superviseOwnedProcess` helper would serve them, but the timing is lock-adjacent.
- **Any part:** `package.json` is read by more than one reader in `tooling/`. A single reader must
  keep the array-valued edge in `repoConventions.ts`.

P02 skips are in
[`simplify-deferred-items-2026-11-16.md`](simplify-deferred-items-2026-11-16.md), with what would
unblock each.

### From P03

Cross-part touches: `selectiveDeepening/shared.ts` (P04) lost its byte-identical `priorityRank`;
`selectiveDeepening/index.ts` and `lensVerification.ts` (P04) now import it from
`auditTaskUtils.ts`.

A follow-up commit deleted `log_entries`, `LogEntry`, `step_duration_ms` and `degraded` from
`executorResult.ts`: no executor set them and nothing in `src/` read them, and their doc comments
told machine consumers to read them. The two type-only tests in
`tests/audit/observability-signals.test.ts` went with them. Settled by the philosophy brief
("delete legacy rather than carry it"); a dead field on a contract is not a test seam.

Leads for later parts (not fixed, not verified as defects):

- **P04:** `IMPORTANT_LENS_VERIFICATION_LENSES` in `selectiveDeepening/shared.ts` is the same set
  as the now-exported `SENSITIVE_LENSES` in `auditTaskUtils.ts`.
- **P04 (or a cross-part move):** `uniqueSorted` lives in `selectiveDeepening/shared.ts`. Six P03
  sites (`flowPlanning.ts`, `graphEnrichmentExecutor.ts` x2, `structureExecutors.ts`,
  `runtimeValidation.ts`, `autoFixExecutor.ts`) still write `[...new Set(x)].sort(...)` because a
  core file importing a deepening-strategy module is the wrong layer. Moving `uniqueSorted` to
  `src/shared` would let all of them use it.
- **P05:** the full fold re-derives a state the engine just derived, at least twice per drain
  step (`decideNextStep` in `runSingleAdvanceStep`, and the post-executor `{...bundle,
  audit_state}` that defeats the engine's WeakMap). Threading the derive cache through
  `AdvanceAuditOptions` crosses into `cli/nextStepHelpers.ts` and needs a clone before caching.
- **P05/P07:** `HostInputPauseInputs` flattens `externalAcquisition.*` into renamed fields that two
  callers map back across; a `Pick<AdvanceAuditOptions, ...>` would remove both mappings.
- **Shared:** `chunkByTaskBudget` → `src/shared/chunkByBudget.ts` re-reduces the growing chunk for
  every item (O(n^2) per block).

P03 skips are in
[`simplify-deferred-items-2026-11-16.md`](simplify-deferred-items-2026-11-16.md), with what would
unblock each.

P03 coverage gap: the efficiency reviewer did not read `scope.ts`, `structureExecutors.ts`,
`syntaxResolutionExecutor.ts`, `graphEnrichmentExecutor.ts`, `autoFixExecutor.ts`,
`unitBuilder.ts`, `runtimeCommand.ts`, `coverageElementBaseline.ts`, `runtimeValidation.ts`,
`flowPlanning.ts`, `edgeReasoning.ts`, `synthesisExecutors.ts`, `executors.ts` and
`localCommands.ts` line by line. The other three angles covered them.

### From P04

P04 closed the P01 lead (`continuityScores` and the rest parameter of `orderReviewPackets` are
deleted) and both P03 leads for P04 (`IMPORTANT_LENS_VERIFICATION_LENSES` is replaced by
`SENSITIVE_LENSES`; `uniqueSorted` moved to `src/shared/compareCodeUnits.ts`).

Cross-part touches that P04 made because its fix needed them:

- `uniqueSorted` is now a shared primitive (`SINGLE_DEFINITION_RULES` in
  `scripts/check-shared-primitives.mjs`). The private copies in `src/shared/affinityArtifacts.ts`,
  `validation/findingsReport.ts`, `friction/frictionRecord.ts` and
  `decompose/contentCoherence.ts` (P01, P02) and the six P03 sites call it.
- `auditTaskUtils.ts` (P03) adds `SENSITIVE_LENS_IDS`, the typed list behind `SENSITIVE_LENSES`.
  The set stays `ReadonlySet<string>`, because custom lens names reach `requeue.ts` and
  `taskBuilder.ts`. `lineCounts.ts` (P03) adds `lineCountsFor`.
- `scope.ts` (P03) imports from the defining modules, because the `reviewPacketGraph.ts` barrel is
  deleted. The header comment of `src/shared/graph/graphPaths.ts` (P02) no longer names it.
- `tests/audit/continuity-score.test.ts` is now `tests/audit/review-packet-order.test.ts`. It
  keeps the ordering tests and drops the continuity-score cases.
- `merge_edge_kind_counts` is now always `{}`: one packet is one coherence component, so no merge
  edge can join two packets. `countMergeEdgeKinds`, `groups` and `planningGraphEdges` are deleted.
- The charter packet archive writes its index with `writeJsonFile`, so that write is now atomic.

Leads for later parts (not fixed, not verified as defects):

- **P07:** `merge_edge_kind_counts` in `src/audit/types/reviewPlanning.ts` has a constant value.
  Remove the field from the type and its readers.
- **P07:** four orchestrator files keep their own lens lists (`SENSITIVE_LENSES`, the two-lens
  high-risk-clean pair, the runtime follow-up order). A policy field on `LENS_METADATA` in
  `src/audit/types.ts` could derive them. It must encode today's sets and order exactly: the
  high-risk-clean pair is not `SENSITIVE_LENSES`, and the runtime order is not `LENS_ORDER`.
- **P07:** `workBlocks.ts` has an index signature and a private `stableStrings` (a `uniqueSorted`
  copy).
- **P05:** in deep mode, `conceptualDispatch` renders the shared structural context once per
  perspective, and the systemic revision renders it again. One render per step is enough.
- **P05 to P12:** other private `[...new Set(x)].sort(...)` copies can call `uniqueSorted`.
- **P03 (caller):** `planningExecutors.ts` and `ingestionExecutors.ts` each call
  `buildTaskAffinityGraph`, and then `buildAuditPlanMetrics` builds the same graph again through
  `buildReviewPacketPlanningData`. Pass the built graph down as a parameter.

P04 skips are in
[`simplify-deferred-items-2026-11-16.md`](simplify-deferred-items-2026-11-16.md), with what would
unblock each.

P04 coverage gap: the altitude reviewer did not read the `designReview*` files,
`intentCheckpointGate.ts`, `intentInterpreter.ts`, `intentScopeDisposition.ts`,
`intentEquivalenceExecutor.ts`, `systemicChallengeExecutor.ts`, `reviewPacketGraphContext.ts`,
`charterPacketArchive.ts`, `charterFidelityPacket.ts` and `charterExtractionExecutor.ts` in depth.
The other three angles covered them.

### From P05

P05 closed the P04 lead for `uniqueSorted` in `src/audit/cli/` (`lineIndex.ts`, `fanoutLanes.ts`,
`recoverSubmissionCommand.ts` and three sites in `dispatch/hostHandoff.ts` call it). It did not do
the other P04 lead (one render of the structural context per step in deep `conceptualDispatch`):
that needs a new optional parameter on the P04 prompt module, so it is in the deferred record.

P05 made no cross-part touch. Every changed file is under `src/audit/cli/`.
`describeZodIssues` (one `path: message` formatter, `(root)` for an empty path) is now exported
from `laneValidators.ts`, and `describeSubmissionFailure` in `nextStepHelpers.ts` calls it.

`ingestAuditHostResults` in `dispatch/hostHandoff.ts` no longer filters a "landed" set. The
filter compared the additions with the in-memory accepted set, and the scan already refuses a
result id in that set, so the filter always returned the additions. It was residue of the
second-hold merge (`cb8acfd5`): the read, judge and append now run under one hold of the ledger
lock.

Leads for later parts (not fixed, not verified as defects):

- **P01:** `src/shared/submission/hostResultOutcomes.ts` has comments about a work item that "a
  concurrent ingest accepted". Check that each one describes an earlier ingest, not a race inside
  one ingest, which the one hold (see above) excludes. Also check whether
  `duplicate_submission_id` with remedy `none` is the correct outcome for a re-used `result_id`.
- **P07 (validation):** `validateOneAuditResult` builds a new lookup `Map` on each call. A
  prepared validator per batch would build it once.
- **P11:** the `artifactsDirWrites` prose in `scripts/guard-reach-data.mjs` is stale.
- **Tests:** a comment in `tests/audit/semantic-review-step.test.ts` names behavior that the code
  no longer has.
- **P05 (correctness, not checked):** `fanoutLanes.ts` stores the unbound `body` in `writtenText`,
  but the comment near it says that the map mirrors the written file. Find which one is intended.

P05 skips are in
[`simplify-deferred-items-2026-11-16.md`](simplify-deferred-items-2026-11-16.md), with what would
unblock each. Some inline `console.log(JSON.stringify(...))` sites and one `audit_state.json`
literal stay, because no `// sites-pinned:` declaration covers those files.

P05 coverage: each of the 50 files was read in full by at least one reviewer.
`nextStepHelpers.ts` was read in full by both of its angles.

### From P06

No earlier part left a lead for P06.

P06 made one cross-part touch: `tests/audit/graph-edge-cache.test.ts`. Its `inv-2` test pins a
digest of every module in the import closure of `graph.ts`, so any text change there requires a
`GRAPH_EDGE_CACHE_KEY_VERSION` bump. The version is now `v16`, the digest is updated, and the
legacy-key case now uses `v15`. An edge cache written before this landing re-extracts once.

New shared helpers in `graphPathUtils.ts`: `stripSourceExtension` (the copies in `graphRoutes.ts`
and `graphTestSources.ts` are deleted), `compareGraphEdges`, and `edgeSignature`, which moved
there from `graph.ts` so that `analyzers/merge.ts` can use it without an import of `graph.ts`.
`graph.ts` re-exports `edgeSignature` for its one orchestrator importer.
`couplingEdgesFromPairWeights` in `dataStateCoupling.ts` is the one pair-weight-to-edge fold for
`dataStateCoupling.ts` and `commentDecomposition.ts`. The inert longest-first token sort in
`commentDecomposition.ts` is gone: both consumers test every token into a set, so no token order
can change a result.

Leads for later parts (not fixed, not verified as defects):

- **P03/P04 (loop-core):** `src/audit/orchestrator/edgeReasoning.ts` can import `edgeSignature`
  from `extractors/graphPathUtils.ts`. Then `graph.ts` can drop its re-export. The file is
  loop-core, so the change needs the review attestation.
- **P07 (decompose):** `extractors/docsDigest.ts` imports `isDocIntentFile` from
  `src/audit/decompose`. Check whether that predicate belongs with the extractor path predicates.
- **P06 (correctness, not checked):** the pair key `"<a> <b>"` is split at the first space in
  `couplingEdgesFromPairWeights`, so a path that contains a space splits into the wrong two paths.
  Also, `dfsVisit` in `graphSignals.ts` is recursive, so a very deep graph can overflow the stack.

P06 skips are in
[`simplify-deferred-items-2026-11-16.md`](simplify-deferred-items-2026-11-16.md), with what would
unblock each.

P06 coverage: each of the 50 reviewed files was read in full by all four reviewers.
`languageMap.generated.ts` is generated and was not reviewed.

### From P07

P07 checked the seven leads that earlier parts left for it:

- **Applied:** the `workBlocks.ts` index signature and its private `stableStrings` (P04) are gone;
  `uniqueSorted` replaces the private `[...new Set(x)].sort(...)` copies in P07 files that carry a
  `// sites-pinned:` declaration, three of them loop-core (`io/runSnapshot.ts`,
  `systemic/reviewFileMap.ts`, `systemic/secondOrderAdversaryPrompt.ts`).
- **Skipped, with the reason in the deferred record:** `access_memory.json` is written and never
  read (P01; retiring it is an owner decision); `merge_edge_kind_counts` is always `{}` (P04; the
  removal changes persisted bytes, and the writer is loop-core P03); one lens policy on
  `LENS_METADATA` (P04); the prepared validator (P05; its adopter is the loop-core
  `hostHandoff.ts`); the move of `isDocIntentFile` (P06; it touches the loop-core
  `charterPackets.ts`).
- **Not a P07 change:** the `HostInputPauseInputs` `Pick` (P03) has its type in P03 and its
  callers in loop-core P03/P05 files.

P07 made no cross-part touch. It deleted `io/runArtifactTypes.ts` (its one interface, `RunPaths`,
now lives in `io/runArtifacts.ts`, its only importer) and the unused `runSample` re-export in
`cli.ts`. No P07 change is in the import closure of `extractors/graph.ts`, so
`GRAPH_EDGE_CACHE_KEY_VERSION` stays `v16`.

Leads for later parts (not fixed, not verified as defects):

- **P10:** `src/shared/io/collectFilesSorted.ts` walks one directory at a time and runs a `stat`
  for every entry, also when the `Dirent` already says it is a file. That is most of the 4–7 s
  walk in `buildToolingManifest` (pinned by `tests/shared/collect-files-sorted.test.ts`). Also: a
  shared `getOrCreate` map helper (the same shape is in `reviewFileMap.ts`,
  `secondOrderAdversaryPrompt.ts` and twice in `scoreAudit.ts`), and one
  `sessionIntentPath(root)` for `supervisor/operatorHandoff.ts` and `cli/validateCommand.ts`.
- **P03/P05 (landed, loop-core):** `judgeBoundEntry` in `cli/dispatch/hostHandoff.ts` copies
  `activeTaskIds` and `[...auditTasks]` per entry; the index for the `coverage.ts` lookups belongs
  in `orchestrator/planning.ts`.
- **P04 (landed):** `LENS_ORDER` sorts `LENS_REGISTRY` again although it is already sorted, and
  the {security, data integrity} pair has no shared constant.
- **P05/P12:** the next-step command text in `cli/prompts.ts` and in
  `supervisor/operatorHandoff.ts` is built in two places; check whether they must agree.

P07 skips are in
[`simplify-deferred-items-2026-11-16.md`](simplify-deferred-items-2026-11-16.md), with what would
unblock each. Most code skips are in files with no `// sites-pinned:` declaration (the P05 rule).

P07 coverage: five reviewers (altitude, reuse, efficiency, simplification, and a gap reader).
Each of the 55 files was read in full by at least one reviewer, most of them from one angle only.
The gap reader read 15 files in full from all angles (`types.ts`, `conceptualAdjudication.ts`,
`reviewPlanning.ts`, the six `systemic/` files, `validation/artifacts.ts`,
`ingestIssueCodes.ts`, `operatorHandoff.ts`, `scoreAudit.ts`, and the two reporting prompts).

### From P08

P08 closed the P04 lead for `uniqueSorted` in `src/remediate/steps/` (`contractPipeline.ts`
`sourceDigests`, two lists in `dispatch/hostCorroboration.ts`, three returns in
`gateCommands.ts`). It also used the shared `errorMessage`, `countBy`, `contentSha256`,
`isRecord`, `stringArray` and `idsAreStrictlyAscending` where a file spelled out the same body.
The `countBy` site counts the closed item-status enum, so the P01 `constructor` caveat does not
apply.

Cross-part touches: two comments that named `KNOWN_SCHEMA_VERSIONS` in `intakeResolver.ts` as the
example of a duplicated version literal (`scripts/check-version-gates.mjs`,
`tests/shared/version-gate-scan.test.ts`). That Set now imports the three intake version
constants, so the comments describe the shape without naming it. Comment text only.

Moves inside P08: `randomRunId` is exported from `stepWriter.ts` (the blocked-step backstop and
`nextStep.ts` share it; the old copy in `stepWriter.ts` said an import would cycle, and it does
not). `RETIRED_DISPATCH_SHAPE_MESSAGE` is exported from `dispatch/hostContracts.ts` and replaces
four copies in `nextStep.ts` and `recoverIngest.ts`. The orphaned, stale docblock of
`RemediationRequiredTestVerdicts` moved from `dispatch/hostHandoff.ts` to the type in
`dispatch/requiredTests.ts`, with the `spawnSync` rationale corrected.

`prepareRemediationHostHandoff` no longer catches a `BlockContractError` from the workload build,
and its empty-workload branch no longer scans the plan a second time. The `planBlockIssues` scan
just before the build refuses every block the build can reach, so neither path could run.
`settledFindingIds` and `pendingItems` in the host ingest were residue of the time when a work
item held several findings: a work item id is unique in the workload, so the filter could never
skip an item.

Leads for later parts (not fixed, not verified as defects):

- **P09:** exact `error instanceof Error ? error.message : String(error)` sites that can call
  `errorMessage`: `contractPipeline/executionPlan.ts` (three), `runtimePlanAuthority.ts`,
  `index.ts`, `intake.ts`, `phases/close.ts` (three), `phases/grounding.ts`,
  `review/reviewGate.ts`, `validation/artifacts.ts` (three). Check each for the exact form first
  (the P03 and P06 rejections were other forms).
- **P09 (with a P08 site):** `contractPipeline/executionPlan.ts` and `dispatch/hostHandoff.ts`
  (P08, loop-core) build the `intent_checkpoint.json` path by hand; `intakePaths(...)
  .intentCheckpoint` owns it. The `owner-decision.json` and `risk-decisions.json` joins
  (`executionPlan.ts`, five in `steps/contractPipeline.ts`, one in `steps/nextStep.ts`, one test)
  belong as members of `executionPlanPaths`; `generate-runtime-artifact-names.mjs` reads
  `executionPlan.ts`, so check its output.
- **P09:** `phases/triageConformance.ts` has its own `hashContent(stableStringify(...))` digest
  (use `contentSha256`) and repeats the `conformance-review` path literals that
  `conformanceReviewPaths` owns. `executionPlan.ts` has two more `contentSha256` sites.
- **P09:** `intake.ts` can export a named `IntakePaths` type; `ReturnType<typeof intakePaths>` is
  spelled four times in `steps/prompts.ts`, four times in `steps/intakeResolver.ts`, and in tests.
- **P09:** `"clarification_resolution.json"` and `"triage_resolution.json"` are raw literals in
  `steps/submitGateResult.ts`, `phases/triage.ts` and the `z.enum` in
  `state/decisionConsumption.ts`, with no named constant.
- **P10:** `scripts/shared/loopCoreClosureData.mjs` declares `steps/intakeResolver.ts` as
  `claim: "reads-only"`, but the module writes `source-manifest.json`,
  `selected-audit-findings.json`, the current step and the brief. Check what the closure gate
  verifies, and correct the claim.
- **P01 (landed):** `errorMessage` is not in the `audit-tools/shared` barrel, so every remediate
  caller needs a deep import. `hasExactKeys` in `submission/hostHandoffCore.ts` sorts
  `[...expected]` again for each key; one sort per call is enough.
- **P05 (landed):** the audit twin `cli/dispatch/hostHandoff.ts` has three hand-rolled
  string-array checks (`stringArray`, as in P08), and the same "issue ids for the refusal read"
  projection as `recordAndEnrichHostIssues`; a helper in `src/shared/submission/` would serve both.
- **Any part:** the backticked id list `` .map((id) => `\`${id}\``).join(", ") `` is written 16
  times in six remediate and shared files. One shared helper gives the same bytes.

P08 skips are in
[`simplify-deferred-items-2026-11-16.md`](simplify-deferred-items-2026-11-16.md), with what would
unblock each. `stepUtils.ts` and `sessionConfigLoad.ts` have no `// sites-pinned:` declaration, so
they did not change (the P05 rule).

P08 coverage: four reviewers, one per file group (`nextStep.ts`; `dispatch/hostHandoff.ts`; the
other dispatch and gate files; the prompt and intake files). Each of the 21 files was read in full
by its reviewer from all four angles. An independent refuter checked the risky items before the
apply, and a second reviewer checked the applied diff.

### From P09

P09 closed the P08 leads for `errorMessage` (the exact form, at 13 sites in seven files), for
`intakePaths(...).intentCheckpoint` in `contractPipeline/executionPlan.ts`, and for the
`contentSha256` sites in `executionPlan.ts` and `phases/triageConformance.ts` (plus two in
`state/decisionConsumption.ts`). The `owner-decision.json` and `risk-decisions.json` joins in
`executionPlan.ts` are now the `ownerDecision` and `riskDecisions` members of
`executionPlanPaths`, and `readApprovedExecutionPlan` reads them there. The quoted `join(`
literals stay, so the output of `generate-runtime-artifact-names.mjs` did not change. P09 also
used the shared `uniqueSorted`, `normalizeRepoRelPath`, `toPosixPath`, `outputDirFor`,
`REMEDIATION_REPORT_FILENAME` and `REMEDIATION_OUTCOMES_FILENAME` where a file spelled out the
same body.

Moves inside P09: `admittedFailureOutput` is exported from `phases/closeVerifyLandingGates.ts`,
and the default test and e2e legs of `phases/close.ts` use it (the same tail-or-label body).
`close.ts` imports `archiveFrictionRecords` and `outputDirFor` statically; the old
`await import("audit-tools/shared")` loaded a module that the file already imports. In
`state/types.ts`, the host-handoff record schema is one `z.object` (the binding-fields object
and the explicit-scope alias each had one reader), and the 64-hex digest regex is the local
`Sha256Hex`. `RemediationStore` lost its unused `_correlationId` constructor parameter (no
caller passes a second argument). `phases/closeVerifyAnalyzerLeads.ts` no longer spreads the
persisted `analyzer_consent`: `loadAnalyzerPolicy` drops legacy consent, so the spread was
always empty.

Comment fixes: `state/itemStatus.ts` no longer says that a red final gate routes an item to
`abandoned` (a red final gate pauses the run and leaves the item statuses as they are).
The `applyIntentOrdering` doc in `intent/intentOrdering.ts` now says that only units are
reordered, and it states the tie-break. The stale `opencode.json` comment in `index.ts` is now
the named `DEFAULT_ARTIFACTS_DIR_OPTION`.

Leads for later parts (not fixed, not verified as defects):

- **P08 sites (landed), with the P09 helpers:** `steps/contractPipeline.ts` (five) and
  `steps/nextStep.ts` (one) still join `owner-decision.json` and `risk-decisions.json` by hand;
  `executionPlanPaths(...).ownerDecision` and `.riskDecisions` own those paths now.
  `dispatch/hostHandoff.ts` still builds the `intent_checkpoint.json` path. An exported
  `IntakePaths` type serves only the `steps/` sites, so P09 did not add it (see the deferred
  record).
- **P08 sites (landed):** `phases/triageConformance.ts` repeats the `conformance-review` path
  literals that `conformanceReviewPaths` in `steps/` owns. An `observation` member and a
  `conformanceSubjectsDir` export would serve both.
- **Any part (tested-but-unwired, for the manual knip audit):** `LOCK_TIMEOUT_MS`
  (`state/store.ts`), `validateFinding` and `validateExecutionUnit` (`validation/`) have no
  production reader; only tests import them.
- **P09 (correctness, not checked):** `readRunRecoveryFacts` (`phases/close.ts`) turns a read
  failure into "no facts"; the verify-doc result that `close.ts` reads has no producer in the
  tree; the e2e failure reason reuses the combined-suite text; the by-outcome sentence of the
  outcomes report omits two statuses; the preserve note omits `unresolvedRequest`.
- **P09 (correctness, not checked):** `state/store.ts` parses the plan twice, so one plan error
  can show two times; the `!inputSnapshot` check in `phases/triage.ts` cannot be reached; the
  `phases/grounding.ts` doc names a map that does not exist; a nested retired key in
  `review/reviewGate.ts` gives an empty reason; `closeVerifyLandingGates.ts` splits a command
  with `command.split(" ")` where `close.ts` uses `parseCommandString`;
  `review_filter_dispositions.json` is not in the generated runtime artifact names;
  `applyIntentOrdering` reorders units but not findings; `ingestExecutionPlan` reports
  `String(error)`; the `review-history` read can race its existence check.
- **Owner item:** `runValidateCommand` (`index.ts`) has `timeout: 3_600_000` with no measurement
  behind it (the owner rule on limits).

P09 skips are in
[`simplify-deferred-items-2026-11-16.md`](simplify-deferred-items-2026-11-16.md), with what would
unblock each. `phases/grounding.ts`, `review/autonomousGate.ts` (code), `riskSignal.ts` (code)
and `review/findingFilter.ts` have no `// sites-pinned:` declaration for those sites, so their
code did not change (the P05 rule).

P09 coverage: four reviewers, one per file group (`phases/close.ts` and `closeAcceptance.ts`;
the other `phases/` and `review/` files; the top-level, `contractPipeline/` and `intent/` files;
the `state/` and `validation/` files). Each of the 40 files was read in full by its reviewer from
all four angles. The lap checked each risky item against source before the apply, and a second
reviewer checked the applied diff.

### From P10

P10 checked the leads that earlier parts left for it:

- **The P08 lead on `loopCoreClosureData.mjs`:** the `intakeResolver.ts` row keeps
  `claim: "reads-only"`. The closure gate (`checkDeclaredClaims` in `loopCoreClosure.mjs`) reads
  only the module's own source for a direct filesystem verb, and it does not follow a helper.
  `intakeResolver.ts` writes only through `writeJsonFile`, `writeCurrentStep` and
  `writeRemediationBrief`, so the claim is true by the gate's rule; `mutates` would red the gate.
  The row's `reason` now names those writes. The data file's header and the claim comment in
  `loopCoreClosure.mjs` no longer say that a `reads-only` module "can observe, never change".
- **Private `[...new Set(x)].sort(...)` copies (P04 lead):** none in `scripts/shared/` uses a
  comparator. Several use the default `.sort()`, which is code-unit order for strings. A
  scripts-tree `uniqueSorted` twin is in the deferred record.
- **The three P07 leads labeled P10** (`collectFilesSorted`, a `getOrCreate` helper, one
  `sessionIntentPath`) name `src/` files of landed parts, not `scripts/shared/`. They are in the
  deferred record.

P10 made no cross-part touch. Every changed file is under `scripts/shared/`.
`triage-backlog.mjs` splits entries with `splitBacklogEntries` (its `chunk` was a copy), and
`resolveCodePaths` has one query and one result tail for both path forms. The handoff roadmap
generator lost the `groups` list that it built and discarded, and the `heading` field that only
that list read; `sectionText` and the Immediate-next reader share one section scan.
`lane-dispatch.mjs` has one `errText` and one `rawText`; `mcp-dispatch-lane.mjs` has one
`cancelJob` for its two cancel paths, and a `// sites-pinned:` declaration that binds those paths
to `tests/shared/triage-lane-health.test.ts`, the test that drives them.
`derived-file-preflight.mjs` lost `normPinPath`, a copy of `norm`. Comments in
`sessionRegistry.mjs` and `liveSessionWork.mjs` no longer name the retired friction Stop gate.

Leads for later parts (not fixed, not verified as defects):

- **P11/P12:** the "is this module the entry point" test is written out in about 30 scripts, with
  two spellings (`pathToFileURL` and `new URL(\`file://...\`)`); the two can differ for a Windows
  path. A shared helper in `scripts/shared/` would serve them.
- **P11:** the repo-root derivation `resolve(here, "../..")` is written in about 14 files.
- **P11:** `(error)?.message ?? error` and `error instanceof Error ? error.message : String(error)`
  are both used in `scripts/`; they differ for a non-`Error` throw. The `src` `errorMessage` cannot
  be imported there (the scripts tree is pre-build).
- **P12:** the `wrapper/` copies of `resolveSpawn` and `quoteForCmd` differ from
  `scripts/shared/spawn-shell.mjs` (caret escape, `%` refusal); they are not twins.
- **P10 (correctness, not checked):** `shardSuffix` (`vitestShard.mjs`) reads only the
  `--shard=N/M` form, so `--shard 1/4` gets no suffix; `readLoadFlakeRecord` hides a corrupt
  record behind an empty catch; `install-host-assets.mjs` prints "build the shared workspace
  first", but there is one package now; `conversion-assertion-parity.mjs` runs `git` at import
  and exits 0 on a divergence; `MUTATING_CALL` in `loopCoreClosure.mjs` also matches comments and
  strings; `resolveSpecifier` uses a `startsWith(root)` test that is not segment-accurate;
  `OUT = process.argv[2]` in `triage-backlog.mjs` is read at import time, so an importer's default
  `outPath` can be a test-runner argument.

P10 skips are in
[`simplify-deferred-items-2026-11-16.md`](simplify-deferred-items-2026-11-16.md), with what would
unblock each. Most code skips are in files, or regions of files, with no `// sites-pinned:`
declaration (the P05 rule).

P10 coverage: four reviewers, one per file group (the docs and backlog generators; the session,
lane, landing and host-asset files; the gate, generator and loop-core files; the test, suite and
release files). Each of the 64 hand-written `.mjs` files was read in full by its reviewer from
all four angles; the three `*.generated.mjs` files (their generators were reviewed) and the three
JSON files were not reviewed. The docs-and-backlog reviewer
wrote its findings from notes taken before a context compaction, so the lap checked each of its
items against the source again. The lap checked each applied item against source, and a second
reviewer checked the applied diff.

### From P11

Four reviewers read every line of the 60 hand-written scripts outside the shared directory at
`f1704b29` (17,210 lines). The partition table keeps the original counts. Three scripts had
since been removed. The reviewers covered installation and release (15), code gates (13),
backlog and document gates (18), and repository operations (14). The graph excludes scripts,
so the reviews used source. A separate reviewer checked the applied diff and the test pins.

- Eleven strict direct-entry checks use `isScriptEntry`. The conversion to a file URL and the
  undefined-argument test stay the same. Eleven module-directory expressions use Node’s
  `import.meta.dirname`, with the original path joins. The release script also dropped a
  one-use directory binding.
- The document and retirement gates share `excludedDocMatchers`. The memory gate shares
  the line-suffix parser, runtime directory prefixes, and batched Git ignore check with the
  other citation gates. Each backlog refusal has one formatter for its standalone and
  consolidated callers. Both file-budget refusals build their largest-entry list the same way.
- The postinstall scripts use one wildcard permission migration. The audit installer reads
  its package-root binding directly. The remediation smokes reuse the final-gate import and
  the existing npm command selector.
- The P05 reach note now describes the scoped field checked by both executor rows. P11 also
  removed an unreachable string fallback, an unused type comment and detached comments,
  and corrected two test citations. The six generated schemas and the auditor-contract
  fixture matched the bytes at the review base.
- The nightly probe filter checks that exactly one probe form is present. P11 removed a
  repeated condition on the same stored fields, a duplicate answer-CLI comment and obsolete
  closeout comment text. The nightly inbox, ledger and answer commands still have readers.
- The different entry checks and error conversions keep their contracts. The scripts-tree
  unique-sort and map-helper leads remain in the design queue. The earlier TypeScript-only
  leads stay with their owners. See the [deferred record](simplify-deferred-items-2026-11-16.md)
  for the skipped changes and what each needs.

**P12 leads.** Check the hook and wrapper entry predicates against the shared predicate one site
at a time. The wrapper permission helpers compare with a literal allow value. Check that
contract against the installer's injected value before sharing code. The philosophy hook and
generator use the same prefix for the opening marker and the same complete closing marker.
The wrapper spawn helpers and the next-step command text still have the P10 and P05 leads above.

**Correctness leads (not checked).** A URL-special character in the checkout path may affect the
raw-file-URL guard in the guard-reach path generator. Its normal npm command did run the check.
The executor extraction table still holds a rule with no selecting site. The smoke scripts have
leads for a missing built module, an unchecked npm initialization, a fixed pause bound, and
repeated next-step checks on an already advanced root. The link gate has a broad filename
suffix guard, the comment scanner walks the AST recursively, the routing gate exposes a raw
JSON parse error, and importing the memory CLI can run its scan. The nightly answer command reads raw arguments for the
settlement disposition, and the producer writes queue artifacts before the projection rewrites
them. Both leads need separate verification.

### From P12

The four source reviews cover all 38 tracked paths selected by the partition rule at
`54b807b4` (10,655 lines). They cover nine installer modules, ten Git and commit-hook
files, eight session and tool hooks, and eleven runtime and configuration files. The Git
group checked the generated loop-core matcher against its generator. All four Git launcher
scripts are included. A second reviewer checked the runtime and configuration group.
The table retains its original partition counts.

- The audit installer takes its prompt filename from its renderer. Five wrapper modules use
  Node's file-module directory. The audit wrapper reads Node's executable at the spawn site.
  Its only child-process caller inherits stdio and discards the result, so the unused output
  buffers are gone. Root discovery resolves the starting path once in the climb helper.
- The core ESLint rule and its TypeScript counterpart get the same unused-variable options
  from one definition. Each gets its own array and options object.
- The independent review caught a change to the remediation CLI's stderr on a missing root.
  The CLI prints the error stack. Moving a helper changed both its filename and the caller
  locations. P12 kept the installer, OpenCode and Markdown writer paths that expose those
  locations. A comparison at the same checkout path reproduced the difference and verified
  the restored stderr bytes.
- The philosophy hook and README generator read the same marked text. Each keeps its own
  action for missing markers or an empty body. The commit gate uses the record reader's stale
  verdict and one scan for loop-core paths. The attester keeps the SHA of its first capture
  for the suite check. The push gate stops at the first failed source check.
- The closeout hook uses the upstream sentence directly and skips sorting for a length-only
  key. The tool hooks reuse the containment verdict, statement list and restore tokens.
  Comments now identify which Git hook runs the checks and which machine registry supplies
  the lanes.

**Earlier leads.** The remediation entry guard compares both real paths and handles missing
paths. The audit entry runs directly. The hooks that turn paths into file URLs use them for
imports. None needs the strict script-entry helper. The wrapper and script quoting contracts
remain separate. The supervisor suggests the installed command with the artifact directory.
The prompt builder also selects the invocation and passes the repository root. Merging these
would change command bytes. The prebuild sort helper and earlier TypeScript-only leads keep
their existing entries in the [deferred record](simplify-deferred-items-2026-11-16.md).

**Correctness leads (not checked).** The remediator normalizes its source prompt on install
and compares with the raw prompt on verification. The installer help describes home-directory
writes. The closeout hook may produce a second finding for an unreadable render record. The
tree snapshot restore has open questions about a failed path listing and journal retention
after a failed restore. The attester's summary and the branch-strand refusal may describe a
different path set or branch workflow from the one that ran.

The runtime review also flagged the audit binary writer's production reach, the Windows
build command under a custom shell, lock-release events after a close or unlink error, and
the two CLIs' different error displays. The audit wrapper's flag-span assumption and the
handling of `--help=x` also remain unchecked.

P12 closes the sweep. The combined release is on hold.
