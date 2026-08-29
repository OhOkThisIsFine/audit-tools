/**
 * How an executor relates to an artifact it writes.
 *
 *   `primary`      — the executor that authoritatively creates it.
 *   `refresh`      — an executor that rewrites it later in the pipeline
 *                    (staleness-driven).
 *   `side_channel` — a host-facing file written to disk but deliberately OUTSIDE
 *                    `ARTIFACT_DEFINITIONS` and the staleness DAG; `note` states
 *                    why. Never silently omitted — an unrepresented write is the
 *                    drift this declaration exists to stop.
 */
export type ArtifactProductionRole = "primary" | "refresh" | "side_channel";

/** One (executor → artifact) production edge. */
export interface ArtifactProduction {
  /** Artifact fileName exactly as `ARTIFACT_DEFINITIONS` names it. */
  artifact: string;
  role: ArtifactProductionRole;
  /** Qualifier carried into the generated producer table (mechanism, not prose). */
  note?: string;
}

export interface ExecutorDefinition {
  id: string;
  kind: "deterministic" | "host_delegation";
  obligation_ids: string[];
  /**
   * The STATIC set of artifacts this executor can write — the single home of the
   * executor→artifact producer relation, rendered by
   * `scripts/shared/generate-executor-producers.mjs` into
   * `spec/audit/executor-producers.generated.md`.
   *
   * Distinct from `ExecutorRunResult.artifacts_written`, which is what one
   * INVOCATION happened to write (a subset — the acquisition executor declares
   * its results artifact only when a tool actually contributed). This is the
   * superset the code may produce; the two are pinned against each other by
   * `tests/audit/executor-artifact-production-declaration.test.ts`.
   *
   * Ordered by artifact fileName, then role (content-derived stable key, as
   * `LIFECYCLE_PRODUCTIONS` and `EXECUTOR_WRITE_SITES` are) — pinned by DECL-9.
   */
  produces: readonly ArtifactProduction[];
}

/** An artifact written outside every executor, by the run lifecycle itself. */
export interface LifecycleProduction {
  /** Artifact fileName, or a lifecycle file outside `ARTIFACT_DEFINITIONS`. */
  artifact: string;
  /** The code that performs the write. */
  writer: string;
  /** Why it is not an executor's output. */
  reason: string;
}

/**
 * Artifacts no executor produces. `advanceAudit` writes the supervisor pair on
 * every fold, the environment probe writes the tooling manifest, and workers
 * append their own reflections — so these carry an explicit declaration rather
 * than an empty producer cell in the rendered table.
 *
 * Ordered by artifact fileName (content-derived stable key).
 */
export const LIFECYCLE_PRODUCTIONS: readonly LifecycleProduction[] = [
  {
    artifact: "agent-feedback.jsonl",
    writer: "audit workers (append-only)",
    reason:
      "opt-in meta-audit reflections appended by whoever ran the task; treated as always-updated when metadata is computed",
  },
  {
    artifact: "artifact_metadata.json",
    writer: "advanceAudit (src/audit/orchestrator/advance.ts)",
    reason:
      "the staleness bookkeeping the fold itself recomputes from every run's write-set",
  },
  {
    artifact: "audit_state.json",
    writer: "advanceAudit (src/audit/orchestrator/advance.ts)",
    reason:
      "the derived obligation state each advance carries on its bundle; the fold persists it ONCE at its halt (CX-02 persist-once)",
  },
  {
    artifact: "tooling_manifest.json",
    writer: "the environment probe (src/audit/orchestrator/advance.ts)",
    reason: "probed from the host environment, not derived from any upstream artifact",
  },
];

/**
 * Returns true when the executor identified by `id` is a host-delegation point
 * (i.e. it pauses the deterministic pipeline and asks the active LLM agent to
 * perform work) rather than a deterministic executor.
 */
export function isHostDelegationExecutor(id: string): boolean {
  return executorById.get(id)?.kind === "host_delegation";
}

export const EXECUTOR_REGISTRY: ExecutorDefinition[] = [
  {
    id: "intake_executor",
    kind: "deterministic",
    obligation_ids: ["repo_manifest", "file_disposition"],
    produces: [
      {
        artifact: "file_disposition.json",
        role: "primary",
      },
      {
        artifact: "repo_manifest.json",
        role: "primary",
      },
      {
        artifact: "scope_summary.json",
        role: "side_channel",
        note:
          "host-facing scope digest; the in-process channel is ExecutorRunResult.scope_summary, so it is deliberately outside ARTIFACT_DEFINITIONS and the staleness DAG",
      },
    ],
  },
  {
    id: "intent_checkpoint_executor",
    kind: "host_delegation",
    obligation_ids: ["intent_checkpoint_current"],
    produces: [
      {
        artifact: "intent_checkpoint.json",
        role: "primary",
        note:
          "written by the host at the confirm-intent pause, at the path the CLI binds",
      },
    ],
  },
  {
    // DD-9 intent-equivalence gate. host_delegation: a prose-only delta emits
    // the bounded judge step; every other arm (baseline stamp, gate-version
    // stale, structured delta) resolves deterministically via the runner —
    // mirroring charter_extraction's emit-vs-run gating in nextStepHelpers.
    id: "intent_equivalence_executor",
    kind: "host_delegation",
    obligation_ids: ["intent_equivalence_current"],
    produces: [],
  },
  {
    // Item B consent surfacing is a FOLD-LEVEL pause on this executor (see
    // pendingAnalyzerConsent in hostInputPause.ts + the analyzer-consent branch
    // in nextStepHelpers) — the same shape as the analyzer-install consent fold,
    // not a separate registry obligation.
    id: "external_analyzer_acquisition_executor",
    kind: "deterministic",
    obligation_ids: ["external_analyzers_current"],
    produces: [
      {
        artifact: "external_analyzer_acquisition.json",
        role: "primary",
      },
      {
        artifact: "external_analyzer_results.json",
        role: "refresh",
        note:
          "upserts each tool's normalized findings, and declares the artifact ONLY when a tool actually contributed, so an unchanged results array never churns its downstreams",
      },
    ],
  },
  {
    id: "structure_executor",
    kind: "deterministic",
    obligation_ids: ["structure_artifacts"],
    produces: [
      {
        artifact: "critical_flows.json",
        role: "primary",
        note:
          "merges the persisted critical-flow-fallback.json when one exists",
      },
      {
        artifact: "file_disposition.json",
        role: "refresh",
      },
      {
        artifact: "git_history.json",
        role: "primary",
      },
      {
        artifact: "graph_bundle.json",
        role: "primary",
      },
      {
        artifact: "risk_register.json",
        role: "primary",
      },
      {
        artifact: "surface_manifest.json",
        role: "primary",
      },
      {
        artifact: "unit_manifest.json",
        role: "primary",
      },
    ],
  },
  {
    // Critical-flow LLM fallback. host_delegation (NON-DRAINABLE): when the
    // deterministic flow inference marked itself below the confidence bar it emits
    // a host step; when the bar was met the obligation self-satisfies and this is
    // never selected. The consume path persists the host submission via the
    // deterministic runner (the durable upstream input the structure phase merges).
    id: "critical_flow_fallback_executor",
    kind: "host_delegation",
    obligation_ids: ["critical_flow_fallback_current"],
    produces: [
      {
        artifact: "critical-flow-fallback.json",
        role: "primary",
        note:
          "durable host input the structure phase merges on the next fold",
      },
    ],
  },
  {
    id: "graph_enrichment_executor",
    kind: "deterministic",
    obligation_ids: ["graph_enrichment_current"],
    produces: [
      {
        artifact: "analyzer_capability.json",
        role: "primary",
      },
      {
        artifact: "graph_bundle.json",
        role: "refresh",
        note:
          "merges analyzer edges",
      },
    ],
  },
  {
    id: "design_assessment_executor",
    kind: "deterministic",
    obligation_ids: ["design_assessment_current"],
    produces: [
      {
        artifact: "design_assessment.json",
        role: "primary",
      },
    ],
  },
  {
    id: "structure_decomposition_executor",
    kind: "deterministic",
    obligation_ids: ["structure_decomposition_current"],
    produces: [
      {
        artifact: "structure_decomposition.json",
        role: "primary",
      },
    ],
  },
  {
    id: "docs_digest_executor",
    kind: "deterministic",
    obligation_ids: ["docs_digest_current"],
    produces: [
      {
        artifact: "docs_digest.json",
        role: "primary",
      },
    ],
  },
  {
    // Phase C charter extraction. host_delegation: at a deep+ ceiling it emits an
    // LLM charter-extraction step; at a shallow ceiling (default) the runner omits
    // deterministically (the branch in buildAuditObligations gates emit vs run,
    // mirroring synthesis_narrative).
    id: "charter_extraction_executor",
    kind: "host_delegation",
    obligation_ids: ["charter_extraction_current"],
    produces: [
      {
        artifact: "charter_register.json",
        role: "primary",
      },
    ],
  },
  {
    // Phase C.2 delta-mining, mirrors charter_extraction. host_delegation: at a
    // deep+ ceiling that produced ≥1 subsystem (charter_register.deltas_pending)
    // it emits an LLM step for the INDEPENDENT delta-miner; otherwise the runner
    // settles the register deterministically (the branch in nextStepHelpers gates
    // emit vs run, mirroring charter_extraction).
    id: "charter_delta_executor",
    kind: "host_delegation",
    obligation_ids: ["charter_delta_current"],
    produces: [
      {
        artifact: "charter_register.json",
        role: "refresh",
        note:
          "settles the register's pending deltas",
      },
    ],
  },
  {
    id: "design_review_contract",
    kind: "host_delegation",
    obligation_ids: ["design_review_contract_completed"],
    produces: [
      {
        artifact: "design_assessment.json",
        role: "refresh",
        note:
          "merges the consumed pass verdict at the CLI ingestion site",
      },
    ],
  },
  {
    id: "design_review_conceptual",
    kind: "host_delegation",
    obligation_ids: ["design_review_conceptual_completed"],
    produces: [
      {
        artifact: "design_assessment.json",
        role: "refresh",
        note:
          "merges the consumed pass verdict at the CLI ingestion site",
      },
    ],
  },
  {
    // Phase D charter-clarification triangulation loop. host_delegation (NON-
    // DRAINABLE): at a deep+ ceiling WITH attention > 0 and open interactive
    // questions it emits an LLM step surfacing the VOI-ranked queue; otherwise the
    // runner assembles the loop deterministically (autonomous mode / omit) — the
    // branch in nextStepHelpers gates emit vs run, mirroring charter_extraction.
    id: "charter_clarification_executor",
    kind: "host_delegation",
    obligation_ids: ["charter_clarification_current"],
    produces: [
      {
        artifact: "charter_clarification.json",
        role: "primary",
      },
    ],
  },
  {
    // Phase E systemic improvement-seeking challenge loop. host_delegation (NON-
    // DRAINABLE): at a deep+ ceiling it emits a second-order-adversary step
    // (loop-until-dry, optimization/better-way mandate); at a shallow ceiling
    // (default) the runner omits deterministically — the branch in nextStepHelpers
    // gates emit vs run, mirroring charter_clarification.
    id: "systemic_challenge_executor",
    kind: "host_delegation",
    obligation_ids: ["systemic_challenge_current"],
    produces: [
      {
        artifact: "systemic_challenge.json",
        role: "primary",
      },
    ],
  },
  {
    id: "planning_executor",
    kind: "deterministic",
    obligation_ids: ["planning_artifacts"],
    produces: [
      {
        artifact: "audit_plan_metrics.json",
        role: "primary",
      },
      {
        artifact: "audit_tasks.json",
        role: "primary",
      },
      {
        artifact: "coverage_matrix.json",
        role: "primary",
      },
      {
        artifact: "flow_coverage.json",
        role: "primary",
      },
      {
        artifact: "requeue_tasks.json",
        role: "primary",
      },
      {
        artifact: "runtime_validation_report.json",
        role: "refresh",
        note:
          "when runtime-validation tasks exist",
      },
      {
        artifact: "runtime_validation_tasks.json",
        role: "primary",
      },
      {
        artifact: "scope.json",
        role: "primary",
      },
      {
        artifact: "task_affinity_graph.json",
        role: "primary",
      },
    ],
  },
  {
    id: "result_ingestion_executor",
    kind: "deterministic",
    obligation_ids: ["audit_results_ingested"],
    produces: [
      {
        artifact: "access_memory.json",
        role: "primary",
      },
      {
        artifact: "audit_plan_metrics.json",
        role: "refresh",
      },
      {
        artifact: "audit_results.jsonl",
        role: "primary",
        note:
          "appends validated results returned through semantic_review_executor",
      },
      {
        artifact: "audit_tasks.json",
        role: "refresh",
      },
      {
        artifact: "coverage_matrix.json",
        role: "refresh",
      },
      {
        artifact: "flow_coverage.json",
        role: "refresh",
      },
      {
        artifact: "requeue_tasks.json",
        role: "refresh",
      },
      {
        artifact: "runtime_validation_report.json",
        role: "refresh",
      },
      {
        artifact: "runtime_validation_tasks.json",
        role: "refresh",
      },
      {
        artifact: "task_affinity_graph.json",
        role: "refresh",
      },
    ],
  },
  {
    id: "runtime_validation_executor",
    kind: "deterministic",
    obligation_ids: ["runtime_validation_current"],
    produces: [
      {
        artifact: "audit_plan_metrics.json",
        role: "refresh",
        note:
          "selective deepening",
      },
      {
        artifact: "audit_tasks.json",
        role: "refresh",
        note:
          "selective deepening",
      },
      {
        artifact: "runtime_validation_report.json",
        role: "primary",
      },
      {
        artifact: "task_affinity_graph.json",
        role: "refresh",
        note:
          "selective deepening",
      },
    ],
  },
  {
    // No obligation_ids: dispatched only via an explicit preferredExecutor
    // (imported runtime-validation evidence), never selected by the priority scan.
    id: "runtime_validation_update_executor",
    kind: "deterministic",
    obligation_ids: [],
    produces: [
      {
        artifact: "audit_plan_metrics.json",
        role: "refresh",
        note:
          "selective deepening; preferredExecutor only",
      },
      {
        artifact: "audit_tasks.json",
        role: "refresh",
        note:
          "selective deepening; preferredExecutor only",
      },
      {
        artifact: "runtime_validation_report.json",
        role: "refresh",
        note:
          "preferredExecutor only",
      },
      {
        artifact: "task_affinity_graph.json",
        role: "refresh",
        note:
          "selective deepening; preferredExecutor only",
      },
    ],
  },
  {
    id: "synthesis_executor",
    kind: "deterministic",
    obligation_ids: ["synthesis_current"],
    produces: [
      {
        artifact: "audit-findings.json",
        role: "primary",
      },
      {
        artifact: "audit-report.md",
        role: "primary",
      },
    ],
  },
  {
    id: "synthesis_narrative_executor",
    kind: "host_delegation",
    obligation_ids: ["synthesis_narrative_current"],
    produces: [
      {
        artifact: "audit-findings.json",
        role: "refresh",
        note:
          "re-render with the narrative",
      },
      {
        artifact: "audit-report.md",
        role: "refresh",
        note:
          "re-render with the narrative",
      },
      {
        artifact: "synthesis-narrative.json",
        role: "primary",
      },
    ],
  },
  {
    // No obligation_ids: dispatched only via an explicit preferredExecutor
    // (imported normalized external-analyzer results), never selected by the scan.
    id: "external_analyzer_import_executor",
    kind: "deterministic",
    obligation_ids: [],
    produces: [
      {
        artifact: "external_analyzer_results.json",
        role: "refresh",
        note:
          "preferredExecutor only",
      },
    ],
  },
  {
    id: "auto_fix_executor",
    kind: "deterministic",
    obligation_ids: ["auto_fixes_applied"],
    produces: [
      {
        artifact: "auto_fixes_applied.json",
        role: "primary",
      },
    ],
  },
  {
    id: "syntax_resolution_executor",
    kind: "deterministic",
    obligation_ids: ["syntax_resolved"],
    produces: [
      {
        artifact: "external_analyzer_results.json",
        role: "primary",
      },
      {
        artifact: "syntax_resolution_status.json",
        role: "primary",
      },
    ],
  },
  {
    id: "semantic_review_executor",
    kind: "host_delegation",
    obligation_ids: ["audit_tasks_completed"],
    produces: [],
  },
  {
    id: "friction_capture_executor",
    kind: "deterministic",
    obligation_ids: ["friction_capture_current"],
    produces: [
      {
        artifact: "friction/run.json",
        role: "side_channel",
        note:
          "run-scoped friction ledger under the run directory rather than a bundle artifact; it has no DAG dependents",
      },
    ],
  },
];

// O(1) lookup indexes over the registry, built once at module load. Uniqueness
// of the obligation→executor mapping is asserted at load in nextStep.ts
// (assertExecutorRegistryCoversPriority), so last-wins insertion cannot mask an
// ambiguity there.
const executorById = new Map(EXECUTOR_REGISTRY.map((e) => [e.id, e]));

/** Executor owning each obligation id — O(1) replacement for scanning the registry. */
export const EXECUTOR_BY_OBLIGATION: ReadonlyMap<string, ExecutorDefinition> =
  new Map(
    EXECUTOR_REGISTRY.flatMap((e) =>
      e.obligation_ids.map((id) => [id, e] as const),
    ),
  );
