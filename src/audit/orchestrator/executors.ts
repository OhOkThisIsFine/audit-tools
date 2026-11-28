// sites-pinned: tests/audit/next-step-helpers.test.ts, tests/audit/charter-emit-order.test.ts, tests/audit/executor-registry-sync.test.ts, tests/audit/pipeline-integration.test.ts, tests/audit/source-read-only-executors.test.ts, tests/audit/lifecycle-production-flags.test.ts, tests/audit/advance-drain-loop.test.ts, tests/audit/executor-artifact-production-declaration.test.ts
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
   * legacy tests/audit/executor-artifact-production-declaration.test.ts.
   *
   * Ordered by artifact fileName, then role, like `LIFECYCLE_PRODUCTIONS`.
   */
  produces: readonly ArtifactProduction[];
  /**
   * An AUDITED source-read-only runner: it may keep the fold's manifest-index
   * memo (`preservesSourceIndexes`). An allowlist — absent means false, so a new
   * runner and every command-backed runner drop the memo by default, even when
   * a command reports failure after it changed source bytes.
   */
  source_read_only?: true;
}

/** An artifact written outside every executor, by the run lifecycle itself. */
export interface LifecycleProduction {
  /** Artifact fileName, or a lifecycle file outside `ARTIFACT_DEFINITIONS`. */
  artifact: string;
  /** The code that performs the write. */
  writer: string;
  /** Why it is not an executor's output. */
  reason: string;
  /**
   * No executor lists it in `artifacts_written`, so every advance recomputes
   * its metadata entry from live content: unchanged content keeps its
   * revision, changed content bumps it once (`ALWAYS_UPDATED_ARTIFACTS`).
   */
  always_updated?: true;
  /**
   * Something other than its producer mutates its bytes, so its body runs
   * ahead of its manifest record by design. Staleness exempts it from the
   * `partial` verdict, which would re-fire its producer forever
   * (`HOST_APPENDED_ARTIFACTS`). A deliberate, named statement — never a
   * structural rule, because "mutated by something other than its producer"
   * is not derivable from the dependency map.
   */
  host_appended?: true;
  /**
   * Absence is the normal case, never an upstream that vanished: staleness
   * does not stale its dependents when it is absent
   * (`OPTIONAL_PROBE_ARTIFACTS`).
   */
  optional_probe?: true;
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
    always_updated: true,
    host_appended: true,
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
    artifact: "conceptual_review_adjudication.json",
    writer: "design-review fold (src/audit/cli/nextStepHelpers.ts)",
    reason:
      "validated deep conceptual judge attribution is committed atomically with the conceptual findings it explains",
  },
  {
    artifact: "tooling_manifest.json",
    writer: "the environment probe (src/audit/orchestrator/advance.ts)",
    reason: "probed from the host environment, not derived from any upstream artifact",
    always_updated: true,
    optional_probe: true,
  },
];

const lifecycleArtifactsWith = (
  flag: "always_updated" | "host_appended" | "optional_probe",
): ReadonlySet<string> =>
  new Set(LIFECYCLE_PRODUCTIONS.filter((entry) => entry[flag]).map((entry) => entry.artifact));

/** Lifecycle artifacts whose metadata every advance recomputes from live content. */
export const ALWAYS_UPDATED_ARTIFACTS = lifecycleArtifactsWith("always_updated");
/** Lifecycle artifacts staleness exempts from the `partial` verdict. */
export const HOST_APPENDED_ARTIFACTS = lifecycleArtifactsWith("host_appended");
/** Lifecycle artifacts whose absence never stales a dependent. */
export const OPTIONAL_PROBE_ARTIFACTS = lifecycleArtifactsWith("optional_probe");

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
    source_read_only: true,
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
    source_read_only: true,
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
    source_read_only: true,
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
    source_read_only: true,
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
    source_read_only: true,
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
    // Steps 2–3 of the charter layer, mirrors charter_extraction. host_delegation:
    // at a deep+ ceiling whose lanes produced ≥1 node (charter_register.
    // comparison_pending) it emits an LLM step for the comparison reader;
    // otherwise the runner settles the register deterministically.
    id: "charter_comparison_executor",
    kind: "host_delegation",
    obligation_ids: ["charter_comparison_current"],
    produces: [
      {
        artifact: "charter_register.json",
        role: "refresh",
        note: "settles the register's pending comparison (correspondences + differences)",
      },
    ],
  },
  {
    // Step 4 of the charter layer. host_delegation: when ≥1 finding candidate
    // awaits a lane verdict (charter_register.fidelity_pending) it emits an LLM
    // step for the separate fidelity lane; otherwise the runner settles it.
    id: "charter_fidelity_executor",
    kind: "host_delegation",
    obligation_ids: ["charter_fidelity_current"],
    produces: [
      {
        artifact: "charter_register.json",
        role: "refresh",
        note: "stamps the fidelity verdicts and surfaces the supported differences as findings",
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
        artifact: "review_plan.json",
        role: "primary",
      },
      {
        artifact: "scope.json",
        role: "primary",
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
    source_read_only: true,
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
