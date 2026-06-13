import type {
  TaskAffinityGraph,
  TaskAffinityNode,
} from "./taskAffinityGraph.js";

// ---------------------------------------------------------------------------
// Just-in-time graph partition (Phase B of the plan/dispatch seam).
//
// Takes the provider-neutral task-affinity graph and partitions it into packets
// under TWO model-parameterized ceilings — a context-token ceiling and a
// risk-mass ceiling — by greedy agglomerative merging along descending edge
// weight. Both are CEILINGS, not quotas: a high-risk cluster may sit well under
// the token ceiling and that is correct (focused review beats a padded window).
// Because we never merge across an edge that would breach a ceiling, coherent
// clusters split naturally at their weakest internal edge.
//
// This function makes NO model/provider decision — the caller supplies the
// ceilings derived from whatever model it is dispatching to right now. See
// docs/audit-workflow-design.md.
// ---------------------------------------------------------------------------

export interface GraphPacket {
  packet_id: string;
  task_ids: string[];
  /** Sum of member content-token estimates (excludes prompt overhead). */
  token_estimate: number;
  /** Aggregate risk (sum of member risk estimates). */
  risk_mass: number;
  /** Max member risk — the tier this packet routes to. */
  routing_risk: number;
  /** True when a single atomic task alone exceeds the token ceiling. */
  over_budget?: boolean;
}

export interface PartitionOptions {
  /** Context-token ceiling for one packet (the dispatching model's window). */
  contextTokenBudget: number;
  /** Risk-mass ceiling — max aggregate risk one agent should hold at once. */
  riskMassBudget: number;
  /** Per-packet prompt overhead reserved against the context ceiling. */
  promptOverheadTokens?: number;
}

/**
 * Provisional risk-mass ceiling used until N5 supplies real per-model values.
 * Node risk is in [0,1] (high-risk task ≈ 0.7–1.0), so ~4 lets a single agent
 * hold a handful of high-risk tasks (a coherent critical flow) before the cap
 * forces a split along the weakest internal edge. Tunable from real outcomes;
 * a stronger model warrants a higher ceiling. Exposed as the `risk_mass_budget`
 * dispatch knob.
 */
export const DEFAULT_RISK_MASS_BUDGET = 4;

interface Cluster {
  parent: number;
  tokens: number;
  risk: number;
}

function find(clusters: Cluster[], i: number): number {
  let root = i;
  while (clusters[root].parent !== root) root = clusters[root].parent;
  // path compression
  let cur = i;
  while (clusters[cur].parent !== cur) {
    const next = clusters[cur].parent;
    clusters[cur].parent = root;
    cur = next;
  }
  return root;
}

export function partitionTaskGraph(
  graph: TaskAffinityGraph,
  options: PartitionOptions,
): GraphPacket[] {
  const overhead = options.promptOverheadTokens ?? 0;
  const { contextTokenBudget, riskMassBudget } = options;
  const nodes = graph.nodes;
  const indexOf = new Map<string, number>();
  nodes.forEach((n, i) => indexOf.set(n.task_id, i));

  const clusters: Cluster[] = nodes.map((n, i) => ({
    parent: i,
    tokens: n.token_estimate,
    risk: n.risk_estimate,
  }));

  // Process edges strongest-first; merge two clusters only when the merged
  // cluster breaches neither ceiling. Deterministic tie-break by endpoints.
  const sortedEdges = [...graph.edges].sort((a, b) => {
    if (b.weight !== a.weight) return b.weight - a.weight;
    if (a.from !== b.from) return a.from < b.from ? -1 : 1;
    return a.to < b.to ? -1 : a.to > b.to ? 1 : 0;
  });

  for (const edge of sortedEdges) {
    const ui = indexOf.get(edge.from);
    const vi = indexOf.get(edge.to);
    if (ui === undefined || vi === undefined) continue;
    const ru = find(clusters, ui);
    const rv = find(clusters, vi);
    if (ru === rv) continue;
    const combinedTokens = clusters[ru].tokens + clusters[rv].tokens;
    const combinedRisk = clusters[ru].risk + clusters[rv].risk;
    if (combinedTokens + overhead > contextTokenBudget) continue;
    if (combinedRisk > riskMassBudget) continue;
    // union rv into ru
    clusters[rv].parent = ru;
    clusters[ru].tokens = combinedTokens;
    clusters[ru].risk = combinedRisk;
  }

  // Gather members per root.
  const members = new Map<number, TaskAffinityNode[]>();
  nodes.forEach((node, i) => {
    const root = find(clusters, i);
    const list = members.get(root) ?? [];
    list.push(node);
    members.set(root, list);
  });

  const packets: GraphPacket[] = [];
  for (const list of members.values()) {
    const taskIds = list.map((n) => n.task_id).sort();
    const tokenEstimate = list.reduce((s, n) => s + n.token_estimate, 0);
    const riskMass = list.reduce((s, n) => s + n.risk_estimate, 0);
    const routingRisk = list.reduce((m, n) => Math.max(m, n.risk_estimate), 0);
    const overBudget =
      list.length === 1 && tokenEstimate + overhead > contextTokenBudget;
    packets.push({
      packet_id: "",
      task_ids: taskIds,
      token_estimate: tokenEstimate,
      risk_mass: Math.round(riskMass * 1000) / 1000,
      routing_risk: Math.round(routingRisk * 1000) / 1000,
      ...(overBudget ? { over_budget: true } : {}),
    });
  }

  // Stable ordering: highest-routing-risk first, then by first task id.
  packets.sort((a, b) => {
    if (b.routing_risk !== a.routing_risk) return b.routing_risk - a.routing_risk;
    return a.task_ids[0] < b.task_ids[0] ? -1 : a.task_ids[0] > b.task_ids[0] ? 1 : 0;
  });
  packets.forEach((p, i) => {
    p.packet_id = `packet-${i + 1}`;
  });
  return packets;
}
