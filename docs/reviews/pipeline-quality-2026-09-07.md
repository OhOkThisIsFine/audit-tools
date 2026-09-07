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
