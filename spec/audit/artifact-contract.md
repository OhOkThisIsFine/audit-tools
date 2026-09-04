# Artifact contract

## Purpose

Artifacts are the continuity layer for the single-entrypoint audit engine. They are the authoritative representation of current audit state between invocations.

## Artifact rules

1. Every artifact must have a defined producer.
2. Every artifact must have defined freshness dependencies.
3. Artifacts must be machine-readable and stable.
4. Orchestration decisions should be based on artifacts, not hidden transient reasoning.

## Source of truth

The canonical, machine-readable artifact registry is `ARTIFACT_DEFINITIONS` in
`src/audit/io/artifacts.ts` — one entry per artifact, each declaring a filename, a phase
(`intake` / `analysis` / `execution` / `reporting` / `supervisor`), and typed
read/write functions (JSON, NDJSON, or plain text). This document is the
declarative reference; that table is authoritative. For exact upstream
dependencies (staleness edges) per artifact, see
[`dependency-map.md`](dependency-map.md) — not duplicated here. For which
executor produces which artifact and its obligation id, see
[`executor-catalog.md`](executor-catalog.md) — also not duplicated here.

Design-review snapshots (per-pass semantic projections), the per-file graph-edge
cache (incremental graph-build reuse), and run-scoped host workload/binding/
accepted-result ledgers participate in orchestrator state but are not
`ARTIFACT_DEFINITIONS` entries. `agent-feedback.jsonl` is also outside the
registry—host-appended and orchestrator-read-only—but does participate in the
staleness DAG (see dependency-map.md).

## Artifacts by phase

The five tables below are GENERATED from `ARTIFACT_DEFINITIONS` by
`scripts/shared/generate-spec-mirrors.mjs` (`npm run check:spec-mirrors` gates
them). Filename, format and phase come from the registry; the *Purpose* prose and
the one deliberate non-registry row are declared in
`scripts/shared/spec-mirror-data.mjs`. Never hand-edit between the markers — add
the artifact to the registry, its purpose to the declaration, and re-run the
generator.

### Intake

<!-- BEGIN GENERATED spec-mirror artifact-contract#intake — scripts/shared/generate-spec-mirrors.mjs — DO NOT EDIT BY HAND -->
| Artifact | Format | Purpose |
|---|---|---|
| `repo_manifest.json` | JSON | Repository structure and file classification. |
| `file_disposition.json` | JSON | Per-file audit-scope disposition derived from the manifest. |
| `auto_fixes_applied.json` | JSON | Record of mechanical auto-fixes applied before review. |
| `intent_checkpoint.json` | JSON | User/host-confirmed audit intent and lens propositions. |
<!-- END GENERATED spec-mirror artifact-contract#intake -->

### Analysis

<!-- BEGIN GENERATED spec-mirror artifact-contract#analysis — scripts/shared/generate-spec-mirrors.mjs — DO NOT EDIT BY HAND -->
| Artifact | Format | Purpose |
|---|---|---|
| `unit_manifest.json` | JSON | Parsed units (functions/classes/modules). |
| `graph_bundle.json` | JSON | Dependency/call graph, with optional external-analyzer edge enrichment. |
| `surface_manifest.json` | JSON | Public API surface and exports. |
| `critical_flows.json` | JSON | Identified critical execution/data flows. |
| `critical-flow-fallback.json` | JSON | Durable host input: the LLM fallback flow enrichment authored when `critical_flows.fallback_required` is set. Merged into `critical_flows.json` by the structure phase. REGISTERED in `ARTIFACT_DEFINITIONS` and a declared leaf of the staleness DAG — the file itself is the durable input. |
| <!-- doc-citation-exempt: transient host submission — written and deleted at runtime --> `intent-equivalence-verdict.json` | JSON | **Transient host submission** — NOT registered, NOT a staleness-DAG participant: the DD-9 gate's verdict on whether a re-stated intent still means what the confirmed checkpoint meant. Authored only for a prose-only delta — every other arm resolves deterministically without host input. Written by the host to the tool-computed path its step contract binds (`submissions/<sha256(submission_id)>.json`), validated, and — once applied — consumed and DELETED; a submission that validates but cannot be applied is quarantined and recorded, never dropped; the accepted judgment is materialized into `artifact_metadata.intent_baseline`, which is the revision authority. Per DD-9 no verdict-pair cache is persisted, so the executor writes no artifact — do not "fix" its absence from the registry by adding a row. |
| `flow_coverage.json` | JSON | Coverage of critical flows by ingested results. |
| `risk_register.json` | JSON | Per-unit risk signals (see `src/audit/extractors/risk.ts` for the full signal list). |
| `git_history.json` | JSON | Deterministic co-change/churn/authorship mined from the commit log. |
| `design_assessment.json` | JSON | Deterministic + optional host-delegated design assessment (see below). |
| `conceptual_review_adjudication.json` | JSON | Validated adjudication of deep conceptual-review findings, candidate dispositions (each carrying the judge's `verification_status`), final finding shares, and the tool-derived candidate disposition/verification breakdowns. |
| `docs_digest.json` | JSON | Deterministic bounded telos extraction over the doc universe; rendered into the confirm-intent prompt. NO downstream edge, and never an upstream of `intent_checkpoint.json` (checkpoint stays a leaf). |
| `structure_decomposition.json` | JSON | Deterministic structure-layer decomposition (overlay-and-delta operator over behavior-graph + intent sources); emits non-co-localization findings. |
| `charter_register.json` | JSON | Phase-C charter layer (carries a stamped schema version and is discarded on mismatch, DISCARD read policy — regenerable analysis state): three channel-pure estimator charters with per-kind teleologies joined by file-set overlap over the structure-decomposition hint, plus the miner's deltas, triangulated teloses, and tool-counted disagreement density; gated by the confirmed intent-checkpoint ceiling. |
| `charter_clarification.json` | JSON | Phase-D charter-alignment triangulation loop over the charter register, gated by the confirmed intent-checkpoint ceiling. |
| `systemic_challenge.json` | JSON | Phase-E second-order-adversary improvement-seeking challenge loop over the charter register, gated by the confirmed intent-checkpoint ceiling. |
| `analyzer_capability.json` | JSON | Marker: what the optional graph-enrichment pass actually produced (`coverage`, in the shared measured-outcome vocabulary, derived from the entries over the analyzers that were ASKED FOR) + per-analyzer provenance. |
| `external_analyzer_acquisition.json` | JSON | Marker: external-analyzer acquisition run record over the curated `EXTERNAL_ANALYZER_CANDIDATES` registry in `src/shared/analyzers/candidates.ts` — `defaultRun: true` members run without the per-run consent token; every other candidate requires it. |
<!-- END GENERATED spec-mirror artifact-contract#analysis -->

`flow_coverage.json` is listed here at `analysis` phase per `ARTIFACT_DEFINITIONS`
even though it's computed after execution — the phase tag reflects where it's
declared in the registry, not a strict pipeline-order guarantee.

The design-assessment portion may include observational contract assessment.
That mode infers existing contracts from the repository artifacts and inspected
code: invariants, trust boundaries, preconditions, postconditions, data
lifecycle obligations, and critical-flow guarantees. It should attack those
inferred contracts with concrete counterexamples and report evidenced gaps using
categories such as `inferred_contract_gap`, `trust_boundary_gap`,
`invariant_counterexample`, and `critical_invariant_coverage_gap`. It must not
invent a new contract DSL, create a remediation plan, edit source code, or turn
audit-code into an implementation pipeline.

### Execution

<!-- BEGIN GENERATED spec-mirror artifact-contract#execution — scripts/shared/generate-spec-mirrors.mjs — DO NOT EDIT BY HAND -->
| Artifact | Format | Purpose |
|---|---|---|
| `scope.json` | JSON | How this run was scoped (`full` vs. `delta` with `--since` seed/expanded file sets). |
| `coverage_matrix.json` | JSON | Task allocation matrix: files × lens buckets, tracks which are queued/complete. |
| `runtime_validation_tasks.json` | JSON | Runtime-validation task specs derived from risk + coverage. |
| `runtime_validation_report.json` | JSON | Runtime-validation results (initial + import-refreshed). |
| `external_analyzer_results.json` | JSON | Normalized findings from acquired external analyzers. |
| `syntax_resolution_status.json` | JSON | Per-file syntax-parse status and failures. |
| `audit_results.jsonl` | **NDJSON** | Ingested `AuditResult` records, one per line — not a `.json` array. |
| `audit_tasks.json` | JSON | Task specifications for external (host-delegated) audit execution. |
| `audit_plan_metrics.json` | JSON | Planning metrics and cost estimates for the current task set. |
| `task_affinity_graph.json` | JSON | Provider-neutral task-affinity graph derived from `audit_tasks.json`; consumed during planning packet composition. |
| `requeue_tasks.json` | JSON | Re-audit tasks derived from coverage/flow-coverage gaps. |
| `access_memory.json` | JSON | Per-run access-memory: deterministic path-level summary harvested from the ingested result ledger (frequency + step-ordinal recency + lenses) — a write-only record with no audit-side reader; reserved to bias later host-work composition toward continuity. |
<!-- END GENERATED spec-mirror artifact-contract#execution -->

Run-scoped host handoff adds `host-workload.json`, `host-result-map.json`,
`host-task-bindings.json`, host result files, and the accepted-results ledger.
Their tool-owned bindings and content hashes are the authority for ingestion;
file presence alone is not acceptance.

### Reporting

<!-- BEGIN GENERATED spec-mirror artifact-contract#reporting — scripts/shared/generate-spec-mirrors.mjs — DO NOT EDIT BY HAND -->
| Artifact | Format | Purpose | Deliverable? |
|---|---|---|---|
| `audit-report.md` | **Markdown** | Human-readable rendered report. | **Promoted** on completion. |
| `audit-findings.json` | JSON | Canonical machine contract (`AuditFindingsReport`) — source of truth. | **Promoted** on completion. |
| `synthesis-narrative.json` | JSON | Marker: whether the optional LLM narrative pass (themes/exec-summary/top-risks) was `applied` or `omitted`. | internal |
<!-- END GENERATED spec-mirror artifact-contract#reporting -->

`audit-report.md` and `audit-findings.json` are co-produced by
`synthesis_executor` in one call — `audit-report.md` is the render of
`audit-findings.json`, not an independently-derived artifact.

### Supervisor

<!-- BEGIN GENERATED spec-mirror artifact-contract#supervisor — scripts/shared/generate-spec-mirrors.mjs — DO NOT EDIT BY HAND -->
| Artifact | Format | Purpose |
|---|---|---|
| `audit_state.json` | JSON | Orchestrator state snapshot (stateless — re-derivable from the rest of the bundle). |
| `artifact_metadata.json` | JSON | Per-artifact staleness metadata (recorded upstream revisions/hashes). |
| `tooling_manifest.json` | JSON | Detected tooling/analyzer versions (rebuilt fresh every `advanceAudit` call — never stale by construction). |
<!-- END GENERATED spec-mirror artifact-contract#supervisor -->

<!-- doc-citation-exempt: runtime artifact directory under .audit-tools/, not a tracked path -->
### Retained evidence: `charter-packets/`

Hand-written prose, deliberately outside every generated `spec-mirror` region:
this directory has **no `ARTIFACT_DEFINITIONS` row**, so no registry can describe
it and no generator owns these lines.

`<artifactsDir>/charter-packets/` holds the evidence packets the charter
extraction lanes actually read, archived at ingest and keyed by content —
`<kind>-<first 12 of sha256>.md`, with a `index.json` of <!-- doc-citation-exempt: runtime artifact names under .audit-tools/, not tracked files -->
`{ kind, sha256, byte_length, archived_at, source_filename, archived }` rows
sorted by kind then digest. It follows the precedent `design-review-snapshots/` <!-- doc-citation-exempt: runtime artifact directory under .audit-tools/, not a tracked path -->
set: loaded specially, not a dependency-map node, and never read as input by any
production module, so it adds no DAG edge and can re-stale nothing. The prune in
`writeCoreArtifacts` unlinks only registry filenames and never enumerates a
directory, so it cannot reach these files.

Two properties hold together. The emitter's read path
(`<artifactsDir>/lanes/`) is EMPTY after a successful ingest — a stale packet
left there would feed a later staleness-triggered re-extraction yesterday's
evidence — and the bytes still exist, because they are archived and re-verified
by hash BEFORE the source is unlinked. A packet is a function of the bundle *and
the working tree*, so once the audited tree moves it is not regenerable: a hash
alone would answer "did this lane get the tool's packet" but never "what exactly
did this lane read". An archive that cannot be verified leaves the source in
place and records `archived: false` with a reason, which the report's charter
evidence coverage block surfaces.

Growth is NOT bounded by a character ceiling, because a packet carries no
character limit (owner, 2026-09-04): a packet holds every doc, comment block,
declaration set and stripped body its channel names, in full, so the directory
grows with the audited tree and with the number of DISTINCT extractions — three
kinds per extraction, and identical re-extractions collapse onto the same file.
The only per-file bound is the read-safety guard in
`src/audit/orchestrator/charterPackets.ts`, which declines to read a file over
512 KiB at all and names it in the coverage manifest instead.
