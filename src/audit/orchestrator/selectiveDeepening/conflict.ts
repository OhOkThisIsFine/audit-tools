// sites-pinned: tests/audit/selective-deepening-conflicts.test.ts, tests/audit/selective-deepening-handoff.test.ts
import { compareCodeUnits, stableStringify } from "audit-tools/shared";
import { lineCountForPath } from "../lineCounts.js";
import type { AuditResult, AuditTask, Lens } from "../../types.js";
import {
  CONFIDENCE_RANK,
  DEEPENING_TAG,
  type FindingContext,
  SEVERITY_RANK,

  sanitizeSegment,
  taskIdFor,
  uniqueSorted,
} from "./shared.js";

export function buildConflictFollowupTask(params: {
  contexts: FindingContext[];
  conflictKeys: string[];
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
      params.conflictKeys[0]!,
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
            ? lineCountForPath(path, { task: source.task, result: source.result, lineIndex: params.lineIndex })
            : (params.lineIndex?.[path] ?? 0),
        ];
      }),
    ),
    rationale:
      `Reconcile conflicting audit output for ${params.conflictKeys.join(", ")}. ` +
      `Compare source tasks ${sourceTaskIds.join(", ")} and decide the correct severity, confidence, and evidence-backed conclusion.`,
    priority: maxSeverity >= SEVERITY_RANK.high ? "high" : "medium",
    tags: [
      DEEPENING_TAG,
      "trigger:conflicting_output",
      ...sourceTaskIds.map((id) => `source_task:${sanitizeSegment(id)}`),
    ],
    status: "pending",
  };
}

function conflictGroups(
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

/** Coalesce only already-qualified buckets with exactly the same member set. */
export function coalescedConflictGroups(
  contexts: FindingContext[],
  lineIndex?: Record<string, number>,
): Array<{ conflictKeys: string[]; contexts: FindingContext[] }> {
  type Member = { context: FindingContext; primary: string; secondary: string };
  function members(group: FindingContext[]): Member[] {
    const ordered = group.map((context) => {
      const paths = uniqueSorted(context.paths);
      return {
        context,
        primary: stableStringify([
          context.result.task_id, context.result.unit_id, context.result.pass_id,
          context.result.lens, context.result.agent_role ?? null,
          context.finding.id, context.finding.category, context.finding, paths,
        ]),
        // Only effective builder inputs break equal-member ties. This is a
        // lexicographic representative choice, not a preference for more lines.
        secondary: stableStringify(paths.map((path) => [path, lineCountForPath(path, {
          task: context.task, result: context.result, lineIndex,
        })])),
      };
    }).sort((a, b) => compareCodeUnits(a.primary, b.primary) || compareCodeUnits(a.secondary, b.secondary));
    return ordered.filter((member, index) => index === 0 || member.primary !== ordered[index - 1]!.primary);
  }

  const classes = new Map<string, { conflictKeys: string[]; contexts: FindingContext[] }>();
  for (const [key, group] of conflictGroups(contexts)) {
    const canonical = members(group);
    const membership = stableStringify(canonical.map((member) => member.primary));
    const existing = classes.get(membership);
    if (existing) {
      existing.conflictKeys.push(key);
      existing.contexts.push(...canonical.map((member) => member.context));
    } else {
      classes.set(membership, { conflictKeys: [key], contexts: canonical.map((member) => member.context) });
    }
  }
  return [...classes.values()].map((group) => ({
    conflictKeys: uniqueSorted(group.conflictKeys),
    contexts: members(group.contexts).map((member) => member.context),
  })).sort((a, b) => compareCodeUnits(a.conflictKeys[0]!, b.conflictKeys[0]!));
}
