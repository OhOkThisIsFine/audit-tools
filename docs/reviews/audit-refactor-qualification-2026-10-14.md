# Audit refactor source qualification

<!-- review-routing: deferred -->

Baseline: `e64e0cd1574e953b4a43c6804528567ff415ba33`, package 0.55.6.
This record accompanies the [finalized plan](audit-final-refactor-plan.md). It qualifies only the
bounded assembled source candidate, not completion of that eleven-unit plan or release readiness.

## Evidence at the individual source-review boundary

The unrun statuses below describe each individual review; later native results are recorded separately.

Ten separately reviewed patches cover 42 source/test/fixture files. Unit 2 composes with unit 9
in findingGrounding: admission changes retain the reviewed recursive enumeration and import.
Each assembled file was byte-compared with its approved candidate; a separately reviewed unit 11A
test-helper type annotation fixes native literal inference without changing runtime behavior. A second
reviewed test-only correction makes the unit 9 beforeEach block-bodied, preventing its returned mock
from being invoked as a Vitest cleanup; adapter rejection assertions remain unchanged. The assembly uses an independent
full-history clone of committed HEAD, excluding the source checkout's working changes.

- Unit 4, pipx/Lizard contracts: `8d06b4c2d550d3f5aac2762a81d52fb5ca0e79c4468956bae521eb2cb667572e`.
  Independent corrected-tree focused gate: 5 files, 133 tests passed; four quoting/header mutations
  killed. Offline upstream pipx/Lizard smoke was NOT RUN because those binaries were absent.
  The provenance fixture is source-derived synthetic output, not captured live output. Corrected
  final-tree build/typecheck and aggregate validation remain unestablished.
- Gate signal failure boundary: `4f943d40519951d14cca7b862e222c73cc3f454cabea74dbe1a1eaca329f3a3e`.
  Independent real-gate synthetic-child harness: 11 cases passed, including actual POSIX signals
  and a real ENOENT result. Supplemental transpilation adapter: 19 cases passed. No Vitest,
  build/type/lint or aggregate gate was run for this patch. These do not prove Windows behavior.
- UTF-8 capture prerequisite: `b38975c630b8822886258198b756857cbd2d967b60d3a0d00ba8ad5a751417bd`.
  Amended source approved after 136 independent actual-source checks. All 35 authored Vitest
  cases remain unrun. Whole-chunk admission measures emitted UTF-16 length, so corrected UTF-8
  can admit chunks previously discarded by replacement-character corruption. Up to three pending
  bytes do not count until emitted; whole-chunk and terminal-flush overshoot remain intentional.
  Raw-byte overflow accounting is unchanged. Unit 9 below consumes this exact amended prerequisite.
- Unit 10, first-owner packet index: `44113aa61aaa5cbba8b97377ee8eb50048da6f16ed825a6d5e05a67daaa6258b`.
  Independent extracted-source evidence: 240 whole-packet comparisons and deterministic operation
  counts passed. This does not execute the production import graph or planning projection.
  Native regression, behavioral baseline-red, build/type/lint and aggregate gates remain pending.
- Unit 8, exact conflict membership coalescing: `8ca6ad181e29c47e57b90a610a6354e157d9fe6868673477163a22f4de92e2cb`.
  Independent extracted-source evidence: 240 permutations and four critical mutations passed.
  Native handoff/frontier regressions, build/type/lint and aggregate gates remain pending. Behavioral
  baseline-red must use the fresh-three-file handoff case (one candidate conflict versus three baseline
  conflicts); a missing-new-export error is not that evidence. Live-run convergence remains unverified.

- Unit 9, recursive tracked-path ownership: `2650dbc568a411ba64de699c4ee8f566112802682a22ba8c9328b35994d09619`.
  Revised source approved with the exact UTF-8 prerequisite above. Independent source-derived probes
  include 144 old/new scope-hash comparisons, failure/ordering/diagnostic checks and memo freshness.
  Review found and the author repaired a test-only promisified-wrapper misuse with an explicit callback
  adapter; the independent actual-wrapper probe verifies its NUL-delimited stdout. The ten delta files
  and two prerequisite files were independently replayed. Native build/test/type/lint/aggregate and
  real-submodule parity tests remain unrun; probes do not prove import or native compilation correctness.

- Unit 11B, line-measurement policy extraction: `f16bb4a2f2fdb01d8c84fd3e4f593ec3b4e32faf18c6df0be76675674cc305bd`.
  Source-approved for stable, schema-valid plain-data inputs. Baseline and candidate passed the
  dependency-free source probe, with nine narrow mutations killed; a separate independent 60-occurrence
  probe checked cross-batch duplicates, reverse completion, failure diagnostics and exact batch barriers.
  The manifest adapter now snapshots all paths up front. Concurrent array mutation or side-effectful
  getters could differ, but review found no supported production dependency on those behaviors.
  All 13 authored Vitest cases and native build/type/lint/integration gates remain unrun; actual Vitest
  spy interoperability is unverified. Baseline passes
  are expected for this behavior-preserving extraction; mutation sensitivity is its negative evidence.

- Unit 11A, omittable obligation policies: `2ef9d1e1ad9600e5faea498d27db2a858ca5bab612c9c86cfd5172004b7694a8`.
  Independent source review approved eight exact outer adapters and intent lifecycle reuse. Charter
  extraction's inner handler and registry ordering tail remain byte-identical to baseline. The 18 new
  registered-body cases retain real handler/IO/validation paths but mock derived selection/apply seams;
  they are not whole-fold proof. Native tests, baseline equivalence and mutation sensitivity remain
  unrun. Existing fold/transaction/charter suites must establish ledger/refusal/commit-on-throw coverage.
  Exact host-result identity and terminal guards are source-established, not dedicated native assertions.

- Unit 2, evidence-read containment: `b70bded3625f78ab44f7e2776f6d08b95fe3dce2bc544c3f50e6e27a1774b50a`.
  Independent source review verified eight postimages, 27 source-harness cases and three mutation kills.
  Baseline admitted outside traversal/absolute/symlink evidence; candidate refused before content reads.
  Containment covers existing topology, not concurrent same-user symlink swaps. Native integration
  subsequently passed build, production/test/script compilers and nine focused files / 110 tests,
  including audit ingestion, remediation and unit 9 real-submodule overlap. No cases were skipped or
  unfinished. Observer root exit 0 plus ECHILD was confirmed. Windows drive/junction and symlink
  permission behavior, final whole-tree suite and aggregate remain unqualified.

- Process-fixture safety prerequisite: `8314adb49bfe925a808f9385cd3292c11954c86a992c28626419b669de88831d`.
  Independent source review approved three files. Runtime production bytes exactly match the historical
  recovered seam; the test adds separately reviewed strict object identity/no-PID/platform-ledger
  assertions. The natural-exit timer fixture retains its historical 60-second inner deadline and
  3-second outer timeout. The separate absent-checkout preflight now asserts exact refusal and zero
  injected spawn calls. Seven mutations failed with zero native calls in the source-slice probe.
  Native tests and descendant lifecycle qualification remain separate; no gate is disabled.

These independent reports were read during assembly; their supplemental probes were not rerun here.
The initial assembly was source-only. Subsequent isolated normal installation succeeded with lockfile
integrity-verified offline cache and normal lifecycle scripts. Build, production/test/script typechecks
passed after the reviewed test-helper annotation. The first native focused run reported 403 passed and
one failure in the rejected-runner adapter fixture (27 files, no skipped/unfinished tests); that failure
was traced to the returned-mock cleanup and corrected; all 13 adapter tests then passed. The process
fixture addition passed 3 files / 43 tests, including the owned natural-exit watchdog and strengthened
preflight. No focused tests were skipped or unfinished. Full-tree lint exited 137 without a verdict;
the bounded 768 MiB heap retry explicitly failed with V8 heap exhaustion (exit 134). Lint has no
passing verdict. The normal unfiltered Linux full suite ran 607 files: 604 passed and three failed;
7,312 tests passed, seven failed and five skipped. The unchanged gate completed its isolated diagnostics.
The reviewed observer established root exit 1 plus ECHILD, reaping 1,417 children with no adopted
failures; the dispatch checkout remained absent. No successful full-suite stamp was established.

Two failure causes were repaired after that run: the unchanged graph-consumed disposition helpers
justify a source-digest-only cache pin refresh with cache version v10 retained; the gate test now uses
the existing window-hidden spawn helper instead of a raw import. Independent review approved both
narrow corrections. Their normal focused gate passed three files / 67 tests with no failed, skipped or
unfinished tests, and observer root exit 0 plus ECHILD. The remaining five dispatch-worktree failures
are environmental: every authorized cloud temporary root has a `.git` ancestor that the existing
nested-worktree guard correctly refuses. The guard and tests remain intact.

These partial results do not qualify the latest final tree. Final lint, normal full-suite stamp and
aggregate qualification must run in an authorized environment with a temporary root outside repository
ancestors. No aggregate, commit, push, attestation, release, deployment or live analyzer acceptance is claimed.

## Excluded work and next gates

Snapshot cleanup is excluded:
its review is platform-blocked, and its patch was not inspected, applied or rerouted in this assembly.
Other plan units and the deferred SEC-04/CX-2/publish-cache work are not claimed implemented.

Continue the authorized serialized native lane. An independently reviewed Linux subreaper observer
now permits trusted unchanged normal commands while retaining detached descendants until root terminal
status plus ECHILD; this is lifecycle observation, not a general hostile-code sandbox. Its reviewed
digest is `4d66802c22f4b7917b1da6fbb9c61a6301a974161369746e046fb9749541e23e`.
Verify the private environment and absent dispatch checkout before and after each run; no diagnostic
bypass, argument filter, outer kill timeout or copied stamp is allowed. Preserve all runner isolation/diagnostic controls and use the real repository gate. Establish
meaningful baseline-red and candidate-green for defect regressions; for behavior-preserving extractions,
establish baseline/candidate equivalence and mutation sensitivity instead. Then run all required
exact-final-tree checks and aggregate local CI. Review any resulting changes and repeat affected gates. Existing
baseline stamps and attestations do not certify this candidate. Publication requires the separately
authorized normal landing flow and exact-HEAD checks; release/global installation remain separate.

The plan copy retains its implementation contracts; publication-only changes add routing and replace
private fixture references and machine paths with descriptive evidence and explicit path placeholders.
