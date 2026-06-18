import { z } from "zod";
import type { AuditTask } from "../types.js";
import type { GraphBundle, GraphEdge } from "@audit-tools/shared";

// ---------------------------------------------------------------------------
// Task-affinity graph (Phase A of the plan/dispatch seam).
//
// Nodes are audit tasks carrying their FROZEN provider-neutral estimates;
// edges express SOFT, weighted relatedness between tasks. This graph is the
// persisted, provider-neutral planning artifact. It encodes no model, packet,
// tier, or concurrency decision. At dispatch time a provider partitions this
// graph into packets just-in-time, under its own model's context + risk-mass
// ceilings (see docs/audit-workflow-design.md).
//
// Reuses the language-neutral edge contract shape (from/to/kind/weight/reason)
// and is kept DISTINCT from graph_bundle.json (which is code structure, not
// tasks).
// ---------------------------------------------------------------------------

export const TaskAffinityEdgeKindSchema = z.enum([
  "shared_file",
  "cross_lens_same_file",
  "same_flow",
  "same_unit",
  "call_adjacent",
  "same_dir",
]);
export type TaskAffinityEdgeKind = z.infer<typeof TaskAffinityEdgeKindSchema>;

export const TaskAffinityNodeSchema = z
  .object({
    task_id: z.string(),
    unit_id: z.string(),
    lens: z.string(),
    file_paths: z.array(z.string()),
    /** Frozen byte-based content-token estimate (from the task). */
    token_estimate: z.number(),
    /** Frozen audit-risk score in [0,1] (from the task). */
    risk_estimate: z.number(),
  })
  .strict();
export type TaskAffinityNode = z.infer<typeof TaskAffinityNodeSchema>;

export const TaskAffinityEdgeSchema = z
  .object({
    /** task_id of one endpoint (undirected; emitted once, from < to). */
    from: z.string(),
    to: z.string(),
    /** Dominant relatedness kind (the one contributing the max weight). */
    kind: TaskAffinityEdgeKindSchema,
    /** Affinity weight in [0,1]; higher = pack together first. */
    weight: z.number(),
    /** All contributing kinds (+ "same_lens" bonus), for transparency. */
    reason: z.string().optional(),
  })
  .strict();
export type TaskAffinityEdge = z.infer<typeof TaskAffinityEdgeSchema>;

export const TaskAffinityGraphSchema = z
  .object({
    schema_version: z.literal("task-affinity-graph/v1"),
    nodes: z.array(TaskAffinityNodeSchema),
    edges: z.array(TaskAffinityEdgeSchema),
  })
  .strict();
export type TaskAffinityGraph = z.infer<typeof TaskAffinityGraphSchema>;

/**
 * Restrict a task-affinity graph to a set of task ids, keeping only nodes whose
 * task survives and edges whose both endpoints survive. Used at dispatch to
 * partition only the still-pending tasks from a persisted full-run graph.
 */
export function filterTaskAffinityGraph(
  graph: TaskAffinityGraph,
  keep: ReadonlySet<string>,
): TaskAffinityGraph {
  const nodes = graph.nodes.filter((n) => keep.has(n.task_id));
  const have = new Set(nodes.map((n) => n.task_id));
  const edges = graph.edges.filter((e) => have.has(e.from) && have.has(e.to));
  return { schema_version: graph.schema_version, nodes, edges };
}

// Per-kind base weights. Tuned so stronger structural coupling packs first.
const KIND_WEIGHT: Record<TaskAffinityEdgeKind, number> = {
  shared_file: 0.9,
  cross_lens_same_file: 0.85,
  same_flow: 0.6,
  same_unit: 0.55,
  call_adjacent: 0.4,
  same_dir: 0.35,
};
// Small additive nudge when two related tasks also share a lens (a single agent
// reviewing one lens benefits from shared mental model). Never a standalone edge.
const SAME_LENS_BONUS = 0.05;

function dirOf(path: string): string {
  const norm = path.replace(/\\/g, "/");
  const idx = norm.lastIndexOf("/");
  return idx === -1 ? "" : norm.slice(0, idx);
}

function flowIdsOf(task: AuditTask): Set<string> {
  const out = new Set<string>();
  for (const tag of task.tags ?? []) {
    if (tag.startsWith("critical_flow:")) out.add(tag.slice("critical_flow:".length));
  }
  return out;
}

function looksLikePath(value: string): boolean {
  return value.includes("/") || value.includes("\\");
}

/**
 * Build a file → adjacent-files map from the code-structure graph bundle's
 * import/call/reference edges. Only path-like endpoints are used, so this
 * degrades gracefully to "no call-adjacency edges" when the bundle's nodes are
 * symbol ids rather than file paths.
 */
function buildFileAdjacency(graphBundle?: GraphBundle): Map<string, Set<string>> {
  const adjacency = new Map<string, Set<string>>();
  if (!graphBundle) return adjacency;
  const edgeGroups: Array<GraphEdge[] | undefined> = [
    graphBundle.graphs.imports,
    graphBundle.graphs.calls,
    graphBundle.graphs.references,
  ];
  const link = (a: string, b: string) => {
    if (!adjacency.has(a)) adjacency.set(a, new Set());
    adjacency.get(a)!.add(b);
  };
  for (const edges of edgeGroups) {
    if (!Array.isArray(edges)) continue;
    for (const edge of edges) {
      if (!edge || !looksLikePath(edge.from) || !looksLikePath(edge.to)) continue;
      const a = edge.from.replace(/\\/g, "/");
      const b = edge.to.replace(/\\/g, "/");
      if (a === b) continue;
      link(a, b);
      link(b, a);
    }
  }
  return adjacency;
}

function intersects<T>(a: Set<T>, b: Iterable<T>): boolean {
  for (const item of b) if (a.has(item)) return true;
  return false;
}

/**
 * Build the provider-neutral task-affinity graph from frozen tasks. Each task
 * must already carry `token_estimate` and `risk_estimate` (planning freezes
 * them); missing values default to 0 so the graph is always well-formed.
 */
export function buildTaskAffinityGraph(
  tasks: ReadonlyArray<AuditTask>,
  options: { graphBundle?: GraphBundle } = {},
): TaskAffinityGraph {
  const nodes: TaskAffinityNode[] = tasks.map((task) => ({
    task_id: task.task_id,
    unit_id: task.unit_id,
    lens: task.lens,
    file_paths: task.file_paths,
    token_estimate: task.token_estimate ?? 0,
    risk_estimate: task.risk_estimate ?? 0,
  }));

  const adjacency = buildFileAdjacency(options.graphBundle);
  // Precompute per-task derived sets to keep the O(n^2) pass cheap.
  const fileSets = tasks.map((t) => new Set(t.file_paths.map((p) => p.replace(/\\/g, "/"))));
  const dirSets = tasks.map(
    (t) => new Set(t.file_paths.map((p) => dirOf(p))),
  );
  const flowSets = tasks.map((t) => flowIdsOf(t));
  const neighborSets = tasks.map((t) => {
    const out = new Set<string>();
    for (const p of t.file_paths) {
      const adj = adjacency.get(p.replace(/\\/g, "/"));
      if (adj) for (const n of adj) out.add(n);
    }
    return out;
  });

  const edges: TaskAffinityEdge[] = [];
  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      const kinds: TaskAffinityEdgeKind[] = [];

      const sharesFile = intersects(fileSets[i], fileSets[j]);
      if (sharesFile) {
        // Same file(s), different lens → a single agent could cover both lenses.
        kinds.push(
          tasks[i].lens !== tasks[j].lens ? "cross_lens_same_file" : "shared_file",
        );
      }
      if (flowSets[i].size > 0 && intersects(flowSets[i], flowSets[j])) {
        kinds.push("same_flow");
      }
      if (tasks[i].unit_id === tasks[j].unit_id) kinds.push("same_unit");
      if (
        neighborSets[i].size > 0 &&
        (intersects(neighborSets[i], fileSets[j]) ||
          intersects(neighborSets[j], fileSets[i]))
      ) {
        kinds.push("call_adjacent");
      }
      if (intersects(dirSets[i], dirSets[j])) kinds.push("same_dir");

      if (kinds.length === 0) continue;

      let dominant = kinds[0];
      let weight = KIND_WEIGHT[dominant];
      for (const k of kinds) {
        if (KIND_WEIGHT[k] > weight) {
          weight = KIND_WEIGHT[k];
          dominant = k;
        }
      }
      const reasons: string[] = [...kinds];
      if (tasks[i].lens === tasks[j].lens) {
        weight = Math.min(1, weight + SAME_LENS_BONUS);
        reasons.push("same_lens");
      }

      const [from, to] =
        tasks[i].task_id < tasks[j].task_id
          ? [tasks[i].task_id, tasks[j].task_id]
          : [tasks[j].task_id, tasks[i].task_id];
      edges.push({
        from,
        to,
        kind: dominant,
        weight: Math.round(weight * 1000) / 1000,
        reason: reasons.join(","),
      });
    }
  }

  return { schema_version: "task-affinity-graph/v1", nodes, edges };
}
