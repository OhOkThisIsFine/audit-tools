import type { AnalyzerSetting } from "@audit-tools/shared";
import type { AnalyzerResolution } from "../extractors/analyzers/types.js";

// Marker artifact recording the outcome of the optional Phase 5 graph-enrichment
// pass. Its presence (and freshness against `graph_bundle.json`) satisfies the
// `graph_enrichment_current` obligation; the merged analyzer edges themselves
// live in `graph_bundle.json` (with `analyzers_used[]` provenance).

export type AnalyzerCapabilityStatus = "applied" | "omitted";

export interface AnalyzerCapabilityEntry {
  id: string;
  resolution: AnalyzerResolution;
  setting: AnalyzerSetting;
  edges_added: number;
  routes_added: number;
  note?: string;
}

export interface AnalyzerCapabilityRecord {
  /** `applied` when ≥1 analyzer contributed edges/routes; `omitted` otherwise. */
  status: AnalyzerCapabilityStatus;
  analyzers: AnalyzerCapabilityEntry[];
}
