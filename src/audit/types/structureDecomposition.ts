import type { Finding } from "../types.js";
import type { DecomposedNode } from "audit-tools/shared";

/**
 * The `structure_decomposition.json` artifact — the deterministic structure layer
 * of the conceptual design-review overlay-and-delta operator (Phase B). It is the
 * scaffold the Phase C charter layer runs on: `consensus` nodes are the confident
 * subsystems to charter-review, `contested` nodes are the disputed boundaries
 * (each a hotspot), and `findings` are the two first-class non-co-localization
 * leads (behavioral-cluster-no-purpose / purpose-no-cluster). No LLM content —
 * charters and their deltas are Phase C.
 */
export interface StructureDecomposition {
  generated_at: string;
  /** The decomposition target — `"structure"` at this layer. */
  target: string;
  /** Number of in-scope files the operator decomposed over. */
  node_universe_size: number;
  /** Ids of the sources that actually contributed (empty ones omitted). */
  source_ids: string[];
  /** Confident subsystems: high on both robustness scores. */
  consensus: DecomposedNode[];
  /** Contested boundaries: low on either robustness score. */
  contested: DecomposedNode[];
  /** The two non-co-localization findings (deterministic leads). */
  findings: Finding[];
}
