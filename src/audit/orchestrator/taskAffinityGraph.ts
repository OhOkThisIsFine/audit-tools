// sites-pinned: tests/audit/task-affinity-graph.test.ts, tests/audit/partition-task-graph.test.ts
import { z } from "zod";

// ---------------------------------------------------------------------------
// Task-affinity graph for semantic workload coherence.
//
// Nodes are audit tasks carrying frozen local estimates; edges express soft,
// weighted relatedness between tasks. The persisted graph contains semantic
// planning metadata only. The host workload projects its connected coherence
// groups without consulting backend identity, capacity, or concurrency.
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

export const TaskAffinityEdgeSchema = z
  .object({
    /** task_id of one endpoint (undirected; emitted once, from < to). */
    from: z.string(),
    to: z.string(),
    /** Dominant relatedness kind (the one contributing the max weight). */
    kind: TaskAffinityEdgeKindSchema,
    /** Affinity strength in [0,1], retained as explanatory metadata. */
    weight: z.number(),
    /** All contributing kinds (+ "same_lens" bonus), for transparency. */
    reason: z.string().optional(),
  })
  .strict();

export const TaskAffinityGraphSchema = z
  .object({
    schema_version: z.literal("task-affinity-graph/v1"),
    nodes: z.array(TaskAffinityNodeSchema),
    edges: z.array(TaskAffinityEdgeSchema),
  })
  .strict()
  .superRefine((graph, context) => {
    const nodeIds = new Set<string>();
    for (const [index, node] of graph.nodes.entries()) {
      if (nodeIds.has(node.task_id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["nodes", index, "task_id"],
          message: `Duplicate task-affinity node id: ${node.task_id}`,
        });
      }
      nodeIds.add(node.task_id);
    }
    for (const [index, edge] of graph.edges.entries()) {
      if (edge.from === edge.to) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["edges", index],
          message: `Self task-affinity edge: ${edge.from}`,
        });
      }
      if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["edges", index],
          message: `Dangling task-affinity edge: ${edge.from} -> ${edge.to}`,
        });
      }
    }
  });
export type TaskAffinityGraph = z.infer<typeof TaskAffinityGraphSchema>;
