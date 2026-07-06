// Phase E — the LANGUAGE-NEUTRAL aggregate-metrics digest TYPES (leaf module).
//
// The digest interfaces live here, apart from the `aggregateMetricsDigest`
// derivation, so a consumer that only needs the SHAPE (the systemic_challenge
// register type) can import it WITHOUT pulling in `aggregateMetricsDigest.ts` — which
// depends on `ArtifactBundle` (io/artifacts.ts) and would otherwise close a
// types → systemic → io → types import cycle (ARC-1fa005bb regression guard). Pure
// type-only leaf: no imports, no runtime.

/**
 * A single language-neutral rollup: an abstract count with a short, ecosystem-free
 * label. `unit` names WHAT is counted in neutral terms ("components", "edges",
 * "subsystems"), never a tool or language.
 */
export interface MetricRollup {
  label: string;
  count: number;
  unit: string;
}

/**
 * The aggregate-metrics digest — a stable, content-derived set of abstract rollups.
 * Language-neutral: expressed as counts / fan-out / dispersion over the neutral
 * graph + structure artifacts. Deterministic: same bundle → identical digest (so it
 * never churns the artifact hash).
 */
export interface AggregateMetricsDigest {
  /** Ordered abstract rollups (component/unit/subsystem/edge/task counts). */
  rollups: MetricRollup[];
  /** Max fan-out: the highest out-degree over the dependency graph (0 if none). */
  max_fan_out: number;
  /** Total directed edges across every graph category — the coupling mass. */
  total_edges: number;
  /**
   * Count of nodes carrying a structural metric (complexity OR duplication) — the
   * MEASURED surface the adversary can probe for over-built / duplicated code.
   * Language-neutral: the metrics are computed over whatever source the graph
   * builder understood; a node without metrics simply isn't counted (never
   * zero-filled). Deliberately a presence count, not a threshold on the raw
   * `value` — the raw scale is measure-specific, so thresholding it here would
   * smuggle an ecosystem assumption into a language-neutral contract.
   */
  metric_covered_nodes: number;
}
