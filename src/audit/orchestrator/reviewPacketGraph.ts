// Barrel re-export: reviewPacketGraph was split into three focused sub-modules.
// All external imports of "./reviewPacketGraph.js" continue to resolve here.

// Graph-edge primitives used for packet presentation and quality metrics.
export {
  normalizeGraphPath,
  HIGH_FAN_DEGREE_THRESHOLD,
  collectGraphEdges,
  graphEdgeConfidence,
  isConcreteGraphEdge,
  buildGraphDegreeIndex,
  isPacketExpansionEdge,
  buildFileToGroupKeys,
} from "./reviewPacketGraphEdges.js";
export type { GraphDegreeIndex } from "./reviewPacketGraphEdges.js";

// Packet-level graph context: key edges, boundary files, entrypoints, quality.
export { roundQuality, buildPacketGraphContext } from "./reviewPacketGraphContext.js";
