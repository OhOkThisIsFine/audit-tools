# Dependency map

## Purpose

This document defines artifact dependencies and the default staleness rules used by the orchestrator.

## Rule

If an upstream artifact changes, all dependent downstream artifacts should be considered stale unless an executor explicitly proves otherwise.

## Canonical direction: artifact → what it depends on

The single hand-authored adjacency table is `ARTIFACT_DEPENDS_ON_MAP` in
`src/audit/orchestrator/dependencyMap.ts`, keyed `{ artifact → dependsOn[] }` — the
natural direction for `computeArtifactMetadata`, which records each artifact's
upstream revisions and reduces stale detection to a revision/hash compare. The
inverse "upstream → its dependents" view (`ARTIFACT_DEPENDENTS_MAP`, used by
`computeStaleArtifacts` to propagate staleness downstream) is *derived* from this
table by `invertDependencyMap` — there is exactly one hand-authored adjacency
representation, so the two views can never drift. This document mirrors the
canonical (upstream) direction for the same reason.

The [generated dependency tables](dependency-map.generated.md) mirror the registry and are checked by
`npm run check:spec-mirrors`. Their headings group rows and do not define executor order.

### Phase 1 — intake

[Generated Phase 1 table](dependency-map.generated.md#phase-1).

`repo_manifest.json` is rebuilt when the tooling/environment probe changes (a
different analyzer version can classify files differently).

### Phase 2 — structure

[Generated Phase 2 table](dependency-map.generated.md#phase-2).

`charter_clarification.json` (Phase D charter-difference clarification loop) and
`systemic_challenge.json` (Phase E second-order-adversary challenge loop) both
anchor to the same triad as `charter_register.json` so the two conceptual-review
outputs stale together whenever the charter register, the intent ceiling, or the
repo manifest changes.

`critical-flow-fallback.json` is a durable HOST INPUT (a leaf, like
`intent_checkpoint.json`): the critical-flow LLM fallback pass writes the
host-authored flow enrichment there when the deterministic inference falls below
its confidence bar, and the structure phase merges it into `critical_flows.json`.
Declaring it upstream of `critical_flows.json` is what makes the enrichment take
effect cleanly — the submission re-stales `critical_flows.json`, so structure
rebuilds `critical_flows.json` AND its `risk_register.json` sibling atomically off
the merged flows (no self-clobber from a separate post-hoc rewrite). Absent on the
common bar-met path → recorded at revision 0, never stale.

`critical_flows.json` and `surface_manifest.json` read the dependency graph, but
deliberately do NOT list `graph_bundle.json`. The structure phase builds the
regex-floor graph IN THE SAME CALL and hands it straight to both, so their real
inputs are the floor's own upstreams (`repo_manifest.json`,
`file_disposition.json`), which they already declare. The persisted
`graph_bundle.json` revision also moves when graph enrichment (a later
obligation) merges analyzer edges, so a direct edge would re-stale
`critical_flows.json` after every enrichment. Structure would then rebuild the
floor graph, which re-stales `analyzer_capability.json`, which re-runs
enrichment: the loop never settles.

`analyzer_capability.json` is the marker recording the outcome of the optional
graph-enrichment pass (its shape is defined in
[`spec/audit/artifact-contract.md`](artifact-contract.md)); the merged analyzer
edges themselves live in `graph_bundle.json`
(with `analyzers_used[]` provenance). No cycle: the enrichment executor writes
`graph_bundle.json` **and** the marker in one `advanceAudit` call, and metadata
is computed dependency-first, so the marker records the post-enrichment graph
revision (mirrors `audit-findings.json` → `synthesis-narrative.json` below).

`intent_checkpoint.json` is a durable host input (a leaf, with no upstream row of
its own), but its *revision* is not the ordinary content/deps-change bump: while a
gate-current `artifact_metadata.intent_baseline` exists, the intent entry's
revision MIRRORS `intent_baseline.revision` (`computeArtifactMetadata` in
`src/audit/orchestrator/artifactMetadata.ts`). Only the intent-equivalence
executor advances that baseline, and only at a committed resolution (structured
delta / judged-`changed` / stale gate) — so a re-confirmed provenance or a pending
prose judgment never re-stales the downstreams that list `intent_checkpoint.json`,
and a committed change re-stales them exactly once. The mirror can never rewind
below the entry's previous revision: a previous revision above the baseline means
ordinary bumps happened while the mirror was inactive (a gate-version-stale
window), and snapping back would hide them from downstream `dependency_revisions`
compares.

`docs_digest.json` (change 3, scope-confirmation context) is the bounded
deterministic telos extraction over the doc universe (the single
`isDocIntentFile` predicate), rendered into the confirm-intent prompt so the
scope decider sees the repo's stated purpose. Its dependencies are exactly what
the extractor reads — the disposition selects the doc universe, and
`repo_manifest.json`'s per-file hashes re-stale it transitively when a doc's
content changes. It deliberately has NO downstream row, and it must never be
declared upstream of `intent_checkpoint.json`: the checkpoint is a durable
host-input leaf whose revision mirrors the intent baseline, and an edge here
would re-stale a confirmed checkpoint on every doc edit.

`external_analyzer_acquisition.json` is the external-analyzer acquisition marker
(over the curated `EXTERNAL_ANALYZER_CANDIDATES` registry in
`src/shared/analyzers/candidates.ts` — `defaultRun: true` members run without the
per-run consent token; every other candidate requires it) — a run-record + staleness anchor
with no downstream of its own; the findings it produces land in
`external_analyzer_results.json` (a leaf input to structure and Phase 3, absent from THIS
dependency table because nothing declares an upstream dependency for it — it does
appear in the producer table below, where the acquisition executor is one of its
three writers).

### Phase 3 — planning & execution

[Generated Phase 3 table](dependency-map.generated.md#phase-3).

`scope.json` records full scope or, for `--since`, the changed seed and expanded
neighbor file sets. It is a direct input to `review_plan.json`; planning writes
both in one call, dependency-first. The selected lenses and admitted evidence
determine the questions. A suggested file is a starting point, not a completed
review obligation.

The run-scoped accepted-answer ledger is outside this DAG. Question dispatch
and synthesis project it against the current plan, so neither a stale binding
nor a legacy per-file result can close current work. Retired per-file artifacts
are raw archival evidence, not dependency inputs.

### Phase 4 — reporting

[Generated Phase 4 table](dependency-map.generated.md#phase-4).

`review_plan.json` is a declared dependency of both `audit-findings.json` and
`audit-report.md`. Synthesis writes the machine report and its Markdown render
together. An accepted answer, adjudication, or consolidation can change
reporting without changing the plan revision: current-pair verification also
checks the accepted ledger. The optional narrative marker tracks the machine
report; narrative changes do not close unanswered questions or add findings.

### `agent-feedback.jsonl` (not a registry entry)

Opt-in worker-appended meta-audit reflections (NDJSON; schema `AgentReflectionSchema` in
`src/shared/agentReflections.ts`). Workers own this file — the orchestrator only
reads it (parsed leniently into `bundle.agent_reflections`; it is not a writable
registry entry, so it is never rewritten or pruned). Synthesis renders the
parsed reflections as the report's "Process Feedback" section. Only the human
render depends on it — `audit-findings.json` (the machine contract) carries no
reflections. Because no executor writes the file, `advanceAudit` treats it as
always-updated when computing metadata (the same pattern as `tooling_manifest.json`):
a reflection appended after synthesis bumps its revision and re-stales the report
exactly once; an unchanged file keeps its revision, so finalization converges.

## Which executor produces each artifact

The producer relation is DECLARED in code, on `EXECUTOR_REGISTRY[].produces`
(`src/audit/orchestrator/executors.ts`), with `LIFECYCLE_PRODUCTIONS` in the same
module covering the artifacts the run lifecycle writes outside every executor.
The by-artifact view is generated from that declaration into
[`executor-producers.generated.md`](executor-producers.generated.md); a producer
edge is added by editing the registry, never a table.

## Staleness policy examples

### Example 1

If `repo_manifest.json` changes, every artifact whose [generated dependency row](dependency-map.generated.md)
lists `repo_manifest.json` is stale, and so is every artifact downstream of
those — the structure rows first, then the planning, execution and reporting rows
that list a stale artifact. The generated tables are the sole authoritative
enumeration; this example deliberately names none of them, so it cannot omit
one.

### Example 2

If the confirmed scope changes, the question plan becomes stale, and so do its
dependent reports. Earlier structure inputs do not become stale solely because
the scope changed.

### Example 3

If an answer is accepted for the same question revision, the plan need not
change. An older report pair no longer matches the accepted ledger and must
be regenerated before it can be presented as current.

## Implementation note

The canonical machine-readable form of this map is `ARTIFACT_DEPENDS_ON_MAP` in
`src/audit/orchestrator/dependencyMap.ts`. That table is the single hand-authored
adjacency representation: it is keyed `{ artifact → dependsOn[] }`, and the
forward "upstream → dependents" view (`ARTIFACT_DEPENDENTS_MAP`) is derived from
it via `invertDependencyMap` — so the two adjacency views can never drift.
`computeStaleArtifacts` (in `src/audit/orchestrator/staleness.ts`) uses the
derived dependents map to propagate staleness downstream deterministically.
This document is the declarative reference; the TypeScript table is the
authoritative implementation.
