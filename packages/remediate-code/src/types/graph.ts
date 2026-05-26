export interface GraphEdge {
  from: string;
  to: string;
  kind?: string;
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
    routes?: RouteEdge[];
    [key: string]: unknown;
  };
}
