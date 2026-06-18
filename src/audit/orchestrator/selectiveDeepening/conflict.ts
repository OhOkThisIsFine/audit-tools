import type { AuditResult, AuditTask, Lens } from "../../types.js";
import {
  CONFIDENCE_RANK,
  DEEPENING_TAG,
  type FindingContext,
  SEVERITY_RANK,
  lineCountForPath,
  sanitizeSegment,
  taskIdFor,
  uniqueSorted,
} from "./shared.js";

export function buildConflictFollowupTask(params: {
  contexts: FindingContext[];
  conflictKey: string;
  lineIndex?: Record<string, number>;
}): AuditTask {
  const [first] = params.contexts;
  const paths = uniqueSorted(params.contexts.flatMap((context) => context.paths));
  const maxSeverity = Math.max(
    ...params.contexts.map((context) => SEVERITY_RANK[context.finding.severity]),
  );
  const lineSources = new Map<string, { task?: AuditTask; result: AuditResult }>();
  for (const context of params.contexts) {
    for (const path of context.paths) {
      if (!lineSources.has(path)) {
        lineSources.set(path, { task: context.task, result: context.result });
      }
    }
  }
  const sourceTaskIds = uniqueSorted(
    params.contexts.map((context) => context.result.task_id),
  );
  const findingIds = uniqueSorted(
    params.contexts.map((context) => context.finding.id),
  );

  return {
    task_id: taskIdFor("conflict", [
      params.conflictKey,
      ...sourceTaskIds,
      ...findingIds,
    ]),
    unit_id: first?.result.unit_id ?? "selective-deepening",
    pass_id: `deepening:${first?.result.pass_id ?? "conflict"}`,
    lens: (first?.result.lens ?? "correctness") as Lens,
    file_paths: paths,
    file_line_counts: Object.fromEntries(
      paths.map((path) => {
        const source = lineSources.get(path);
        return [
          path,
          source
            ? lineCountForPath(path, source.task, source.result, params.lineIndex)
            : (params.lineIndex?.[path] ?? 0),
        ];
      }),
    ),
    rationale:
      `Reconcile conflicting audit output for ${params.conflictKey}. ` +
      `Compare source tasks ${sourceTaskIds.join(", ")} and decide the correct severity, confidence, and evidence-backed conclusion.`,
    priority: maxSeverity >= SEVERITY_RANK.high ? "high" : "medium",
    tags: [
      DEEPENING_TAG,
      "trigger:conflicting_output",
      ...sourceTaskIds.slice(0, 3).map((id) => `source_task:${sanitizeSegment(id)}`),
    ],
    status: "pending",
  };
}

export function conflictGroups(
  contexts: FindingContext[],
): Map<string, FindingContext[]> {
  const groups = new Map<string, FindingContext[]>();
  for (const context of contexts) {
    for (const path of context.paths) {
      const key = [
        context.result.lens,
        context.finding.category,
        path.toLowerCase(),
      ].join(":");
      const group = groups.get(key) ?? [];
      group.push(context);
      groups.set(key, group);
    }
  }
  for (const [key, group] of groups) {
    const uniqueTasks = new Set(group.map((context) => context.result.task_id));
    const severities = group.map((context) => SEVERITY_RANK[context.finding.severity]);
    const confidences = group.map((context) => CONFIDENCE_RANK[context.finding.confidence]);
    const severitySpread = Math.max(...severities) - Math.min(...severities);
    const confidenceSpread = Math.max(...confidences) - Math.min(...confidences);
    if (uniqueTasks.size < 2 || (severitySpread < 2 && confidenceSpread < 2)) {
      groups.delete(key);
    }
  }
  return groups;
}
