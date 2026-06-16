import type { ArtifactBundle } from "../io/artifacts.js";
import type {
  AuditObligation,
  AuditState,
  AuditTopLevelStatus,
  ObligationState,
} from "../types/auditState.js";
import { computeStaleArtifacts } from "./staleness.js";
import {
  unresolvedConstraintClauses,
} from "./intentInterpreter.js";

function has(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function obligation(
  id: string,
  state: ObligationState,
  reason?: string,
): AuditObligation {
  return { id, state, reason };
}

function staleOrSatisfied(
  staleArtifacts: Set<string>,
  deps: string[],
  present: boolean,
): ObligationState {
  if (!present) return "missing";
  return deps.some((dep) => staleArtifacts.has(dep)) ? "stale" : "satisfied";
}

export function deriveAuditState(bundle: ArtifactBundle): AuditState {
  const obligations: AuditObligation[] = [];
  const staleArtifacts = computeStaleArtifacts(bundle);

  obligations.push(
    obligation(
      "provider_confirmation",
      has(bundle.provider_confirmation) ? "satisfied" : "missing",
    ),
  );

  obligations.push(
    obligation(
      "repo_manifest",
      has(bundle.repo_manifest) ? "satisfied" : "missing",
    ),
  );
  obligations.push(
    obligation(
      "file_disposition",
      staleOrSatisfied(
        staleArtifacts,
        ["file_disposition.json"],
        has(bundle.file_disposition),
      ),
    ),
  );
  obligations.push(
    obligation(
      "auto_fixes_applied",
      staleOrSatisfied(
        staleArtifacts,
        ["file_disposition.json"],
        has(bundle.auto_fixes_applied),
      ),
    ),
  );
  obligations.push(
    obligation(
      "syntax_resolved",
      staleOrSatisfied(
        staleArtifacts,
        ["auto_fixes_applied.json", "syntax_resolution_status.json"],
        has(bundle.syntax_resolution_status),
      ),
    ),
  );

  const structureReady =
    has(bundle.unit_manifest) &&
    has(bundle.surface_manifest) &&
    has(bundle.graph_bundle) &&
    has(bundle.critical_flows) &&
    has(bundle.risk_register);
  obligations.push(
    obligation(
      "structure_artifacts",
      staleOrSatisfied(
        staleArtifacts,
        [
          "unit_manifest.json",
          "surface_manifest.json",
          "graph_bundle.json",
          "critical_flows.json",
          "risk_register.json",
        ],
        structureReady,
      ),
    ),
  );

  obligations.push(
    obligation(
      "graph_enrichment_current",
      staleOrSatisfied(
        staleArtifacts,
        ["analyzer_capability.json"],
        has(bundle.analyzer_capability),
      ),
    ),
  );

  obligations.push(
    obligation(
      "design_assessment_current",
      staleOrSatisfied(
        staleArtifacts,
        ["design_assessment.json"],
        has(bundle.design_assessment),
      ),
    ),
  );

  // The checkpoint is "current" only when it both exists/fresh AND every
  // unencodable free_form_intent clause has been escalated to a host-answered
  // constraint. An unanswered unencodable clause keeps this obligation unmet so
  // the blocking `confirm_intent` step re-fires — the directive is never
  // silently dropped at planning time (the single shared interpreter is the
  // encodability authority; see intentInterpreter.unresolvedConstraintClauses).
  const intentCheckpointBase = staleOrSatisfied(
    staleArtifacts,
    ["intent_checkpoint.json"],
    has(bundle.intent_checkpoint),
  );
  const unresolvedClauses =
    intentCheckpointBase === "satisfied"
      ? unresolvedConstraintClauses(bundle.intent_checkpoint)
      : [];
  obligations.push(
    obligation(
      "intent_checkpoint_current",
      unresolvedClauses.length > 0 ? "missing" : intentCheckpointBase,
      unresolvedClauses.length > 0
        ? `${unresolvedClauses.length} free_form_intent clause(s) could not be encoded as planning signals and need a host answer in constraint_clauses before planning proceeds.`
        : undefined,
    ),
  );

  // Backward-compat: old artifacts only have `reviewed`; new artifacts have
  // contract_reviewed and conceptual_reviewed. Treat both as satisfied when
  // the legacy flag is set and neither new flag is present.
  // Guard: a stale design_assessment.json must NOT activate the legacy path —
  // the artifact was written by an old executor before the split; once stale it
  // triggers design_assessment_current and the executor will write a fresh
  // artifact with the new fields. Letting a stale legacy artifact permanently
  // satisfy both obligations bypasses the split-review passes (ARC-14c59af5-2).
  const legacyReviewed =
    bundle.design_assessment?.reviewed === true &&
    bundle.design_assessment?.contract_reviewed !== true &&
    bundle.design_assessment?.conceptual_reviewed !== true &&
    !staleArtifacts.has("design_assessment.json");

  obligations.push(
    obligation(
      "design_review_contract_completed",
      (bundle.design_assessment?.contract_reviewed === true || legacyReviewed) ? "satisfied" : "missing",
    ),
  );

  obligations.push(
    obligation(
      "design_review_conceptual_completed",
      (bundle.design_assessment?.conceptual_reviewed === true || legacyReviewed) ? "satisfied" : "missing",
    ),
  );

  const planningReady =
    has(bundle.coverage_matrix) &&
    has(bundle.flow_coverage) &&
    has(bundle.runtime_validation_tasks) &&
    has(bundle.audit_tasks) &&
    has(bundle.requeue_tasks);
  obligations.push(
    obligation(
      "planning_artifacts",
      staleOrSatisfied(
        staleArtifacts,
        [
          "external_analyzer_results.json",
          "coverage_matrix.json",
          "flow_coverage.json",
          "runtime_validation_tasks.json",
          "audit_tasks.json",
          "requeue_tasks.json",
        ],
        planningReady,
      ),
    ),
  );

  const completedTaskIds = new Set(
    (bundle.audit_results ?? []).map((result) => result.task_id),
  );
  // Tasks deferred by a budget cap (FINDING-013) will never have results, so
  // they must be excluded from the completion check — otherwise the obligation
  // loops forever under a budget. Absent active_dispatch => empty set => the
  // logic is unchanged (all tasks must be complete).
  const deferredTaskIds = new Set<string>(
    bundle.active_dispatch?.deferred_task_ids ?? [],
  );
  // Tasks stranded by a partial-completion terminal (OBL-A06): when the dispatch
  // engine fires an empty-pool or livelock terminal and records it on
  // active_dispatch, those tasks will never be dispatched. Treat them as
  // uncovered so the pipeline can proceed to synthesis on partial coverage
  // rather than stalling forever. This shortcut fires ONLY when the terminal
  // was deliberately written — gate on its presence, not on the deferred list.
  const partialTerminal = bundle.active_dispatch?.partial_completion_terminal;
  const strandedTaskIds = new Set<string>(
    partialTerminal?.stranded_ids ?? [],
  );

  const hasPendingAuditTasks =
    bundle.audit_tasks?.some(
      (task) =>
        task.status !== "complete" &&
        !completedTaskIds.has(task.task_id) &&
        !deferredTaskIds.has(task.task_id) &&
        !strandedTaskIds.has(task.task_id),
    ) ?? false;

  if (hasPendingAuditTasks) {
    obligations.push(obligation("audit_tasks_completed", "missing"));
  } else if (has(bundle.audit_tasks)) {
    obligations.push(obligation("audit_tasks_completed", "satisfied"));
  }

  obligations.push(
    obligation(
      "audit_results_ingested",
      (bundle.audit_tasks?.length ?? 0) === 0 || has(bundle.audit_results)
        ? "satisfied"
        : "missing",
    ),
  );
  const runtimeTasks = bundle.runtime_validation_tasks?.tasks ?? [];
  const runtimeResults = bundle.runtime_validation_report?.results ?? [];
  const runtimeReady =
    runtimeTasks.length === 0 ||
    (runtimeTasks.length > 0 &&
      runtimeTasks.every((task) =>
        runtimeResults.some(
          (result) =>
            result.task_id === task.id &&
            result.status !== "pending",
        ),
      ));
  obligations.push(
    obligation(
      "runtime_validation_current",
      runtimeReady
        ? "satisfied"
        : has(bundle.runtime_validation_report)
          ? "stale"
          : "missing",
      runtimeTasks.length === 0
        ? "No deterministic runtime validation tasks were planned."
        : undefined,
    ),
  );
  obligations.push(
    obligation(
      "synthesis_current",
      staleOrSatisfied(
        staleArtifacts,
        ["audit-report.md"],
        has(bundle.audit_report),
      ),
    ),
  );
  obligations.push(
    obligation(
      "synthesis_narrative_current",
      staleOrSatisfied(
        staleArtifacts,
        ["synthesis-narrative.json"],
        has(bundle.synthesis_narrative),
      ),
    ),
  );

  // A run is "not_started" only when neither the session gate (provider_confirmation)
  // nor the first intake artifact (repo_manifest) has been produced. Once the provider
  // gate fires, the run is live and must not be cleaned up as stale.
  let status: AuditTopLevelStatus = "not_started";
  if (!has(bundle.provider_confirmation) && !has(bundle.repo_manifest)) {
    status = "not_started";
  } else if (obligations.some((o) => o.state === "blocked")) {
    status = "blocked";
  } else {
    status = "active";
  }

  const incomplete = obligations.some(
    (o) => o.state === "missing" || o.state === "stale",
  );
  if (!incomplete && has(bundle.audit_report)) {
    status = "complete";
  }

  return {
    status,
    blockers: [],
    obligations,
  };
}
