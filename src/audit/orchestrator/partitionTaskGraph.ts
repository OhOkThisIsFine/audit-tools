import {
  buildContentCoherenceTrace,
  type ContentCoherenceRelationship,
  type ContentCoherenceTrace,
} from "../../shared/decompose/contentCoherence.js";
import {
  TaskAffinityGraphSchema,
  type TaskAffinityGraph,
} from "./taskAffinityGraph.js";

/** Audit projection of one canonical content-coherence component. */
export interface GraphPacket {
  packet_id: string;
  task_ids: string[];
  token_estimate: number;
  risk_mass: number;
  risk_score: number;
}

export interface TaskCoherencePartition {
  coherence_trace: ContentCoherenceTrace;
  packets: GraphPacket[];
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function relationshipsFromGraph(
  graph: TaskAffinityGraph,
): ContentCoherenceRelationship[] {
  const deduped = new Map<string, ContentCoherenceRelationship>();
  for (const edge of graph.edges) {
    const pair = [edge.from, edge.to].sort(compareCodeUnits);
    const kinds = [
      edge.kind,
      ...(edge.reason?.split(",").map((kind) => kind.trim()) ?? []),
    ].filter((kind) => kind.length > 0);
    for (const kind of new Set(kinds)) {
      const relationship = { left: pair[0]!, right: pair[1]!, kind };
      deduped.set(`${relationship.left}\u0000${relationship.right}\u0000${kind}`, relationship);
    }
  }
  return [...deduped.values()].sort((left, right) => {
    const leftKey = `${left.left}\u0000${left.right}\u0000${left.kind}`;
    const rightKey = `${right.left}\u0000${right.right}\u0000${right.kind}`;
    return compareCodeUnits(leftKey, rightKey);
  });
}

/**
 * Project the persisted task-affinity graph through the shared membership core.
 * Any additional JavaScript arguments are deliberately inert: backend sizing
 * is not an input to semantic membership.
 */
export function buildTaskCoherencePartition(
  input: TaskAffinityGraph,
  ..._ignored: readonly unknown[]
): TaskCoherencePartition {
  const graph = TaskAffinityGraphSchema.parse(input);
  const coherenceTrace = buildContentCoherenceTrace({
    items: graph.nodes.map((node) => ({
      id: node.task_id,
      file_paths: node.file_paths,
      unit_ids: node.unit_id.length > 0 ? [node.unit_id] : [],
      tags: node.lens.length > 0 ? [node.lens] : [],
    })),
    relationships: relationshipsFromGraph(graph),
  });
  const nodeById = new Map(graph.nodes.map((node) => [node.task_id, node]));
  const packets = coherenceTrace.components.map((taskIds, index) => {
    const nodes = taskIds.map((taskId) => nodeById.get(taskId)!);
    const riskMass = nodes.reduce((sum, node) => sum + node.risk_estimate, 0);
    const riskScore = nodes.reduce(
      (highest, node) => Math.max(highest, node.risk_estimate),
      0,
    );
    return {
      packet_id: `packet-${index + 1}`,
      task_ids: [...taskIds],
      token_estimate: nodes.reduce(
        (sum, node) => sum + node.token_estimate,
        0,
      ),
      risk_mass: Math.round(riskMass * 1_000) / 1_000,
      risk_score: Math.round(riskScore * 1_000) / 1_000,
    };
  });
  return { coherence_trace: coherenceTrace, packets };
}
