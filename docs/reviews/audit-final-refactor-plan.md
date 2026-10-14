# Final mechanical refactor plan: audit-tools

<!-- review-routing: backlog-bugs -->

Date: 2026-10-14. Baseline: `OhOkThisIsFine/audit-tools@e64e0cd1574e953b4a43c6804528567ff415ba33`, package 0.55.6.

## Decision and scope

Implement the eleven ordered landing units below. Correct filesystem authority and analyzer false negatives first, then resource/identity defects, then three bounded ownership simplifications. Each unit replaces its old mechanism atomically, with its tests, and must be green before commit. Do not parallel-edit overlapping modules. No provider inventory, quota manager, model routing, new orchestration framework, or revival of the discarded October 5 dogfood run. The host continues to execute semantic work.

This is an implementation-ready plan, not a claim that implementation, local CI, installation, shipping, or a live analyzer run has occurred. The clean source checkout remains read-only. Copy this plan into the implementation repository as `docs/reviews/audit-final-refactor-plan.md`, register it in the document manifest if its existing pattern does not cover it, and commit it after the normal gates. Do not commit scratch fixtures, synthetic outputs, or environment paths.

### Independent consolidation evidence

I read all six fresh reviews, then checked the actual pinned code independently. Local HEAD and clean status match the pin; the GitHub commit API independently confirmed the same SHA and its explicit discard of the historical dogfood run. Source checkout is shallow: an empty retirement-history search here is not evidence of complete history. The implementer must run the repository design-check retirement search in its full-history authorized checkout. No conflicting retirement was found in the current standing instructions or relevant backlog text.

I reran the synthetic fixtures against the pinned code:

- Snapshot cleanup deleted only the probe's disposable unrelated canary directory using a tampered copy record; returned no problem.
- Traversal, absolute outside path, and an outside-target symlink each passed citation and finding grounding. A symlinked artifact directory redirected a workload write.
- Remediation selected only `plain.ts`; Git-quoted Unicode, quote and newline filenames were lost. Audit's NUL reader preserved all four.
- Three shared files with the same two conflicting findings produced three full-scope tasks. A repeat round produced zero, so this is exact same-round duplication, not an infinite loop.
- Two concurrent cold misses produced four fake HTTP requests; a warm verified cache produced none. Missing/unmatched checksums still caused payload requests. An expired deadline still began a fake fetch.
- A rejected 64 MiB extractor input allocated about 64 MiB of array buffers despite a 512 KiB cap. A 10,000-file packet token-sizing fixture performed 50,005,000 owner-membership calls.
- An additional consolidator fixture extracted the unchanged `parseCsvLine` and `parseLizard` bodies: one headerless over-threshold row produced zero leads instead of three; two rows produced three instead of six. The same fixture called actual resolveBinary with a fake successful Gitleaks 8.18.4 probe against the 8.21.2 pin and reproduced an accepted PATH result.

The consolidation fixtures use temporary synthetic files, injected network/process seams, and in some cases exact extracted bodies/Node type stripping. They are reproductions, not the package build or Vitest gate. Convert them into repository-native regression tests; do not copy experimental loaders or borrowed dependency paths into production tests.

Primary external contracts were independently checked: [pipx CLI](https://pipx.pypa.io/stable/reference/cli.html), pinned [Lizard argument/file-selection source](https://github.com/terryyin/lizard/blob/bb8aa4d200a2935b07e6d2bf1e6072b449bc5ae3/lizard.py), pinned [Lizard CSV printer](https://github.com/terryyin/lizard/blob/bb8aa4d200a2935b07e6d2bf1e6072b449bc5ae3/lizard_ext/csvoutput.py), and [Node cancellation API](https://nodejs.org/api/globals.html#static-method-abortsignaltimeoutdelay). pipx requires an app operand after its package spec. Lizard appends repeated language arguments and prints the CSV header only in verbose mode. Some upstream line anchors in the service review are offset; use the pinned functions, not those line numbers.

## Consolidated disposition

- SEC-01, SEC-02, SEC-03: accepted reachable local-state/path authority defects. No remote exploit or wholesale secret exfiltration is claimed.
- SVC-01/02/03: accepted together as one integration repair; fixing only the launcher leaves two independent silent-coverage bugs.
- SVC-04 and Q4: one deadline defect, one implementation owner.
- Q2/Q3 and SVC-05: accepted in the same binary acquisition landing unit as that deadline repair, to avoid competing edits and incompatible seams.
- EFF-1: accepted resource-bound bug. EFF-2: accepted output-preserving linear lookup simplification; no promised whole-audit speedup.
- Abstraction 1: accepted dirty-path bug with explicit fail-closed handling and old-run policy below. Abstraction 2/3: accepted shared ownership fixes.
- Q1: accepted exact conflict-membership deduplication. Retain legacy-compatible deterministic IDs; no wholesale live-plan migration.
- CX-1: accepted existing gate-contract consolidation. CX-2: deferred from this implementation: sharing source observations across additional mutation/apply paths needs a separate frozen-source invalidation proof. It is redundant IO, not a demonstrated wrong result, and is not necessary for the accepted gate or line-measurement extractions.
- SEC-04: confirmed exported-API defect, deferred from this CLI-focused implementation. No in-tree production caller exists. The fake executable reproduction proves basename admission is unsafe; merely rejecting slashes would not establish a trusted PATH/config boundary, and project-loading analyzers/Git configuration make a general read-only sandbox promise unsound. Keep this explicitly open for a dedicated API retirement/trust-contract decision; do not market this release as closing all security findings. Do not wire this runner into production.
- npm publish-cache hardening: optional defense in depth, deferred; no compromised cache was demonstrated. OSV `scan --format json` is not a defect. Do not remove result revalidation, independent review roles, checksum verification, either audit cycle guard, or scope/index freshness checks.

## Ordered nonoverlapping landing units

### 0. Commit the reviewed plan and establish baseline

Commit only the finalized plan/document routing after setup and baseline gates below. The pre-implementation design-check applies to the accepted shared contracts and loop-core units. Have a fresh independent reviewer refute the plan using pinned recon, standing decisions, and retirement evidence; resolve reproduced concerns before coding. A green plan commit must not pretend all future regression tests have already passed. Follow the mandated Chat-first coding route chosen by the parent task.

### 1. `fix(snapshot): derive cleanup and recovery authority from trusted context`

Files: `src/audit/io/runSnapshot.ts`, all its cleanup/completion callers including `src/audit/cli/cleanup.ts` and `nextStepHelpers.ts`, snapshot/frozen-source tests.

- Introduce one private `resolveSnapshotIdentity(root, artifactsDir)` returning canonical live root, canonical artifact identity, existing `snapshotKey`, owned state-root/key directory, tree directory, expected ref, and Git top-level/prefix when applicable. Preserve the existing hash algorithm and location. Resolve trusted root/CLI artifact configuration, never record fields, to derive authority.
- Add `validateRunSnapshot(record, identity)` and use it before reuse, recovery, or destructive operations. `removeRunSnapshot` takes trusted root as well as artifactsDir. Do not merely validate cleanup: `restoreSnapshot`/`addEmptyWorktree` can also remove directories.
- `repository_root` must equal trusted real root. Copy records require zero pins and `source_root === ownedTree`. Git records require first pin at ownedTree, repository equal independently resolved Git top-level, and source_root equal ownedTree plus trusted top-level prefix. This explicitly supports auditing a nested root.
- Each later pin must be a unique, strict descendant checkout corresponding to a recursively initialized live submodule discovered from trusted Git indexes. Independently derive its live repository directory and compare physical paths; record-supplied repository names never choose where Git runs. Missing/unverifiable live submodule identity causes safe refusal, not guessed cleanup.
- Every ref equals exactly `refs/audit-tools/snapshots/<key>`. Base/index/commit must be full valid object IDs (base may be null), and recovery verifies expected object types. Ref deletion uses `git update-ref -d <expectedRef> <expectedCommit>`; a changed ref is preserved and reported. Absent refs/absent owned checkout can be idempotent success only after identity validation.
- Validate all pins before any side effect. Require nonsymlink owned directory/ancestors below the admitted physical state root, checking `snapshots` and key parents even when tree is missing. Never derive the recursive delete target via dirname(record fields). Delete only the deterministic key directory; unlink links within it without following them. State-root override is trusted configuration, not a record field.
- On validation mismatch: return a diagnostic, retain the record and all purported targets. Normal completion may still present the report, but cannot conceal leftover scratch. Existing `cleanup --force` may remove the admitted artifact record/tree and warn about orphaned scratch; it must never make untrusted snapshot targets eligible for deletion. No automatic quarantine move outside admitted storage or permissive recovery fallback.

Tests: forged copy root, first/submodule pin, foreign repository, sibling run, arbitrary ref, changed ref value, missing tree, symlinked state child/key, nested audit root, normal copy/Git/unborn/submodule recovery and cleanup, repeated cleanup. Canary files and unrelated refs/worktree registrations remain unchanged. Failure in one pin prevents all destructive work. Pin the cleanup caller behavior with and without force.

Migration: v1 records remain supported only if deterministically verified. Invalid records are refused unchanged. Rollback: retain authority checks or disable automatic snapshot deletion/recovery; never restore record-directed deletion as a compatibility fallback.

### 2. `fix(grounding): contain source reads before opening evidence`

Files: new small `src/shared/io/sourcePath.ts`, `citationGrounding.ts`, `findingGrounding.ts`, their direct tests and audit/remediation grounding integration tests.

- Share `resolveContainedSourcePath(root, candidate): string | undefined`. First lexical containment, then realpath containment against real root, then require a regular file. Check both the file and parent target. No content read occurs for rejected paths. Permit in-root absolute paths and internal symlinks; reject outside links/traversal, foreign drive/UNC absolute spellings on the wrong platform, directories and broken links. Use platform path primitives; do not lowercase source filenames or invent separator changes for actual POSIX backslash filenames.
- `resolveCitedPath` applies that resolver to direct paths and every basename fallback. Escaping input cannot be rehabilitated by basename fallback. Preserve unique/ambiguous basename policy and existing delivered-evidence checks. Returned relative citation identity is rooted, not a raw outside absolute input.
- `groundFinding` performs admission before its injected content reader, clears old location claims as today, and reports an unreadable/ungrounded miss on rejection. Keep its existing any-valid-location finding aggregation; no added content-based finding policy.
- Synchronous path admission is acceptable for the synchronous citation checker; no global cache. This guards pre-existing filesystem topology. It is not a defense against a same-user concurrent symlink swap; document that residual instead of calling realpath race-proof.

Tests: both public entrypoints, all reproduced outside spellings, parent symlink, valid internal symlink, in-root absolute, missing file, ambiguous basename, case variants, platform-native drive/UNC cases. Spy readers must prove zero content reads on rejection. Keep existing quote/line/delivered-evidence verdicts on valid content.

Migration: no schema change; previously incorrectly grounded outside evidence becomes ungrounded on normal revalidation. Never rewrite prior accepted evidence silently. Revert only as a whole; if a regression requires disabling grounding, preserve outside-path refusal.

### 3. `fix(artifacts): admit physical storage before managed IO`

Files: new small `src/shared/io/artifactPath.ts`, artifact-root CLI admission for both bins, shared handoff/submission IO, audit artifact hold/writers/cleanup, remediation state/writers, related tests. Do not change the pure lexical `resolveWithinRoot` contract or generic source-file writes.

Chosen policy: managed artifact directories may contain no directory symlinks/junctions, even links whose targets are internal. A trusted root supplied by the user may itself be reached through a canonicalized ancestor; descendants below that admitted root must be real directories. A final-file symlink is replaced by atomic rename, never followed for writing. Reads of artifact state/submissions also reject final-file symlinks.

- `admitArtifactStorage(root, artifactsDir, explicitOverride)` returns canonical trusted storage context. Only CLI/config admission can set explicitOverride, never an artifact. Default storage is under real repo root and checks every existing segment from root through `.audit-tools` and tool directory before mkdir or lock creation. Explicit `--artifacts-dir` continues to support existing external-storage uses by admitting that explicitly selected physical directory; this does not widen host handoff's existing repository-relative path contract.
- `assertArtifactPath(context, path, operation)` checks lexical containment and every existing parent with lstat before read/write/mkdir/rename/delete. Recheck after creating missing parents and immediately before IO. For rename validate both endpoints; for deletion unlink leaf links rather than recurse through them. Failed admission has no artifact write, lock creation, deletion, or external canary change.
- Thread this explicit context through artifact hold, core artifact persistence, promotion/rollover/cleanup, remediation state store, both host handoffs, expected submissions/staging/quarantine/lane assets, and shared step emission. The context authorizes the artifact subtree plus the existing specifically named promoted report/diagnostic destinations in outputDirFor(artifactsDir); it does not authorize arbitrary sibling writes. Check the physical parent of those promoted destinations too, and preserve their current names. Use plain helper calls at those IO boundaries, not a process-global list of admitted roots or a new generic filesystem framework. Context is required at managed mutating entrypoints; do not add an optional guard that callers can silently omit.
- `resolveHostHandoffPaths` admits physical parents using its trusted repo root, including existing run/result directories; guard exact destinations again at actual IO. A pure resolve followed by generic write is not the final security boundary.
- Add a source/call-site contract test covering those artifact mutating entrypoints plus direct exported handoff use; do not rely only on a CLI preflight. Preserve generic `writeJsonFile` behavior for unrelated callers and final-file atomic-replacement semantics.

Tests: link at `.audit-tools`, tool dir, run dir, result dir, intermediate newly used child; internal link also refused; Windows junction suite; missing children created normally; default repo symlink spelling; explicit physical external artifact root; rejected external host handoff as today; final-file link replaced on atomic writes without changing target; staging rename and force cleanup do not escape. Both bins' normal fixture workflows must pass.

Migration: intentional symlink-based storage now yields a diagnostic directing the user to the existing explicit artifact-directory option where supported, or to a real local artifact directory for repository-relative handoff. Do not invent a new persistent trust-setting UI. Rollback must keep physical rejection or disable affected IO.

### 4. `fix(analyzers): honor pipx and pinned Lizard contracts`

Files: `src/shared/analyzers/{acquisitionEngine,candidates}.ts`, acquisition/candidate tests, provenance fixture.

- Generalize existing candidate `bin` documentation and require a nonempty bin for pipx candidates. Registry sets `bin: "semgrep"` and `bin: "lizard"`. Missing pipx bin is an explicit candidate-resolution failure before spawn, never a guessed distribution name. `runnerPrefix` emits `["pipx","run","--spec",spec,bin]`; preserve npx/cargo/bundle behavior and per-run consent.
- Lizard argv uses repeated `-l language` pairs in current detected order, then `--csv`, root. JS/TS exclusion stays unchanged.
- `parseLizard` parses from row zero, skipping only the recognized pinned verbose header field sequence (case-insensitive known captions for existing artificial fixtures is acceptable; arbitrary first text is not a header). Empty output is clean; malformed sole row increments dropped_rows and is parse degradation. Preserve thresholds/IDs/severity. Do not add optional source-line enrichment in this commit.

Tests: full argv through real registered candidates and `runExternalAnalyzer`, consent declined/granted controls, differing package/bin fixture, mixed Python/Rust and C/C++, single language, JS-only. Pinned headerless one-row fixture yields three leads; two rows six; real header+rows works; header-only clean; malformed sole row degrades. A pre-provisioned offline pipx/Lizard contract lane must exercise the real parser without downloading at test time. If binaries are absent, the hermetic unit gate can pass but the upstream smoke remains explicitly not run, not silently counted as verified integration.

Migration: no persisted schema. Fresh acquisition recovers missed leads; do not relabel historical clean results as valid. Rollback withdraws pipx/Lizard coverage rather than silently accepting empty scans.

### 5. `fix(acquisition): enforce pinned identity and bounded single-flight downloads`

Files: `binaryAcquisition.ts`, `acquisitionEngine.ts`, candidate BinarySpecs, production `acquisitionExecutor.ts`, `nextStepCommand.ts`/`nextStepHelpers.ts` deadline handoff, binary/acquisition tests. This one atomic unit owns SVC-04/05 and Q2/3/4; no competing partial fetch-seam commits.

Deadline contract:
- `ExternalAcquisitionAdvanceOptions.deadline?: SpawnDeadline`. At the production next-step invocation boundary compute one absolute deadline from its existing `params.timeoutMs`/`getTimeoutMs(argv)` budget (default 30 minutes), and carry it in externalAcquisition through the fold and executor. Pass the same value through resolveBinaryCandidates and runAcquisitionEngine; never restart the clock per tool. Preserve each subprocess's existing 120-second cap. Direct enabled executor callers without a budget get a finite fallback equal to admitted candidate count times the existing tracked-child cap, computed once; a standalone single-binary resolver gets the single tracked-child cap. Do not impose a new 120-second aggregate cap on an entire multi-tool production acquisition.
- Standalone resolveBinary without a caller budget also gets that existing bounded default. Expired entry starts zero probe/network/extraction operations. Every later operation checks remaining time. Remaining candidates receive explicit unavailable deadline status; none appear clean.
- `BinaryFetcher(url, {signal}): Promise<Uint8Array|null>`. The production adapter passes signal to global fetch and keeps it live through body consumption; do not swallow abort as null. A resolver-owned AbortController/timer covers each remaining wait and is cleaned in finally. Reject and observe a non-cooperating injected promise on expiry as well, but production correctness requires actual fetch/body cancellation, not merely Promise.race. New reason `deadline_exceeded` maps to visible not-resolved coverage. No automatic retries.

Version contract:
- Each of the four BinarySpecs provides `parseVersion(stdout, stderr): string|null`, with pinned upstream output fixtures for gitleaks, osv-scanner, hadolint and actionlint. Normalize only the documented optional v prefix, not fuzzy ranges/substrings.
- Resolve an absolute PATH executable once, using platform PATH/PATHEXT rules through the existing execution substrate; probe and return that exact executable. Permit it only on zero status and exact parsed version match. Empty/malformed/mismatching output falls through to verified cache/download. Keep explanatory mismatch text if acquisition ultimately fails. Intentional toolchain-resolved ecosystem candidates are unchanged.

Cache/request contract:
- Fetch checksum first, validate expected digest for asset, then fetch payload. Null/empty checksum returns download_empty; nonempty malformed/unmatched manifest returns no_checksum_for_asset; both start no payload, extraction or cache publication. Preserve SHA-256-before-execution.
- New cache identity includes binaryName, version, platform, arch and selected asset identity. Manifest records these plus the existing executable digest and a relative executable path. Use a v2 identity-keyed directory. Do not trust legacy name/version-only cache entries lacking platform/asset provenance; leave them untouched and reacquire once. No cache garbage collector in this change.
- On miss acquire existing `withFileLock` using a per-full-identity lock under the private cache root, with wait bounded by remaining deadline. Recheck cache under lock. Invalid published cache is purged only while holding this lock.
- Download/extract/write manifest in an exclusively created sibling staging directory on the same filesystem. Verify executable containment and regular-file status, digest, identity and executable setup before an atomic directory rename to the final identity directory. Never extract in the published directory. Readers see only verified completed output. Remove only this invocation's staging on failure. Reclaim dead locks through existing fileLock ownership/heartbeat behavior; do not add a second stale-lock algorithm.
- Fast warm hits retain digest verification and zero network. PATH success creates no cache directory. Concurrent cold same-key callers share one checksum+payload acquisition; different keys proceed independently. No unbounded model or network scheduler.

Tests: exact/mismatch/malformed versions (including old Gitleaks never receiving `dir`); PATH resolved once; expired entry, hanging headers/body, budget exhausted between checksum/payload and resolution/engine; no timer/listener leak; null/malformed/unmatched checksum one request; valid two; mismatch fails closed; two real worker processes cold cache exactly two fetches total; independent keys; crash mid-staging; corrupt final cache; old identity cache ignored; partial dirs never cache hits; platform/arch separation; warm zero fetch. Fake process/network tests remain hermetic. Preserve current admission and exactly-one status per candidate.

Migration: cache v2 cold reacquisition and new explicit timeout reason; no audit/result schema rewrite. Release notes disclose exact PATH pins and the bounded acquisition budget. Rollback code/interface/manifest consumers together, retain checksum verification, and treat v2 directories as unavailable rather than interpreting them under an older format.

### 6. `fix(extractors): enforce byte cap during file reads`

File: `src/audit/extractors/readFileText.ts`, direct reader/docs/decomposition tests.

`defaultReadFileText` opens one handle; reject invalid nonfinite/negative limits with undefined; floor finite limits. Same-handle stat may reject oversize early. Otherwise request/read no more than cap+1 bytes total in bounded chunks, honoring short reads; cap zero probes one byte. At EOF accept only length <= cap and decode with existing Buffer UTF-8 semantics. Return undefined on oversize/error, never truncated text; close in finally. Avoid cap-sized up-front allocations for enormous valid limits: use fixed small chunks. Preserve injected caller readers.

Tests: empty/exact/minus/plus-one sizes, chunk-boundary multibyte text, missing/read error, short reads, growth after stat, invalid limit, finally-close. Deterministic requested-byte bound <= floor(cap)+1; no flaky RSS threshold. Through docs/decomposition, rejected content contributes no evidence and valid fixture outputs remain identical. No migration; single revert restores the known resource defect and must say so.

### 7. `fix(git): use one lossless dirty-path protocol`

Files: `src/shared/git.ts`, remediation state/plan-join/attribution/closing consumers, dirty-path and closing tests.

- Add private `readDirtyPathsAgainst(root, ref)` returning `{ok:true,paths:string[]}` or `{ok:false,reason:string}`. Own the two bounded NUL-delimited Git queries, `--no-renames`, lossless split and insertion-order union. Never trim/unquote/fold filenames. Catch thrown spawn and either query failure explicitly.
- `dirtyPathsAgainst` adapter retains audit exclusions/sorting/prior stamp behavior. `stagedAndUntracked` uses the shared reader against HEAD, returns raw ordered paths on success, and throws a named discovery error on failure. This intentionally tightens remediation's former partial/empty failure fallback: baseline capture, gate attribution and closing must stop before staging/commit, with a useful error; a failed scan cannot claim a clean tree.
- Add `run_start_dirty_encoding: "git-z/v1"` only when a NEW baseline is captured, in the same state write as the paths. Never recapture on replan. Central baseline admission rejects an existing unmarked baseline at every attribution/closing authority consumer (close, gateCommands, hostCorroboration, hostHandoff); ordinary terminal report viewing remains possible. Existing already-in-progress states with no trustworthy pre-edit baseline are also refused before attribution. Explain that a fresh authorized run is required; do not guess-decode Git display strings or reinterpret current dirt as history.
- Keep this marker optional in read schemas for diagnostic access, required by the runtime authority guard. Do not bump the entire state contract solely to prevent report reading. New empty baselines also carry the marker.
- Preserve the existing close selector's case-fold fallback, sensitive-path exclusions and original output spelling. Whitespace-normalizing manifest matching remains a separate limitation; no claim that this commit makes every exotic filename safe for every downstream command.

Tests: real tracked/untracked Unicode/quote/newline/space paths, rename both endpoints, audit own-state exclusions/prior stamp, each query failure and thrown spawn, actual collectStagingFiles on the four-name fixture, user/run dirt separation, marker persisted once, replan unchanged, every authority consumer refuses legacy baseline before mutations, terminal viewing preserved. No silent state migration. Rollback preserves marked baselines/work; never close affected sessions with the lossy old code.

### 8. `fix(deepening): coalesce identical conflict memberships`

Files: `selectiveDeepening/conflict.ts` and its index caller; frontier/deepening and handoff tests.

Keep existing qualifying-bucket policy. After qualification, group buckets only when sorted member tuples are exactly identical: result task/unit/pass/lens identity, finding id/category and stable serialized finding content, plus the member's scope paths. Deduplicate repeated identical member entries. Do not merge overlapping memberships, different findings, lenses or roles. Order contexts canonically before first-context metadata/line-source selection.

Emit one task per equal-membership class, with union of all original conflict keys/scope/source references. Its ID uses the existing `taskIdFor("conflict", ...)` with the lexicographically smallest original conflict key and existing sorted source task/finding IDs. This deliberately preserves one of the old IDs rather than inventing a second durable task-identity scheme. Rationale names all conflict keys; source tags retain current format. No cap or coverage truncation.

Migration is explicitly conservative: existing task objects, accepted records, prompt hashes and pending redundant tasks are not removed or relabeled. Existing-ID dedupe recognizes the canonical legacy-compatible member. Fresh generation emits only one; resumed old runs finish their old tasks. Changed source task/finding IDs generate a new obligation as before; same-ID content replacement continues through existing staleness rules, not a new ad hoc migration. Do not claim same-ID content renewal is solved here.

Tests: three-file fixture one task and one handoff item; permutation stable ID and complete task; distinct/overlapping memberships separate; existing canonical old ID no additional task; all three old tasks preserved unchanged; repeat round zero; changed task/finding IDs distinct; one-file thresholds and line-count precedence retained. Revert generator/caller together; durable task artifacts are left intact.

### 9. `refactor(git): single-source recursive tracked-path reads`

Files: new `src/shared/gitTrackedPaths.ts`, disposition evaluateTrackedFiles, grounding enumerateTrackedFilePaths, scopeIndexBaseline probeScopeIndexKey, shared exports/tests.

`readRecursiveTrackedPaths(root, options?)` returns raw NUL-decoded paths on success, structured failure otherwise. Own exactly `git ls-files -z --recurse-submodules`, existing tracked-child deadline, and one 256 MiB capture limit. This deliberately raises grounding's prior 64 MiB bound to match both other consumers. Retain an injected asynchronous runner seam, adapting disposition's existing GitSpawn without introducing synchronous subprocesses.

Domain adapters retain their policies: disposition failure diagnostics/root/high-share guards; grounding separator normalization and empty corpus on failure; scope null-on-failure, candidate intersection, normalization, sorting and identical hash bytes. Empty successful corpus remains distinguishable from failure in the core. No global cache, no change to ScopeIndexMemo lifetime, no extra enumeration in a fold.

Tests: real nested/populated/uninitialized submodule corpus across all three consumers; scope key reacts to a submodule index-only change on next fold; empty success vs failure; ENOENT/nonzero/throw/timeout/overflow; NUL unusual paths; old adapter output and hash equality. Remove duplicate command bodies and stale atomic-pair comments in the same commit. No persisted migration; revert all three adapters/core atomically.

### 10. `refactor(packets): index first file owners once`

Files: `reviewPackets.ts`, `reviewPacketSizing.ts`, packet/sizing tests.

After canonicalTasks in buildPacket, build one call-local readonly map from raw path to first task, never replacing an existing entry. Reuse for line-count materialization and fileGroupContentTokens; replace that internal helper's task-array parameter with the map. File collection may share traversal, but preserve path sort, canonical task order, first-owner semantics (including missing/zero counts), positive-byte precedence, fallback rounding, full serialized packet/ID/rationale and iterable multiplicity. Do not change estimateTaskGroupTokens or packet grouping.

Tests: deep-equal whole packets for shuffled/overlapping/empty fixtures, first owner missing a count versus later owner present, zero, no-owner fallback, missing/zero/positive bytes. Operation-count assertion proves O(total memberships + unique paths) owner work with no per-path tasks.find/includes. No timing assertion, cache, durable format or migration. Atomic signature/caller revert.

### 11. `refactor(gates): share existing outcome and measurement policies`

Two independent private extractions may be reviewed together, but no caching change:

A. In `nextStepHelpers.ts`, private adapter from omittable handler to `AuditObligationDef["execute"]` replaces exactly eight repeated registry bodies. `return` emits its host result with original engine bundle; `continue` transitions on returned bundle; `run_omit` dispatches exactly once. Exhaustively handle the discriminant. Convert intent-equivalence's duplicated lifecycle to `runOmittableGate` with the same schema/lane/forced executor/verdict and `intentEquivalenceOmits`. Reuse charterComparisonOmits/charterFidelityOmits. Keep registry PRIORITY/order/assertions, charter extraction's custom inner lane sequencing, graph enrichment and analyzer consent separate.

B. In `lineIndex.ts`, private `measureLinePaths(root, preparedPaths)` owns batches of 25, per-path diagnostic, NaN unmeasured sentinel, aggregate count, and Object.fromEntries order. Manifest adapter passes original ordered/multiplicity-preserving sequence; path adapter alone dedupes/sorts. Keep addFileLineCountHints' persisted coercion separate. Do not share a memo across new apply/mutation paths (CX-2 remains deferred).

Tests A: all three outcomes with bundle identity; intent malformed JSON/schema/valid/no-submission deterministic/no-submission semantic/throw; omission executes once; staging/quarantine/ledger/refusal/fold commit-on-throw unchanged; charter ordering, registry sync and transaction suites. Tests B: duplicate/shuffled paths, 0/26/60 files, CRLF/no-final-newline, missing and other IO errors; instrument actual peak concurrency <=25 (the old result-cardinality test is insufficient). No schema/migration. Atomic removal of duplicate bodies; revert as one unit if policy equivalence fails.

## Setup, gates, commit, landing and release

Use the selected authorized Chat-first implementation executor. Do not mutate the review checkout or its .git. A linked worktree would mutate its Git administration; prefer an independent clone there, or the executor's proper repository checkout. Verify the pin before branching; if remote main has advanced, inspect/rebase explicitly and revalidate affected findings rather than pretending the pinned plan describes new code unchanged.

Replace the three path placeholders with separately verified, task-owned paths before using this recipe. The following is the supported POSIX isolated source-install recipe; on Windows use a disposable environment with an isolated user profile rather than assuming HOME overrides homedir. It deliberately runs the normal postinstall into disposable host directories:

```sh
src=/path/to/verified-full-history-source
work=/path/to/task-owned/audit-tools-implementation
isolate=/path/to/task-owned/audit-tools-install-sandbox
mkdir -p "$isolate/home" "$isolate/config" "$isolate/cache" "$isolate/npm-prefix"
git clone --no-hardlinks "$src" "$work"
cd "$work"
git switch -c refactor/oct14-verified e64e0cd1574e953b4a43c6804528567ff415ba33
export HOME="$isolate/home" XDG_CONFIG_HOME="$isolate/config" XDG_CACHE_HOME="$isolate/cache"
export npm_config_cache="$isolate/npm-cache" npm_config_prefix="$isolate/npm-prefix"
export CODEX_HOME="$HOME/.codex" CLAUDE_CONFIG_DIR="$HOME/.claude"
export AUDIT_CODE_STATE_DIR="$isolate/audit-state"
export AUDIT_TOOLS_BINARY_CACHE="$isolate/binaries" AUDIT_TOOLS_ANALYZER_CACHE="$isolate/analyzers"
export AUDIT_TOOLS_REPO_VISIBILITY=public
node -p 'require("node:os").homedir()'
node --version
npm --version
npm install --prefer-offline --no-audit --no-fund
```

Run this only in the implementation environment, not as a workaround for a denied network/install action. Ensure the homedir output is the disposable directory before npm. Install may require registry access not available in the review runtime; report a verified connection failure and move only through the authorized environment route. Do not disable lifecycle scripts and call that a successful normal install. The lockfile-backed CI equivalent is `npm ci --prefer-offline --no-audit --no-fund`; choose it for the repeatable CI job. Postinstall builds dist and installs both host assets. Review any install-generated .gitignore/lockfile changes; keep unrelated changes out of commits. No npm global deployment into the user's profile is authorized by this isolation recipe. Resolve the real GitHub remote separately before landing: an independent local clone's origin points at the review checkout and must never be used as the publication target.

Baseline, then every final implementation tree:

```sh
npm run build
npm run check
npm run check:tests
npm run check:scripts
npm test
npm run verify:checks
npm run verify:release
```

The user requested local CI. A focused pass is not sufficient. `verify:release` overlaps preceding checks intentionally; it is the aggregate evidence. Keep full logs and structured gate summaries. Never pipe a running suite through head/tail; never run two suites or rebuild dist while a suite is running in the same checkout. Use the repository gate for focused evidence after fresh build:

```sh
node scripts/shared/run-vitest-gate.mjs <affected-test-paths>
```

Tests must fail against the actual pinned implementation before the fix and pass afterward; run narrow reverted-mutation checks where needed. Do not commit a red regression-only intermediate state. No real-network analyzer fetch in the unit suite. Preserve normal generated-schema/host-asset/citation/guard checks; if touched APIs require regeneration, use their existing generators and include their output in the same atomic unit.

For the plan and each code commit:

1. Inspect/stage only intended files. Ensure document manifest, guard reach and pinned sites are current.
2. Fresh independent review for changed loop-core/shared authority surfaces; do not self-attest as an independent reviewer. Record actual identity/outcome against the exact staged tree using the existing attestation tool.
3. Run `npm run build && npm run check`, focused gate and `npm run staged:legs`; allow tracked pre-commit hooks to run. Never use no-verify. Commit conventional message only after green.
4. Before landing, rerun full local CI on the exact integrated tree and verify the suite stamp via `node scripts/shared/suite-green-status.mjs`.
5. For authorized publication use `npm run land`, never direct push to main. It requires clean tree, a current full-suite stamp and required checks on exact HEAD; observe its result. Do not invent a substitute merge flow to bypass branch protection.

Release commands, only when the parent confirms release/deployment is in authorized scope: reread `.claude/skills/ship/SKILL.md`, then `npm run release:patch:publish`. The script owns bump/landing/tag/release/CI/npm propagation/global reinstall and both bin smokes. The ordinary fix set is patch-sized; if public API or durable contract scope expands beyond this plan, reevaluate versioning before invoking it. Do not hand-create tags, manually re-dispatch publishing, silently reinstall the user's global tools, or treat GitHub push as a published npm release. The installer environment/target used for final reinstall must be explicitly the authorized target, not accidentally the temporary plan-validation HOME. Verify the resulting npm version, exact release CI, and both binary versions. Preserve the release journal on interruption and use its supported resume path.

## Completion and rollback contract

Completion requires plan committed after gates, all accepted units implemented and independently reviewed, local aggregate green on the final tree, required remote checks green if landed, and an explicit report of any upstream smoke not run. If publication is authorized, also verify release/npm/bin outcomes. Carry deferred SEC-04/CX-2/publish hardening honestly; do not represent them as fixed. A fresh real audit is separate from deterministic regression validation and must be independently authorized; the October 5 run stays discarded.

Do not rewrite user work, old findings, prompt-bound accepted evidence or historical baselines. Roll back a failed unit atomically with its interface/tests; for safety fixes use fail-closed disablement rather than restoring unsafe authority. Preserve valid generated reports and abandoned scratch for explicit recovery. No automatic deletion of legacy caches, malicious-record targets, or obsolete live tasks is needed to ship this plan.
