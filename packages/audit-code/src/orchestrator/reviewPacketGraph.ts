// Barrel re-export: reviewPacketGraph was split into three focused sub-modules.
// All external imports of "./reviewPacketGraph.js" continue to resolve here.

// Graph-edge primitives: collection, confidence, degree index, expansion
// predicate, group-key mapping, union-find merge.
export {
  normalizeGraphPath,
  HIGH_FAN_DEGREE_THRESHOLD,
  collectGraphEdges,
  graphEdgeConfidence,
  isConcreteGraphEdge,
  buildGraphDegreeIndex,
  isPacketExpansionEdge,
  buildFileToGroupKeys,
  unionFindFromGroups,
} from "./reviewPacketGraphEdges.js";
export type { GraphDegreeIndex } from "./reviewPacketGraphEdges.js";

// Cluster edge builders: subsystem, package-ownership, module-ownership,
// entrypoint-flow bridges → combined into planning graph edges.
export { buildPlanningGraphEdges } from "./reviewPacketGraphClustering.js";

// Packet-level graph context: key edges, boundary files, entrypoints, quality.
export { roundQuality, buildPacketGraphContext } from "./reviewPacketGraphContext.js";
