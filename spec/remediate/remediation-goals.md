# Remediation Goals

This document is the normative product definition for the remediator. Other
specs and docs should defer to it. The remediator may be paired with the auditor
but runs independently; when the two are paired, read alongside the auditor's
[`spec/audit/audit-goals.md`](../audit/audit-goals.md).

## Core principles

1. Three rules, balanced case by case: use the mechanical tool wherever it does
   the job as well as or better than a model; use LLM judgment where it strongly
   lifts quality, bounded and recorded; and enforce in tooling whatever *can* be
   enforced, regardless of who does the work. This restates conviction A2 in
   [`docs/project-philosophy.md`](../../docs/project-philosophy.md), which
   GOVERNS: where this document and the philosophy differ, the philosophy wins.
2. User *questions* are confined to explicit, batched windows: an up-front
   planning window before implementation starts, a clarification window at the
   END of the implement phase for questions workers raised mid-phase, and an
   end-of-run triage window for any blocked items. No ad hoc prompts during
   implementation — a worker that hits a scoping or judgment question records it
   and returns; it never prompts the user itself, and its question never
   interrupts a sibling item's remaining work. (A batched *question* window is
   not the same thing as a pause: a run can also halt resumably without asking
   anything — waiting at a host-workload boundary is one such pause, see Resume
   semantics.
   The windows above are not an exhaustive list of every point a run can stop.)
3. Remediation is binary: every remediation item ends in a TERMINAL state, and a
   run cannot complete while any item has not. The terminal states are resolved,
   resolved with no change needed, user-confirmed ignored, deemed inappropriate,
   and abandoned (the tool gave up — retry bound exhausted, final gate red, or
   operator halt). No partial completion state: an item that reached no end state
   at all is exactly what `abandoned` exists to prevent, and abandonment is
   deliberately distinct from ignoring, so "the tool gave up" is never recorded as
   "the user decided not to act".
4. The final retained outputs are the machine contract
   `remediation-outcomes.json` (the source of truth) and its deterministic
   Markdown render `remediation-report.md`; both are written under
   `.audit-tools/` on completion.
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
planning transitions directly to implementing, and implement dispatch reads scope
from the finding. There is no per-item specification artifact at all.

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
tool derives the dependency-ready frontier from — `hostDependencyLevels`,
`src/remediate/steps/dispatch/hostHandoff.ts`; assignment, concurrency, and
execution are the host's). The stage detail — multi-agent seam negotiation,
the adversarial critic→judge→repair loop, DAG promotion metadata — is specified
in [`spec/remediation-workflow-design.md`](../remediation-workflow-design.md)
and [`spec/contract-authoring-determinism-design.md`](../contract-authoring-determinism-design.md);
this document names the mechanism and owns the output contract it produces, not
the mechanism's internals.

There is ONE plan-building mechanism traversed at two depths. The risk tier is
the dial: a `low` tier collapses coherent authoring phases into shared
round-trips and drops adversarial depth to a light inline self-check, while
`medium`/`high` keep every phase its own gated step at full depth. There is no
second producer and no path that skips the pipeline. `plan.source` records
PROVENANCE only — where a plan came from, never which engine built it — so a
plan ingested from outside the pipeline is still distinguishable from one the
pipeline authored.

## Phases

### Phase 1: Plan

Deterministic when the input is an `audit-findings.json`; LLM-assisted when the
input is Markdown, free-form, or conversational.

- Extract the findings list. Deterministic parse of `audit-findings.json`,
  LLM extraction otherwise (including `audit-report.md`), emitting the same
  `finding.schema.json` shape in either case.
- If the input already carries block assignments (as `audit-findings.json`
  does), adopt them. Otherwise, use the shared deterministic work partitioner:
  attach an advisory, content-derived token estimate for the finding plus its
  unique-file context and report that size to the host — planning never reshapes
  or splits work around a backend's context window (`applyPlanPipeline`,
  `src/remediate/phases/plan.ts`) — optimize normalized semantic/unit cohesion
  and cross-block overlap, and keep shared files/units as affinity rather than
  transitive-closure edges. Dangerous overlap is emitted as an explicit seam-preparation dependency;
  it does not force one unbounded block.
- Compute parallel-safety per block (default true unless dependencies are found).
- Detect project type and candidate closing actions (git remote, package
  metadata, release scripts) for confirmation in Phase 2.
- Emit `remediation_plan.json` conforming to the `RemediationPlan` contract (validated by the
  hand-written TypeScript validators in `src/remediate/validation/`, per the Schemas section below).

### Phase 2: Planning gates (batched review + ambiguity)

There is no separate per-item LLM "document" phase (dissolved — N-R13): planning
transitions DIRECTLY to implementing. Before any implement dispatch, two batched
gates fire at planning, each at most once per run:

- **Review-necessity gate**: every run gets exactly ONE batched keep/decline
  review before implementation, surfaced tiered by how much human review each
  item needs. A declined item becomes a RECORDED terminal disposition
  (`ignored`), never silently bulk-dispositioned inside a quality-tail node.
  Which step performs the review (and over which objects) differs by intake
  path; the obligation — one batched review per run, with recorded declines —
  is the contract, and no run is reviewed twice.
- **Ambiguity gate** (`runPlanAmbiguityGate`): every scoping/judgment ambiguity
  across all items is batched into a single `ambiguity_request.json` and
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

There is no per-item specification artifact: the implementation workload reads
file scope from `finding.affected_files`, and the ENFORCED write scope is the
block's `touched_files`. The project-level `closing_plan` persists inline on
`RemediationState` (`state.closing_plan`), validated against `ClosingPlanSchema`
before the next phase may read it.

After the gates exit cleanly, the next user *question* is the deferred
clarification window at the end of Phase 3, or the end-of-run triage window.

### Phase 3: Implement (host-executed LLM work)

The tool emits every dependency-ready block as a complete provider-neutral host
workload. Each item carries its bounded prompt, scope, worktree binding, result
path, and content-derived metadata. The host chooses sequential or parallel
execution; audit-tools does not configure or infer host concurrency.

**Deterministic Merge & Fallback:**
Completed work is accepted in the workload's deterministic item order. Worktrees, merging, and test execution belong to the HOST: the tool emits the workload and, on ingestion, validates the evidence the host reports back (`src/remediate/steps/dispatch/hostHandoff.ts`). A landing is accepted only when the host attests `merge.status: "merged"` on an accepted result; anything else is refused, and the node is re-entered into the end-of-run triage window (retry vs. block) rather than merged — there is no category-sorted sequential fallback queue.

Within a block, each item runs through:

1. Write tests from the finding — its title, summary and `affected_files`.
   Tests must fail on the current code where a test step is applicable.
2. Refactor code until the item's tests pass.
3. Run the affected test scope deterministically and record results.
4. LLM-verify the produced code against the finding. Conformance check, not a
   freshness opinion: catches cases where tests pass but the change deviates
   from the stated intent.

Per-item state: `pending -> tested -> tested_successfully -> refactored -> verified -> resolved`
(or `resolved_no_change`), with side-states `blocked`, `needs_clarification`, `deemed_inappropriate`,
`ignored`, and `abandoned` reachable at defined points (`abandoned` is the tool giving up — retry bound
exhausted, final gate red, or operator halt — so that every item ends terminal). A blocked item does
not stop sibling items in the same block or other blocks from making progress.

**Deferred clarifications.** A worker that hits a scoping or judgment question
sets `needs_clarification`, records the question, and returns. That does NOT halt
the run: pending work keeps dispatching, and the questions are batched into one
window at the END of the implement phase, once the eligible dispatch frontier has
drained. Because a `needs_clarification` item is not verified-complete, its
dependents are ineligible while the answer is outstanding — they are HELD
`pending`, explicitly distinguished from nodes whose upstream genuinely failed
(`dependencyAwaitingClarification`), so an unanswered question is never recorded
as "upstream failed". Once the answer lands, a re-opened upstream makes the
dependents eligible and a disposed (skipped) upstream dead-ends them with the
accurate reason.

Every item that can make progress does, even if other items are blocked or
awaiting an answer. No item-level user prompts during Phase 3. Phase 3 does not
run to completion in one call: like every phase it advances one bounded step per
invocation, and it can halt mid-phase at the provider-neutral host handoff or
re-block at a phase-boundary test gate. A host that cannot yet complete an item
leaves its bound result absent; no backend failure class is persisted by audit-tools.

### Phase 3b: Triage (user, batched)

After Phase 3 terminates, if any items are `blocked` the remediator batches
them into a single triage interaction:

- for each blocked item, the recorded failure and the last successful step,
- user chooses per item: retry (optionally with new guidance), mark ignored
  (with rationale), or halt the run.

Retried items re-enter Phase 3. Ignored items are terminal and recorded in
the final report. Halt leaves durable state and exits.

Triage and the deferred clarification window are the user interactions after
Phase 2. If Phase 3 produces no blocked items, Phase 3b is skipped.

### Phase 4: Close

- Run the full unit/integration test suite on the combined post-remediation
  state. If it fails, the run is not complete; offending items move to
  `blocked` and Phase 3b is re-entered.
- Run end-to-end tests if an `e2e_command` was detected in Phase 1. Because
  individual per-finding refactors may be interdependent, e2e tests run once
  after all findings are resolved rather than per-block. A failure here
  transitions the run back to triage — it does not throw. The code changes are
  complete but not shippable until the e2e issue is investigated, and triage is
  where that investigation is scheduled.
- Render `remediation-report.md` from the durable item records.
- Remove `.audit-tools/remediation/` and any scratch files, logs, or branches
  created only to support remediation — but ONLY after a fully-green close
  (combined tests passed, e2e passed, closing actions completed, nothing
  blocked). Otherwise the artifacts directory is preserved for diagnosis.
- Execute the confirmed closing action. The fixed enumeration is:
  `commit`, `push`, `open-pr`, `publish`, `tag`, `none`, `custom`. The
  `custom` option takes a user-supplied command and records its exit code
  and output; it is an explicit opt-out from Phase 4 determinism.

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
- ambiguity identification (no per-item write-up phase)
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
contract (`RemediationPlan`, `RemediationBlock`, `ClarificationRequest`, `ClosingPlan`,
`TestSpec`, the remediation report) is validated by hand-written TypeScript validator functions
(`src/remediate/validation/remediationState.ts`, `src/remediate/validation/contractPipeline.ts`,
`src/remediate/validation/contractPipelineGates.ts`, `src/remediate/validation/artifacts.ts`),
not JSON Schema files. `TriageBatch` is an internal wire type local to
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

- every item is in a terminal state (`resolved`, `resolved_no_change`,
  `deemed_inappropriate`, user-confirmed `ignored`, or `abandoned`),
- the full unit/integration test suite passes on the combined post-remediation state,
- end-to-end tests pass (if an `e2e_command` was detected),
- the configured closing action has either executed or been explicitly
  recorded as skipped,
- `remediation-outcomes.json` and its render `remediation-report.md` have been
  written under `.audit-tools/`,
- `.audit-tools/remediation/` has been cleared.

If any condition fails, the run is not complete and resumable state is
retained.

## Final output

The machine contract is `remediation-outcomes.json`; its render
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

An incomplete host workload is resumable: accepted prompt-bound results remain
recorded, while items without an accepted result stay pending and are emitted
again from the dependency-ready frontier. Backend retries, allowance recovery,
and transport errors remain host state and never enter the remediation schema.

## Parallelism

Host-owned. The tool exposes all currently eligible items without choosing a
parallelism level. Regardless of how the host executes them:

- parallel-safety is determined deterministically in Phase 1 and is NOT revoked by
  an LLM `public_contract` inference (that automatic stripping is not wired); a
  dependency that surfaces later is resolved through triage.
- each parallel block runs in an isolated workspace (worktree or
  equivalent),
- merge-back is serialized in deterministic workload order; the host performs the
  merge and the tests, and a node whose reported evidence does not attest a
  completed landing is refused into the end-of-run triage window (there is no
  sorted sequential fallback queue — see Phase 3's Deterministic Merge &
  Fallback).
- Phase 4 re-validates the final combined tree.
