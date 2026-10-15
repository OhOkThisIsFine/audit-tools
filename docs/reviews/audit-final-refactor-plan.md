# Final mechanical refactor plan: audit-tools, 2026-10-15

<!-- review-routing: backlog-bugs -->

## Decision

Ship three bounded priority units: lossless and failure-aware `--since` discovery; actual release-commit ancestry and same-SHA qualification; and elimination of unusable commit-status polling. Follow with three independently revertible, behavior-preserving simplifications if their equivalence gates pass: manifest-relative target construction, packet graph-context indexing, and remediation priority ownership. These secondary units are not release blockers and must not delay a necessary correctness repair.

The public runner finding remains confirmed but **deferred for an explicit public compatibility/trust-contract decision**. Do not silently disable the public API, remove exports, introduce a new runtime trust framework, or present basename-only tightening as a complete repair. The prior plan already recorded this exposure as SEC-04. Its current reach is conditional library consumption, not a demonstrated audit/remediate CLI ingestion exploit.

This document is a plan only. No source edits, installation, full test suite, desktop work, live provider calls, landing, or publication were performed in consolidation. Implementation/publication authorization belongs to the parent task; it does not authorize a fresh live audit or user-global installation by this document.

## Baseline and independent validation

Repository: `OhOkThisIsFine/audit-tools`. Main commit: `a4cf53d94024cd3d5a133f7d96f9429dd96ce701`. Tree: `eeaae3d2054553853a3e3d1e43434e6940c756b9`. Package version: `0.55.7`.

I read all six reports (`architecture.md`, `efficiency.md`, `abstractions.md`, `services.md`, `security.md`, `quotas.md`), the standing repository instructions and previous finalized plan, and independently traced the named functions, production consumers, tests and publish workflow. I independently recomputed Git blob hashes for every materialized manifest entry: **1,552 matched; zero mismatches; zero missing manifest entries**. The separate omitted set contains historical tracked `.audit-tools` output; it is not behavioral qualification evidence. This source materialization is not a full-history executable checkout. Perform retirement/history checks in the eventual authorized full-history checkout.

PR42's merged repairs and PR43's version bump are baseline, not work to repeat. Reported historical CI/Windows outcomes are not tests rerun here. Reviewer probes establish their specific synthetic cases, not a production patch or whole-application performance. No assertion of npm publication/global installation follows from package.json alone.

Verified source chains:

- `src/shared/git.ts::changedFiles` uses `gitLines` and newline-trimmed `diff --name-only`; `src/audit/orchestrator/scope.ts::resolveAuditScope` passes it into `computeAuditScope`; unmatched seeds can retain previous complete coverage through `applyScopeToCoverage`. `readGitPathList` already provides bounded NUL parsing with structured failures.
- `src/shared/tooling/allowlistedExec.ts::isAllowedAnchorCommand` admits directory-stripped basenames; `runAllowlistedReadOnlyCommand` executes the original argv. `isAllowedGitCommand` is a denylist, including an attached `-c` gap. Searches found definitions/re-exports and tests, no in-tree production invocation. The module's historical ingestion comments overstate current reach.
- `.github/workflows/publish-package.yml` checks release `target_commitish` metadata before separately checking out the event ref. Gate/test/publish do not consume one explicitly resolved, verified commit output.
- `scripts/shared/landThroughPullRequest.mjs::evaluateRequiredChecks` never uses statuses for non-null app IDs, but the polling loop always requests `/status`.
- The three secondary-unit duplication/scan claims also match current source; none establishes a wrong current output.

## Invariants and exclusions

Snapshot cleanup/recovery authority and managed artifact-write safety units remain **excluded and on hold**. No edits to their behavior, authority, cleanup, storage layout, locks, or migration. Do not revive the withdrawn hidden-artifact upload lead or add blanket `include-hidden-files`.

Preserve current source containment, consent/admission, independent result revalidation, dirty-baseline authority and encoding, exact executable/version checks in analyzer acquisition, checksum-first verification, deadlines/cancellation, cache identity and lock ownership. Preserve audit's one-core-commit transaction and remediation's separate phase-locked store semantics. No provider/model inventories, routing, quota manager, persisted cross-run caches, obligation-granularity redesign, or universal path normalization.

## 0. Establish the implementation baseline

Use only the parent's selected authorized implementation environment. Keep this review source immutable. Verify exact source SHA and real remote; if main advanced, inspect the delta and revalidate each affected finding before applying this plan. Install normally in a task-owned isolated checkout/profile; follow repository instructions and keep postinstall out of the user's live profile. Do not borrow stale dist or disable lifecycle hooks and claim a qualified normal install.

Commit the plan through the normal document manifest/routing gates. Run the existing design-check with full-history retirement evidence before shared-contract, workflow authority or loop-core changes. Obtain fresh independent review of those changes; do not self-attest. Do not copy environment paths or synthetic probe outputs into production code.

## 1. `fix(scope): preserve Git delta paths and discovery failures`

Priority: P2 correctness. Owner files: `src/shared/git.ts`, `src/shared/index.ts` for the additive structured-helper export, `src/audit/orchestrator/scope.ts`; `tests/shared/git.test.ts`, existing Git discovery seam tests, `tests/audit/scope.test.ts`.

### Exact replacement

1. Add `readChangedFiles(root, since)` in `src/shared/git.ts`, returning the existing `GitPathListResult` shape `{ok:true, paths:string[]} | {ok:false, reason:string}` by delegating to `readGitPathList(root, ["diff", "--name-only", "-z", since, "--"])`. Add its function re-export alongside the existing Git helpers in `src/shared/index.ts`; no new result model is needed. Keep the current 64 MiB capture bound, tracked-child deadline, complete-output/error checks and exact NUL parser. Preserve exported `changedFiles(root, since): Promise<string[]>` as a thin compatibility adapter: call the structured helper once and return `result.paths` on success or `[]` on failure. This retains the supported array return shape and legacy empty-on-failed-discovery convention while correcting successful path transport. Document that this compatibility API cannot distinguish clean from unknown; it must not establish audit scope or clean-tree authority. Do not change `gitLines` globally; commit-ID/remote consumers have different contracts.
2. Keep the existing ref/repository preflight. Replace the `changedFiles` import/use in `resolveAuditScope` with `readChangedFiles` and await it once; on failure return `fullAuditScope(input.budget, diagnostic)` before `computeAuditScope`. The diagnostic must state that the delta could not be established and a full audit is used, retaining a bounded useful reason. On success pass `result.paths` unchanged. A failed diff after valid ref preflight is never a successful empty delta.
3. Keep source/manifest graph-key normalization unchanged. This fixes quoted transport, not every whitespace/backslash graph-identity collision. Preserve committed/staged/unstaged comparison against `since`, Git rename/post-image semantics, deleted-file filtering by manifest admission, and exclusion of purely untracked files. Do not add `--no-renames` or an untracked query by analogy with dirty-baseline capture.
4. Update direct tests, helper/compatibility comments including `gitRefExists`'s distinction between the two APIs, generated declarations and release notes together. Preserve existing imports and the `Promise<string[]>` signature of `changedFiles`; the structured helper is additive. Do not route scope back through the compatibility adapter or claim that its empty array establishes success. No avoidable public return-type migration or release-version decision is required for this repair; normal release policy still applies. No persisted scope/schema migration.

### Required evidence

- Actual temporary Git repository: ordinary, Unicode, quote and newline paths under default quotePath and quotePath=false. Exact path equality from discovery; raw leading/trailing-space cases characterize transport separately from downstream graph identity. Windows must execute Unicode coverage; POSIX-only names must be labeled capability-specific rather than counted as Windows qualification.
- Through `resolveAuditScope` and `applyScopeToCoverage`, matching Unicode/quote/newline manifest entries become seeds and retain fresh pending coverage despite previous complete records. Include ordinary paths, clean delta, deleted files, rename targets, staged/unstaged changes, and untracked-only controls.
- Inject nonzero exit, returned spawn error, thrown runner, timeout, overflow, empty interior field and unterminated NUL. Every unknown result produces full scope with a diagnostic, never delta with zero seeds; no partial paths escape. Empty complete output remains `{ok:true,paths:[]}` and a valid empty delta.
- Add compatibility tests and a compile-time signature assertion: existing `changedFiles` callers still receive `string[]`, ordinary/Unicode successful results are exact, and failed discovery retains the documented empty-array fallback. Separately test `readChangedFiles` success/failure discrimination and assert the production scope path imports/uses that helper, never the compatibility wrapper. The new helper intentionally converts thrown transport failures into structured failure through the existing discovery substrate; no promise is made to preserve undocumented thrown-error behavior of the legacy wrapper.
- Regression tests for transport and scope failure must fail against the baseline and pass after repair. Existing dirty-baseline, tracked-corpus and scope-expansion tests must remain green.

Rollback: revert interface/caller/tests atomically only in an unshipped branch; for shipped safety rollback retain full-scope fallback or disable delta mode rather than restoring silent omissions. Existing potentially incomplete delta reports are not retroactively validated; a fresh run requires normal authorization.

## 2. `fix(release): qualify and publish one verified on-main commit`

Priority: P2 release-policy integrity; prerequisite to the next live release. Files: `.github/workflows/publish-package.yml`, a narrowly scoped `scripts/shared/verify-release-source.mjs` helper if needed for executable testability, new `tests/audit/publish-source-contract.test.ts`, and affected `release-ci-gate.test.ts` / `release-contract.test.ts` assertions. Leave local `evaluateReleaseBranch` semantics alone.

### Exact policy and flow

Use **ancestor-of-current-default-branch**, not tip equality: older releases already on main remain permitted after main advances. A release creator's metadata is not proof of ancestry. This does not establish unauthorized fork publish access or wrongdoing in 0.55.7.

1. Add one read-only source-validation job before gate/test/publish. It checks out the event's immutable `github.sha` with full history, not a floating branch or tag; resolves it with `rev-parse --verify <sha>^{commit}`; fetches the repository's trusted default branch into an explicit remote-tracking ref; and verifies live release ancestry via `git merge-base --is-ancestor <resolvedCommit> <fetchedDefaultCommit>`. Require valid full object IDs. Fetch failure, missing object, shallow/incomplete history and nonzero ancestry are refusal, never assumed success.
2. For release events, independently resolve the exact event release-tag ref to a commit and require equality to the captured event commit. Accept annotated and lightweight tags via peeling. A moved/mismatched/unresolvable tag fails instead of switching the code under qualification. Do not rely on `target_commitish` even when it spells the default branch. Validate branch/tag ref spelling before constructing refspecs; use quoted environment variables or argv arrays, never expression-interpolated shell source. Avoid option interpretation of user-derived ref names.
3. Preserve current live manual-dispatch rule: its branch name must be the default branch; also verify its captured commit is an ancestor of the fetched default branch. Preserve off-default `workflow_dispatch` with `dry_run=true`, but still resolve/capture one commit and use it throughout. Dry-run may not acquire an actual upload path.
4. Emit the resolved full commit as the validation job output. Gate, every test shard, and publish depend on validation and checkout exactly that output. Update publish dependencies without dropping any gate or shard. No later checkout of the mutable tag/branch may replace the verified commit. Gate/test build and publish packing operate on that same SHA.
5. Before any install/build in the OIDC-capable publish job, independently confirm `HEAD` equals the validated output and repeat the live ancestry check against a freshly fetched default branch. Fail if rewritten default history no longer contains the commit. Keep read-only contents permission and give OIDC permission only to publish; do not introduce a third-party service or persistent credential.
6. If a helper is added, it owns the exact resolver/ancestry algorithm and has a side-effect-free import plus injected Git command seam. The workflow invokes it and the tests exercise it; do not maintain a separate policy implementation merely for tests. Only source admission changes: retain pinned Actions, install/build, package validation, dist-tag selection, bounded publication retries, propagation reporting and artifact paths.

### Required evidence

- Disposable Git graph: main ancestor, main tip, older main commit after advancement, divergent existing tag with misleading target_commitish=main, annotated/lightweight tags, moved tag mismatch, absent tag, fetch failure and shallow-history uncertainty. Non-main live manual dispatch refuses; dry-run off-main is allowed but cannot upload.
- Workflow structural/parsed tests prove one resolved SHA flows to all checkouts, publish needs every qualifying job, no install precedes its source recheck, no event strings are directly interpolated into shell code in the changed gate, and no permissive `|| true` hides ancestry/fetch failure.
- Negative mutations: replace ancestry with metadata comparison, checkout a floating tag in one shard/publish, omit a dependency, or permit unresolved history. Tests must fail. Keep all release-script import tests side-effect-free; no registry, tag creation or real release required.

Rollback: preserve the source gate or disable live publishing; do not restore metadata-only authorization. A workflow revert cannot unpublish npm artifacts. This unit changes no registry credentials or external trusted-publisher configuration and does not assert those settings were inspected.

## 3. `perf(land): skip unusable app-pinned commit statuses`

Priority: small confirmed request reduction. Files: `scripts/shared/landThroughPullRequest.mjs`, `tests/shared/land-through-pull-request.test.ts`.

After the existing branch-protection response is normalized through `requiredStatusChecks`, compute `needsCommitStatuses = required.some(check => check.appId === null)`. Keep every check-run query. Only call the existing `/commits/${sha}/status` poller when needed; otherwise pass `[]` into unchanged `evaluateRequiredChecks`. Preserve protected-branch failure refusal, exact SHA, app identity matching, latest rerun precedence, pending/red/green decisions, backoff and fast-forward logic. Empty requirements naturally skip statuses under this predicate; do not separately bypass check-run polling or broaden this into a no-check landing redesign.

Tests: all-app-pinned green/red/pending/missing/wrong-app with `/status` seam throwing if invoked and zero status requests; mixed and legacy-null requirements still query status and preserve fallback; a matching check run does not eliminate legacy fallback requests across later polls. Fake-clock 30-minute always-pending fixture retains 361 check-run observations and zero forward pushes while removing 361 status invocations (722 to 361 polling calls under negligible fake latency). Preserve retry/error behavior for needed endpoints, protection failure and latest-run/exact-SHA tests. Counts are local command/API invocations, not billing or measured account quota.

Rollback: one atomic script/test revert; no state or migration. This unit may ship independently of secondary refactors.

## 4. `refactor(graph): own manifest-relative target construction`

Priority: low, behavior-preserving. Add audit-local `resolveManifestRelativeTarget(fromPath: string, specifier: string): string | undefined` in `src/audit/extractors/graphPathUtils.ts`. Replace only identical prefixes in `graphManifestEdges/packageJson.ts::resolvePackageEntrypoint`, `typescript.ts::resolveTypescriptProjectReference`, `go.ts::resolveGoWorkspaceModuleReference`, and `maven.ts::resolveMavenModuleReference`.

Helper algorithm: normalize specifier once with existing `normalizeGraphPath`; reject zero-length normalized value, leading `/`, or `/^[a-z][a-z0-9+.-]*:/i`; compute `posix.dirname(normalizeGraphPath(fromPath))`; return the normalized specifier for `.` base, otherwise `posix.join(base, specifier)`. No IO, lowercase, trim, lookup, extension probing or new traversal rejection. Empty raw input currently normalizes to `.`; preserve it.

Callers retain all target probes, original-case returned map values, edge types/confidence/reasons/order/multiplicity. Package uses `resolveCandidate`; TypeScript keeps config-kind validation and tsconfig fallback; Go keeps direct go.mod-kind then go.mod fallback without extension/index probing; Maven keeps extra normalized `..` escape rejection and pom.xml fallback plus self-edge exclusion. Do not migrate different `resolveSpecifier`/`resolveReferenceLiteral` policies or manifest string-array parsing.

Tests in `tests/audit/graph-path-utils.test.ts` and `graph-manifest-edges.test.ts`: root/nested manifests, bare/dot/parent targets, empty/dot, slash/backslash/trailing slash/whitespace, URI and absolute/drive/UNC spellings, unresolved and mixed-case values; direct/fallback collisions and wrong-kind direct hits, sibling references, Maven escape/self-edge rejection, repeated specifiers. Compare full edges through every public extractor, including package script edges. Baseline equivalence plus mutations of guard/base/probe order must distinguish failures; no invented baseline functional defect. Roll back helper and all four callers together, no durable migration.

## 5. `perf(packets): index graph context per planning call`

Priority: optional efficiency, not demonstrated production latency. Files: `src/audit/orchestrator/reviewPacketGraphContext.ts`, `reviewPackets.ts`; `tests/audit/review-packets.test.ts` and focused graph-context/metrics tests.

Add a call-local index owner in the graph-context module. Build once in `planningDataFromProjection` immediately after `collectGraphEdges`; pass through `materializeProjectedPacket`/`buildPacket`. Keep existing direct graph-context/buildPacket seam via a one-call adapter to the same indexed core, never a second classifier. Index each original edge ordinal under each distinct normalized endpoint and valid route occurrences under normalized handler. Keep original edge/route references and original ordinals; normalize with current graph spelling only.

For a packet, gather incident ordinals using its deduped normalized file set, dedupe ordinals, sort numerically to original order, then perform the existing concrete-edge classification. Equal-valued distinct source edges remain distinct; self-edges count once. Gather routes once per normalized handler while preserving duplicate source occurrences and final lexical output order. Preserve raw emitted spellings, comparator-equal stable ties (reason is not a comparator key), boundary counts versus unique files, heuristic exclusion, confidence, connected-file counts and repeated filePaths semantics. Leave full `graphEdges` and `planningGraphEdges` arrays in planning data; no change to affinity, partitioning, IDs, task membership, sizing, coherence or metrics semantics.

Tests: full serialized packets and metrics equal baseline for empty/single/repeated paths, aliases, internal/boundary/neither/self/parallel/duplicate edges, overlapping packets, malformed/duplicate/absent routes, heuristic edges, and comparator ties with distinct reasons. Deterministic sparse 500-packet fixture proves one index build and 500 selected edge/route occurrences instead of 250,000 each; no wall-clock threshold. Complexity is O(E+R+F+sum(S_p log S_p)+Q), excluding retained-output sorting, with O(E+R) index storage. Do not claim linearity or end-to-end speedup; overlap can reduce benefit.

Defer optional top-eight insertion optimization this lap: index selection is independently useful and avoids combining another ordering-sensitive algorithm change. Retain full stable internal-edge sort for now. Roll back index/core/adapter changes together if any serialization differs; no persisted cache or migration.

## 6. `refactor(remediate): derive priority from ordered obligations`

Priority: low and last, requires loop-core independent review. Files: `src/remediate/steps/nextStep.ts`, `tests/remediate/obligation-priority-coverage.test.ts`, affected cited-site/guard declarations only through normal generators.

Remove production `PRE_INTAKE_PRIORITY` and `MAIN_PRIORITY` duplicates. At each current `advance` site build its definitions once into a local array; pass that same array as obligations and `.map(def => def.id)` as priority. Build main definitions only after the existing between-fold `store.loadState`. Keep all derive/execute bodies, shared engine contract and two advances unchanged.

Exact regression order:

- Pre-intake: input_conflict, confirm_resume, confirm_intent, interpret_intent, complete_redelivery, complete, pending_intake.
- Main: operator_plan_only, waiting_for_clarification, waiting_for_triage, planning_documentable, deferred_clarification, implementing, triage, planning_zero, all_terminal, closing, unhandled.

Replace mirror-consistency tests with independently written exact expected-order and uniqueness assertions. Behavioral fixtures exercise actual engine selection when multiple obligations are actionable, input conflict over resume/intent, plan-only over implementation, deferred clarification's eligibility over triage/close, planning-zero over all-terminal, and unhandled last. Preserve nonmutating builder construction, pre-intake emit/stop no-fallthrough, exactly one countStep per applicable host call and the persisted-state reload. Test a pre-intake transition that writes a newer state without returning it and assert main sees the persisted value.

Run priority, outcomes-contract, resume-gates, lifecycle, deferred-clarification, phase-mutex, dirty-baseline authority and shared engine suites. Mutation checks swap precedence, duplicate an ID, skip reload or permit stopped-fold fallthrough. No new stateSignature (prior reverted regression), engine cap, fold merger, state migration or phase granularity. Rollback is the atomic constants/builders/call-sites/tests unit; never alter historical state/artifacts.

## Deferred and no-change register

1. **Public runner / prior SEC-04 / current SEC-1: confirmed, deferred compatibility decision.** Both path-basename authority and attached Git `-c`/external-command admission remain open. Simply refusing slashes leaves PATH and tool/repository configuration trust unresolved. Disabling the runner, changing exported types, requiring a trusted runtime map, or narrowing supported tools/flags materially changes public behavior. Do none silently in this lap. A separate explicit decision must choose retirement or a fully reviewed executable/config/argument trust contract with zero-spawn refusal tests; preserve no production wiring and make no read-only sandbox guarantee meanwhile. Do not claim this release closes all security findings.
2. **Runner-capability memoization (Q2): defer.** Small conditional subprocess reduction, no end-to-end measurement; executable/environment freshness is not established. Keep per-candidate safety/admission/deadline and status handling.
3. **Binary response byte cap (Q3): defer contract work.** Absence of a cap is confirmed, but legitimate per-asset/checksum budgets have not been established. Do not choose arbitrary limits or reopen excluded artifact/cleanup units. Future bounded streaming must preserve cancellation and digest/publication invariants.
4. **npm publish cache hardening: remains optional/deferred.** No compromised cache demonstrated; do not mix cache changes into ancestry correctness. External OIDC account configuration was not inspected.
5. **CX-2 source observation sharing: defer.** No new frozen-source invalidation proof. The packet index is immutable and synchronous-call-local, not permission for a broader memo.
6. **Top-eight edge selection: defer separately.** Sketch probe evidence exists, but preserve full stable sort during index migration for a smaller equivalence surface.
7. **Closed PR42 work: do not repeat.** UTF-8 capture, NUL dirty baselines and legacy authority refusal, tracked-corpus substrate, containment, bounded extractor reader, pipx operand, Lizard language/CSV, binary admission/deadline/PATH/cache-lock/checksum-first, conflict membership coalescing, packet first-owner map, omittable gate lifecycle and line measurement are present.
8. **Rejected generalizations:** no universal path normalizer, catch-all IO error policy, shared dirty-query bodies with different index/worktree semantics, all-pairs affinity redesign, deque for eleven-element output tails, provider subsystem, or collapsing independent audit/remediation verification.
9. **Withdrawn artifact lead:** no established missing-ledger defect. Exact visible-basename upload paths under hidden parents require actual glob evidence; no blanket hidden-file inclusion.
10. **Held snapshot/artifact authority work stays held.** Prior plan describing those units does not mean they landed or are newly authorized.

## Qualification, landing and completion

Landing order: baseline/plan; delta correctness; release source gate; status-query reduction; then manifest extraction, packet index and remediation order. Units 1–3 are the immediate bounded repair set; 4–6 are independent equivalence work. Do not parallel-edit shared files or package generated output. Any failing secondary unit may be omitted with an explicit deferred status; it cannot weaken the first three.

In the authorized implementation checkout: normal install first, then baseline and final `npm run build`, `npm run check`, `npm run check:tests`, `npm run check:scripts`, `npm test`, `npm run verify:checks`, `npm run verify:release`. Use `node scripts/shared/run-vitest-gate.mjs <affected-tests>` after fresh build for focused evidence. Do not pipe running suites through head/tail, run overlapping suites, rebuild dist during a suite, bypass hooks, or confuse a hash check with CI. Run `npm run staged:legs` per commit and verify the final suite stamp with `scripts/shared/suite-green-status.mjs`. Preserve generated artifacts, documentation/citation/guard checks and independent attestation requirements.

Record exact tested tree, native Linux/Windows coverage, deliberately capability-specific skips, full logs and actual gate outcomes. No real analyzer/network smoke is required for hermetic regressions; report what was not run. Correctness regression tests should fail against baseline; extraction equivalence tests should already pass baseline and fail targeted mutations.

Use the repository's authorized landing and ship workflow, not direct ad hoc pushes or tag creation. Unit 1 preserves the legacy exported array return type and adds an explicit result helper; the public runner remains unchanged/deferred. Use normal repository release-version policy. Verify exact remote qualification SHA, release workflow result, registry version and any explicitly authorized installed-bin target separately. Publication retries/resume follow existing journal ownership; do not substitute an unapproved global installation. Completion claims name shipped units and deferrals. Roll back code/interface/tests atomically; retain fail-closed release/delta behavior and user artifacts. No live audit rerun, old coverage rewrite, snapshot deletion or artifact migration is implied by this plan.
