# audit-tools: finite closure and evidence checklist, 7 October 2026

<!-- review-routing: deferred -->

Companion to the [canonical implementation plan](audit-tools-canonical-implementation-plan-2026-10-07.md). Implementation and runtime qualification remain [deferred work](../backlog/deferred.md). Revision 4 preserves the approved revision-3 contract and reconciles main 5756602bad536b145f2ec43d13b7ed032c71c922, tree 74fca00cca7232e6844babe4851138bef90577d9; both independent exact-hash source rechecks approved this contract; see the [source-review record](audit-tools-canonical-source-review-2026-10-07.md). No runtime row is newly checked off. This is a finite acceptance checklist, not a list of tests claimed to have run. All unchecked execution rows are pending. Source-only work established the current-main comparison, saved patch/tree bindings and concrete caller/fixture choices; the two source-review scopes approved the plan while leaving implementation/runtime evidence pending.

A row closes only with the named artifact and oracle, or its explicitly permitted unavailable/refusal outcome. “Started,” a progress count, a green prior tree, a passing narrower subset, or no observed failure does not close it. Do not replace missing evidence with a self-authored review/stamp. New planned test filenames in this record are future implementation targets; the P0 parser test is already in the saved draft but absent from current main.

## Recovery and baseline (R0)

- [ ] R01. Read the existing task’s recorded outcome and preserve its source/evidence. Known task/last turn: 01a11369-da85-730b-a741-ea05ce9f600b / 01a113dd-cfca-7290-bd6c-6265cdbdd1af. Artifact: task-local recovery inventory with exact repository root, HEAD, status/diffs, untracked inventory and immutable evidence copies. W6 remains untouched.
- [ ] R02. Resolve the old full-suite process only through its owned handle or exact-instance/task evidence. Artifact: terminal exit plus gate log, reporter runToken/outcome and original stamp, OR an explicit unconfirmed-old-run record plus preservation and separately owned qualification checkout. No broad PID termination or holder deletion. A live unresolved run blocks rebuild/reuse of that checkout.
- [ ] R03. Verify materialized full annotated patch SHA-256, all six candidate blobs and tree. Artifact: exact diff/manifest, matching f2f2def9fa9817dbb3939435db66f67b4016bf7c on original base, or independently reviewed actual delta. The current-baseline six-file prediction is 7c6596227ce365e66d729161e38cbd4293bd6d5d on 5756602bad536b145f2ec43d13b7ed032c71c922 and requires fresh tests; the earlier docs-only prediction c68c5ab0f8ff327942c115e56bddd8c75837fb60 is historical; it is not a recovered execution result.
- [ ] R04. Qualify task-local Node 22.23.3/npm 10.9.9 and the real platform. Artifact: official archive checksum, absolute executable paths, version records and clean-lock install result. No global replacement or silent lock rewrite.
- [ ] R05. Pass the isolation sentinels before real CLI/package tests. Artifact: HOME/TEMP containment, per-worker state/caches, npm/Git config isolation, real-home/credential-read refusal, outside/sibling-prefix-write refusal, egress refusal, ordinary-warning visibility, registry-derived fixture analyzer skips and teardown. The historical Node 22.14 harness is a starting hypothesis, not transferred qualification. Also exercise repeated-load-failure diagnostics with AGENT_DISPATCH_REPO bound to a verified absent owned path, assert no bridge/agent call, and observe the owned diagnostic’s terminal cleanup. Native descendants need real inherited isolation, not parent-only Node flags. After P6, actual production-root CLI/packed qualification uses a disposable OS account/profile; synthetic HOME is insufficient.
- [ ] R06. Record a safe baseline and independent pre-implementation review at the applicable depth. Artifact: exact baseline tree (including only P6.0 harness deviation when necessary), baseline outcomes, real negative controls and source review findings. No fabricated-PID Windows baseline; no inference that a filtered pass mints full-suite evidence.

## Package closure

- [ ] A01, P0 dependency scope. Only smol-toml minimum/resolution/integrity change plus the already-reviewed fixtures/P6.0 seam; helpers unchanged. Artifact: structural manifest/lock diff, exact six blobs and local installed 1.9.0 resolution. EOF/prototype/graph compatibility/scaling child oracles pass with no watchdog or synthetic OS PID control.
- [ ] A02, P0 runtime/package. Artifact: focused gate, unfiltered final-tree gate/stamp and private packed-install smoke on patched Node 22; installed Cargo/pyproject graph edges match exact tuples. The old 7,095-pass result is historical only. P0 may close without implementing the rest of P6. Use the R7 exact-override lower-bound fixture, reviewed consumer lock/offline cache, supplied fixed installed-adapter script and tarball/manifest/lock/script hashes. Keep ordinary unoverridden packaged smoke separate.
- [ ] A03, P1 descriptor reader. Artifact: async/sync fixture log showing containment, in-root aliases/submodule success, byte caps, multibyte boundaries, regular-file checks, replacement/growth refusal and balanced closes. No hostile same-user ancestor-swap confinement claim.
- [ ] A04, P1 real consumers. Artifact: accepted comparison → fidelity packet plus finding/citation/normalizer tests. Outside sentinel absent from packet/steps/status/logs/findings; path-only citations still authorize, valid basename/no-quote paths pass, arbitrary SourceReader injection removed from callers/exports. Leakage checks forbid the whole sentinel and three declared nonoverlapping 16-byte markers, with connected negative controls for each; not every substring.
- [ ] A05, P2 data contracts. Artifact: strict v1alpha2 steps and wrapper handoff; write → runtime validate → host route; extras cannot override command arrays; unresolved parameters only in command_templates; old steps regenerated while quiesced. No executable strings remain in allowed/suggested command authority. Preserve D3’s task-first/ready-inspection/carried-report order, count-only pending section, correct workload pointer and existing repair-remedy/missing_result_with_commit remediation restriction.
- [ ] A06, P2 byte preservation. Artifact: project-facts argv retained in persisted plan and all close/e2e/required consumers, old explicit-string semantics preserved/refused as specified, literal special-character argv round-trips without render/parse. Exact cwd/argv, no side-effect sentinel. New process request name does not alter semantic ExecutionRequest. The generic floor, runCloseAcceptance/terminalUnit and combined admission receive the same copied frozen argv for both source modes; changed/unavailable project facts refuse at late admission. Keep the audit-tools-specific floor distinct. Use real historical-Python→current-npm project-facts migration separately from the explicit native-Node special-argument array fixture; do not widen discovery.
- [ ] A07, P2 real shell/host qualification. Artifact: emitted-command argv-echo results on actual POSIX and qualified PowerShell/cmd, with explicit unsupported cases and structured fallback. Generated host assets derive from canonical prompts. Missing platform means unavailable adapter, not assumed rendering safety. Shell-host execution cwd must be independently established and physically match command.cwd; wrong or unverified cwd refuses before spawn. Echo both cwd and argv from an unrelated starting directory.
- [ ] A08, P3 lock truth. Artifact: child/barrier races proving live-owner nonsteal, exact same-scope dead-owner recovery, refused ambiguous owners, bounded one-attempt-zero-timeout, nonstealable reaper, no late unlink/no false removal, one mutator maximum. Filesystem identity/type/race qualification recorded separately. Include two final-directory aliases in unrelated parents plus physical/missing-suffix paths returning one identical lock pathname. Validate finite nonnegative timeouts and use monotonic budget despite wall-clock jumps.
- [ ] A09, P3 all persistence. Artifact: direct-store, artifact-hold, normal/catch fold, consent/friction/ledger and remediation phase tests; ownership loss/unsafe hold yields zero later authoritative writes. Lifecycle lock survives tree rm; aliases serialize; migration refuses live legacy holders. Preserve D1’s published-task identity checks and test publication-read/cleanup serialization. Thread the accepted-results callback hold through prepare, new pre-binding invalid-entry eviction, ordinary acceptance and unaccept-results; assert before each ledger/render write and before returning a usable published-task set. Include the .mjs load-flake-record writer: ownership loss across its awaited callback prevents persistence/success. Keep the public next-step lifecycle hold through cleanup/fold/publication/emission.
- [ ] A10, P4 no-clobber/restart. Artifact: A capture → B publication → injected failure → failed quarantine → two restarts → completion. B byte-identical; A remains readable at returned path; no entry reuse or copied success; correct accepted count. Preserve D2’s required pendingTaskIds, filtered stale-binding return, completed/orphan exemption and same-ingest repair/reaccept semantics; ownership loss or crash must not resurrect evicted entries. EEXIST/EXDEV/ENOTSUP/copy/close/unlink/open-writer cases preserve data. An unconsumed B or unknown/nonregular bound entry retains the working tree at terminal publication through two restarts; no B relocation merely to permit rm.
- [ ] A11, P4 hand recovery. Artifact: validator rejection, absent/occupied publication, ledger failure and crash-before/after-ledger fixture results. Durable intent reconciles idempotently before consumption; occupied B never overwritten or labeled recovered; pending A retained. Verify v2 destination/tool/artifact binding and recovered/rejected/pending CLI exits; reconcile before both normal and recovery precomputed test consumption. Crash after payload deletion must finish a genuine acceptance only from the durable committed-effect intent. Fold physical-effect membership includes graphEdgeCachePath with replace when defined and preserve when undefined; two restarts must never accidentally prune or omit it.
- [ ] A12, P5 promotion integrity. Artifact: every member-read/copy/readback/canonical-replace/receipt/rm failure plus crash/restart results. No source-only data lost; previous set recoverable; receipt detects mixed/incomplete output; rm failure is retained cleanup; report-only legacy branch never fabricates complete JSON authority. Receipt uses publication_id and source findings hash, not an invented audit run ID. Complete report publication and audit_completion/origin are distinct facts.
- [ ] A13, P5 actual consumers. Artifact: terminal reentry, cleanup, resynthesize and default remediation discovery using one receipt verifier. Canonical incomplete pair cannot fall back to Markdown; explicit noncanonical input semantics preserved. Recovery archives stay private/outside rm target. Actual persisted intake consumes a verified owned immutable snapshot and hash after A/B publication races. Post-cleanup resynthesis preserves all recovery members; missing/legacy/explicit origins never fabricate completed-audit identity. Real terminal step status carries publication result and retained-cleanup warning. Pre-intake selector identity is separate from snapshot path and survives PlanSource fallback; repeated JSON/Markdown --input reuses its binding without false conflict/allocation, while publication B takes the true generation-change route. Final-component alias/junction roots keep links and target, return artifact_root_alias retention, and emit through the frozen canonical hold without new tree/lock.
- [ ] A14, P6 types and truth projection. Artifact: all runner callbacks receive same budget/signal/scopes/input/output policy; status 0 plus overflow/uncertain cleanup fails required/runtime/close/final/landing/combined gates. Actual status remains 0, failure is separate. Tail vs complete policy cannot be relabeled downstream. Semantic-plan ExecutionRequest remains unchanged. usableCommandOutput receives actual producer OutputPolicy; tail-origin results, error and contradictory truncation refuse machine parsing. Close analyzer absence proof requires zero degradation, not only findings/success status.
- [ ] A15, P6 atomic ownership. Artifact: overlap/linked-worktree/common-Git/different-state-root races; unrelated concurrent updates survive; prepared/active/starting crash tests; unsafe scope survives restart. Registry mutation is locked and callback never runs under metadata lock. No PID-death-only clearing or environment exemption. Both actual CLI fixtures use one injected authority resolver across different workflow dirs; production authority derives from OS userInfo home, independent of environment. Non-Git parent/child and nested cache overlap must serialize without subtree scans.
- [ ] A16, P6 POSIX. Artifact: actual owned guardian tests on each claimed OS; parent-first/closed-pipe writer, inherited pipes, ignored TERM, disconnect, pause/death, delayed receipt, group escape characterization. Only guardian self-group signaling; no numeric late rescue. Ordinary coverage explicitly posix_group; strict all_descendants unavailable before launch.
- [ ] A17, P6 Windows. Artifact: native supported Windows/PowerShell/.NET run and packed compilation; create-time JOB_LIST, exact owned membership, ResumeThread ==1, parent-handle instance, nested jobs, ActiveProcesses terminal query. False/unavailable syscall and killed supervisor cannot produce cleanup certainty. No taskkill rescue or execution-policy bypass. Valid normal direct result immediately enters cleanup and terminates remaining job members while preserving target status; cleanup uncertainty must not be relabeled target timeout.
- [ ] A18, P6 clocks/protocol/bytes. Artifact: nonce/ready_nonce/version/schema/oversize/stale controls, all direct-exit/EOF/job combinations, delayed/repeated stop cutoff, one outer cleanup ceiling, actual fixture exit observed by independent watchdog, exact Unicode/env/NUL stdin and byte-cap boundaries (including 64/256 MiB). Missing terminal evidence retains uncertainty.
- [ ] A19, P6 acquisition/scratch. Artifact: same budget over probe/fetch/extract/analyze, 1 MiB checksum/128 MiB archive actual-byte limits, at most two total transient attempts, abort cancellation, unique temp index; no scratch purge while writing cleanup uncertain. Report count/status alone cannot resume a latched unsafe fold. Cover omitted graph-enrichment install and close-analyzer-verification chains. Newly selected cache-key hold/lease and private complete-directory publication replace the nonexistent “existing version lock”; live/uncertain cache users prevent rename/purge. Prepare and preservation UUID destinations are allocated and reserved before mutation in the immutable lease union; occupied preservation destination is refused unchanged, and recovery reports the recorded exact source/destination.
- [ ] A20, P7 trusted acquisition. Artifact: private exact-version manifest/full lock, origin/integrity/top-level/bin proof, absolute trusted Node/npm launch and clean environment; malicious local bin/.npmrc/NODE_OPTIONS/bin traversal/cache/script sentinels never run. Offline result is unavailable or verified cache. Existing consent boundaries and unrelated package-manager roles stay intact. Require ExecutionContext throughout resolution/install/use, platform/arch keyed strict full-tree manifests, preserved invalid legacy content, actual cached-use revalidation and lease through analyzer completion. Prepare and preservation UUID destinations are allocated and reserved before mutation in the immutable lease union; occupied preservation destination is refused unchanged, and recovery reports the recorded exact source/destination.
- [ ] A21, P7 binary truth. Artifact: exact-path outside-project resolution with trusted installation source and version/capability fixtures; status-zero wrong binary refused. Real registry/download qualification recorded separately; missing independent witness is not invented provenance.
- [ ] A22, P8 report/privacy. Artifact: [] and findings success vs missing/empty/malformed/oversized/unreadable report failure; redaction argv and bounded descriptor read; Secret/Match/Description/Fingerprint/Entropy/stdout/stderr/error sentinels absent from all persistent/public surfaces. Invalid metadata is normalized/dropped with accounting.
- [ ] A23, P8 concurrent lifecycle. Artifact: two same-process Gitleaks and jscpd calls each use one unique descriptor path for argv/read/cleanup; every stopped failure arm reaches finally; uncertain writers retain only private scratch and lease. Privacy/ACL failure prevents scanner launch; no unredacted retry.

## Final evidence and delivery

- [ ] G01. Generated source/exports/schemas/prompts/path registries and all newly added tests are visible to the declared checks. Artifact: generator diff, test visibility and exact caller inventory reconciliation; no casts or deprecated unsafe overloads hide a missed consumer.
- [ ] G02. Real independent code review and exact pre-ledger unfiltered suite pass are recorded. Artifact: reviewer result, defect-specific summary, full log/exit/structured outcome and genuine matching staged-tree stamp. Plan review and sites-pinned output are not substitutes.
- [ ] G03. Supported attester succeeded with honest class/identity and attributable preflight; its exact ledger/record matches the final staged tree. Artifact: writer log and inspected evidence-only delta. If refused, no attestation success claimed. No unsupported overrides or manually constructed ledger entries.
- [ ] G04. Final content after documentation/ledger/integration changes passes complete `npm test`, `verify:checks` and `verify:release` under isolation; final suite-green-status passes. Artifact: per-leg/aggregate exits, final tree, logs, skips and packed/linked-smoke sentinel results. A failed earlier catalog stage leaves later stages unrun.
- [ ] G05. Every claimed runtime/OS/host/filesystem capability has actual evidence, and unavailable branches fail closed without blanket disabling independent functionality. Artifact: explicit capability table with passed/failed/skipped/unavailable and exact reason. No universal safety/release claim from Linux-only or type-only evidence.
- [ ] G06. If code publication was authorized, normal commit/protected PR route succeeded and all required exact-head/merged-head checks are terminal green. Artifact: commit/tree/PR/main URLs and check-run IDs. Preserve W6/current-user work. Documentation PR #29 never counts as this code result.
- [ ] G07. If release and installation were explicitly authorized, existing release pipeline/journal completed and registry/tarball/installed-bin facts independently match. Artifact: release/tag/workflow/registry integrity/provenance/install smoke results. D4’s current release hold must first be satisfied by the separately reviewed frozen-snapshot/dogfood-efficiency composition. Otherwise stop at verified code with release/install clearly not performed; no standalone 0.55.6/P0 release or paused-dogfood resumption. Use the existing --no-wait sterile pre-tag/tag+release leg, then inspect matching journal/HEAD/tag and resume without --no-wait only in the separately approved concrete live installation context. Missing/mismatched journal refuses a fresh live-environment release. Complete held-release next-patch versus incompatible 0.x next-minor versioning is selected from all included changes.
- [ ] G08. Rollback/migration readiness is demonstrated for affected live protocols using fixtures and a scoped operator procedure. Artifact: preserved pre-upgrade data/control files, quiescence evidence, successful verified previous-report restoration/refusal, no discarded v2/new-format data. Never silently roll back to vulnerable smol-toml.

## Exact focused command targets

Prerequisite: R0 isolation and one fresh build after edits. These are future commands, not executions made during preparation. Replace the leading node with the verified absolute Node 22.23.3 executable. The named new test must exist and be visible to `check:tests` before its group runs. Every group also needs the full unfiltered final gates above. Platform branches add real fixture qualification; a mocked unit run does not substitute for them.

### P0

```text
node scripts/shared/run-vitest-gate.mjs tests/audit/graph-manifest-edges.test.ts tests/audit/graph-manifest-toml.test.ts tests/audit/runtime-command-bounded-wait.test.ts tests/audit/runtime-command.test.ts
```

### P1

```text
node scripts/shared/run-vitest-gate.mjs tests/shared/repository-source.test.ts tests/shared/finding-grounding.test.ts tests/shared/citation-grounding.test.ts tests/audit/charter-fidelity-executor.test.ts tests/audit/charter-current-context.test.ts tests/shared/analyzer-acquisition-engine.test.ts tests/audit/host-ingest-grounding.test.ts tests/remediate/grounding.test.ts
```

### P2

```text
node scripts/shared/run-vitest-gate.mjs tests/shared/exec.test.ts tests/audit/command-rendering.test.ts tests/remediate/command-rendering.test.ts tests/shared/step-contract-writer.test.ts tests/audit/steps-write-current-step.test.ts tests/audit/host-asset-renderer-drift.test.ts tests/shared/prompt-renders-its-contract.test.ts tests/remediate/structured-command-state.test.ts tests/remediate/artifacts-validation.test.ts tests/audit/wrapper-response-contract.test.ts tests/remediate/executable-plan-identity.test.ts tests/remediate/pipeline-command-defaults.test.ts tests/remediate/final-acceptance-window.test.ts
```

### P3

```text
node scripts/shared/run-vitest-gate.mjs tests/shared/fileLock.test.ts tests/shared/fileLock-clock-seam.test.ts tests/shared/locked-json-store.test.ts tests/audit/artifact-tree-lock.test.ts tests/audit/artifact-tree-lock-single-surface.test.ts tests/audit/one-lock-hold-per-next-step.test.ts tests/audit/cleanup.test.ts tests/shared/filelock-export-surface.test.ts tests/shared/load-flake-record.test.ts
```

### P4

```text
node scripts/shared/run-vitest-gate.mjs tests/audit/submission-staging.test.ts tests/shared/hand-recovery-uses-the-same-validator.test.ts tests/audit/recover-submission-mis-route.test.ts tests/shared/submission-ledger-records-drift.test.ts tests/remediate/recover-verb-branches.test.ts
```

### P5

```text
node scripts/shared/run-vitest-gate.mjs tests/audit/promotion-receipt.test.ts tests/audit/seam-atomic-promote-findings.test.ts tests/audit/cleanup-promotion-parity.test.ts tests/audit/cleanup.test.ts tests/audit/audit-code-completion-promote.test.ts tests/audit/resynthesize-command.test.ts tests/remediate/pipeline-command-defaults.test.ts tests/remediate/intake-resolver.test.ts tests/remediate/intake-sources-and-digest.test.ts tests/remediate/next-step-lifecycle.test.ts
```

### P6

```text
node scripts/shared/run-vitest-gate.mjs tests/shared/exec.test.ts tests/shared/execution-ownership.test.ts tests/shared/posix-group-runner.test.ts tests/shared/windows-job-runner.test.ts tests/remediate/execution-result-projection.test.ts tests/audit/runtime-command.test.ts tests/audit/runtime-command-bounded-wait.test.ts tests/shared/binary-acquisition.test.ts tests/audit/acquisition-executor.test.ts tests/shared/analyzer-acquisition-engine.test.ts tests/remediate/phase-close.test.ts tests/remediate/final-acceptance-window.test.ts tests/remediate/final-gate-red-pause.test.ts tests/remediate/final-gate-extraction-equivalence.test.ts tests/remediate/landing-gates-close.test.ts tests/shared/projectTestAdmission.test.ts tests/shared/projectTestAdmission-spawn-control.test.ts tests/remediate/close-verify-analyzer-leads.test.ts tests/audit/graph-enrichment-observability.test.ts
```

### P7

```text
node scripts/shared/run-vitest-gate.mjs tests/shared/analyzer-acquisition-engine.test.ts tests/shared/binary-acquisition.test.ts tests/shared/analyzerDeps.test.ts tests/shared/analyzerDeps-injectable-log.test.ts tests/shared/acquired-npm-origin.test.ts tests/audit/cli-fixture-analyzer-acquisition.test.ts tests/shared/candidates-safety.test.ts tests/audit/graph-enrichment-observability.test.ts
```

### P8

```text
node scripts/shared/run-vitest-gate.mjs tests/shared/analyzer-acquisition-engine.test.ts tests/shared/analyzer-candidates.test.ts tests/shared/candidates-safety.test.ts tests/shared/gitleaks-invocation-lifecycle.test.ts
```

## Additional exact future qualification commands

R6 sterile diagnostic regression, after one isolated build:

```text
node scripts/shared/run-vitest-gate.mjs tests/shared/load-flake-record.test.ts tests/shared/vitest-gate-false-red.test.ts
```

R7 consumer fixture, from its owned manifest/lock/tarball directory and with the reviewed offline npm cache:

```text
<absolute-node-22.23.3> <bundled-npm-cli.js> ci --offline --ignore-scripts --no-audit --no-fund
<absolute-node-22.23.3> <absolute-materialized-fixture-path>/p0-installed-toml.mjs
```

Its registry/setup lock-generation step is separate and explicitly network-authorized. Record exact materialized absolute arguments; placeholders are not executable identities. The packet contains source fixture files only, not a generated lock, tarball or passing result.

The installed-parser script and manifest bytes are supplied in the [support record](audit-tools-implementation-support-2026-10-07.md#installed-parser-fixtures); materialize and hash them before the installed leg.

R18 sterile-versus-install release-flow fixture:

```text
node scripts/shared/run-vitest-gate.mjs tests/audit/release-resume-main.test.ts
```

These are distinct from actual release/install commands and authorize none of those effects.

## Evidence row schema and stopping rule

One row per command or real platform fixture: evidence ID; package/checklist IDs; exact command/argv/cwd; pre/post content tree; commit if committed; changed blob manifest; environment/toolchain/harness identity; start/end; terminal handle/instance; exit; passed/failed/skipped/unfinished/unrun classification; log/structured-output path and SHA-256; stamp/review binding when applicable; residual limitation; next authorized action.

Recovery closes when the original evidence is either genuinely recovered or explicitly preserved as unconfirmed and a fresh qualified final candidate result is established. Each package closes when its rows and G01–G05 are satisfied. Publication and release close only under their separate G06/G07 authority and actual terminal evidence. A missing external capability is a scoped blocker or tested unavailable branch, not an unresolved design choice and not permission to bypass a gate. W6 remains an explicit preserved unknown until a separate authorized comparison/recovery request.

Source authorities: [current main](https://github.com/OhOkThisIsFine/audit-tools/commit/5756602bad536b145f2ec43d13b7ed032c71c922), [original source review](audit-p0-source-review-2026-10-07.md), [runner](https://github.com/OhOkThisIsFine/audit-tools/blob/5f21025909e4b7cd55c00b32047e67abb5dbbede/scripts/shared/run-vitest-gate.mjs), [stamp](https://github.com/OhOkThisIsFine/audit-tools/blob/5f21025909e4b7cd55c00b32047e67abb5dbbede/scripts/shared/suiteGreenStamp.mjs), [attester](https://github.com/OhOkThisIsFine/audit-tools/blob/5f21025909e4b7cd55c00b32047e67abb5dbbede/.claude/hooks/attest-loop-core-review.mjs), and [executable gate catalog](https://github.com/OhOkThisIsFine/audit-tools/blob/5f21025909e4b7cd55c00b32047e67abb5dbbede/scripts/guard-reach-data.mjs).

## Revision 4 source-delta preservation fixtures

These are required later regression legs, not additional completed execution rows. Run through the same isolated focused gate after implementation; no invocation below mints a full-suite stamp.

```sh
node scripts/shared/run-vitest-gate.mjs tests/audit/planning-inflight-tasks.test.ts tests/audit/task-id-names-one-file-set.test.ts tests/audit/host-handoff-validate-before-accept.test.ts tests/audit/host-handoff-atomic-publication.test.ts tests/audit/accepted-pair-write-order.test.ts tests/audit/host-handoff-unaccept-results.test.ts tests/audit/host-delegation-fold-carry-non-host-step.test.ts tests/audit/semantic-review-step.test.ts tests/shared/ingest-report.test.ts tests/shared/contract-construction-sites.test.ts
```

D1 oracle: stable published work survives unrelated completion/signals; actual premise/source/policy/ownership changes invalidate it; cleanup and publication read share one outer artifact hold. D2 oracle: pending invalid accepted entries disappear before stale-binding replay, repaired bound bytes can reaccept once, and no lost-hold write/phantom acceptance occurs. D3 oracle: count-only pending report remains after the complete task/ready-inspection and the repair instruction follows the existing exact predicate, retaining the known missing-result_path residual. D4 oracle: release/install/dogfood cannot proceed while the current frozen-snapshot composition gate is unsatisfied. The current-baseline preservation targets are specified in canonical D0–D4 and summarized in the [source-review record](audit-tools-canonical-source-review-2026-10-07.md). Existing ledger rows are not attestations of these future changes.
