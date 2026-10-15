import { afterEach, expect, test, vi } from "vitest";
import * as context from "../../src/audit/orchestrator/reviewPacketGraphContext.js";
import { buildAuditPlanMetrics, buildReviewPacketPlanningData } from "../../src/audit/orchestrator/reviewPackets.js";
import type { AuditTask } from "../../src/audit/types.js";

import type { GraphBundle, GraphEdge } from "audit-tools/shared";
import { isRecord, compareCodeUnits } from "audit-tools/shared";
import type {
  ReviewPacketGraphEdge,
  ReviewPacketQuality,
} from "../../src/audit/types/reviewPlanning.js";
import { normalizeGraphPath } from "../../src/audit/extractors/graphPathUtils.js";
import {
  isConcreteGraphEdge,
  graphEdgeConfidence,
  compareGraphEdges,
} from "../../src/audit/orchestrator/reviewPacketGraphEdges.js";

// Frozen a4cf53d scan oracle: intentionally independent of candidate index selection.

const MAX_PACKET_KEY_EDGES = 8;
const MAX_PACKET_BOUNDARY_FILES = 12;

function roundQuality(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function reviewPacketGraphEdge(edge: GraphEdge): ReviewPacketGraphEdge {
  const result: ReviewPacketGraphEdge = {
    from: edge.from,
    to: edge.to,
    confidence: graphEdgeConfidence(edge),
  };
  if (edge.kind) result.kind = edge.kind;
  if (edge.reason) result.reason = edge.reason;
  return result;
}

function packetEntrypoints(
  filePaths: string[],
  graphBundle?: GraphBundle,
): string[] {
  const fileSet = new Set(filePaths.map(normalizeGraphPath));
  const routes = Array.isArray(graphBundle?.graphs.routes)
    ? graphBundle.graphs.routes
    : [];

  return routes
    .filter(
      (route) =>
        isRecord(route) &&
        typeof route.handler === "string" &&
        typeof route.path === "string" &&
        fileSet.has(normalizeGraphPath(route.handler)),
    )
    .map((route) => {
      const method = typeof route.method === "string" ? `${route.method} ` : "";
      return `${method}${route.path} -> ${route.handler}`;
    })
    .sort((a, b) => compareCodeUnits(a, b));
}

function baselineContext(
  filePaths: string[],
  graphEdges: GraphEdge[],
  graphBundle?: GraphBundle,
): {
  keyEdges: ReviewPacketGraphEdge[];
  boundaryFiles: string[];
  entrypoints: string[];
  quality: ReviewPacketQuality;
} {
  const fileSet = new Set(filePaths.map(normalizeGraphPath));
  const internalEdges: GraphEdge[] = [];
  const boundaryFiles = new Set<string>();
  let boundaryEdgeCount = 0;

  for (const edge of graphEdges) {
    if (!isConcreteGraphEdge(edge)) {
      continue;
    }
    const fromInPacket = fileSet.has(normalizeGraphPath(edge.from));
    const toInPacket = fileSet.has(normalizeGraphPath(edge.to));
    if (fromInPacket && toInPacket) {
      internalEdges.push(edge);
    } else if (fromInPacket !== toInPacket) {
      boundaryEdgeCount += 1;
      boundaryFiles.add(fromInPacket ? edge.to : edge.from);
    }
  }

  const internallyConnectedFiles = new Set<string>();
  for (const edge of internalEdges) {
    internallyConnectedFiles.add(normalizeGraphPath(edge.from));
    internallyConnectedFiles.add(normalizeGraphPath(edge.to));
  }

  const unexplainedFileCount =
    filePaths.length <= 1
      ? 0
      : filePaths.filter(
          (path) => !internallyConnectedFiles.has(normalizeGraphPath(path)),
        ).length;
  const cohesionScore =
    filePaths.length <= 1
      ? 1
      : Math.min(1, internalEdges.length / (filePaths.length - 1));

  return {
    keyEdges: internalEdges
      .sort(compareGraphEdges)
      .slice(0, MAX_PACKET_KEY_EDGES)
      .map(reviewPacketGraphEdge),
    boundaryFiles: [...boundaryFiles]
      .sort((a, b) => compareCodeUnits(a, b))
      .slice(0, MAX_PACKET_BOUNDARY_FILES),
    entrypoints: packetEntrypoints(filePaths, graphBundle),
    quality: {
      cohesion_score: roundQuality(cohesionScore),
      internal_edge_count: internalEdges.length,
      boundary_edge_count: boundaryEdgeCount,
      unexplained_file_count: unexplainedFileCount,
    },
  };
}


afterEach(() => vi.restoreAllMocks());

test("indexed contexts match the scan oracle for duplicate occurrences, aliases and stable ties", () => {
  let seed = 42;
  const random = (n: number): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % n;
  };
  const paths = ["a/x.ts", "b/y.ts", "./a/x.ts", "b\\y.ts", "outside", "solo"];
  const kinds = ["imports", "heuristic-container-edge", "heuristic-other", undefined];
  const confidence = [undefined, 0, 0.8, 1, NaN, Infinity, -1];
  for (let run = 0; run < 200; run += 1) {
    const edges: GraphEdge[] = Array.from({ length: random(150) }, (_, i) => ({
      from: paths[random(paths.length)]!, to: paths[random(paths.length)]!,
      kind: kinds[random(kinds.length)], confidence: confidence[random(confidence.length)],
      reason: `reason-${i}`,
    }));
    if (edges.length) edges.push({ ...edges[0]!, reason: "same keys, distinct reason" }, edges[0]!);
    const routes: unknown[] = Array.from({ length: random(40) }, () => ({
      handler: paths[random(paths.length)], path: `/route${random(4)}`, method: random(2) ? "GET" : 42,
    }));
    routes.push(null, {}, [], { handler: 23, path: "/bad" }, { handler: "a/x.ts", path: 23 });
    if (routes[0]) routes.push(routes[0]);
    const bundle = { graphs: { routes } } as unknown as GraphBundle;
    const index = context.createPacketGraphContextIndex(edges, bundle);
    for (let query = 0; query < 10; query += 1) {
      const files = Array.from({ length: random(7) }, () => paths[random(paths.length)]!);
      const expected = baselineContext(files, edges, bundle);
      expect(context.buildPacketGraphContextFromIndex(files, index)).toEqual(expected);
      expect(context.buildPacketGraphContext(files, edges, bundle)).toEqual(expected);
    }
  }
});

test("empty inputs and malformed or absent route collections retain scan behavior", () => {
  for (const bundle of [undefined, { graphs: {} }, { graphs: { routes: {} } } as unknown as GraphBundle]) {
    for (const files of [[], ["solo"], ["solo", "solo"]]) {
      expect(context.buildPacketGraphContext(files, [], bundle)).toEqual(baselineContext(files, [], bundle));
    }
  }
});

function makeTask(id: string, paths: string[]): AuditTask {
  return {
    task_id: id, unit_id: id, pass_id: `pass:${id}`, lens: "correctness",
    file_paths: paths, file_line_counts: Object.fromEntries(paths.map(path => [path, 10])),
    rationale: `Review ${id}.`, priority: "medium", token_estimate: 100, risk_estimate: 0.2,
  };
}

test("full serialized packets and metrics retain baseline context and complete graph arrays", () => {
  const tasks = [makeTask("a", ["a/x.ts", "./a/x.ts"]), makeTask("b", ["b/y.ts"]), makeTask("z", ["solo"])];
  const edges: GraphEdge[] = [
    ...Array.from({ length: 10 }, (_, i) => ({ from: "a/x.ts", to: "b/y.ts", kind: "imports", reason: `tie-${i}` })),
    { from: "a/x.ts", to: "a/x.ts", kind: "calls" },
    { from: "a/x.ts", to: "outside", kind: "imports" },
    { from: "solo", to: "a/x.ts", kind: "heuristic-container-edge" },
    { from: "neither", to: "unrelated", kind: "imports" },
  ];
  const route = { handler: "./a/x.ts", path: "/x", method: "GET" };
  const graphBundle = { graphs: { imports: edges, routes: [route, route, null, { handler: 42 }] } } as unknown as GraphBundle;
  const options = { graphBundle, generatedAt: new Date("2026-10-15T00:00:00Z") };
  const planning = buildReviewPacketPlanningData(tasks, options);
  const metrics = buildAuditPlanMetrics(tasks, options);
  expect(planning.graphEdges).toEqual(edges);
  expect(planning.planningGraphEdges).toBe(planning.graphEdges);
  vi.spyOn(context, "buildPacketGraphContextFromIndex").mockImplementation(files => baselineContext(files, edges, graphBundle));
  expect(JSON.stringify(buildReviewPacketPlanningData(tasks, options).packets)).toBe(JSON.stringify(planning.packets));
  expect(JSON.stringify(buildAuditPlanMetrics(tasks, options))).toBe(JSON.stringify(metrics));
});

function countReads<T>(values: readonly T[], visit: () => void): readonly T[] {
  return new Proxy(values, {
    get(target, key, receiver) {
      if (typeof key === "string" && /^(0|[1-9][0-9]*)$/.test(key)) visit();
      return Reflect.get(target, key, receiver);
    },
  });
}

test("500 sparse packets build one index and select 500 edge and route occurrences", () => {
  const edges: GraphEdge[] = Array.from({ length: 500 }, (_, i) => ({
    from: `p${i}/a.ts`, to: `p${i}/b.ts`, kind: "imports",
  }));
  const routes = edges.map(edge => ({ handler: edge.from, path: "/route" }));
  const graphBundle: GraphBundle = { graphs: { imports: edges, routes } };
  const tasks = edges.map((edge, i) => makeTask(`task-${i}`, [edge.from, edge.to]));
  let selectedEdges = 0;
  let selectedRoutes = 0;
  const create = context.createPacketGraphContextIndex;
  const build = vi.spyOn(context, "createPacketGraphContextIndex").mockImplementation((allEdges, bundle) => {
    const index = create(allEdges, bundle);
    return {
      ...index,
      graphEdges: countReads(index.graphEdges, () => { selectedEdges += 1; }),
      routesByHandler: new Map([...index.routesByHandler].map(([handler, occurrences]) => [
        handler, countReads(occurrences, () => { selectedRoutes += 1; }),
      ])),
    };
  });
  const planning = buildReviewPacketPlanningData(tasks, { graphBundle });
  expect(planning.packets).toHaveLength(500);
  expect(build).toHaveBeenCalledTimes(1);
  expect(selectedEdges).toBe(500);
  expect(selectedRoutes).toBe(500);
  let baselineEdges = 0;
  let baselineRoutes = 0;
  const scanEdges = countReads(edges, () => { baselineEdges += 1; }) as GraphEdge[];
  const scanRoutes = countReads(routes, () => { baselineRoutes += 1; }) as typeof routes;
  for (const packet of planning.packets) {
    expect(baselineContext(packet.file_paths, scanEdges, { graphs: { routes: scanRoutes } })).toEqual({
      keyEdges: packet.key_edges ?? [], boundaryFiles: packet.boundary_files ?? [],
      entrypoints: packet.entrypoints ?? [], quality: packet.quality,
    });
  }
  expect(baselineEdges).toBe(250_000);
  expect(baselineRoutes).toBe(250_000);
});
