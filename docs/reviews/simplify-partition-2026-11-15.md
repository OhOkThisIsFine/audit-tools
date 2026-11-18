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
| P08 remediate steps | `src/remediate/steps/**` | 21 | 10,858 | 527 | open |
| P09 remediate other | the rest of `src/remediate/**` | 40 | 11,197 | 66 | open |
| P10 scripts shared | `scripts/shared/**` | 69 | 14,406 | 269 | open |
| P11 scripts other | the rest of `scripts/**` | 63 | 18,357 | 82 | open |
| P12 wrapper, hooks, entries, root config | `wrapper/**`, `.claude/hooks/**`, `.githooks/**`, `audit-code.mjs`, `remediate-code.mjs`, `eslint.config.js`, `vitest.config.ts`, `.dependency-cruiser.cjs` | 34 | 10,747 | 113 | open |

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
