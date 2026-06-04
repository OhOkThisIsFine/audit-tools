import type { ArtifactBundle } from "../io/artifacts.js";
import type {
  AuditObligation,
  AuditState,
  AuditTopLevelStatus,
  ObligationState,
} from "../types/auditState.js";
import { computeStaleArtifacts } from "./staleness.js";

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

  obligations.push(
    obligation(
      "design_review_completed",
      bundle.design_assessment?.reviewed ? "satisfied" : "missing",
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
  const hasPendingAuditTasks =
    bundle.audit_tasks?.some(
      (task) =>
        task.status !== "complete" &&
        !completedTaskIds.has(task.task_id) &&
        !deferredTaskIds.has(task.task_id),
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
          ? "missing"
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

  let status: AuditTopLevelStatus = "not_started";
  if (!has(bundle.repo_manifest)) {
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
