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
}
