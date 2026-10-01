# Outcomes-first workflow cleanup

<!-- review-routing: no-forward-work -->

This record is implemented by the accompanying workflow-replacement change; it
is not a separate proposal queue. Final validation is tracked in the handoff.

## Outcome and authority

The owner requested a concrete plan and implementation after reviewing the audit
and remediation workflows. The test for a mechanism is whether it advances the
user's outcome, not whether other implementation details currently depend on it.
Refactor size is not a reason to preserve a worse endpoint.

Audit should establish worthwhile findings and honest uncertainty: understand the
purpose and scope, investigate, independently challenge and consolidate, report.
Remediation should turn agreed problems or requests into verified changes: agree
the change, plan, challenge and revise, implement, verify integration, finish as
authorized. These are responsibilities, not a required number of host turns.

## Implementation sequence

1. **Put development policy at its owning boundary.** Remove mandatory friction
   reflection from shipped audit/remediation completion. Preserve passive capture,
   diagnostic archival, and the repository's own development closeout. External
   repositories must complete without audit-tools development attestations.
2. **Review the executable change plan.** Preserve original findings/request as
   provenance. Make execution units, affected behavior/interfaces, dependencies,
   stable requirements, and acceptance evidence the subject of independent review.
   Accepted counterexamples revise that plan and invalidate affected approval.
   After approval, derive dispatch metadata mechanically. Remove synthetic
   operational findings and independently editable copies of derived decisions.
3. **Let audit investigations inform each other.** Begin scoped work from sufficient
   confirmed purpose/scope/source context alongside isolated architectural inquiry.
   Feed concrete discoveries into targeted additional or redirected tasks. Hold
   only work genuinely dependent on an unresolved question. Preserve unrelated
   accepted and in-flight work; join all required investigation before synthesis.
4. **Make final verification express acceptance requirements.** Within a genuinely
   stable integrated-tree execution window, one observed command result can satisfy
   multiple identical requirements. Preserve distinct trust boundaries, subjects,
   deliberate repetitions, command side effects, and failure routing. Do not build
   a general persistent cache or equate the same HEAD with the same environment.
5. **Delete superseded machinery and verify the product.** Update canonical design
   documentation and tests to the replacement contract. Independently review the
   final diff, run required checks and end-to-end smoke coverage, push a draft PR,
   verify exact-head CI, and merge under the owner's existing authorization.
   A new npm publication is not part of this cleanup unless separately requested.

Independent slices may be developed concurrently. Shared runtime/state contracts
are agreed before parallel edits. Temporary internal seams must be removed before
merge; the main branch receives a coherent replacement.

## Properties that must survive

- Independent critic and judge responsibilities; isolated charter source readers
- Tool-owned scope and permissions, current input/source bindings, stale rejection
- Immutable submissions and accepted history, idempotence and interruption recovery
- Source findings retain their original identity and separate dispositions
- One source can require several execution units; one unit can serve several sources
- Changed premises invalidate affected review; unrelated edits preserve valid work
- Candidate verification does not substitute for integrated-result verification
- Unresolved, declined, and blocked outcomes remain visible rather than becoming fixes
- Host owns execution and routing; no provider/backend scheduler is introduced

## Acceptance evidence

Write production-path regressions before each replacement and demonstrate red then
green. Cover external completion with pending friction, preserved diagnostics on
archive failure, independent source/task identity, requirement insertion/reorder,
counterexample-driven revision, stale/out-of-scope submissions, interrupted resume,
parallel audit results arriving in either order, targeted discovery without duplicate
work, genuine question-dependent holds, final join, and verification invalidation.

Run type checks, affected suites, full suite and repository aggregate gates against
the integrated diff. Exercise installed command entry points and generic-repository
smokes; a green collection of representation-level tests is not sufficient evidence
that the user-facing workflow works. Record failed, blocked, and unrun checks honestly.

## Decisions to make easy to revisit

- Development friction reflection is not a product completion requirement. Prefer
  existing repo-owned development closeout over target-name heuristics or user flags.
- Concurrency follows real dependencies. Architectural discoveries should inform
  scoped planning; completion of every architectural review is not a universal
  prerequisite for useful scoped inspection.
- Review revisions of the actual plan. New information warrants revision and renewed
  judgment, not an additional chain of equivalent semantic representations.
- Stable semantic identities must not depend on array position. Derive presentation
  and workload views; preserve evidence/history separately because they are different facts.
- Preserve meaningful independence. No wholesale charter/fidelity or critic/judge
  collapse is authorized as an incidental simplification.
- Final verification reuse is local to its valid execution boundary, not a persistent
  receipt-cache project. Retain repetitions that observe genuinely different facts.
- The execution-unit runtime uses a new state contract. An older stamped in-progress
  runtime must be rejected clearly and without modifying its saved evidence; do not
  maintain two live planning authorities or silently reinterpret accepted work.
  Resume guarantees apply within the supported state contract. This compatibility
  break must be called out in the hand-back.
- Explicit evidence-backed no-change source dispositions are valid outcomes. Empty
  work is not forced to manufacture requirements, execution units or audit findings.
- Workload and outcome wire contracts change with the source/unit distinction;
  version them rather than silently reinterpret the prior field meanings. Source
  outcomes distinguish pending and deferred work instead of labeling either fixed.
- Reviewed scope is exact. Dispatch no longer silently adds a glossary path or
  recovers implicit legacy directory grants; newly required write scope returns to
  plan revision and approval.
- Optional integration checkpoints are reviewed plan decisions. They require an
  integrated-state verification boundary in addition to unit dependencies; ordinary
  plans need no phase numbers. Dependencies cannot point into a later checkpoint.
- Review binds relevant repository context as well as intake documents. Actual
  implementation changes are reconciled through accepted landed evidence; an
  unrelated code change cannot masquerade as the original reviewed context.

- Pending review resumes from the tool-owned source and canonical plan; it does not
  restart intake merely because approval is absent or invalidated. Confirmed intent
  remains a prerequisite even when only the source has been persisted.
- Source findings are immutable through grounding and deduplication. Filtering uses
  working copies; retained source and outcome records preserve exact original payloads.
- Closing requires current plan authority at entry and immediately before its action.
  Once an authorized action has executed, report that completed operation honestly;
  do not add a post-action retry loop that could repeat it.
- Review context refuses interior symlink traversal, including ancestors of missing
  write targets. A selected repository root may itself be an alias. These checks
  are fresh containment checks, not an OS sandbox against concurrent filesystem races.

Implementation-specific decisions and contrary evidence should be recorded here
before merge. Current progress belongs in the rolling handoff, not duplicated specs.

## Regression coverage map

Representation-specific tests disappear with their retired producers; their counts
are not evidence of equivalent behavior. The replacement must exercise these real
boundaries, alongside the retained integration and host-ingestion suites:

- `tests/audit/friction-runtime-boundary.test.ts` and
  `tests/remediate/friction-capture-closeout.test.ts`: external completion and
  diagnostic preservation without development attestations
- `tests/audit/audit-frontier.test.ts`: independent concurrent investigation,
  source-isolated packets, task-local questions, targeted discovery and in-flight
  bindings; baseline/ledger tests also cover changed-source redispatch and replay
- `tests/remediate/executable-plan-identity.test.ts`: real author/review/approval,
  semantic revisions, requirement identity/retirement, source drift, accepted work
  and counterexample-driven repair
- `tests/remediate/execution-unit-runtime.test.ts` and retained host-handoff suites:
  direct unit dispatch, reviewed authority, scope, actual landed evidence, retries,
  dependency/checkpoint barriers and non-destructive old-state refusal
- Source/unit outcome, request-outcome, HEAD/analyzer evidence and roundtrip suites:
  all original findings survive, shared units cannot overwrite independent outcomes,
  request-only work remains visible, owner choices and unresolved work stay distinct
- `tests/remediate/final-acceptance-window.test.ts` plus retained close/final-gate
  suites: actual command counts, direct-close enforcement, failure precedence,
  preview pauses and action reapproval, separate E2E and observed exit codes
- `tests/remediate/close-plan-authority.test.ts`, context-containment and replan
  safety suites: stale authority, missing review history, interior symlinks,
  resumable refusal, and preserved owner declines/accepted history
- Path-A provenance and phantom-source suites: exact original payloads through
  singleton, merged and grounded intake, explicit excluded-source accounting
- Shared schema, graph, prompt and grounding tests: the actual executable graph
  replaces the separate obligation graph; prompts name real inputs and preserve
  evidence-reading capabilities rather than testing retired artifact choreography

This map states what must be checked, not that the aggregate checks have passed.
Record final integrated evidence and any limitations before merge.

## Integrated verification

- Final independent review found no remaining blocking defect in the four slices.
  The containment patch also received independent review by two other lanes.
- Clean full suite: **570 files passed; 6,846 tests passed, 3 skipped, 0 failed**.
  This run used cached dependency resolution (`npm_config_offline=true`) with npm
  update notifications disabled; no fetch preloader or test suppression was used.
- Earlier unrestricted attempts were interrupted by the execution environment's
  network policy. A diagnostic-only no-network fetch shim identified a fixture
  missing the existing analyzer-decline setup. That fixture was corrected and
  checked without the shim; the final full run above does not use it.
- Pack/install checks run actual npm with lifecycle scripts enabled, under an
  external temporary wrapper forwarding arguments/status while adding only
  `--offline --update-notifier=false` and an explicit writable dependency-cache
  location (the runtime's default home does not exist). Missing cached dependencies
  remain failures.
  Standard-environment behavior must also pass exact-head GitHub CI before merge.
- The authoring-machine citation check reports its reference store unavailable;
  that material was not verified from this cloud checkout.

All checks-catalog steps, packaged audit/remediation flows, remediation gate smoke,
and the full suite passed in the release-catalog run. The linked audit leg initially
hit an unwritable default global prefix; both linked smokes subsequently passed
with an isolated writable home/prefix and the same offline policy. Thus all catalog
legs were verified, but the original aggregate invocation is not labeled successful.
Exact-head standard-environment CI is required before merge.
