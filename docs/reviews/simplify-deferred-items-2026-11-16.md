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
- **P03:** one `laneGate({lane, pendingReason, omits?, boundaryReason})` constructor for six rows
  of `POLICY_CLASSIFIERS` in `src/audit/orchestrator/obligationPolicy.ts` (intent equivalence,
  charter comparison, charter fidelity, charter clarification, systemic challenge, critical-flow
  fallback). Gain: one shape instead of six copies. Blocker: two reviewers disagreed on whether
  the check order and the error text stay the same. **Unblock:** a row-by-row comparison of
  the branch order, then a test that pins each row's branches.
- **P03:** derive `SLICE_PARTICIPANT_PRODUCERS` in `src/audit/orchestrator/advance.ts` from
  `EXECUTOR_REGISTRY[].produces`. Gain: a hand-kept map goes. Blocker: the map is declared on
  purpose, and the derived value adds `file_disposition` as a producer of `repo_manifest.json`
  (one executor owns both), which moves that artifact's upstream index from 0 to 1.
  **Unblock:** confirm `findPriorityOrderingViolations` and its tests accept the extra producer.

## 3. Design changes (larger than a cleanup; worth a lap of their own)

- **P03 — a PRIORITY-keyed derivation table for `deriveAuditState`** in
  `src/audit/orchestrator/state.ts`. About twelve rows have the same
  `obligation(id, staleOrSatisfied(stale, [artifact], has(bundle.x)))` shape. The open property
  (an id that `deriveAuditState` does not emit reads as satisfied in `deriveObligationState`) is
  now held by `tests/audit/obligation-emission-covers-priority.test.ts`, which found and closed
  the one gap (`audit_tasks_completed` on a bundle with no task plan). What remains is the shape
  gain: a `Record<PriorityId, Derivation>` with `PRIORITY` declared `as const` makes a missing
  row a type error for every bundle, not only for the bundles that test builds.
- **P03 — flags on `LIFECYCLE_PRODUCTIONS`** in `src/audit/orchestrator/executors.ts`
  (restamped every advance, host-appended, optional probe). Today the same artifacts are named in
  three places: that list, the always-updated list in `advance.ts` (which holds a
  `"tooling_manifest.json"` literal), and `HOST_APPENDED_ARTIFACTS` plus a `tooling_manifest.json`
  branch in `staleness.ts`.
- **P03 — a `source_read_only` field on `ExecutorDefinition`** instead of the separate
  `SOURCE_READ_ONLY_EXECUTORS` set in `executorRunners.ts`. A typo there fails safe (it only
  invalidates a cache), so the gain is one list fewer.
- **P01 — `classifyRead` delegation, a private `runGit` wrapper, an artifact-freshness policy
  table.** Small gain; part of it is loop-core.
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

## 5. Low value (do it only when you are already in the file)

- **P03 — `hasPackageJsonEslintConfig`** in `syntaxResolutionExecutor.ts` could call
  `readPackageJson` from `intakeExecutors.ts`. That needs `readPackageJson` exported and an
  `eslintConfig?: unknown` field on its shape. Edge cases checked: identical for a missing file,
  bad JSON, `null`, an array and a primitive.
- **P03 — the keyed dedupe loop in `syntaxResolutionExecutor.ts`** could use a `dedupeBy` helper.
  `requeueCommand.ts` has a private one; a shared home would be needed first.

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
