// Phase E — the LANGUAGE-NEUTRAL aggregate-metrics digest.
//
// The systemic improvement-seeking challenge loop feeds a second-order adversary an
// aggregate view of the system so it can reason about redundancy / serial-that-could-
// be-parallel / over-built shape (design of record backlog "Feed aggregate metrics
// into the systemic context"). The digest is NECESSARY supporting evidence, but
// explicitly NOT SUFFICIENT on its own — the adversary reasons from the whole picture
// (structure, charters, findings), not from the counts.
//
// Every field is a LANGUAGE-NEUTRAL abstraction — abstract counts / timeouts / fan-out
// — never an ecosystem-specific measure like a "vitest collect time" or a "webpack
// chunk". A rollup that only makes sense for one ecosystem is a coupling bug: it would
// fork the systemic pass per-language, which the language-neutral-by-contract invariant
// forbids. Counts are derived from the already-language-neutral graph/structure
// artifacts, so the digest inherits their neutrality.
//
// PURE + deterministic: no IO, no LLM. Reads only the bundle. Absent inputs degrade to
// zero counts (an early-stage bundle still produces a valid, empty digest).

import type { ArtifactBundle } from "../io/artifacts.js";
import type { AggregateMetricsDigest, MetricRollup } from "./metricsDigestTypes.js";

export type { AggregateMetricsDigest, MetricRollup } from "./metricsDigestTypes.js";

function countEdges(bundle: ArtifactBundle): { total: number; maxFanOut: number } {
  const graphs = bundle.graph_bundle?.graphs;
  if (!graphs) return { total: 0, maxFanOut: 0 };
  let total = 0;
  const outDegree = new Map<string, number>();
  for (const value of Object.values(graphs)) {
    if (!Array.isArray(value)) continue;
    for (const edge of value as Array<{ from?: unknown }>) {
      total += 1;
      const from = typeof edge?.from === "string" ? edge.from : undefined;
      if (from) outDegree.set(from, (outDegree.get(from) ?? 0) + 1);
    }
  }
  let maxFanOut = 0;
  for (const degree of outDegree.values()) {
    if (degree > maxFanOut) maxFanOut = degree;
  }
  return { total, maxFanOut };
}

function countMetricCoveredNodes(bundle: ArtifactBundle): number {
  const nodeMetrics = bundle.graph_bundle?.node_metrics;
  if (!nodeMetrics) return 0;
  let count = 0;
  for (const metrics of Object.values(nodeMetrics)) {
    if (metrics?.complexity !== undefined || metrics?.duplication !== undefined) {
      count += 1;
    }
  }
  return count;
}

/**
 * Build the language-neutral aggregate-metrics digest from the bundle. Deterministic
 * and total: an early bundle missing analysis artifacts yields zero counts, never
 * throws. Rollups are emitted in a fixed content-independent order so the artifact
 * never churns.
 */
export function aggregateMetricsDigest(bundle: ArtifactBundle): AggregateMetricsDigest {
  const componentCount = bundle.repo_manifest?.files?.length ?? 0;
  const unitCount = bundle.unit_manifest?.units?.length ?? 0;
  const consensusCount = bundle.structure_decomposition?.consensus?.length ?? 0;
  const contestedCount = bundle.structure_decomposition?.contested?.length ?? 0;
  const taskCount = bundle.audit_tasks?.length ?? 0;
  const { total: totalEdges, maxFanOut } = countEdges(bundle);
  const metricCoveredNodes = countMetricCoveredNodes(bundle);

  const rollups: MetricRollup[] = [
    { label: "Components", count: componentCount, unit: "components" },
    { label: "Analysis units", count: unitCount, unit: "units" },
    { label: "Consensus subsystems", count: consensusCount, unit: "subsystems" },
    { label: "Contested subsystems", count: contestedCount, unit: "subsystems" },
    { label: "Dependency edges", count: totalEdges, unit: "edges" },
    { label: "Planned audit tasks", count: taskCount, unit: "tasks" },
    { label: "Metric-covered nodes", count: metricCoveredNodes, unit: "nodes" },
  ];

  return {
    rollups,
    max_fan_out: maxFanOut,
    total_edges: totalEdges,
    metric_covered_nodes: metricCoveredNodes,
  };
}
