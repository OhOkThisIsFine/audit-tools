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
- **P05 — one render per step of the design-review file map and input revision**, and of the
  structural context in deep `conceptualDispatch` (the P04 lead). Each needs a new optional
  parameter on the P04 prompt modules.
- **P05 — a prepared validator for `validateOneAuditResult`** (P07 validation; see the P05
  leads in the partition record).
- **P01 — public barrel narrowing** (unused exported types, `lensOutcome`): an owner decision on
  the public surface of `audit-tools/shared`.

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
