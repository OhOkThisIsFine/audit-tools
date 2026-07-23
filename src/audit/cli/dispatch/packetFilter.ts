import type { SessionConfig, GraphBundle, DispatchModelHint, DispatchModelTier } from "audit-tools/shared";
import type { AuditTask } from "../../types.js";
import type { ReviewPacket } from "../../types/reviewPlanning.js";
import type { ArtifactBundle } from "../../io/artifacts.js";
import type { TaskAffinityGraph } from "../../orchestrator/taskAffinityGraph.js";
import type { DispatchComplexity } from "./types.js";
import {
  orderTasksForPacketReview,
  buildReviewPacketsFromPartition,
  orderReviewPackets,
  sizeIndexFromManifest,
} from "../../orchestrator/reviewPackets.js";
import {
  buildTaskAffinityGraph,
  filterTaskAffinityGraph,
} from "../../orchestrator/taskAffinityGraph.js";
import { LARGE_FILE_PACKET_TARGET_LINES } from "./types.js";
import { resolveDispatchTier, TIER_ORDER } from "./tierRouting.js";
import { derivePendingTaskPartition } from "../../orchestrator/pendingTasks.js";

// Packet filtering and fitting: budget cap, pending-task derivation,
// JIT task-graph resolution, per-tier re-fit pass, oversized warnings, and
// dispatch-complexity assembly. Pure logic — no file I/O.

export function isIsolatedLargeFilePacket(packet: {
  file_paths: string[];
  total_lines: number;
}): boolean {
  return (
    packet.file_paths.length === 1 &&
    packet.total_lines > LARGE_FILE_PACKET_TARGET_LINES
  );
}

export function buildDispatchComplexity(
  packet: {
    task_ids: string[];
    file_paths: string[];
    total_lines: number;
    estimated_tokens: number;
    priority: NonNullable<AuditTask["priority"]>;
    lenses: AuditTask["lens"][];
    tags?: string[];
  },
  largeFileMode: boolean,
): DispatchComplexity {
  return {
    priority: packet.priority,
    task_count: packet.task_ids.length,
    file_count: packet.file_paths.length,
    total_lines: packet.total_lines,
    estimated_tokens: packet.estimated_tokens,
    lenses: packet.lenses,
    tags: packet.tags ?? [],
    large_file_mode: largeFileMode,
  };
}

export function buildPendingAuditTasks(bundle: ArtifactBundle) {
  // The pending set is the shared partition (INV-PENDING-SINGLE-SOURCE,
  // orchestrator/pendingTasks.ts) — the SAME derivation deriveAuditState's
  // `audit_tasks_completed` obligation consumes, so dispatch and the gate never
  // disagree on which tasks still need work. A drifted task re-dispatches even
  // though its stale result left it status `complete` (O3).
  const { pendingTasks } = derivePendingTaskPartition(bundle);
  const lineIndex = Object.fromEntries(
    pendingTasks.flatMap((task) => Object.entries(task.file_line_counts ?? {})),
  );
  // No continuity bias here: this returns a task ORDER that every downstream
  // consumer re-derives (the JIT partitioner + admission re-order independently),
  // so a continuity pass would be discarded work. The bias lives where it bites —
  // the final packet sort in buildReviewPacketsFromPartition / fitPacketsToTierBudgets.
  return orderTasksForPacketReview(pendingTasks, {
    graphBundle: bundle.graph_bundle,
    lineIndex,
    sizeIndex: sizeIndexFromManifest(bundle.repo_manifest),
  });
}

interface FilterPacketsResult {
  emitPackets: ReviewPacket[];
  deferredPackets: ReviewPacket[];
}

/**
 * Encapsulates the budget-cap filtering logic.
 * Returns the subset of packets to emit this round plus deferred packets.
 */
export function filterPackets(
  packets: ReviewPacket[],
  sessionConfig: SessionConfig,
): FilterPacketsResult {
  const maxPackets = sessionConfig.dispatch?.max_packets;
  const budgetCapped =
    typeof maxPackets === "number" &&
    maxPackets >= 0 &&
    maxPackets < packets.length;
  const emitPackets = budgetCapped
    ? packets.slice(0, maxPackets)
    : packets;
  const deferredPackets = budgetCapped
    ? packets.slice(maxPackets)
    : [];

  return { emitPackets, deferredPackets };
}

/**
 * Resolve the task-affinity graph to partition at dispatch: prefer the persisted
 * provider-neutral graph (built + frozen at planning) restricted to the still-
 * pending tasks; fall back to building one from the dispatch tasks when the
 * persisted graph is missing or doesn't cover every pending task (older
 * artifacts or freshly generated tasks). Frozen per-task estimates live on the
 * tasks, so a rebuild reuses the same node numbers.
 */
export function resolveDispatchTaskGraph(
  bundle: ArtifactBundle,
  orderedTasks: AuditTask[],
): TaskAffinityGraph {
  const pendingIds = new Set(orderedTasks.map((task) => task.task_id));
  const persisted = bundle.task_affinity_graph;
  if (persisted && persisted.nodes.length > 0) {
    const covered = persisted.nodes.filter((node) =>
      pendingIds.has(node.task_id),
    ).length;
    if (covered === pendingIds.size) {
      return filterTaskAffinityGraph(persisted, pendingIds);
    }
  }
  return buildTaskAffinityGraph(orderedTasks, {
    graphBundle: bundle.graph_bundle,
  });
}

/**
 * Per-tier re-fit pass (partition-then-validate, design (a) of the roster
 * handshake): the initial partition runs under the LARGEST reported window so
 * coherent clusters are not over-split, but risk routing may then assign a
 * packet to a rank with a smaller window. Re-partition just that packet's
 * subgraph under its assigned tier's budget. The re-split sub-packets get
 * their own tiers, so iterate to a bounded fixed point; a packet that cannot
 * split further (single task, or the partition refuses) is left for the
 * oversized-packet warning.
 */
export function fitPacketsToTierBudgets(params: {
  packets: ReviewPacket[];
  taskGraph: TaskAffinityGraph;
  orderedTasks: AuditTask[];
  tierBudgets: Record<DispatchModelTier, number>;
  sessionConfig: SessionConfig;
  lineIndex?: Record<string, number>;
  sizeIndex?: Record<string, number>;
  graphBundle?: GraphBundle;
  /** Continuity scores so a per-tier re-split preserves the access-memory ordering bias. */
  continuityScores?: Map<string, number>;
}): ReviewPacket[] {
  const { tierBudgets, sessionConfig } = params;
  let packets = params.packets;
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    const next: ReviewPacket[] = [];
    for (const packet of packets) {
      const hint = resolveDispatchTier({
        routingRisk: packet.routing_risk,
        complexity: buildDispatchComplexity(
          packet,
          isIsolatedLargeFilePacket(packet),
        ),
        routingTiers: sessionConfig.dispatch?.routing_tiers,
      });
      if (
        packet.estimated_tokens <= tierBudgets[hint.tier] ||
        packet.task_ids.length <= 1
      ) {
        next.push(packet);
        continue;
      }
      const memberIds = new Set(packet.task_ids);
      const subPackets = buildReviewPacketsFromPartition(
        params.orderedTasks.filter((task) => memberIds.has(task.task_id)),
        {
          graph: filterTaskAffinityGraph(params.taskGraph, memberIds),
          contextTokenBudget: tierBudgets[hint.tier],
          riskMassBudget: sessionConfig.dispatch?.risk_mass_budget,
          graphBundle: params.graphBundle,
          lineIndex: params.lineIndex,
          sizeIndex: params.sizeIndex,
          continuityScores: params.continuityScores,
        },
      );
      if (subPackets.length <= 1) {
        next.push(packet);
        continue;
      }
      next.push(...subPackets);
      changed = true;
    }
    packets = next;
    if (!changed) break;
  }
  // Re-establish the canonical global order: an in-place split appends a packet's
  // sub-packets where the parent sat, so without this a low-priority sub-packet
  // could sit ahead of a higher-priority packet (priority-monotonicity break) and
  // the continuity ordering would be lost across the split boundary. One final
  // sort restores both (priority → continuity → size → id).
  return orderReviewPackets(packets, params.continuityScores);
}

/**
 * Extracts the context-budget warning loop.
 * Returns warnings for packets whose estimated token count exceeds the context
 * budget — the assigned tier's budget when the host reported a roster, the
 * single resolved window otherwise.
 * When confidence is 'low', returns an empty array (limits are unreliable).
 */
export function collectOversizedWarnings(
  plan: Array<{
    packet_id: string;
    complexity: DispatchComplexity;
    model_hint?: DispatchModelHint;
  }>,
  waveSchedule: { confidence: string; resolved_limits: { context_tokens: number; output_tokens: number } },
  tierBudgets?: Record<DispatchModelTier, number> | null,
): Array<{ code: string; message: string }> {
  if (waveSchedule.confidence === "low") {
    return [];
  }
  const fallbackBudget = Math.max(
    0,
    waveSchedule.resolved_limits.context_tokens - waveSchedule.resolved_limits.output_tokens,
  );
  const warnings: Array<{ code: string; message: string }> = [];
  for (const p of plan) {
    const tier = p.model_hint?.tier;
    const contextBudget =
      tierBudgets && tier ? tierBudgets[tier] : fallbackBudget;
    if (p.complexity.estimated_tokens > contextBudget) {
      warnings.push({
        code: "oversized_packet",
        message:
          `Packet ${p.packet_id} estimated tokens (${p.complexity.estimated_tokens}) exceed ` +
          `context budget (${contextBudget}). This packet may fail at dispatch. ` +
          `Set quota.default_context_tokens or quota.models in session-config.json to override.`,
      });
    }
  }
  return warnings;
}
