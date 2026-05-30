export interface GraphEdge {
  from: string;
  to: string;
  kind?: string;
  direction?: "directed" | "undirected";
  confidence?: number;
  reason?: string;
}

export interface RouteEdge {
  path: string;
  handler: string;
  method?: string;
}

export interface GraphBundle {
  graphs: {
    imports?: GraphEdge[];
    calls?: GraphEdge[];
    references?: GraphEdge[];
    routes?: RouteEdge[];
    [key: string]: unknown;
  };
  /**
   * Provenance for the optional graph-enrichment pass: the ids of the language
   * analyzers whose edges were merged into this bundle (empty/absent when only
   * the deterministic regex floor was used). See Phase 5 analyzer seam.
   */
  analyzers_used?: string[];
}
