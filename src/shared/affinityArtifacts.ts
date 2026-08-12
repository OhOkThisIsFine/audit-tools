/**
 * Canonical copies for the two persisted task-affinity artifacts.
 *
 * `stableStringify` sorts object keys but deliberately preserves array order,
 * while `writeJsonFile` preserves both object insertion order and array order.
 * These artifacts therefore need one semantic canonicalization boundary shared
 * by construction, persistence, and metadata hashing.
 */

export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortObjectKeys<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => sortObjectKeys(item)) as T;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort(compareCodeUnits)
        .map((key) => [key, sortObjectKeys(record[key])]),
    ) as T;
  }
  return value;
}

function sortedUniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareCodeUnits);
}

export interface CanonicalAuditTaskShape {
  task_id: string;
  file_paths: string[];
  file_line_counts?: Record<string, number>;
  line_ranges?: Array<{ path: string; start: number; end: number }>;
  inputs?: Record<string, string>;
  tags?: string[];
}

function compareLineRanges(
  left: { path: string; start: number; end: number },
  right: { path: string; start: number; end: number },
): number {
  const path = compareCodeUnits(left.path, right.path);
  if (path !== 0) return path;
  const start = left.start - right.start;
  return start !== 0 ? start : left.end - right.end;
}

function canonicalizeAuditTask<T extends CanonicalAuditTaskShape>(task: T): T {
  if (!task || typeof task !== "object" || typeof task.task_id !== "string") {
    throw new Error("Invalid audit task: task_id must be a string");
  }
  if (!Array.isArray(task.file_paths)) {
    throw new Error(`Invalid audit task ${task.task_id}: file_paths must be an array`);
  }

  const copy = {
    ...task,
    file_paths: sortedUniqueStrings(task.file_paths),
    ...(task.file_line_counts !== undefined
      ? { file_line_counts: { ...task.file_line_counts } }
      : {}),
    ...(task.inputs !== undefined ? { inputs: { ...task.inputs } } : {}),
    ...(task.line_ranges !== undefined
      ? {
          line_ranges: task.line_ranges
            .map((range) => ({ ...range }))
            .sort(compareLineRanges),
        }
      : {}),
    ...(task.tags !== undefined
      ? { tags: sortedUniqueStrings(task.tags) }
      : {}),
  } as T;

  return sortObjectKeys(copy);
}

export function canonicalizeAuditTasks<T extends CanonicalAuditTaskShape>(
  tasks: ReadonlyArray<T>,
): T[] {
  if (!Array.isArray(tasks)) {
    throw new Error("Invalid audit_tasks artifact: expected an array");
  }

  const seen = new Set<string>();
  const canonical = tasks.map((task) => {
    const copy = canonicalizeAuditTask(task);
    if (seen.has(copy.task_id)) {
      throw new Error(`Duplicate audit task id: ${copy.task_id}`);
    }
    seen.add(copy.task_id);
    return copy;
  });
  return canonical.sort((left, right) =>
    compareCodeUnits(left.task_id, right.task_id),
  );
}

export interface CanonicalAffinityNodeShape {
  task_id: string;
  file_paths: string[];
}

export interface CanonicalAffinityEdgeShape {
  from: string;
  to: string;
  kind: string;
  weight: number;
  reason?: string;
}

export interface CanonicalAffinityGraphShape {
  schema_version: string;
  nodes: CanonicalAffinityNodeShape[];
  edges: CanonicalAffinityEdgeShape[];
}

function compareAffinityEdges(
  left: CanonicalAffinityEdgeShape,
  right: CanonicalAffinityEdgeShape,
): number {
  for (const [leftValue, rightValue] of [
    [left.from, right.from],
    [left.to, right.to],
    [left.kind, right.kind],
    [left.reason ?? "", right.reason ?? ""],
  ] as const) {
    const compared = compareCodeUnits(leftValue, rightValue);
    if (compared !== 0) return compared;
  }
  return left.weight - right.weight;
}

export function canonicalizeTaskAffinityGraph<
  T extends CanonicalAffinityGraphShape,
>(graph: T): T {
  if (
    !graph ||
    typeof graph !== "object" ||
    !Array.isArray(graph.nodes) ||
    !Array.isArray(graph.edges)
  ) {
    throw new Error("Invalid task_affinity_graph artifact");
  }

  const nodeIds = new Set<string>();
  const nodes = graph.nodes.map((node) => {
    if (typeof node.task_id !== "string" || !Array.isArray(node.file_paths)) {
      throw new Error("Invalid task-affinity node");
    }
    if (nodeIds.has(node.task_id)) {
      throw new Error(`Duplicate task-affinity node id: ${node.task_id}`);
    }
    nodeIds.add(node.task_id);
    return sortObjectKeys({
      ...node,
      file_paths: sortedUniqueStrings(node.file_paths),
    });
  });

  const edges = graph.edges.map((edge) => {
    if (
      typeof edge.from !== "string" ||
      typeof edge.to !== "string" ||
      typeof edge.kind !== "string" ||
      typeof edge.weight !== "number"
    ) {
      throw new Error("Invalid task-affinity edge");
    }
    if (edge.from === edge.to) {
      throw new Error(`Self task-affinity edge: ${edge.from}`);
    }
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
      throw new Error(
        `Dangling task-affinity edge: ${edge.from} -> ${edge.to}`,
      );
    }
    const [from, to] =
      compareCodeUnits(edge.from, edge.to) < 0
        ? [edge.from, edge.to]
        : [edge.to, edge.from];
    return sortObjectKeys({ ...edge, from, to });
  });

  nodes.sort((left, right) => compareCodeUnits(left.task_id, right.task_id));
  edges.sort(compareAffinityEdges);
  return sortObjectKeys({ ...graph, nodes, edges }) as T;
}

/** Apply the affinity canonicalizer only at the two artifact-name seams. */
export function canonicalizeAffinityArtifactValue(
  artifactName: string,
  value: unknown,
): unknown {
  if (artifactName === "audit_tasks.json") {
    return canonicalizeAuditTasks(value as CanonicalAuditTaskShape[]);
  }
  if (artifactName === "task_affinity_graph.json") {
    return canonicalizeTaskAffinityGraph(
      value as CanonicalAffinityGraphShape,
    );
  }
  return value;
}
