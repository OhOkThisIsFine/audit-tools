// The doc-side half of the three spec/audit registry mirrors, HELD AS DATA.
//
// WHY THIS EXISTS. `spec/audit/artifact-contract.md`, `spec/audit/executor-catalog.md`
// and `spec/audit/dependency-map.md` each carried a table that hand-mirrored a code
// registry — ARTIFACT_DEFINITIONS, EXECUTOR_REGISTRY, ARTIFACT_DEPENDS_ON_MAP. A row
// added to a registry left three docs quietly wrong, and nothing failed: the same
// defect `spec/audit/executor-producers.generated.md` already fixed for the producer
// relation. Owner decision (nightly docs-7, 2026-08-26): render those tables from
// their registries, in place, with the executor-producers banner and check gate.
//
// The registries own everything a registry can own — WHICH rows exist, and every
// column derivable from the declaration (an artifact's filename / format / phase, an
// executor's kind and obligation ids, an artifact's upstream list). What no registry
// holds is the doc-side prose: an artifact's *Purpose*, an executor's *Notes*, and the
// section a row is filed under (the executor catalog groups by pipeline stage, which
// EXECUTOR_REGISTRY does not declare; the dependency map groups by DAG phase, which is
// not the artifact registry's phase — `flow_coverage.json` is registry-phase
// `analysis` and DAG-phase 3).
//
// So the prose and the grouping live HERE, as declared data, and
// `scripts/shared/generate-spec-mirrors.mjs` JOINS them onto the registry rows. The
// join is reconciled in both directions: a registry row no region declares, and a
// declared row no registry holds, are both hard refusals — so a registry edit forces
// the doc to change rather than silently drifting from it. That is the
// `scripts/guard-reach-data.mjs` shape (declared data reconciled against the tree),
// applied to three doc tables.
//
// Row ORDER inside a region is this file's declaration order, and it is the doc's
// order — deliberately, because these tables are read as documents. The reconciler
// pins membership, not sequence.

/** The artifact registry the artifact-contract tables mirror. */
export const ARTIFACT_REGISTRY_FILE = "src/audit/io/artifacts.ts";

/** The executor registry the executor-catalog tables mirror. */
export const EXECUTOR_REGISTRY_FILE = "src/audit/orchestrator/executors.ts";

/** The canonical staleness adjacency the dependency-map tables mirror. */
export const DEPENDENCY_MAP_FILE = "src/audit/orchestrator/dependencyMap.ts";

/**
 * Modules whose `export const NAME = "…"` string constants the registries above
 * reference by IDENTIFIER rather than by literal (`textArtifact(AUDIT_REPORT_FILENAME,
 * …)`, `[AUDIT_REPORT_FILENAME]: [… AGENT_FEEDBACK_FILENAME]`). The extraction
 * resolves an identifier only from this declared set and refuses otherwise — it never
 * guesses a filename, because a wrong guess renders a plausible row.
 */
export const CONSTANT_SOURCE_FILES = [
  "src/shared/io/auditToolsPaths.ts",
  "src/shared/agentReflections.ts",
];

/** Every file the render reads — the reach declaration imports this, never a copy. */
export const SPEC_MIRROR_SOURCE_FILES = [
  ARTIFACT_REGISTRY_FILE,
  EXECUTOR_REGISTRY_FILE,
  DEPENDENCY_MAP_FILE,
  ...CONSTANT_SOURCE_FILES,
];

/** The three docs carrying generated regions. */
export const ARTIFACT_CONTRACT_DOC = "spec/audit/artifact-contract.md";
export const EXECUTOR_CATALOG_DOC = "spec/audit/executor-catalog.md";
export const DEPENDENCY_MAP_DOC = "spec/audit/dependency-map.md";

/** Every doc the render writes into. */
export const SPEC_MIRROR_DOCS = [
  ARTIFACT_CONTRACT_DOC,
  EXECUTOR_CATALOG_DOC,
  DEPENDENCY_MAP_DOC,
];

/**
 * The generated regions, in the order they appear in their docs.
 *
 * `kind` selects the registry and the table shape:
 *   • `artifacts`    — ARTIFACT_DEFINITIONS. `phase` names the registry phase whose
 *                      entries this region renders; every row's `purpose` is doc
 *                      prose. `deliverable` is rendered as a fourth column when the
 *                      region declares `deliverableColumn: true`.
 *   • `executors`    — EXECUTOR_REGISTRY. `note` is doc prose; an empty note renders
 *                      as an em dash.
 *   • `dependencies` — ARTIFACT_DEPENDS_ON_MAP. No prose at all: the row is entirely
 *                      registry-derived, and only its section membership is declared.
 *
 * A row with `registered: false` is a deliberate NON-registry row (it documents a
 * file that exists at runtime but is intentionally absent from the registry); it
 * carries its own `format`, must state `why` it is not a registry entry, and is the
 * only row shape the reconciler does not expect to find in code.
 *
 * @type {readonly import("./generate-spec-mirrors.mjs").SpecMirrorRegion[]}
 */
export const SPEC_MIRROR_REGIONS = [
  {
    id: "artifact-contract#intake",
    doc: ARTIFACT_CONTRACT_DOC,
    kind: "artifacts",
    phase: "intake",
    rows: [
      { artifact: "repo_manifest.json", purpose: "Repository structure and file classification." },
      {
        artifact: "file_disposition.json",
        purpose: "Per-file audit-scope disposition derived from the manifest.",
      },
      {
        artifact: "auto_fixes_applied.json",
        purpose: "Record of mechanical auto-fixes applied before review.",
      },
      {
        artifact: "intent_checkpoint.json",
        purpose: "User/host-confirmed audit intent and lens propositions.",
      },
    ],
  },
  {
    id: "artifact-contract#analysis",
    doc: ARTIFACT_CONTRACT_DOC,
    kind: "artifacts",
    phase: "analysis",
    rows: [
      { artifact: "unit_manifest.json", purpose: "Parsed units (functions/classes/modules)." },
      {
        artifact: "graph_bundle.json",
        purpose: "Dependency/call graph, with optional external-analyzer edge enrichment.",
      },
      { artifact: "surface_manifest.json", purpose: "Public API surface and exports." },
      { artifact: "critical_flows.json", purpose: "Identified critical execution/data flows." },
      {
        artifact: "critical-flow-fallback.json",
        purpose: "Durable host input: the LLM fallback flow enrichment authored when `critical_flows.fallback_required` is set. Merged into `critical_flows.json` by the structure phase. REGISTERED in `ARTIFACT_DEFINITIONS` and a declared leaf of the staleness DAG — the file itself is the durable input.",
      },
      {
        artifact: "intent-equivalence-verdict.json",
        registered: false,
        format: "JSON",
        why:
          "a transient host SUBMISSION, not an artifact: the host writes it to the path the step " +
          "contract binds, the tool consumes and DELETES it, and per DD-9 nothing is cached — so it " +
          "is deliberately outside ARTIFACT_DEFINITIONS and the staleness DAG. The row exists to " +
          "stop the absence being read as an omission and 'fixed' by adding a registry entry.",
        citationExempt: "transient host submission — written and deleted at runtime",
        purpose: "**Transient host submission** — NOT registered, NOT a staleness-DAG participant: the DD-9 gate's verdict on whether a re-stated intent still means what the confirmed checkpoint meant. Authored only for a prose-only delta — every other arm resolves deterministically without host input. Written by the host to the tool-computed path its step contract binds (`submissions/<sha256(submission_id)>.json`), validated, and — once applied — consumed and DELETED; a submission that validates but cannot be applied is quarantined and recorded, never dropped; the accepted judgment is materialized into `artifact_metadata.intent_baseline`, which is the revision authority. Per DD-9 no verdict-pair cache is persisted, so the executor writes no artifact — do not \"fix\" its absence from the registry by adding a row.",
      },
      {
        artifact: "flow_coverage.json",
        purpose: "Coverage of critical flows by ingested results.",
      },
      {
        artifact: "risk_register.json",
        purpose: "Per-unit risk signals (see `src/audit/extractors/risk.ts` for the full signal list).",
      },
      {
        artifact: "git_history.json",
        purpose: "Deterministic co-change/churn/authorship mined from the commit log.",
      },
      {
        artifact: "design_assessment.json",
        purpose: "Deterministic + optional host-delegated design assessment (see below).",
      },
      {
        artifact: "docs_digest.json",
        purpose: "Deterministic bounded telos extraction over the doc universe; rendered into the confirm-intent prompt. NO downstream edge, and never an upstream of `intent_checkpoint.json` (checkpoint stays a leaf).",
      },
      {
        artifact: "structure_decomposition.json",
        purpose: "Deterministic structure-layer decomposition (overlay-and-delta operator over behavior-graph + intent sources); emits non-co-localization findings.",
      },
      {
        artifact: "charter_register.json",
        purpose: "Phase-C charter layer (carries a stamped schema version and is discarded on mismatch, DISCARD read policy — regenerable analysis state): three channel-pure estimator charters with per-kind teleologies joined by file-set overlap over the structure-decomposition hint, plus the miner's deltas, triangulated teloses, and tool-counted disagreement density; gated by the confirmed intent-checkpoint ceiling.",
      },
      {
        artifact: "charter_clarification.json",
        purpose: "Phase-D charter-alignment triangulation loop over the charter register, gated by the confirmed intent-checkpoint ceiling.",
      },
      {
        artifact: "systemic_challenge.json",
        purpose: "Phase-E second-order-adversary improvement-seeking challenge loop over the charter register, gated by the confirmed intent-checkpoint ceiling.",
      },
      {
        artifact: "analyzer_capability.json",
        purpose: "Marker: outcome of the optional graph-enrichment pass (`applied`/`omitted`) + per-analyzer provenance.",
      },
      {
        artifact: "external_analyzer_acquisition.json",
        purpose: "Marker: external-analyzer acquisition run record over the curated `EXTERNAL_ANALYZER_CANDIDATES` registry in `src/shared/analyzers/candidates.ts` — `defaultRun: true` members run without the per-run consent token; every other candidate requires it.",
      },
    ],
  },
  {
    id: "artifact-contract#execution",
    doc: ARTIFACT_CONTRACT_DOC,
    kind: "artifacts",
    phase: "execution",
    rows: [
      {
        artifact: "scope.json",
        purpose: "How this run was scoped (`full` vs. `delta` with `--since` seed/expanded file sets).",
      },
      {
        artifact: "coverage_matrix.json",
        purpose: "Task allocation matrix: files × lens buckets, tracks which are queued/complete.",
      },
      {
        artifact: "runtime_validation_tasks.json",
        purpose: "Runtime-validation task specs derived from risk + coverage.",
      },
      {
        artifact: "runtime_validation_report.json",
        purpose: "Runtime-validation results (initial + import-refreshed).",
      },
      {
        artifact: "external_analyzer_results.json",
        purpose: "Normalized findings from acquired external analyzers.",
      },
      {
        artifact: "syntax_resolution_status.json",
        purpose: "Per-file syntax-parse status and failures.",
      },
      {
        artifact: "audit_results.jsonl",
        purpose: "Ingested `AuditResult` records, one per line — not a `.json` array.",
      },
      {
        artifact: "audit_tasks.json",
        purpose: "Task specifications for external (host-delegated) audit execution.",
      },
      {
        artifact: "audit_plan_metrics.json",
        purpose: "Planning metrics and cost estimates for the current task set.",
      },
      {
        artifact: "task_affinity_graph.json",
        purpose: "Provider-neutral task-affinity graph derived from `audit_tasks.json`; consumed during planning packet composition.",
      },
      {
        artifact: "requeue_tasks.json",
        purpose: "Re-audit tasks derived from coverage/flow-coverage gaps.",
      },
      {
        artifact: "access_memory.json",
        purpose: "Per-run access-memory: deterministic path-level summary harvested from the ingested result ledger (frequency + step-ordinal recency + lenses) — a write-only record with no audit-side reader; reserved to bias later host-work composition toward continuity.",
      },
    ],
  },
  {
    id: "artifact-contract#reporting",
    doc: ARTIFACT_CONTRACT_DOC,
    kind: "artifacts",
    phase: "reporting",
    deliverableColumn: true,
    rows: [
      {
        artifact: "audit-report.md",
        purpose: "Human-readable rendered report.",
        deliverable: "**Promoted** on completion.",
      },
      {
        artifact: "audit-findings.json",
        purpose: "Canonical machine contract (`AuditFindingsReport`) — source of truth.",
        deliverable: "**Promoted** on completion.",
      },
      {
        artifact: "synthesis-narrative.json",
        purpose: "Marker: whether the optional LLM narrative pass (themes/exec-summary/top-risks) was `applied` or `omitted`.",
        deliverable: "internal",
      },
    ],
  },
  {
    id: "artifact-contract#supervisor",
    doc: ARTIFACT_CONTRACT_DOC,
    kind: "artifacts",
    phase: "supervisor",
    rows: [
      {
        artifact: "audit_state.json",
        purpose: "Orchestrator state snapshot (stateless — re-derivable from the rest of the bundle).",
      },
      {
        artifact: "artifact_metadata.json",
        purpose: "Per-artifact staleness metadata (recorded upstream revisions/hashes).",
      },
      {
        artifact: "tooling_manifest.json",
        purpose: "Detected tooling/analyzer versions (rebuilt fresh every `advanceAudit` call — never stale by construction).",
      },
    ],
  },
  {
    id: "executor-catalog#intake",
    doc: EXECUTOR_CATALOG_DOC,
    kind: "executors",
    rows: [
      {
        executor: "intake_executor",
        note: "one call satisfies two obligations, each with its own satisfaction rule (`repo_manifest`: presence-only; `file_disposition`: presence + staleness)",
      },
      { executor: "intent_checkpoint_executor", note: "" },
      {
        executor: "intent_equivalence_executor",
        note: "DD-9 intent-equivalence gate. A prose-only delta emits the bounded judge step; every other arm (baseline stamp, gate-version stale, structured delta) resolves deterministically via the runner — mirroring `charter_extraction`'s emit-vs-run gating in `nextStepHelpers`",
      },
      { executor: "auto_fix_executor", note: "" },
    ],
  },
  {
    id: "executor-catalog#analysis",
    doc: EXECUTOR_CATALOG_DOC,
    kind: "executors",
    rows: [
      {
        executor: "external_analyzer_acquisition_executor",
        note: "acquires the analyzer set and records the acquisition marker",
      },
      {
        executor: "structure_executor",
        note: "emits all structure artifacts in one call, merging any persisted host flow enrichment",
      },
      {
        executor: "critical_flow_fallback_executor",
        note: "the durable host-authored flow enrichment. Fires ONLY when the deterministic flow inference asked for a fallback; emits a host step to author the enrichment, otherwise self-satisfies. Persisting the submission re-stales the deterministic flow artifact so the structure phase merges it",
      },
      {
        executor: "graph_enrichment_executor",
        note: "records the graph-enrichment marker; merges analyzer edges into the graph when there are any",
      },
      { executor: "design_assessment_executor", note: "deterministic design pass" },
      {
        executor: "structure_decomposition_executor",
        note: "overlay-and-delta structure operator",
      },
      {
        executor: "docs_digest_executor",
        note: "bounded telos extraction over the doc universe (change 3); renders into the confirm-intent prompt",
      },
      {
        executor: "charter_extraction_executor",
        note: "Phase C.1 charter layer — teleologies/charters ONLY, three blind estimator lanes fed channel-pure evidence packets; the tool grounds file scopes against the repo universe and joins lanes by file-set overlap (decomposition = hint). At a deep+ ceiling emits the lane step, otherwise the runner omits deterministically at the default shallow ceiling. Sets `deltas_pending` when it produced ≥1 subsystem for the independent delta pass",
      },
      {
        executor: "charter_delta_executor",
        note: "Phase C.2 — the INDEPENDENT delta-miner + triangulation engine: routes+gates the channel-pair deltas, persists the triangulated teloses + disagreement density + goal_graph, and (deepest ceiling only) admits gate-surviving True nominations; emits an LLM step when the register is `deltas_pending`, otherwise settles deterministically (no author marks its own homework)",
      },
      {
        executor: "design_review_contract",
        note: "contract-assessment mode — invariants/boundaries/obligations",
      },
      {
        executor: "design_review_conceptual",
        note: "conceptual-critique mode — philosophy/alternatives",
      },
      {
        executor: "charter_clarification_executor",
        note: "Phase D triangulation loop; assembles deterministically at a shallow ceiling / zero attention",
      },
      {
        executor: "systemic_challenge_executor",
        note: "Phase E second-order-adversary loop-until-dry; omits deterministically at a shallow ceiling",
      },
      { executor: "syntax_resolution_executor", note: "" },
    ],
  },
  {
    id: "executor-catalog#execution",
    doc: EXECUTOR_CATALOG_DOC,
    kind: "executors",
    rows: [
      { executor: "planning_executor", note: "emits all planning artifacts in one call" },
      {
        executor: "semantic_review_executor",
        note: "emits a complete provider-neutral host workload and ingests prompt-bound results; performs no backend launch or routing",
      },
      {
        executor: "external_analyzer_import_executor",
        note: "imported normalized external-analyzer results",
      },
      {
        executor: "result_ingestion_executor",
        note: "ingests prompt-bound host results and refreshes the downstream planning/coverage view",
      },
      {
        executor: "runtime_validation_executor",
        note: "the first runtime-validation pass; applies selective deepening",
      },
      {
        executor: "runtime_validation_update_executor",
        note: "re-runs that pass over imported evidence",
      },
    ],
  },
  {
    id: "executor-catalog#reporting",
    doc: EXECUTOR_CATALOG_DOC,
    kind: "executors",
    rows: [
      {
        executor: "synthesis_executor",
        note: "co-produces the machine contract + its human render",
      },
      {
        executor: "synthesis_narrative_executor",
        note: "optional LLM narrative pass (+ re-renders the contract/report with the enriched narrative)",
      },
    ],
  },
  {
    id: "executor-catalog#unreachable",
    doc: EXECUTOR_CATALOG_DOC,
    kind: "executors",
    rows: [
      {
        executor: "friction_capture_executor",
        note: "Unreachable — never produced by `deriveAuditState`'s obligation scan (its id sits in `PRIORITY` only to satisfy the executor-registry-coverage invariant). Friction triage actually fires from the `present_report` terminal step.",
      },
    ],
  },
  {
    id: "dependency-map#phase-1",
    doc: DEPENDENCY_MAP_DOC,
    kind: "dependencies",
    rows: [
      { artifact: "repo_manifest.json" },
      { artifact: "file_disposition.json" },
    ],
  },
  {
    id: "dependency-map#phase-2",
    doc: DEPENDENCY_MAP_DOC,
    kind: "dependencies",
    rows: [
      { artifact: "graph_bundle.json" },
      { artifact: "analyzer_capability.json" },
      { artifact: "unit_manifest.json" },
      { artifact: "surface_manifest.json" },
      { artifact: "critical_flows.json" },
      { artifact: "risk_register.json" },
      { artifact: "git_history.json" },
      { artifact: "external_analyzer_acquisition.json" },
      { artifact: "design_assessment.json" },
      { artifact: "docs_digest.json" },
      { artifact: "structure_decomposition.json" },
      { artifact: "charter_register.json" },
      { artifact: "charter_clarification.json" },
      { artifact: "systemic_challenge.json" },
    ],
  },
  {
    id: "dependency-map#phase-3",
    doc: DEPENDENCY_MAP_DOC,
    kind: "dependencies",
    rows: [
      { artifact: "coverage_matrix.json" },
      { artifact: "audit_tasks.json" },
      { artifact: "audit_plan_metrics.json" },
      { artifact: "task_affinity_graph.json" },
      { artifact: "flow_coverage.json" },
      { artifact: "requeue_tasks.json" },
      { artifact: "runtime_validation_tasks.json" },
      { artifact: "runtime_validation_report.json" },
      { artifact: "access_memory.json" },
    ],
  },
  {
    id: "dependency-map#phase-4",
    doc: DEPENDENCY_MAP_DOC,
    kind: "dependencies",
    rows: [
      { artifact: "audit-report.md" },
      { artifact: "synthesis-narrative.json" },
    ],
  },
];
