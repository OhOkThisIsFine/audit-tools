import type { AuditTask } from "../types.js";
import type {
  ReviewPacketGraphEdge,
  ReviewPacketQuality,
} from "../types/reviewPlanning.js";
import type { GraphBundle, GraphEdge } from "@audit-tools/shared";
import { isRecord } from "@audit-tools/shared";
import { UnionFind } from "./unionFind.js";
import {
  normalizeGraphPath,
  isPackageManifestPath,
  isTypescriptProjectConfigPath,
  isGoModuleManifestPath,
  isCargoManifestPath,
  isMavenPomPath,
} from "../extractors/graphPathUtils.js";
import {
  DEFAULT_TARGET_PACKET_TOKENS,
  fileGroupContentTokens,
} from "./reviewPacketSizing.js";

// Planning graph-edge construction: collect graph edges, score/index them, and
// derive the clustering / ownership / entrypoint-flow bridge edges that packet
// planning merges on. The lower DAG layer beneath reviewPackets (packet building
// + plan metrics). normalizeGraphPath is re-exported here for scope.ts
// (delta-scope hub-skipping) and reviewPackets.
export { normalizeGraphPath };

const PACKET_EXPANSION_MIN_CONFIDENCE = 0.65;
/**
 * Fan-in / fan-out degree above which a node is treated as a hub. Exported so
 * the Phase 3 delta-scope expansion skips the same hubs that packet planning
 * skips, preventing scope blow-up through highly-connected modules.
 */
export const HIGH_FAN_DEGREE_THRESHOLD = 12;
const HIGH_FAN_EXPANSION_CONFIDENCE = 0.99;
const MAX_PACKET_KEY_EDGES = 8;
const MAX_PACKET_BOUNDARY_FILES = 12;
const MAX_ENTRYPOINT_FLOW_BRIDGE_HOPS = 3;
const MAX_ENTRYPOINT_FLOW_BRANCHES = 8;
const SUBSYSTEM_CLUSTER_CONFIDENCE = 0.7;
const PACKAGE_OWNERSHIP_CLUSTER_CONFIDENCE = 0.68;
const MODULE_OWNERSHIP_CLUSTER_CONFIDENCE = 0.66;
const ANALYZER_OWNERSHIP_EDGE_KIND = "analyzer-ownership-root-link";
const MAX_SUBSYSTEM_CLUSTER_GROUPS = 4;
const MAX_SUBSYSTEM_CLUSTER_TASKS = 8;
const MAX_SUBSYSTEM_CLUSTER_FILES = 8;
const MODULE_OWNERSHIP_EDGE_KINDS = new Set([
  "typescript-project-reference-link",
  "go-workspace-module-link",
  "cargo-workspace-member-link",
  "maven-module-link",
  ANALYZER_OWNERSHIP_EDGE_KIND,
]);
const BROAD_ANALYZER_OWNERSHIP_ROOTS = new Set([
  "src",
  "lib",
  "app",
  "apps",
  "packages",
  "services",
  "crates",
  "modules",
  "test",
  "tests",
  "spec",
  "specs",
]);

export function collectGraphEdges(graphBundle?: GraphBundle): GraphEdge[] {
  if (!graphBundle?.graphs) {
    return [];
  }
  const edges: GraphEdge[] = [];
  for (const key of ["imports", "calls", "references"]) {
    const raw = graphBundle.graphs[key];
    if (!Array.isArray(raw)) {
      continue;
    }
    for (const item of raw) {
      if (!isRecord(item)) {
        continue;
      }
      if (typeof item.from !== "string" || typeof item.to !== "string") {
        continue;
      }
      const edge: GraphEdge = {
        from: item.from,
        to: item.to,
        kind: typeof item.kind === "string" ? item.kind : undefined,
      };
      if (item.direction === "directed" || item.direction === "undirected") {
        edge.direction = item.direction;
      }
      if (typeof item.confidence === "number" && Number.isFinite(item.confidence)) {
        edge.confidence = Math.min(1, Math.max(0, item.confidence));
      }
      if (typeof item.reason === "string" && item.reason.trim().length > 0) {
        edge.reason = item.reason.trim();
      }
      edges.push(edge);
    }
  }
  return edges;
}

export function graphEdgeConfidence(edge: GraphEdge): number {
  if (typeof edge.confidence === "number" && Number.isFinite(edge.confidence)) {
    return Math.min(1, Math.max(0, edge.confidence));
  }
  if (edge.kind === "heuristic-container-edge") {
    return 0.25;
  }
  if (edge.kind?.startsWith("heuristic-")) {
    return 0.5;
  }
  return 0.8;
}

export function isConcreteGraphEdge(edge: GraphEdge): boolean {
  return edge.kind !== "heuristic-container-edge";
}

export interface GraphDegreeIndex {
  fanIn: Map<string, number>;
  fanOut: Map<string, number>;
}

export function buildGraphDegreeIndex(edges: GraphEdge[]): GraphDegreeIndex {
  const fanIn = new Map<string, number>();
  const fanOut = new Map<string, number>();

  for (const edge of edges) {
    if (!isConcreteGraphEdge(edge)) {
      continue;
    }
    const from = normalizeGraphPath(edge.from);
    const to = normalizeGraphPath(edge.to);
    fanOut.set(from, (fanOut.get(from) ?? 0) + 1);
    fanIn.set(to, (fanIn.get(to) ?? 0) + 1);
  }

  return { fanIn, fanOut };
}

export function isPacketExpansionEdge(
  edge: GraphEdge,
  degreeIndex: GraphDegreeIndex,
): boolean {
  if (!isConcreteGraphEdge(edge)) {
    return false;
  }
  const confidence = graphEdgeConfidence(edge);
  if (confidence < PACKET_EXPANSION_MIN_CONFIDENCE) {
    return false;
  }

  const fromFanOut = degreeIndex.fanOut.get(normalizeGraphPath(edge.from)) ?? 0;
  const toFanIn = degreeIndex.fanIn.get(normalizeGraphPath(edge.to)) ?? 0;
  const highFanEdge =
    fromFanOut > HIGH_FAN_DEGREE_THRESHOLD ||
    toFanIn > HIGH_FAN_DEGREE_THRESHOLD;

  return !highFanEdge || confidence >= HIGH_FAN_EXPANSION_CONFIDENCE;
}

export function buildFileToGroupKeys(
  groups: Map<string, AuditTask[]>,
): Map<string, Set<string>> {
  const fileToGroupKeys = new Map<string, Set<string>>();
  for (const [key, tasks] of groups) {
    for (const path of new Set(tasks.flatMap((task) => task.file_paths))) {
      const normalized = normalizeGraphPath(path);
      const existing = fileToGroupKeys.get(normalized) ?? new Set<string>();
      existing.add(key);
      fileToGroupKeys.set(normalized, existing);
    }
  }
  return fileToGroupKeys;
}

function collectEntrypointFlowRoots(
  graphEdges: GraphEdge[],
  graphBundle?: GraphBundle,
): Set<string> {
  const roots = new Set<string>();
  const routes = Array.isArray(graphBundle?.graphs.routes)
    ? graphBundle.graphs.routes
    : [];

  for (const route of routes) {
    if (isRecord(route) && typeof route.handler === "string") {
      roots.add(normalizeGraphPath(route.handler));
    }
  }

  for (const edge of graphEdges) {
    if (edge.kind === "route-handler-link") {
      roots.add(normalizeGraphPath(edge.from));
      roots.add(normalizeGraphPath(edge.to));
    } else if (edge.kind === "package-entrypoint-link") {
      roots.add(normalizeGraphPath(edge.to));
    }
  }

  return roots;
}

function buildRepresentativePathIndex(
  groups: Map<string, AuditTask[]>,
  graphEdges: GraphEdge[],
  graphBundle?: GraphBundle,
): Map<string, string> {
  const representatives = new Map<string, string>();
  const addPath = (path: string): void => {
    const normalized = normalizeGraphPath(path);
    if (!representatives.has(normalized)) {
      representatives.set(normalized, path);
    }
  };

  for (const tasks of groups.values()) {
    for (const path of tasks.flatMap((task) => task.file_paths)) {
      addPath(path);
    }
  }
  for (const edge of graphEdges) {
    addPath(edge.from);
    addPath(edge.to);
  }
  const routes = Array.isArray(graphBundle?.graphs.routes)
    ? graphBundle.graphs.routes
    : [];
  for (const route of routes) {
    if (isRecord(route) && typeof route.handler === "string") {
      addPath(route.handler);
    }
  }

  return representatives;
}

function uniqueTaskFilePaths(tasks: AuditTask[]): string[] {
  return [...new Set(tasks.flatMap((task) => task.file_paths))].sort((a, b) =>
    a.localeCompare(b),
  );
}

function groupsOverlap(a: Set<string>, b: Set<string>): boolean {
  for (const key of a) {
    if (b.has(key)) {
      return true;
    }
  }
  return false;
}

export function unionFindFromGroups(
  groups: Map<string, AuditTask[]>,
  graphEdges: GraphEdge[],
): UnionFind {
  const uf = new UnionFind(groups.keys());
  const fileToGroupKeys = buildFileToGroupKeys(groups);
  const degreeIndex = buildGraphDegreeIndex(graphEdges);
  const verbose = Boolean(process.env.AUDIT_CODE_VERBOSE);

  for (const keys of fileToGroupKeys.values()) {
    const [first, ...rest] = [...keys].sort((a, b) => a.localeCompare(b));
    if (!first) continue;
    for (const key of rest) {
      if (verbose) {
        const rootBefore = uf.find(key);
        const rootFirst = uf.find(first);
        uf.union(first, key);
        if (rootFirst !== rootBefore) {
          process.stderr.write(
            `[audit-code:packet-planning] shared-file merge: "${first}" + "${key}" (roots "${rootFirst}" + "${rootBefore}" → "${uf.find(first)}")\n`,
          );
        }
      } else {
        uf.union(first, key);
      }
    }
  }

  for (const edge of graphEdges) {
    const fromGroups = fileToGroupKeys.get(normalizeGraphPath(edge.from));
    const toGroups = fileToGroupKeys.get(normalizeGraphPath(edge.to));
    if (!isPacketExpansionEdge(edge, degreeIndex)) {
      if (verbose && fromGroups && toGroups) {
        // Edge has group mappings but was filtered — check if it was the
        // high fan-degree guard specifically.
        const fromFanOut = degreeIndex.fanOut.get(normalizeGraphPath(edge.from)) ?? 0;
        const toFanIn = degreeIndex.fanIn.get(normalizeGraphPath(edge.to)) ?? 0;
        const highFanEdge =
          fromFanOut > HIGH_FAN_DEGREE_THRESHOLD ||
          toFanIn > HIGH_FAN_DEGREE_THRESHOLD;
        if (highFanEdge) {
          process.stderr.write(
            `[audit-code:packet-planning] edge skip (high-fan-degree): "${edge.from}" → "${edge.to}" (fanOut=${fromFanOut}, fanIn=${toFanIn})\n`,
          );
        }
      }
      continue;
    }
    if (!fromGroups || !toGroups) {
      continue;
    }
    for (const fromKey of fromGroups) {
      for (const toKey of toGroups) {
        if (verbose) {
          const rootFrom = uf.find(fromKey);
          const rootTo = uf.find(toKey);
          uf.union(fromKey, toKey);
          if (rootFrom !== rootTo) {
            process.stderr.write(
              `[audit-code:packet-planning] edge-driven merge: "${fromKey}" + "${toKey}" via edge "${edge.from}" → "${edge.to}" (kind=${edge.kind ?? "unknown"})\n`,
            );
          }
        } else {
          uf.union(fromKey, toKey);
        }
      }
    }
  }

  return uf;
}

function buildGraphConnectedComponentIndex(
  groups: Map<string, AuditTask[]>,
  graphEdges: GraphEdge[],
): Map<string, string> {
  const uf = unionFindFromGroups(groups, graphEdges);
  return new Map([...groups.keys()].map((key) => [key, uf.find(key)]));
}

function subsystemRootForPath(path: string): string | undefined {
  const segments = normalizeGraphPath(path).split("/").filter(Boolean);
  const directories = segments.slice(0, -1);
  if (directories.length < 2) {
    return undefined;
  }

  const namespace = directories[0];
  const depth =
    namespace === "apps" || namespace === "packages"
      ? 4
      : namespace === "src" ||
          namespace === "lib" ||
          namespace === "app" ||
          namespace === "tests" ||
          namespace === "test" ||
          namespace === "spec"
        ? 3
        : 2;
  if (directories.length < depth) {
    return undefined;
  }
  return directories.slice(0, depth).join("/");
}

function subsystemRootForTasks(tasks: AuditTask[]): string | undefined {
  const rootsForFiles = uniqueTaskFilePaths(tasks).map(subsystemRootForPath);
  if (rootsForFiles.some((root) => root === undefined)) {
    return undefined;
  }
  const roots = new Set(rootsForFiles);
  return roots.size === 1 ? [...roots][0] : undefined;
}

function buildBoundedClusterEdges(params: {
  groups: Map<string, AuditTask[]>;
  graphEdges: GraphEdge[];
  rootForTasks: (tasks: AuditTask[]) => string | undefined;
  edgeKind: string;
  edgeConfidence: number;
  reasonForCluster: (root: string, fileCount: number) => string;
  lineIndex?: Record<string, number>;
  sizeIndex?: Record<string, number>;
  targetPacketTokens?: number;
}): GraphEdge[] {
  const groupToComponent = buildGraphConnectedComponentIndex(
    params.groups,
    params.graphEdges,
  );
  const clusters = new Map<
    string,
    Array<{
      component: string;
      tasks: AuditTask[];
      filePaths: string[];
      representativePath: string;
    }>
  >();

  for (const [key, tasks] of params.groups) {
    const root = params.rootForTasks(tasks);
    if (!root) {
      continue;
    }
    const filePaths = uniqueTaskFilePaths(tasks);
    const cluster = clusters.get(root) ?? [];
    cluster.push({
      component: groupToComponent.get(key) ?? key,
      tasks,
      filePaths,
      representativePath: filePaths[0] ?? root,
    });
    clusters.set(root, cluster);
  }

  const clusterEdges: GraphEdge[] = [];
  for (const [root, entries] of [...clusters.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    const components = new Map<
      string,
      {
        taskCount: number;
        filePaths: Set<string>;
        representativePath: string;
      }
    >();

    for (const entry of entries) {
      const component = components.get(entry.component) ?? {
        taskCount: 0,
        filePaths: new Set<string>(),
        representativePath: entry.representativePath,
      };
      component.taskCount += entry.tasks.length;
      for (const filePath of entry.filePaths) {
        component.filePaths.add(filePath);
      }
      if (entry.representativePath.localeCompare(component.representativePath) < 0) {
        component.representativePath = entry.representativePath;
      }
      components.set(entry.component, component);
    }

    const componentEntries = [...components.values()].sort((a, b) =>
      a.representativePath.localeCompare(b.representativePath),
    );
    if (
      componentEntries.length < 2 ||
      componentEntries.length > MAX_SUBSYSTEM_CLUSTER_GROUPS
    ) {
      continue;
    }

    const allFiles = new Set(
      componentEntries.flatMap((entry) => [...entry.filePaths]),
    );
    const totalTasks = componentEntries.reduce(
      (sum, entry) => sum + entry.taskCount,
      0,
    );
    const clusterTasks = entries.flatMap((entry) => entry.tasks);
    const totalContentTokens = fileGroupContentTokens(
      allFiles,
      clusterTasks,
      params.sizeIndex,
      params.lineIndex,
    );

    if (
      allFiles.size > MAX_SUBSYSTEM_CLUSTER_FILES ||
      totalTasks > MAX_SUBSYSTEM_CLUSTER_TASKS ||
      totalContentTokens >
        (params.targetPacketTokens ?? DEFAULT_TARGET_PACKET_TOKENS)
    ) {
      continue;
    }

    for (let index = 1; index < componentEntries.length; index++) {
      const previous = componentEntries[index - 1]!;
      const current = componentEntries[index]!;
      clusterEdges.push({
        from: previous.representativePath,
        to: current.representativePath,
        kind: params.edgeKind,
        direction: "undirected",
        confidence: params.edgeConfidence,
        reason: params.reasonForCluster(root, allFiles.size),
      });
    }
  }

  return clusterEdges.sort(compareGraphEdges);
}

function buildSubsystemClusterEdges(
  groups: Map<string, AuditTask[]>,
  graphEdges: GraphEdge[],
  lineIndex?: Record<string, number>,
  sizeIndex?: Record<string, number>,
  targetPacketTokens = DEFAULT_TARGET_PACKET_TOKENS,
): GraphEdge[] {
  return buildBoundedClusterEdges({
    groups,
    graphEdges,
    rootForTasks: subsystemRootForTasks,
    edgeKind: "subsystem-cluster-link",
    edgeConfidence: SUBSYSTEM_CLUSTER_CONFIDENCE,
    reasonForCluster: (root, fileCount) =>
      `Bounded subsystem cluster '${root}' groups ${fileCount} file(s) without stronger graph evidence.`,
    lineIndex,
    sizeIndex,
    targetPacketTokens,
  });
}

function packageManifestRoot(path: string): string | undefined {
  const segments = normalizeGraphPath(path).split("/").filter(Boolean);
  if (!isPackageManifestPath(path) || segments.length < 2) {
    return undefined;
  }
  return segments.slice(0, -1).join("/");
}

function configFileRoot(
  path: string,
  predicate: (p: string) => boolean,
): string | undefined {
  const segments = normalizeGraphPath(path).split("/").filter(Boolean);
  if (!predicate(path) || segments.length < 2) {
    return undefined;
  }
  return segments.slice(0, -1).join("/");
}

function moduleConfigRoot(path: string): string | undefined {
  return (
    configFileRoot(path, isTypescriptProjectConfigPath) ??
    configFileRoot(path, isGoModuleManifestPath) ??
    configFileRoot(path, isCargoManifestPath) ??
    configFileRoot(path, isMavenPomPath)
  );
}

function analyzerOwnershipRoot(path: string): string | undefined {
  const root = normalizeGraphPath(path).replace(/\/+$/, "");
  if (
    root.length === 0 ||
    root === "." ||
    root === ".." ||
    root.startsWith("../") ||
    root.startsWith("/")
  ) {
    return undefined;
  }

  const segments = root.split("/").filter(Boolean);
  if (
    segments.length === 1 &&
    BROAD_ANALYZER_OWNERSHIP_ROOTS.has(segments[0]!)
  ) {
    return undefined;
  }

  return root;
}

function collectPackageOwnershipRoots(
  groups: Map<string, AuditTask[]>,
  graphEdges: GraphEdge[],
): Set<string> {
  const roots = new Set<string>();
  const addRoot = (path: string): void => {
    const root = packageManifestRoot(path);
    if (root) {
      roots.add(root);
    }
  };

  for (const tasks of groups.values()) {
    for (const path of tasks.flatMap((task) => task.file_paths)) {
      addRoot(path);
    }
  }

  for (const edge of graphEdges) {
    addRoot(edge.from);
    addRoot(edge.to);
  }

  return roots;
}

function ownershipRootForPath(
  path: string,
  ownershipRoots: Set<string>,
): string | undefined {
  const normalized = normalizeGraphPath(path);
  let bestMatch: string | undefined;

  for (const root of ownershipRoots) {
    if (
      normalized === `${root}/package.json` ||
      normalized === `${root}/tsconfig.json` ||
      normalized.startsWith(`${root}/`)
    ) {
      if (!bestMatch || root.length > bestMatch.length) {
        bestMatch = root;
      }
    }
  }

  return bestMatch;
}

function packageOwnershipRootForTasks(
  tasks: AuditTask[],
  packageRoots: Set<string>,
): string | undefined {
  if (packageRoots.size === 0) {
    return undefined;
  }

  const rootsForFiles = uniqueTaskFilePaths(tasks).map((path) =>
    ownershipRootForPath(path, packageRoots),
  );
  if (rootsForFiles.some((root) => root === undefined)) {
    return undefined;
  }
  const roots = new Set(rootsForFiles);
  return roots.size === 1 ? [...roots][0] : undefined;
}

function buildPackageOwnershipClusterEdges(
  groups: Map<string, AuditTask[]>,
  graphEdges: GraphEdge[],
  lineIndex?: Record<string, number>,
  sizeIndex?: Record<string, number>,
  targetPacketTokens = DEFAULT_TARGET_PACKET_TOKENS,
): GraphEdge[] {
  const packageRoots = collectPackageOwnershipRoots(groups, graphEdges);
  if (packageRoots.size === 0) {
    return [];
  }

  return buildBoundedClusterEdges({
    groups,
    graphEdges,
    rootForTasks: (tasks) => packageOwnershipRootForTasks(tasks, packageRoots),
    edgeKind: "package-ownership-link",
    edgeConfidence: PACKAGE_OWNERSHIP_CLUSTER_CONFIDENCE,
    reasonForCluster: (root, fileCount) =>
      `Package ownership root '${root}' groups ${fileCount} file(s) across bounded package subdirectories.`,
    lineIndex,
    sizeIndex,
    targetPacketTokens,
  });
}

function collectModuleOwnershipRoots(
  groups: Map<string, AuditTask[]>,
  graphEdges: GraphEdge[],
): Map<string, "project configuration" | "analyzer ownership hint"> {
  const roots = new Map<string, "project configuration" | "analyzer ownership hint">();
  const addRoot = (path: string): void => {
    const root = moduleConfigRoot(path);
    if (root) {
      roots.set(root, roots.get(root) ?? "project configuration");
    }
  };
  const addAnalyzerRoot = (path: string): void => {
    const root = analyzerOwnershipRoot(path);
    if (root) {
      roots.set(root, roots.get(root) ?? "analyzer ownership hint");
    }
  };

  for (const tasks of groups.values()) {
    for (const path of tasks.flatMap((task) => task.file_paths)) {
      addRoot(path);
    }
  }

  for (const edge of graphEdges) {
    if (edge.kind === ANALYZER_OWNERSHIP_EDGE_KIND) {
      addAnalyzerRoot(edge.from);
      continue;
    }
    if (!MODULE_OWNERSHIP_EDGE_KINDS.has(edge.kind ?? "")) {
      continue;
    }
    addRoot(edge.from);
    addRoot(edge.to);
  }

  return roots;
}

function moduleOwnershipRootForTasks(
  tasks: AuditTask[],
  moduleRoots: Set<string>,
): string | undefined {
  if (moduleRoots.size === 0) {
    return undefined;
  }

  const rootsForFiles = uniqueTaskFilePaths(tasks).map((path) =>
    ownershipRootForPath(path, moduleRoots),
  );
  if (rootsForFiles.some((root) => root === undefined)) {
    return undefined;
  }
  const roots = new Set(rootsForFiles);
  return roots.size === 1 ? [...roots][0] : undefined;
}

function buildModuleOwnershipClusterEdges(
  groups: Map<string, AuditTask[]>,
  graphEdges: GraphEdge[],
  lineIndex?: Record<string, number>,
  sizeIndex?: Record<string, number>,
  targetPacketTokens = DEFAULT_TARGET_PACKET_TOKENS,
): GraphEdge[] {
  const moduleRoots = collectModuleOwnershipRoots(groups, graphEdges);
  if (moduleRoots.size === 0) {
    return [];
  }
  const moduleRootSet = new Set(moduleRoots.keys());

  return buildBoundedClusterEdges({
    groups,
    graphEdges,
    rootForTasks: (tasks) => moduleOwnershipRootForTasks(tasks, moduleRootSet),
    edgeKind: "module-ownership-link",
    edgeConfidence: MODULE_OWNERSHIP_CLUSTER_CONFIDENCE,
    reasonForCluster: (root, fileCount) => {
      const source = moduleRoots.get(root) ?? "project configuration";
      return source === "analyzer ownership hint"
        ? `Module ownership root '${root}' from analyzer ownership hint groups ${fileCount} file(s) across bounded subdirectories.`
        : `Module ownership root '${root}' from project configuration groups ${fileCount} file(s) across bounded subdirectories.`;
    },
    lineIndex,
    sizeIndex,
    targetPacketTokens,
  });
}

function buildEntrypointFlowBridgeEdges(
  groups: Map<string, AuditTask[]>,
  graphEdges: GraphEdge[],
  graphBundle?: GraphBundle,
): GraphEdge[] {
  const roots = collectEntrypointFlowRoots(graphEdges, graphBundle);
  if (roots.size === 0) {
    return [];
  }

  const fileToGroupKeys = buildFileToGroupKeys(groups);
  const degreeIndex = buildGraphDegreeIndex(graphEdges);
  const representatives = buildRepresentativePathIndex(
    groups,
    graphEdges,
    graphBundle,
  );
  const adjacency = new Map<string, GraphEdge[]>();

  for (const edge of graphEdges) {
    if (
      edge.direction === "undirected" ||
      !isPacketExpansionEdge(edge, degreeIndex)
    ) {
      continue;
    }
    const from = normalizeGraphPath(edge.from);
    const edges = adjacency.get(from) ?? [];
    edges.push(edge);
    adjacency.set(from, edges);
  }
  for (const edges of adjacency.values()) {
    edges.sort(compareGraphEdges);
  }

  const bridgeEdges = new Map<string, GraphEdge>();
  const displayPath = (normalized: string): string =>
    representatives.get(normalized) ?? normalized;

  for (const root of [...roots].sort((a, b) => a.localeCompare(b))) {
    const rootGroups = fileToGroupKeys.get(root);
    if (!rootGroups) {
      continue;
    }

    const queue: Array<{ node: string; path: string[]; edges: GraphEdge[] }> = [
      { node: root, path: [root], edges: [] },
    ];
    const visited = new Set<string>([root]);

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || current.edges.length >= MAX_ENTRYPOINT_FLOW_BRIDGE_HOPS) {
        continue;
      }

      const outgoing = adjacency.get(current.node) ?? [];
      if (outgoing.length > MAX_ENTRYPOINT_FLOW_BRANCHES) {
        continue;
      }

      for (const edge of outgoing) {
        const target = normalizeGraphPath(edge.to);
        if (current.path.includes(target)) {
          continue;
        }
        const nextEdges = [...current.edges, edge];
        const nextPath = [...current.path, target];
        const targetGroups = fileToGroupKeys.get(target);

        if (
          targetGroups &&
          nextEdges.length > 1 &&
          !groupsOverlap(rootGroups, targetGroups)
        ) {
          const from = displayPath(root);
          const to = displayPath(target);
          const intermediates = nextPath.slice(1, -1).map(displayPath);
          const confidence = Math.min(...nextEdges.map(graphEdgeConfidence));
          const bridgeEdge: GraphEdge = {
            from,
            to,
            kind: "entrypoint-flow-link",
            direction: "directed",
            confidence,
            reason:
              intermediates.length > 0
                ? `Entrypoint flow from '${from}' reaches '${to}' via ${intermediates.join(" -> ")}.`
                : `Entrypoint flow from '${from}' reaches '${to}'.`,
          };
          bridgeEdges.set(`${from}\0${to}\0${bridgeEdge.kind}`, bridgeEdge);
        }

        if (
          !targetGroups &&
          nextEdges.length < MAX_ENTRYPOINT_FLOW_BRIDGE_HOPS &&
          !visited.has(target)
        ) {
          visited.add(target);
          queue.push({
            node: target,
            path: nextPath,
            edges: nextEdges,
          });
        }
      }
    }
  }

  return [...bridgeEdges.values()].sort(compareGraphEdges);
}

export function buildPlanningGraphEdges(
  groups: Map<string, AuditTask[]>,
  graphEdges: GraphEdge[],
  graphBundle?: GraphBundle,
  lineIndex?: Record<string, number>,
  sizeIndex?: Record<string, number>,
  targetPacketTokens = DEFAULT_TARGET_PACKET_TOKENS,
): GraphEdge[] {
  let edges = graphEdges;

  const bridgeEdges = buildEntrypointFlowBridgeEdges(groups, edges, graphBundle);
  if (bridgeEdges.length > 0) edges = [...edges, ...bridgeEdges];

  const subsystemEdges = buildSubsystemClusterEdges(groups, edges, lineIndex, sizeIndex, targetPacketTokens);
  if (subsystemEdges.length > 0) edges = [...edges, ...subsystemEdges];

  const packageOwnershipEdges = buildPackageOwnershipClusterEdges(groups, edges, lineIndex, sizeIndex, targetPacketTokens);
  if (packageOwnershipEdges.length > 0) edges = [...edges, ...packageOwnershipEdges];

  const moduleOwnershipEdges = buildModuleOwnershipClusterEdges(groups, edges, lineIndex, sizeIndex, targetPacketTokens);
  if (moduleOwnershipEdges.length > 0) edges = [...edges, ...moduleOwnershipEdges];

  return edges;
}

function compareGraphEdges(a: GraphEdge, b: GraphEdge): number {
  const confidenceDelta = graphEdgeConfidence(b) - graphEdgeConfidence(a);
  if (confidenceDelta !== 0) return confidenceDelta;
  return (
    a.from.localeCompare(b.from) ||
    a.to.localeCompare(b.to) ||
    (a.kind ?? "").localeCompare(b.kind ?? "")
  );
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

export function roundQuality(value: number): number {
  return Math.round(value * 1000) / 1000;
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
    .sort((a, b) => a.localeCompare(b));
}

export function buildPacketGraphContext(
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
      .sort((a, b) => a.localeCompare(b))
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
