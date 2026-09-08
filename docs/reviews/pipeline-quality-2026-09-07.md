# Pipeline quality verification

The approved lap prioritizes audit finding quality and remediation verification over
the separately queued September 6 maintenance decisions. Baseline:
`1c72023cc12089519eb7dd7961865e8e56fd80c2`.

## Repository test defaults

`normalizeExtractedPlan` in `src/remediate/steps/nextStep.ts` fills omitted or blank
test and end-to-end commands from persisted project facts. Nonblank extracted
commands remain explicit. Command provenance survives state persistence so
`runCombinedTestSuite` and `runE2eTests` in `src/remediate/phases/close.ts` require
current-manifest admission for discovered defaults. Refusal never falls through
to unrestricted execution. Failed, timed-out, and unspawnable commands fail
verification; refusal evidence is retained in `buildVerificationReport`.

The contract-pipeline path also passes through this normalization after
`promoteImplementationDagToExtractedPlan` writes its plan. Block-level targeted
commands do not replace these final combined checks.

Parent verification reproduced all five initial integration failures on the
unchanged baseline, then passed them with the implementation. A sixth regression
reproduced the misleading "no combined test suite configured" report for an
admission refusal, then passed with the reporting correction. The fixture executes
real repository commands, observes an end-to-end execution marker, and checks
that a failing combined test returns resolved work to triage. Existing close and
admission suites also passed. Independent review by the AGY Gemini lane found no
execution/admission defect and identified the reporting correction above.

## Rejection history across both pipelines

`hostResultOutcomes.ts` in `src/shared/submission/` owns trailing refusal lookup,
raw outcome recording, and missing-result diagnostics. Both host ingestion draws
retain the original refusal code and explanation under `submission_rejected`,
while pointing to the current bound result path. Missing observations and dispatch
events cannot erase a substantive rejection. Acceptance, recovery, and operator
withdrawal clear it; re-acceptance after withdrawal remains a recorded event.

Audit retains its single writer in `runHostDelegationObligation` in
`src/audit/cli/nextStepHelpers.ts`. Its `raw_issues` channel prevents decorated
diagnostics from being recorded recursively. Remediation uses the shared recorder
at its ingestion boundary, adding the ordinary rejection history it previously
lacked. The remediation reader and recorder use the same run identity as recovery.

Audit history spans reminted dispatch IDs within one artifact-directory lifetime.
`promoteFinalAuditReport` archives the ledger beside the completed reports and
removes working artifacts; an active directory denotes a resumable workflow.
This lifecycle supplies isolation without adding another ledger or workflow key.

Boundary tests exercise a mixed accepted/rejected batch, an actual changed audit
run ID and result path, repeated missing polls, and repair acceptance. Parent
verification disabled the shared lookup and observed both new boundary tests fail;
restoring it passed all 69 targeted tests, including the existing ingestion-phase
and ledger tests. Independent review confirmed the corrected remint/repair proofs
and found no remaining production defect.

The full suite then exposed five stale recovery-ledger expectations and one real
integration regression. An unwritable recovery ledger correctly refused the item,
but the new recorder retried that failed write and replaced `recovery_unrecorded`
with an exception. `recordAndEnrichHostIssues` excludes only that already-classified
write failure from recording, preserves its returned explanation, and leaves other
items' error propagation intact. The existing blocked-ledger test reproduced the
failure independently; recovery expectations now retain `rejected` followed by
`accepted_via_recovery`, never a clean acceptance.

## Audit quality experiment

The acceptance protocol remains in
[the workflow-gap review](audit-tools-simplification-workflow-gap-2026-08-26.md).
The local executor was repinned before fresh trials to AGY 1.1.22 and Gemini
3.8 Flash high effort because the original model was unavailable. Private gold
was frozen outside the repository before trial outputs were evaluated. Its SHA-256
is `821de8b96ae2c840ca8b6311e1ad2067e84392627db58637da558d62e2878c74`.
The primary source snapshot was pinned to
`09b0f4e4d0794507e88d45c781f7c02f08a944e1`; the held-out corpus digest was
`5601be44f427ac06228911ac79349f125b200401b0fa1900cdf8c1a89dda802f`.
Later isolated diagnostics used clean tooling commit `1c72023c` (package `0.51.0`),
so they exercise the existing P0 workflow, not this lap's new diagnostic reader.

Preflight accepted the pinned corpus. The first attempt timed out at analyzer
consent. A fixture-only policy subsequently declined acquired analyzers, matching
the declared graph-only tool inventory. The next attempt completed consent and
timed out at critical-flow fallback after 300 seconds. Cleanup also failed with
Windows `EPERM`. Neither attempt produced a valid report or quality score.

The executor can enforce lane selection and a child timeout, but its declared
context/output/agent-turn budgets are not supported by the AGY agent-mode controls.
Consequently these attempts are execution diagnostics, not strict paired quality
acceptance. Harness tests and successful preflight cannot substitute for the
missing blinded evaluation. No speculative audit phase or finding contract was
added on the basis of these incomplete runs.

## Bounded executor diagnosis and verification

The low-effort Gemini profile materialized the exact bound critical-flow artifact
in 98 seconds in a separate calibration. Normal ingestion accepted it and advanced
to five `dispatch_review` work items. A fresh low-profile attempt completed one
control and the flow step, then stopped because its generic external executor
returned a receipt without writing the five bound result files. A later isolated
attempt also stopped on repeated step identity, but its temporary artifact was
cleaned before inspection; the exact cause of that attempt remains unproved.

A preserved reproduction advanced through flow and design review to ordinary
review dispatch. Its external executor interpolated an object-valued prompt as
`[object Object]`. The corrected local executor uses the prompt's text, supplies
the run/item/digest binding, and checks all expected result paths. A separate
300-second diagnostic, with up to three concurrent items, materialized six of
seven bound results; the remaining lane timed out after 191 seconds. Workload and
result-map hashes remained unchanged. One subsequent deterministic `next-step`
found five accepted results in the prior run ledger and reminted four pending
tasks; the missing item remained `src-bounded-context-js:correctness`. No more
model calls were made. File existence was therefore not treated as acceptance.
This is incomplete execution evidence, not a valid paired trial or quality score.

The external quality comparison remains open in
[`forward-tracks.md`](../backlog/forward-tracks.md). It needs a pinned executor
that reliably completes the ordinary host workflow and can enforce the declared
budgets, followed by the complete randomized comparisons and blinded adjudication.
No audit-quality production change was justified by these executor failures.

The combined implementation passed all 40 `verify:checks` legs, including packaged
audit and remediation smokes. Its full local suite passed 6,460 tests across 513
files, with six skipped and none failed. The isolated corroboration suite passed
all 55 tests after the recovery-ledger correction.

## Execution friction

The initial hand-back closed the lap before the quality comparison was complete.
The owner requested continuation under the existing approval. The resumed baseline
includes the independently released `0.51.2`; its full suite reports 6,488 passed
and zero failed, with two reporter-transport timeouts classified by the repository
gate. This verifies the baseline, not audit quality.

Two additional setup failures were verified during continuation:

- The saved semantic-review result for `src-duplicate-js:correctness` contains a
  leading UTF-8 byte-order mark. `readSubmissionDocument` in
  `src/shared/submission/submissionClassifier.ts` rejected that encoding marker
  before contract validation. Replaying the original saved file reproduced the
  refusal. The shared reader now accepts one leading marker for parsing only and
  preserves the file bytes. Parent verification removed the fix and reproduced
  three failures through the shared reader and both ingestion draws; restoring
  it passed all 63 related tests. Wrong bindings, malformed JSON, and misplaced
  markers remain rejected, while marker characters within JSON data are preserved.
- The primary source pin includes the two reference audit reports and this
  experiment's workflow-gap review. `materializePinnedPrimary` in
  `benchmarks/p0/runner.mjs` exposes the full checkout, so private evaluator data
  separation alone does not keep reference answers away from auditors. Scored
  primary trials require a frozen source fixture that excludes those answer-bearing
  records while preserving the product code and governing documents.

The AGY continuation ended without a valid audit. Four semantic-review calls in
its final ledger alone reported 10,211,442 cache-inclusive input tokens and
29,090 output tokens including thinking, exceeding the 10,000,000 input limit.
Earlier stages used another ledger, so these are not whole-arm totals. The CLI's
four reported turns are user turns, not model/tool iterations. The run also used
shallow review and cannot support a comprehensive quality claim.

Source verification identified two independent depth defects:
`proposeConceptualDepth` in `src/audit/cli/confirmIntentStep.ts` ignores the
resolved full-repository scope when the optional intent text is empty; and the
`run` → `candidate` → `runCandidateArm` chain in `benchmarks/p0/runner.mjs`
drops the prepared candidate objective before it reaches the external host.
Both are corrected. Parent verification added the regression tests to the unfixed
tree and observed two failures, then integrated the implementation and passed all
69 focused tests. The subprocess test exercises the production runner across all
twenty requests, verifies the exact candidate objective and its request digest at
the external boundary, and keeps the control prompt unchanged. The depth proposal,
confirmation text, and example JSON agree; explicit bounded requests remain shallow.
The replacement external benchmark host is being calibrated with a pinned free deployment and explicit model calls,
usage receipts, and bounded tools. It has not yet completed a valid trial.

Real tool workloads have ruled out several deployment choices during unscored
calibration. The Kilo and OpenRouter Nemotron routes returned malformed upstream
envelopes on tool requests. Gemini Flash completed a tool sequence but returned
HTTP 429 on the candidate workload. Groq Qwen read actual source and graph evidence,
then returned an empty terminal response without the required submission. The host
now checks declared output paths and can resume the recorded conversation. That
real continuation failed HTTP 413: 7,164 requested input tokens exceeded the
account's 7,000-token allowance. Waiting cannot make that request admissible.
Separate NIM attempts returned HTTP 429 for MiniMax and HTTP 504 for DeepSeek.
These are host/provider execution failures, not measured audit-quality failures.

The preserved critical-flow step remains unaccepted. Its result path was already
present in both the product's `artifact_paths.critical_flow_fallback_results` and
the host request's `access.write_paths`; the null optional `artifact_path` did not
mean the path was lost. No product change was made for that rejected diagnosis.
The original requests, responses, usage, and continuation failure remain under
`.claude/pipeline-benchmark-lean/runs/heldout-candidate-1788817513966/`.

The native OpenCode free lane subsequently completed the same real critical-flow
task. Ordinary `next-step` accepted its submission and advanced to intent
confirmation. Its task-scoped database receipts identify Muse Spark 1.3
contributor-free with high effort and record 230,448 input tokens including cache,
3,376 output tokens including reasoning, and reported cost zero. A fresh held-out
candidate now uses this lane throughout; the mixed-provider qualification is not
a scored trial. Native usage includes descendant sessions, and the external
bridge rejects mismatched model identities and absent usage or output artifacts.
The complete paired run and blinded evaluation remain outstanding.

Inspection of actual native task records then rejected this host configuration
for comprehensive scoring. The standalone control produced a report and complete
usage receipts, but its graph scout had no callable graph tools; the report
explicitly disclosed source-only evidence. The candidate's charter-delta task
reported the same absence. It was stopped before its judge, and both runs remain
unscored. Direct OpenCode MCP diagnostics connect to the graph server, whereas
model-run startup records mark it unavailable. An isolated configuration with an
explicit 30-second timeout did not restore the model's native tools, so the
startup-timeout explanation is only a rejected candidate fix, not an established
cause. A fixture-scoped shell-to-MCP transport is being qualified separately.

The delegated transport refusal was traced to its missing cache/runtime overrides:
the default temporary-directory ancestry grants mutation rights to another Windows
identity, so codebase-memory correctly refuses it. The helper now uses the active
daemon's accepted private cache and rendezvous directories through documented
`CBM_CACHE_DIR` and `CBM_RUNTIME_DIR` settings; permissions and validation are unchanged.
A real free Muse run then completed search, bidirectional trace, source snippet,
and coverage operations against the exact fixture. Its first coverage attempt
encountered a PowerShell UTF-8 byte marker in the argument file; a no-marker rewrite
completed, and the helper now accepts one leading marker during parsing. Raw
receipts are retained under the local benchmark's `graph-qualification` directory.
This establishes a functioning host, not audit quality. A fresh held-out candidate
used the ordinary pipeline with actual graph and usage evidence required before
each step advanced; the earlier source-only runs remain unscored.

The benchmark runner previously retained completed trial records only in memory.
Automatic checkpointing is integrated in `86f512d1` before the long paired run. Review
of the first patch found that an unjournaled pending executor call could be replayed
after a crash, and snapshots beside a checkout-local results directory could inherit
unrelated instructions. The final implementation journals pending calls, validates
accepted responses, preserves isolated snapshots, and refuses ambiguous replay.

Independent parent execution passed 39 focused tests, including actual process
interruption during control and candidate work, concurrent resume, source tampering,
and legitimate generated root artifacts. `runUnlocked` now verifies original source
path/type/content inventory. `checkpointLock` uses SQLite exclusive ownership, which
the operating system releases on process death; no stale-file reclamation is needed.
Request files precede their checkpoint pointers. The delegate gate's five warnings
were local helpers reading actual executor logs, not copied implementations.

The fresh calibration reached final design review but expired its 90-minute wall
budget during a Codex quota pause. Its active native task had completed successfully;
its response, graph receipts, and usage were recovered without rerunning it. Any
continuation must declare its changed wall budget and remain unscored. There are
still zero scored pairs. The first graph-disabled trial stopped at analyzer
consent without a comprehensive claim and was inconclusive, because the effective
host retained a graph augmentation plugin and capability isolation was unproven.

A subsequent isolated trial disabled both MCP definitions, graph-plugin trigger
tools, delegation, and arbitrary shell commands. Its native trace nevertheless
showed semantic critical-flow, contract, and conceptual review before the final
non-comprehensive notice. This is a measured preflight-ordering failure. The
canonical loader in `skills/audit-code/audit-code.prompt.md` previously required
the check only before treating a run as comprehensive, after directing the host
to follow its workload. The loader now checks after the first backend response
and stops before any semantic work or further `next-step` when structural
capability is absent. A fresh isolated Muse Spark high session passed this
ordering check: ten model calls, 259,856 input tokens, 4,529 output tokens, and
reported cost zero. It returned an explicit degraded/non-comprehensive notice,
issued no second backend advance, and wrote only analyzer-consent decisions.
Native tool records confirm no semantic submissions or structural transport.
The original adverse trace remains preserved. This is one successful live
preflight trial, not the outstanding paired audit-quality score.

The primary fixture has been sanitized into a new, history-free repository at
commit `90b377c349191b736eb9309d54b31977f8db6788`. Parent verification confirmed
identical `src`, `tests`, `spec`, `scripts`, `.claude/hooks`, and `.claude/skills`
trees relative to the original primary pin, with reference reports absent. The
fixture retains 1,188 entries and excludes 173; its provenance records twelve
documentation references to intentionally omitted records. Those omissions must
be disclosed to evaluators rather than scored as product defects. No new quality
score is claimed from this setup work.

The unscored continuation exposed two conceptual-retry defects. In
`prepareConceptualPass` (`src/audit/cli/nextStepCommand.ts`), rejection feedback
was joined to the structural re-review section before `prepareConceptualDispatch`
hashed the round identity. A malformed judge therefore reminted perspective
paths despite unchanged review inputs. Separating the two retains valid work
and keeps the rejection explanation in the judge prompt. The benchmark host's
`planNativeStep` also scheduled every manifest perspective regardless of an
existing bound result. Its resume check now follows the materializer's file
existence rule. The full access grant remains stable; it is not a pending list.

`loadConceptualPerspectiveFindings` (`src/audit/types/conceptualAdjudication.ts`)
previously failed at the first malformed perspective, and
`consumeConceptualSubmission` (`src/audit/cli/nextStepHelpers.ts`) quarantined
only the judge. Invalid perspective files consequently stayed marked delivered.
The repair classifies JSON/schema failures separately from IO errors, collects
all malformed perspectives, and reopens only those files. Their lane-specific
prompts point to the preserved rejected content; valid files and round identity
remain intact. A repaired submission records acceptance after its refusal.
Before reading or quarantining a perspective, the consumer verifies its path
against the tool-computed lane binding; a copied or modified manifest cannot
authorize quarantining an unrelated file.
Real `cmdNextStep` regression tests cover judge rejection, mixed JSON/schema
perspective failures, preserved valid output, and recovery acceptance.

The continuation remains unscored. Its original failed calibration and all usage
receipts are preserved. A bounded native repair supplied six missing titles in
perspective 5, retained the other findings, and used a separate judge session.
That judge was subsequently rejected for duplicate contributor rows. The
canonical judge prompt and validator now explain how several candidates from
one contributor must share one attribution row. This is an output-contract
failure, not a measured audit-quality score. Independent design review caught
an incorrect proposal to treat full write grants as pending work; parent checks
also corrected a proposed combined repair/judge task and a Windows separator
comparison in a test fixture before relying on them.
The repaired judge subsequently passed the existing adjudication validator.
The continuation then stopped at the auditor's no-progress guard for
`design_assessment_current`; the benchmark host incorrectly tried to dispatch
that blocked step as work. The original failure and 525-call cumulative ledger
remain preserved while that separate stop is diagnosed.

- Codex crashes required resuming the existing approved lap and its running agents.
  An earlier helper also overwrote the owner's checkpoint; the missing ownership
  enforcement is tracked in the machine-wide backlog at `C:/Code/docs/backlog.md`.
- A free-pool lane exited successfully with only `It` and no edits. A bounded Luna
  worker completed the implementation; exit status alone did not establish delivery.
- Graph coverage reported changed metadata and omitted relevant caller edges.
  Exact source reads supplied the evidence; stale backlog claims were rejected.
- Vitest accepted a nonexistent filename filter while running other matched files.
  The admission checks were rerun with the actual camelCase filenames.
- The delegate diff gate flagged fixture registration through `cleanupRoots.push`;
  source inspection confirmed `afterEach` drains and removes those roots.
- The final worktree inventory found a shared ledger regression test left in the
  worker checkout. It was included before release, with explicit assertions that
  recovery remains distinct and acceptance after withdrawal is recorded.
- PowerShell mangled unquoted `@{u}` and did not expand a wildcard inside an `rg`
  path. Explicit remote refs and directory searches avoided both ambiguities.
- A benchmark wrapper rebuilt the root `dist` while a packaged smoke imported it.
  The smoke passed alone. Benchmark tooling now runs in its own installed checkout;
  missing build/smoke coordination remains a release-tooling issue in the backlog.
- Analyzer consent, missing workload results, timeout, Windows cleanup `EPERM`, and
  unenforced token budgets prevented the earlier benchmark attempts from qualifying.
  Their implications are stated above; none was converted into a quality score.
- Opening-tool output compression returned opaque references; bounded reads recovered
  the evidence. An apply-patch delete/add of the same path was rejected without edits.
  The global baseline verifier's incomplete deferral declaration is already tracked
  in the machine-wide backlog; this repo's own matching suite stamp supplied baseline
  evidence without creating a second ledger.
