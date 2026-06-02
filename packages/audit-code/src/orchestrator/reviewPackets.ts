import { createHash } from "node:crypto";
import type { AuditTask, Lens } from "../types.js";
import type {
  AuditPlanMetrics,
  ReviewPacket,
  ReviewPacketGraphEdge,
  ReviewPacketQuality,
  WeaklyExplainedPacketSample,
} from "../types/reviewPlanning.js";
import type { GraphBundle, GraphEdge } from "@audit-tools/shared";
import { isRecord } from "@audit-tools/shared";
import { LENS_ORDER, priorityRank, sortLenses } from "./auditTaskUtils.js";
import { UnionFind } from "./unionFind.js";
import {
  normalizeGraphPath,
  isPackageManifestPath,
  isTypescriptProjectConfigPath,
  isGoModuleManifestPath,
  isCargoManifestPath,
  isMavenPomPath,
} from "../extractors/graphPathUtils.js";

// Re-exported for scope.ts, which imports the canonical path normalizer here.
export { normalizeGraphPath };

import {
  DEFAULT_MAX_TASKS_PER_PACKET,
  DEFAULT_TARGET_PACKET_TOKENS,
  ESTIMATED_TOKENS_PER_LINE,
  ESTIMATED_PACKET_PROMPT_TOKENS,
  sizeIndexFromManifest,
  fileGroupContentTokens,
  taskContentTokens,
  estimateTaskGroupTokens,
} from "./reviewPacketSizing.js";

// Sizing / token-budget arithmetic moved to reviewPacketSizing.ts; re-exported
// here for the modules that import it from reviewPackets.
export {
  ESTIMATED_TOKENS_PER_LINE,
  ESTIMATED_PACKET_PROMPT_TOKENS,
  sizeIndexFromManifest,
  estimateTaskGroupTokens,
};

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
const MAX_WEAK_PACKET_SAMPLES = 12;
const MAX_WEAK_PACKET_SAMPLE_FILES = 8;
const WEAK_PACKET_GAP_ORDER: WeaklyExplainedPacketSample["primary_gap"][] = [
  "missing_internal_edges",
  "unexplained_files",
  "partial_cohesion",
];
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

export interface BuildReviewPacketOptions {
  graphBundle?: GraphBundle;
  lineIndex?: Record<string, number>;
  /** Path → size_bytes (from the repo manifest); drives byte-based token sizing. */
  sizeIndex?: Record<string, number>;
  maxTasksPerPacket?: number;
  /**
   * Soft per-packet content-token budget. Defaults to
   * DEFAULT_TARGET_PACKET_TOKENS. A packet is split when its estimated content
   * tokens would exceed this budget.
   */
  targetPacketTokens?: number;
  /**
   * Available context budget in tokens (context_tokens − reserved_output_tokens).
   * When provided, targetPacketTokens is capped to fit within this budget so a
   * packet's estimated tokens never exceed it.
   */
  maxContextTokens?: number;
}

interface ReviewPacketPlanningData {
  graphEdges: GraphEdge[];
  groups: Map<string, AuditTask[]>;
  planningGraphEdges: GraphEdge[];
  packets: ReviewPacket[];
}

function normalizePriority(priority: AuditTask["priority"]): NonNullable<AuditTask["priority"]> {
  return priority ?? "low";
}

function lineCountForPath(
  task: AuditTask,
  path: string,
  lineIndex?: Record<string, number>,
): number {
  return task.file_line_counts?.[path] ?? lineIndex?.[path] ?? 0;
}

function taskLineCount(
  task: AuditTask,
  lineIndex?: Record<string, number>,
): number {
  return task.file_paths.reduce(
    (sum, path) => sum + lineCountForPath(task, path, lineIndex),
    0,
  );
}

function taskFileSignature(task: AuditTask): string {
  return [...new Set(task.file_paths)].sort((a, b) => a.localeCompare(b)).join("\0");
}

function packetGroupingKey(task: AuditTask): string {
  const criticalFlowTag = task.tags?.find((tag) =>
    tag.startsWith("critical_flow:"),
  );
  const scope = criticalFlowTag ?? task.unit_id;
  return `${scope}\0${taskFileSignature(task)}`;
}

function buildTaskGroups(tasks: AuditTask[]): Map<string, AuditTask[]> {
  const groups = new Map<string, AuditTask[]>();
  for (const task of tasks) {
    const key = packetGroupingKey(task);
    const group = groups.get(key) ?? [];
    group.push(task);
    groups.set(key, group);
  }
  return groups;
}

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

function isConcreteGraphEdge(edge: GraphEdge): boolean {
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

function isPacketExpansionEdge(
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

function buildFileToGroupKeys(
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

function unionFindFromGroups(
  groups: Map<string, AuditTask[]>,
  graphEdges: GraphEdge[],
): UnionFind {
  const uf = new UnionFind(groups.keys());
  const fileToGroupKeys = buildFileToGroupKeys(groups);
  const degreeIndex = buildGraphDegreeIndex(graphEdges);

  for (const keys of fileToGroupKeys.values()) {
    const [first, ...rest] = [...keys].sort((a, b) => a.localeCompare(b));
    if (!first) continue;
    for (const key of rest) {
      uf.union(first, key);
    }
  }

  for (const edge of graphEdges) {
    if (!isPacketExpansionEdge(edge, degreeIndex)) {
      continue;
    }
    const fromGroups = fileToGroupKeys.get(normalizeGraphPath(edge.from));
    const toGroups = fileToGroupKeys.get(normalizeGraphPath(edge.to));
    if (!fromGroups || !toGroups) {
      continue;
    }
    for (const fromKey of fromGroups) {
      for (const toKey of toGroups) {
        uf.union(fromKey, toKey);
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

function buildPlanningGraphEdges(
  groups: Map<string, AuditTask[]>,
  graphEdges: GraphEdge[],
  graphBundle?: GraphBundle,
  lineIndex?: Record<string, number>,
  sizeIndex?: Record<string, number>,
  targetPacketTokens = DEFAULT_TARGET_PACKET_TOKENS,
): GraphEdge[] {
  const bridgeEdges = buildEntrypointFlowBridgeEdges(
    groups,
    graphEdges,
    graphBundle,
  );
  const graphWithBridges =
    bridgeEdges.length > 0 ? [...graphEdges, ...bridgeEdges] : graphEdges;
  const subsystemEdges = buildSubsystemClusterEdges(
    groups,
    graphWithBridges,
    lineIndex,
    sizeIndex,
    targetPacketTokens,
  );
  const graphWithSubsystems =
    subsystemEdges.length > 0
      ? [...graphWithBridges, ...subsystemEdges]
      : graphWithBridges;
  const packageOwnershipEdges = buildPackageOwnershipClusterEdges(
    groups,
    graphWithSubsystems,
    lineIndex,
    sizeIndex,
    targetPacketTokens,
  );
  const graphWithPackageOwnership =
    packageOwnershipEdges.length > 0
      ? [...graphWithSubsystems, ...packageOwnershipEdges]
      : graphWithSubsystems;
  const moduleOwnershipEdges = buildModuleOwnershipClusterEdges(
    groups,
    graphWithPackageOwnership,
    lineIndex,
    sizeIndex,
    targetPacketTokens,
  );
  return moduleOwnershipEdges.length > 0
    ? [...graphWithPackageOwnership, ...moduleOwnershipEdges]
    : graphWithPackageOwnership;
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

function roundQuality(value: number): number {
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

function buildPacketGraphContext(
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

function sanitizeSegment(value: string): string {
  const sanitized = value
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized.length > 0 ? sanitized : "packet";
}

function packetIdFor(tasks: AuditTask[], packetIndex: number): string {
  const unit = sanitizeSegment(tasks[0]?.unit_id ?? "review");
  const lenses = sortLenses(tasks.map((task) => task.lens)).join("-");
  const hash = createHash("sha1")
    .update(tasks.map((task) => task.task_id).join("\0"))
    .digest("hex")
    .slice(0, 10);
  return `${unit}:${lenses}:packet-${packetIndex + 1}-${hash}`;
}

function compareTasksForPacket(a: AuditTask, b: AuditTask): number {
  const lensDelta = LENS_ORDER.indexOf(a.lens) - LENS_ORDER.indexOf(b.lens);
  if (lensDelta !== 0) return lensDelta;
  return a.task_id.localeCompare(b.task_id);
}

function comparePackets(a: ReviewPacket, b: ReviewPacket): number {
  const priorityDelta = priorityRank(b.priority) - priorityRank(a.priority);
  if (priorityDelta !== 0) return priorityDelta;
  const sizeDelta = b.task_ids.length - a.task_ids.length;
  if (sizeDelta !== 0) return sizeDelta;
  return a.packet_id.localeCompare(b.packet_id);
}

function chunkPacketTasks(
  tasks: AuditTask[],
  options: Required<Pick<BuildReviewPacketOptions, "maxTasksPerPacket" | "targetPacketTokens">> &
    Pick<BuildReviewPacketOptions, "lineIndex" | "sizeIndex">,
): AuditTask[][] {
  const chunks: AuditTask[][] = [];
  let current: AuditTask[] = [];

  for (const task of tasks.sort(compareTasksForPacket)) {
    const isolatedLargeFileTask =
      task.file_paths.length === 1 &&
      taskContentTokens(task, options.sizeIndex, options.lineIndex) >
        options.targetPacketTokens;
    if (isolatedLargeFileTask) {
      if (current.length > 0) {
        chunks.push(current);
        current = [];
      }
      chunks.push([task]);
      continue;
    }

    const candidate = [...current, task];
    const uniquePaths = new Set(candidate.flatMap((item) => item.file_paths));
    const candidateContentTokens = fileGroupContentTokens(
      uniquePaths,
      candidate,
      options.sizeIndex,
      options.lineIndex,
    );
    const wouldExceedTaskCount =
      options.maxTasksPerPacket > 0 && current.length > 0 && candidate.length > options.maxTasksPerPacket;
    const wouldExceedTokens =
      current.length > 0 && candidateContentTokens > options.targetPacketTokens;

    if (wouldExceedTaskCount || wouldExceedTokens) {
      chunks.push(current);
      current = [];
    }

    current.push(task);
  }

  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

function mergeGraphConnectedGroups(
  groups: Map<string, AuditTask[]>,
  graphEdges: GraphEdge[],
): AuditTask[][] {
  const uf = unionFindFromGroups(groups, graphEdges);

  const merged = new Map<string, AuditTask[]>();
  for (const key of groups.keys()) {
    const root = uf.find(key);
    const current = merged.get(root) ?? [];
    current.push(...(groups.get(key) ?? []));
    merged.set(root, current);
  }

  return [...merged.values()];
}

function buildPacket(
  tasks: AuditTask[],
  packetIndex: number,
  lineIndex?: Record<string, number>,
  sizeIndex?: Record<string, number>,
  graphEdges: GraphEdge[] = [],
  graphBundle?: GraphBundle,
): ReviewPacket {
  const filePaths = [...new Set(tasks.flatMap((task) => task.file_paths))].sort(
    (a, b) => a.localeCompare(b),
  );
  const graphContext = buildPacketGraphContext(
    filePaths,
    graphEdges,
    graphBundle,
  );
  const fileLineCounts = Object.fromEntries(
    filePaths.map((path) => {
      const owner = tasks.find((task) => task.file_paths.includes(path));
      return [path, owner ? lineCountForPath(owner, path, lineIndex) : 0];
    }),
  );
  const totalLines = Object.values(fileLineCounts).reduce(
    (sum, value) => sum + value,
    0,
  );
  const estimatedTokens =
    ESTIMATED_PACKET_PROMPT_TOKENS +
    fileGroupContentTokens(filePaths, tasks, sizeIndex, lineIndex);
  const priority = tasks.reduce<NonNullable<AuditTask["priority"]>>(
    (highest, task) =>
      priorityRank(task.priority) > priorityRank(highest)
        ? normalizePriority(task.priority)
        : highest,
    "low",
  );
  const lenses = sortLenses(tasks.map((task) => task.lens));
  const tags = [
    ...new Set(tasks.flatMap((task) => task.tags ?? [])),
  ].sort((a, b) => a.localeCompare(b));
  const baseRationale =
    tasks.length === 1
      ? tasks[0]!.rationale
      : `Review ${filePaths.length} related file(s) across ${lenses.length} lens(es): ${lenses.join(", ")}.`;
  const graphRationale =
    graphContext.keyEdges.length > 0
      ? ` Key graph edges explain ${graphContext.keyEdges.length} internal relationship(s).`
      : graphContext.boundaryFiles.length > 0
        ? ` Boundary context is available for ${graphContext.boundaryFiles.length} adjacent file(s).`
        : "";

  return {
    packet_id: packetIdFor(tasks, packetIndex),
    task_ids: tasks.map((task) => task.task_id),
    unit_ids: [...new Set(tasks.map((task) => task.unit_id))].sort((a, b) =>
      a.localeCompare(b),
    ),
    pass_ids: [...new Set(tasks.map((task) => task.pass_id))].sort((a, b) =>
      a.localeCompare(b),
    ),
    lenses,
    file_paths: filePaths,
    file_line_counts: fileLineCounts,
    total_lines: totalLines,
    priority,
    tags: tags.length > 0 ? tags : undefined,
    entrypoints:
      graphContext.entrypoints.length > 0
        ? graphContext.entrypoints
        : undefined,
    key_edges:
      graphContext.keyEdges.length > 0 ? graphContext.keyEdges : undefined,
    boundary_files:
      graphContext.boundaryFiles.length > 0
        ? graphContext.boundaryFiles
        : undefined,
    quality: graphContext.quality,
    rationale: `${baseRationale}${graphRationale}`,
    estimated_tokens: estimatedTokens,
  };
}

function buildReviewPacketPlanningData(
  tasks: AuditTask[],
  options: BuildReviewPacketOptions = {},
): ReviewPacketPlanningData {
  const maxTasksPerPacket = options.maxTasksPerPacket ?? DEFAULT_MAX_TASKS_PER_PACKET;
  const configuredTargetTokens =
    options.targetPacketTokens ?? DEFAULT_TARGET_PACKET_TOKENS;
  const targetPacketTokens =
    options.maxContextTokens != null
      ? Math.min(
          configuredTargetTokens,
          Math.max(1, options.maxContextTokens - ESTIMATED_PACKET_PROMPT_TOKENS),
        )
      : configuredTargetTokens;
  const graphEdges = collectGraphEdges(options.graphBundle);
  const groups = buildTaskGroups(tasks);

  const planningGraphEdges = buildPlanningGraphEdges(
    groups,
    graphEdges,
    options.graphBundle,
    options.lineIndex,
    options.sizeIndex,
    targetPacketTokens,
  );

  const packets: ReviewPacket[] = [];
  let packetIndex = 0;
  const groupedTasks = mergeGraphConnectedGroups(
    groups,
    planningGraphEdges,
  ).sort((a, b) => {
    const aPriority = Math.max(...a.map((task) => priorityRank(task.priority)));
    const bPriority = Math.max(...b.map((task) => priorityRank(task.priority)));
    if (aPriority !== bPriority) return bPriority - aPriority;
    return (a[0]?.task_id ?? "").localeCompare(b[0]?.task_id ?? "");
  });

  for (const group of groupedTasks) {
    for (const chunk of chunkPacketTasks(group, {
      lineIndex: options.lineIndex,
      sizeIndex: options.sizeIndex,
      maxTasksPerPacket,
      targetPacketTokens,
    })) {
      packets.push(
        buildPacket(
          chunk,
          packetIndex,
          options.lineIndex,
          options.sizeIndex,
          planningGraphEdges,
          options.graphBundle,
        ),
      );
      packetIndex += 1;
    }
  }

  return {
    graphEdges,
    groups,
    planningGraphEdges,
    packets: packets.sort(comparePackets),
  };
}

export function buildReviewPackets(
  tasks: AuditTask[],
  options: BuildReviewPacketOptions = {},
): ReviewPacket[] {
  return buildReviewPacketPlanningData(tasks, options).packets;
}

export function orderTasksForPacketReview(
  tasks: AuditTask[],
  options: BuildReviewPacketOptions = {},
): AuditTask[] {
  const taskById = new Map(tasks.map((task) => [task.task_id, task]));
  return buildReviewPackets(tasks, options).flatMap((packet) =>
    packet.task_ids
      .map((taskId) => taskById.get(taskId))
      .filter((task): task is AuditTask => task !== undefined),
  );
}

function countHighDegreeTaskFiles(
  degreeMap: Map<string, number>,
  taskFiles: Set<string>,
): number {
  let count = 0;
  for (const [path, degree] of degreeMap) {
    if (degree > HIGH_FAN_DEGREE_THRESHOLD && taskFiles.has(path)) {
      count += 1;
    }
  }
  return count;
}

function edgeKindKey(edge: GraphEdge): string {
  const kind = edge.kind?.trim();
  return kind && kind.length > 0 ? kind : "unknown";
}

function edgeIdentity(edge: GraphEdge): string {
  return [
    normalizeGraphPath(edge.from),
    normalizeGraphPath(edge.to),
    edgeKindKey(edge),
  ].join("\0");
}

function incrementEdgeKindCount(
  counts: Record<string, number>,
  edge: GraphEdge,
): void {
  const key = edgeKindKey(edge);
  counts[key] = (counts[key] ?? 0) + 1;
}

function sortCountRecord(counts: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(counts).sort((a, b) => a[0].localeCompare(b[0])),
  );
}

function buildTaskToGroupKey(
  groups: Map<string, AuditTask[]>,
): Map<string, string> {
  const taskToGroupKey = new Map<string, string>();
  for (const [groupKey, tasks] of groups) {
    for (const task of tasks) {
      taskToGroupKey.set(task.task_id, groupKey);
    }
  }
  return taskToGroupKey;
}

function buildGroupToPacketIds(
  packets: ReviewPacket[],
  groups: Map<string, AuditTask[]>,
): Map<string, Set<string>> {
  const taskToGroupKey = buildTaskToGroupKey(groups);
  const groupToPacketIds = new Map<string, Set<string>>();

  for (const packet of packets) {
    const packetGroupKeys = new Set(
      packet.task_ids
        .map((taskId) => taskToGroupKey.get(taskId))
        .filter((groupKey): groupKey is string => groupKey !== undefined),
    );
    for (const groupKey of packetGroupKeys) {
      const packetIds = groupToPacketIds.get(groupKey) ?? new Set<string>();
      packetIds.add(packet.packet_id);
      groupToPacketIds.set(groupKey, packetIds);
    }
  }

  return groupToPacketIds;
}

function setsOverlap<T>(a?: Set<T>, b?: Set<T>): boolean {
  if (!a || !b) {
    return false;
  }
  for (const value of a) {
    if (b.has(value)) {
      return true;
    }
  }
  return false;
}

function countMergeEdgeKinds(
  packets: ReviewPacket[],
  groups: Map<string, AuditTask[]>,
  planningGraphEdges: GraphEdge[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  const seen = new Set<string>();
  const fileToGroupKeys = buildFileToGroupKeys(groups);
  const groupToPacketIds = buildGroupToPacketIds(packets, groups);
  const degreeIndex = buildGraphDegreeIndex(planningGraphEdges);

  for (const edge of planningGraphEdges) {
    if (!isPacketExpansionEdge(edge, degreeIndex)) {
      continue;
    }
    const fromGroups = fileToGroupKeys.get(normalizeGraphPath(edge.from));
    const toGroups = fileToGroupKeys.get(normalizeGraphPath(edge.to));
    if (!fromGroups || !toGroups) {
      continue;
    }

    let mergedDistinctGroups = false;
    for (const fromKey of fromGroups) {
      for (const toKey of toGroups) {
        if (
          fromKey !== toKey &&
          setsOverlap(
            groupToPacketIds.get(fromKey),
            groupToPacketIds.get(toKey),
          )
        ) {
          mergedDistinctGroups = true;
          break;
        }
      }
      if (mergedDistinctGroups) {
        break;
      }
    }

    const identity = edgeIdentity(edge);
    if (mergedDistinctGroups && !seen.has(identity)) {
      seen.add(identity);
      incrementEdgeKindCount(counts, edge);
    }
  }

  return sortCountRecord(counts);
}

function buildFileToPacketIds(
  packets: ReviewPacket[],
): Map<string, Set<string>> {
  const fileToPacketIds = new Map<string, Set<string>>();
  for (const packet of packets) {
    for (const path of packet.file_paths) {
      const normalized = normalizeGraphPath(path);
      const packetIds = fileToPacketIds.get(normalized) ?? new Set<string>();
      packetIds.add(packet.packet_id);
      fileToPacketIds.set(normalized, packetIds);
    }
  }
  return fileToPacketIds;
}

function countBoundaryOnlyEdgeKinds(
  packets: ReviewPacket[],
  planningGraphEdges: GraphEdge[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  const seen = new Set<string>();
  const fileToPacketIds = buildFileToPacketIds(packets);

  for (const edge of planningGraphEdges) {
    if (!isConcreteGraphEdge(edge)) {
      continue;
    }
    const fromPacketIds = fileToPacketIds.get(normalizeGraphPath(edge.from));
    const toPacketIds = fileToPacketIds.get(normalizeGraphPath(edge.to));
    if (!fromPacketIds && !toPacketIds) {
      continue;
    }
    if (setsOverlap(fromPacketIds, toPacketIds)) {
      continue;
    }

    const identity = edgeIdentity(edge);
    if (!seen.has(identity)) {
      seen.add(identity);
      incrementEdgeKindCount(counts, edge);
    }
  }

  return sortCountRecord(counts);
}

function isWeaklyExplainedPacket(packet: ReviewPacket): boolean {
  return (
    packet.file_paths.length > 1 &&
    (packet.quality.internal_edge_count === 0 ||
      packet.quality.cohesion_score < 1 ||
      packet.quality.unexplained_file_count > 0)
  );
}

function weaklyExplainedPackets(packets: ReviewPacket[]): ReviewPacket[] {
  return packets.filter(isWeaklyExplainedPacket);
}

function weaklyExplainedPacketIds(weakPackets: ReviewPacket[]): string[] {
  return weakPackets
    .map((packet) => packet.packet_id)
    .sort((a, b) => a.localeCompare(b));
}

function weakPacketPrimaryGap(
  packet: ReviewPacket,
): WeaklyExplainedPacketSample["primary_gap"] {
  if (packet.quality.internal_edge_count === 0) {
    return "missing_internal_edges";
  }
  if (packet.quality.unexplained_file_count > 0) {
    return "unexplained_files";
  }
  return "partial_cohesion";
}

function weaklyExplainedGapCounts(
  weakPackets: ReviewPacket[],
): AuditPlanMetrics["packet_quality"]["weakly_explained_gap_counts"] {
  const counts: AuditPlanMetrics["packet_quality"]["weakly_explained_gap_counts"] =
    {
      missing_internal_edges: 0,
      unexplained_files: 0,
      partial_cohesion: 0,
    };

  for (const packet of weakPackets) {
    counts[weakPacketPrimaryGap(packet)] += 1;
  }

  return Object.fromEntries(
    WEAK_PACKET_GAP_ORDER.map((gap) => [gap, counts[gap]]),
  ) as AuditPlanMetrics["packet_quality"]["weakly_explained_gap_counts"];
}

function fileExtensionBucket(path: string): string {
  const basename = normalizeGraphPath(path).split("/").at(-1) ?? "";
  const extensionStart = basename.lastIndexOf(".");
  if (extensionStart <= 0 || extensionStart === basename.length - 1) {
    return "no_extension";
  }
  return basename.slice(extensionStart).toLowerCase();
}

function weaklyExplainedFileExtensionCounts(
  weakPackets: ReviewPacket[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  const seenPaths = new Set<string>();

  for (const packet of weakPackets) {
    for (const path of packet.file_paths) {
      const normalized = normalizeGraphPath(path);
      if (seenPaths.has(normalized)) {
        continue;
      }
      seenPaths.add(normalized);
      const extension = fileExtensionBucket(path);
      counts[extension] = (counts[extension] ?? 0) + 1;
    }
  }

  return sortCountRecord(counts);
}

function weaklyExplainedPacketSamples(
  weakPackets: ReviewPacket[],
): WeaklyExplainedPacketSample[] {
  return weakPackets
    .sort(
      (a, b) =>
        b.quality.unexplained_file_count - a.quality.unexplained_file_count ||
        a.quality.cohesion_score - b.quality.cohesion_score ||
        b.file_paths.length - a.file_paths.length ||
        a.packet_id.localeCompare(b.packet_id),
    )
    .slice(0, MAX_WEAK_PACKET_SAMPLES)
    .map((packet) => ({
      packet_id: packet.packet_id,
      primary_gap: weakPacketPrimaryGap(packet),
      file_count: packet.file_paths.length,
      sample_file_paths: packet.file_paths.slice(0, MAX_WEAK_PACKET_SAMPLE_FILES),
      cohesion_score: packet.quality.cohesion_score,
      internal_edge_count: packet.quality.internal_edge_count,
      boundary_edge_count: packet.quality.boundary_edge_count,
      unexplained_file_count: packet.quality.unexplained_file_count,
    }));
}

function buildPacketQualityMetrics(
  packets: ReviewPacket[],
  tasks: AuditTask[],
  graphEdges: GraphEdge[],
  planningGraphEdges: GraphEdge[],
  groups: Map<string, AuditTask[]>,
): AuditPlanMetrics["packet_quality"] {
  const packetTaskIds = new Set(packets.flatMap((packet) => packet.task_ids));
  const orphanTaskCount = tasks.filter(
    (task) => !packetTaskIds.has(task.task_id),
  ).length;
  const degreeIndex = buildGraphDegreeIndex(graphEdges);
  const taskFiles = new Set(
    tasks.flatMap((task) => task.file_paths.map(normalizeGraphPath)),
  );
  const largestUnexplainedPacket = packets.reduce<ReviewPacket | undefined>(
    (largest, packet) =>
      !largest ||
      packet.quality.unexplained_file_count >
        largest.quality.unexplained_file_count
        ? packet
        : largest,
    undefined,
  );
  const largestUnexplainedFiles =
    largestUnexplainedPacket?.quality.unexplained_file_count ?? 0;
  const weakPackets = weaklyExplainedPackets(packets);
  const weakPacketIds = weaklyExplainedPacketIds(weakPackets);
  const weakPacketSamples = weaklyExplainedPacketSamples(weakPackets);

  return {
    average_cohesion_score:
      packets.length > 0
        ? roundQuality(
            packets.reduce(
              (sum, packet) => sum + packet.quality.cohesion_score,
              0,
            ) / packets.length,
          )
        : 0,
    boundary_crossing_count: packets.reduce(
      (sum, packet) => sum + packet.quality.boundary_edge_count,
      0,
    ),
    merge_edge_kind_counts: countMergeEdgeKinds(
      packets,
      groups,
      planningGraphEdges,
    ),
    boundary_edge_kind_counts: countBoundaryOnlyEdgeKinds(
      packets,
      planningGraphEdges,
    ),
    orphan_task_count: orphanTaskCount,
    high_fan_in_file_count: countHighDegreeTaskFiles(
      degreeIndex.fanIn,
      taskFiles,
    ),
    high_fan_out_file_count: countHighDegreeTaskFiles(
      degreeIndex.fanOut,
      taskFiles,
    ),
    weakly_explained_gap_counts: weaklyExplainedGapCounts(weakPackets),
    weakly_explained_file_extension_counts:
      weaklyExplainedFileExtensionCounts(weakPackets),
    weakly_explained_packet_count: weakPacketIds.length,
    weakly_explained_packet_ids: weakPacketIds,
    weakly_explained_packet_samples: weakPacketSamples,
    largest_unexplained_packet_id:
      largestUnexplainedFiles > 0
        ? largestUnexplainedPacket?.packet_id
        : undefined,
    largest_unexplained_packet_files: largestUnexplainedFiles,
  };
}

export function buildAuditPlanMetrics(
  tasks: AuditTask[],
  options: BuildReviewPacketOptions & { generatedAt?: Date } = {},
): AuditPlanMetrics {
  const { graphEdges, groups, packets, planningGraphEdges } =
    buildReviewPacketPlanningData(tasks, options);
  const taskLineCounts = tasks.map((task) => taskLineCount(task, options.lineIndex));
  const totalTaskLines = taskLineCounts.reduce((sum, value) => sum + value, 0);
  const totalPacketLines = packets.reduce(
    (sum, packet) => sum + packet.total_lines,
    0,
  );
  const largestTaskIndex = taskLineCounts.reduce(
    (largest, value, index) => (value > taskLineCounts[largest]! ? index : largest),
    0,
  );
  const largestPacket = packets.reduce<ReviewPacket | undefined>(
    (largest, packet) =>
      !largest || packet.total_lines > largest.total_lines ? packet : largest,
    undefined,
  );
  const taskFileReferences = tasks.reduce(
    (sum, task) => sum + task.file_paths.length,
    0,
  );
  const uniqueFiles = new Set(tasks.flatMap((task) => task.file_paths));
  const lensTaskCounts: Partial<Record<Lens, number>> = {};
  const priorityTaskCounts: AuditPlanMetrics["priority_task_counts"] = {
    high: 0,
    medium: 0,
    low: 0,
  };

  for (const task of tasks) {
    lensTaskCounts[task.lens] = (lensTaskCounts[task.lens] ?? 0) + 1;
    priorityTaskCounts[normalizePriority(task.priority)] += 1;
  }

  return {
    generated_at: (options.generatedAt ?? new Date()).toISOString(),
    task_count: tasks.length,
    packet_count: packets.length,
    estimated_agent_reduction: Math.max(0, tasks.length - packets.length),
    estimated_agent_reduction_ratio:
      tasks.length === 0 ? 0 : Math.max(0, tasks.length - packets.length) / tasks.length,
    unique_file_count: uniqueFiles.size,
    task_file_reference_count: taskFileReferences,
    repeated_file_reference_count: Math.max(0, taskFileReferences - uniqueFiles.size),
    total_task_lines: totalTaskLines,
    total_packet_lines: totalPacketLines,
    repeated_line_reference_count: Math.max(0, totalTaskLines - totalPacketLines),
    min_task_lines: taskLineCounts.length > 0 ? Math.min(...taskLineCounts) : 0,
    max_task_lines: taskLineCounts.length > 0 ? Math.max(...taskLineCounts) : 0,
    average_task_lines:
      taskLineCounts.length > 0 ? totalTaskLines / taskLineCounts.length : 0,
    largest_task_id: tasks[largestTaskIndex]?.task_id,
    largest_packet_id: largestPacket?.packet_id,
    lens_task_counts: lensTaskCounts,
    priority_task_counts: priorityTaskCounts,
    packet_quality: buildPacketQualityMetrics(
      packets,
      tasks,
      graphEdges,
      planningGraphEdges,
      groups,
    ),
    packet_size: {
      single_task_packets: packets.filter((packet) => packet.task_ids.length === 1).length,
      multi_task_packets: packets.filter((packet) => packet.task_ids.length > 1).length,
      max_tasks_per_packet:
        packets.length > 0 ? Math.max(...packets.map((packet) => packet.task_ids.length)) : 0,
      max_files_per_packet:
        packets.length > 0 ? Math.max(...packets.map((packet) => packet.file_paths.length)) : 0,
    },
  };
}
