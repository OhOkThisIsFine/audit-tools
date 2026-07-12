# Remediation Goals

This document is the normative product definition for the remediator. Other
specs and docs should defer to it. The remediator may be paired with the auditor
but runs independently; when the two are paired, read alongside the auditor's
[`spec/audit-goals.md`](../audit/audit-goals.md).

## Core principles

1. Automate every step that can be automated; reserve the LLM for judgment
   calls that cannot be reduced to a deterministic rule.
2. User interaction is confined to explicit, batched windows: an up-front
   planning window before implementation starts, and an end-of-run triage
   window for any blocked items. No ad hoc prompts during implementation.
3. Remediation is binary: every remediation item is resolved, deemed
   inappropriate, or user-confirmed ignored. No partial completion state.
4. The final retained output is deterministic Markdown at
   `remediation-report.md`.
5. Remediation must resume cleanly after interruption at any phase boundary.

## Inputs

Remediator accepts any of:

- An `audit-findings.json` produced by `audit-code` — the canonical machine
  contract. Finding extraction from it is deterministic: findings, work-block
  assignments, and synthesis themes are adopted verbatim, with no LLM involved.
- An audit document in free-form Markdown or other text — including
  `audit-code`'s human-facing `audit-report.md`. Findings are extracted by
  the LLM.
- A conversation transcript or user-supplied list of issues. Findings are
  extracted by the LLM.

Audit-code only retains the finalized report and `audit-findings.json` on
success, so remediator does not rely on `.audit-tools/audit/` being present.

Remediator does not re-run the auditor and does not modify its inputs.

## Concepts

- **Finding**: a single issue to remediate. Atomic unit of outcome reporting.
- **Item**: the concrete change associated with one finding. Findings map
  1:1 to items.
- **Block**: a bundle of items that must be remediated together because they
  write to overlapping files. A block is the unit
  of parallel dispatch, not the unit of outcome reporting. Items within a
  block may have different outcomes.

These are the output-contract vocabulary — the shapes every run reports
against — and are independent of *how* the plan that produces them is built.
The plan-building mechanism is named below (Planning mechanisms).

## Workflow

Every item follows the ordered workflow:

```
Write Tests -> Refactor Code -> Verify Code Against Tests -> Verify Code Against Documentation
```

There is no separate per-item "document" authoring step (dissolved — N-R13):
planning emits an OPTIONAL `item_spec` enrichment, and when it is absent implement
dispatch reads scope directly from the finding. Steps may be declared
not-applicable per item (for example, a comment-only fix has no test step); the
declaration is part of the item record.

## Planning mechanisms

The normative goals above are realized through the **contract-pipeline** — the
planning engine that turns confirmed intent into an implementation DAG whose
nodes each trace to a finding *and* a derived obligation. The pipeline advances
through a fixed sequence of contract stages: `goal_spec` (normalized goals and
constraints) → `context_bundle` (affected files and evidence) →
`module_decomposition` (module list, responsibilities, file scope) →
per-module contract drafting and seam reconciliation → `obligation_ledger`
(one verification/test obligation per invariant and seam) → test/validator plan
and design gates → `implementation_dag` (the metadata-enriched node graph the
rolling dispatcher executes). The stage detail — multi-agent seam negotiation,
the adversarial critic→judge→repair loop, DAG promotion metadata — is specified
in [`spec/remediation-workflow-design.md`](../remediation-workflow-design.md)
and [`spec/contract-authoring-determinism-design.md`](../contract-authoring-determinism-design.md);
this document names the mechanism and owns the output contract it produces, not
the mechanism's internals.

The Finding → Item → Block mechanism described under Phases below (the
deterministic/LLM plan phase in `src/remediate/phases/plan.ts`) is the
**alternate/legacy planning source**. A plan built by the contract pipeline or
the lean fast path carries a `plan.source` tag recording which mechanism built
it (`contract_pipeline` for the primary engine, `lean_fast_path` for its
bounded Path-A shortcut); a plan built by the Finding/Item/Block plan phase
leaves `source` unset, so its absence is itself the third case — the
mechanisms are distinguished at the artifact level. Whichever source produced the plan, it
converges on the same output contract (Finding / Item / Block, `ItemSpec`,
`TestSpec`) and the same downstream implement→close machinery.

## Phases

### Phase 1: Plan

Deterministic when the input is an `audit-findings.json`; LLM-assisted when the
input is Markdown, free-form, or conversational.

- Extract the findings list. Deterministic parse of `audit-findings.json`,
  LLM extraction otherwise (including `audit-report.md`), emitting the same
  `finding.schema.json` shape in either case.
- If the input already carries block assignments (as `audit-findings.json`
  does), adopt them. Otherwise, compute blocks deterministically by **File
  Overlap**: findings that touch the exact same files group into one block.
  (Richer co-location signals — grouping by overlapping test suites, or by git
  co-commit history — are documented future enrichment, not yet built.)
- Compute parallel-safety per block (default true unless dependencies are found).
- Detect project type and candidate closing actions (git remote, package
  metadata, release scripts) for confirmation in Phase 2.
- Emit `remediation_plan.json` conforming to the `RemediationPlan` contract (validated by the
  hand-written TypeScript validators in `src/remediate/validation/`, per the Schemas section below).

### Phase 2: Planning gates (batched review + ambiguity)

There is no separate per-item LLM "document" phase (dissolved — N-R13): planning
transitions DIRECTLY to implementing. Before any implement dispatch, two batched
gates fire at planning, each at most once per run:

- **Review-necessity gate** (`runPlanningReviewGate`): the plan's nodes are
  surfaced tiered by how much human review each needs, for a batched keep/decline.
  A declined node becomes a RECORDED terminal disposition (`ignored`), never
  silently bulk-dispositioned inside a quality-tail node.
- **Ambiguity gate** (`runPlanAmbiguityGate`): every scoping/judgment ambiguity
  across all items is batched into a single `clarification_request.json` and
  surfaced to the user at once (categories under Ambiguity criteria below).
  Remediation halts until every clarification is resolved.

The LLM also confirms the project-level closing action selected by Phase 1, or
proposes an alternative, including the `custom` escape hatch for user-supplied
commands.

**Dependency ambiguity:** `public_contract` is one of the recognized ambiguity
kinds; when an item is flagged with it the ambiguity rides the clarification batch
for user resolution. Automatic `parallel_safe` stripping from the tag alone is
**not** wired — parallel-safety is computed deterministically at plan time, and a
dependency that surfaces later is resolved through triage.

Appropriateness decisions are per-item, not per-block. The LLM may propose marking
any individual item "deemed inappropriate"; that proposal rides the same
clarification batch and requires user confirmation. A block may contain some items
that are remediated and others declared inappropriate without dropping the block.

`ItemSpec` is OPTIONAL enrichment, not a mandatory per-finding write-up: when a
node carries one it seeds test authoring and the code-vs-spec conformance check;
when it is absent, implement dispatch reads file scope directly from
`finding.affected_files` (`buildImplementDispatchItem`). Any produced `item_spec`
and the project-level `closing_plan` persist inline on `RemediationState`
(`state.items[id].item_spec`, `state.closing_plan`), validated against
`ItemSpecSchema` / `ClosingPlanSchema` before the next phase may read them.

After the gates exit cleanly, no further user interaction occurs until the
end-of-run triage window.

### Phase 3: Implement (LLM, sequential or parallel)

Blocks are dispatched in dependency order. When the harness supports it and
a block is parallel-safe, blocks may run in isolated worktrees. Sequential
execution is the default.

**Deterministic Merge & Fallback:**
Parallel worktrees must be merged back into the main branch in the exact order they were originally dispatched. Before merging, the worktree is rebased onto the current `HEAD` and tests are run. If tests fail, the node is quarantined and re-entered into the end-of-run triage window (retry vs. block) rather than merged — there is no category-sorted sequential fallback queue.

Within a block, each item runs through:

1. Write tests from the Phase 2 item spec. Tests must fail on the current
   code where a test step is applicable.
2. Refactor code until the item's tests pass.
3. Run the affected test scope deterministically and record results.
4. LLM-verify the produced code against the Phase 2 item spec. Conformance
   check, not a freshness opinion: catches cases where tests pass but the
   change deviates from written intent.

Per-item state: `pending -> tested -> tested_successfully -> refactored -> verified -> resolved`
(or `resolved_no_change`), with side-states `blocked`, `needs_clarification`, `deemed_inappropriate`,
and `ignored` reachable at defined points. A blocked item does not stop sibling items in the same
block or other blocks from making progress.

Phase 3 runs to termination. Every item that can make progress does, even
if other items are blocked. No item-level user prompts during Phase 3.

### Phase 3b: Triage (user, batched)

After Phase 3 terminates, if any items are `blocked` the remediator batches
them into a single triage interaction:

- for each blocked item, the recorded failure and the last successful step,
- user chooses per item: retry (optionally with new guidance), mark ignored
  (with rationale), or halt the run.

Retried items re-enter Phase 3. Ignored items are terminal and recorded in
the final report. Halt leaves durable state and exits.

Triage is the only user interaction after Phase 2. If Phase 3 produces no
blocked items, Phase 3b is skipped.

### Phase 4: Close

- Run the full unit/integration test suite on the combined post-remediation
  state. If it fails, the run is not complete; offending items move to
  `blocked` and Phase 3b is re-entered.
- Run end-to-end tests if an `e2e_command` was detected in Phase 1. Because
  individual per-finding refactors may be interdependent, e2e tests run once
  after all findings are resolved rather than per-block. A failure here
  hard-errors the run: the code changes are complete but not shippable until
  the e2e issue is investigated. E2e failures do not re-enter triage because
  they are not attributable to a single item.
- Render `remediation-report.md` from the durable item records.
- Remove `.audit-tools/remediation/` and any scratch files, logs, or
  branches created only to support remediation.
- Execute the confirmed closing action. The fixed enumeration is:
  `commit`, `push`, `open-pr`, `publish`, `tag`, `merge-to-base`, `none`, `custom`.
  `merge-to-base` lands the run as a single revertable `--no-ff` merge into the
  branch it was launched from (aborting safely on conflict) — the opt-in fix
  for runs dispatched on an isolated `remediation/<runId>` branch that would
  otherwise never reach the base branch. The `custom` option takes a
  user-supplied command and records its exit code and output; it is an
  explicit opt-out from Phase 4 determinism.

## Deterministic vs LLM boundaries

Deterministic responsibilities:

- finding extraction from an audit-code `audit-findings.json`
- block derivation and parallel-safety computation
- project-type and closing-action detection
- test execution and result capture
- state persistence and resume
- artifact cleanup
- closing-action execution (except `custom`)
- final Markdown rendering

LLM responsibilities:

- finding extraction from Markdown, free-form, or conversational inputs
- ambiguity identification and optional `item_spec` enrichment (no mandatory
  per-item write-up phase)
- test authoring
- refactor authoring
- code-vs-documentation conformance verification

## Ambiguity criteria

An item is ambiguous when a reasonable engineer could read the finding and
produce materially different code. To keep the Phase 2 clarification batch
uniform and schema-able, each ambiguity is tagged with one of a fixed set
of categories. The LLM must pick a category; free-form ambiguity is not
accepted.

Starting category set:

- `public_contract` — change affects an exported symbol, HTTP route, CLI
  flag, config key, database schema, or other externally observable
  surface.
- `behavioral_semantics` — the fix admits multiple behaviors (error
  handling choice, ordering, concurrency, retry policy) and the finding
  does not specify which.
- `scope_of_fix` — finding can be resolved by a surgical patch or a
  broader restructuring; both are defensible.
- `dependency_introduction` — fix would add, remove, or upgrade a
  third-party dependency.
- `compatibility_policy` — breaking and non-breaking resolutions both
  exist.
- `intent_vs_symptom` — finding describes a symptom with multiple
  plausible root causes; LLM cannot pick without user intent.
- `issue_appropriateness` — LLM believes the finding is incorrect,
  obsolete, or describes intentional existing behavior; proposes
  `deemed-inappropriate`.

Style, internal naming, comment wording, import order, local structure
when behavior is clear, and test naming are explicitly not ambiguous —
the LLM decides.

This category list is the starting proposal and is expected to be
refined once the first runs produce real clarification batches.

## Schemas

Only `finding.schema.json` is mirrored in `schemas/` as a JSON Schema. The rest of the remediation
contract (`RemediationPlan`, `RemediationBlock`, `ItemSpec`, `ClarificationRequest`, `ClosingPlan`,
`TestSpec`, the remediation report) is validated by hand-written TypeScript validator functions in
`src/remediate/validation/` (`remediationState.ts`, `contractPipeline.ts`, `contractPipelineGates.ts`,
`artifacts.ts`), not JSON Schema files. `TriageBatch` is an internal wire type local to
`src/remediate/phases/triage.ts`, not a `state/types.ts` contract type.

Every phase transition validates its output against the relevant validator before the next phase may
read it.

## Intermediate status

At any point the remediator can emit a status summary listing, per item:

- items resolved (id, one-line resolution),
- items in-progress with current step,
- items blocked with reason,
- items deemed inappropriate or ignored (with rationale),
- outstanding clarifications, if any.

This mirrors the auditor's `advance` output and is the surface for
orchestration tooling.

## Completion

Remediation is complete only when:

- every item is in a terminal state (resolved, deemed-inappropriate, or
  user-confirmed ignored),
- the full unit/integration test suite passes on the combined post-remediation state,
- end-to-end tests pass (if an `e2e_command` was detected),
- the configured closing action has either executed or been explicitly
  recorded as skipped,
- `remediation-report.md` has been rendered at repo root,
- `.audit-tools/remediation/` has been cleared.

If any condition fails, the run is not complete and resumable state is
retained.

## Final output

`remediation-report.md` lists, in order:

- items resolved (with finding id, summary, and verification evidence),
- items deemed inappropriate (with rationale captured in Phase 2),
- items ignored after triage (with rationale captured in Phase 3b),
- combined-state test result,
- closing-action result.

Root-cause clustering is not part of the product. Re-auditing is left to
the user.

## Resume semantics

Only minimal resumable state lives under `.audit-tools/remediation/` during
a run. On resume the remediator reads persisted item state and continues
from the last non-complete step of each item. User-answered clarifications
and triage decisions are persisted so resume does not re-prompt.

## Parallelism

Optional. Default sequential. Enabled per-run via configuration. When
enabled:

- parallel-safety is determined deterministically in Phase 1 and is NOT revoked by
  an LLM `public_contract` inference (that automatic stripping is not wired); a
  dependency that surfaces later is resolved through triage.
- each parallel block runs in an isolated workspace (worktree or
  equivalent),
- merge-back is serialized in deterministic dispatch order; before merging, the
  worktree is rebased onto `HEAD` and tests run, and on failure the node is
  quarantined into the end-of-run triage window (there is no sorted sequential
  fallback queue — see Phase 3's Deterministic Merge & Fallback).
- Phase 4 re-validates the final combined tree.
