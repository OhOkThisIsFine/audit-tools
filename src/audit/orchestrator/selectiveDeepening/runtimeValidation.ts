import type { AuditResult, AuditTask, Lens } from "../../types.js";
import type {
  RuntimeValidationStatus,
  RuntimeValidationTask,
} from "../../types/runtimeValidation.js";
import {
  DEEPENING_TAG,
  type FindingContext,
  SEVERITY_RANK,
  intersects,
  lineCountFromSources,
  sanitizeSegment,
  taskIdFor,
  uniqueSorted,
} from "./shared.js";

export function runtimeResultNeedsFollowup(
  status: RuntimeValidationStatus,
): boolean {
  return status === "not_confirmed" || status === "inconclusive";
}

export function pickRuntimeFollowupLens(relatedTasks: AuditTask[]): Lens {
  const preference: Lens[] = [
    "security",
    "data_integrity",
    "reliability",
    "correctness",
    "tests",
    "operability",
    "config_deployment",
    "performance",
    "architecture",
    "maintainability",
  ];
  for (const lens of preference) {
    if (relatedTasks.some((task) => task.lens === lens)) {
      return lens;
    }
  }
  return "correctness";
}

export function runtimeValidationHasStrongStaticFinding(
  runtimeTask: RuntimeValidationTask,
  contexts: FindingContext[],
): boolean {
  return contexts.some(
    (context) =>
      intersects(context.paths, runtimeTask.target_paths) &&
      SEVERITY_RANK[context.finding.severity] >= SEVERITY_RANK.high,
  );
}

export function buildRuntimeValidationFollowupTask(params: {
  runtimeTask: RuntimeValidationTask;
  runtimeResultStatus: RuntimeValidationStatus;
  relatedTasks: AuditTask[];
  results: AuditResult[];
  lineIndex?: Record<string, number>;
}): AuditTask {
  const paths = uniqueSorted(params.runtimeTask.target_paths);
  const lens = pickRuntimeFollowupLens(params.relatedTasks);
  const firstRelated = params.relatedTasks[0];

  return {
    task_id: taskIdFor("runtime", [params.runtimeTask.id]),
    unit_id: firstRelated?.unit_id ?? `runtime:${sanitizeSegment(params.runtimeTask.id)}`,
    pass_id: `deepening:runtime:${sanitizeSegment(params.runtimeTask.id)}`,
    lens,
    file_paths: paths,
    file_line_counts: Object.fromEntries(
      paths.map((path) => [
        path,
        lineCountFromSources(
          path,
          params.relatedTasks,
          params.results,
          params.lineIndex,
        ),
      ]),
    ),
    rationale:
      `Reconcile runtime validation ${params.runtimeTask.id} (${params.runtimeResultStatus}) with semantic audit output. ` +
      "Verify the failing or inconclusive runtime evidence, map it to source behavior, and decide whether a finding should be added or escalated.",
    priority:
      params.runtimeTask.priority === "high" ||
      params.runtimeResultStatus === "not_confirmed"
        ? "high"
        : "medium",
    tags: [
      DEEPENING_TAG,
      "trigger:runtime_validation_disagreement",
      `runtime_task:${sanitizeSegment(params.runtimeTask.id)}`,
      `runtime_status:${params.runtimeResultStatus}`,
    ],
    status: "pending",
  };
}
