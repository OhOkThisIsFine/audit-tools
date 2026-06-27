import type { ArtifactBundle } from "../io/artifacts.js";
import type { ExecutorRunResult } from "./executorResult.js";
import type {
  AnalyzerSetting,
  GraphBundle,
  GraphEdge,
  RouteEdge,
} from "audit-tools/shared";
import { installToCache, resolveAnalyzerDep } from "audit-tools/shared";
import { buildDispositionMap } from "../extractors/disposition.js";
import { buildPathLookup } from "../extractors/graph.js";
import { mergeAnalyzerEdges } from "../extractors/analyzers/merge.js";
import { ANALYZER_REGISTRY } from "../extractors/analyzers/registry.js";
import type {
  AnalyzerResolution,
  LanguageAnalyzer,
} from "../extractors/analyzers/types.js";
import type {
  AnalyzerCapabilityEntry,
  AnalyzerCapabilityRecord,
} from "../types/analyzerCapability.js";
import {
  applyEdgeReasoning,
  type EdgeReasoningResults,
  type EdgeReasoningSummary,
} from "./edgeReasoning.js";

export interface GraphEnrichmentOptions {
  root?: string;
  analyzers?: Record<string, AnalyzerSetting>;
  /** Injectable for tests; defaults to the global registry. */
  registry?: LanguageAnalyzer[];
  /** Injectable analyzer-cache root; defaults to ~/.audit-tools/analyzer-cache. */
  cacheRoot?: string;
  /**
   * Phase 4B: gate for the optional edge-reasoning pass (mirrors
   * session-config `graph.llm_edge_reasoning`; default off).
   */
  llmEdgeReasoning?: boolean;
  /** Phase 4B: host-supplied reason rewrites for low-confidence edges. */
  edgeReasoning?: EdgeReasoningResults;
}

const BUCKET_BY_KIND: Record<string, "imports" | "calls" | "references"> = {
  "ts-import": "imports",
  "ts-reexport": "imports",
  "ts-call": "calls",
  "ts-extends": "references",
  "ts-implements": "references",
  // Python (tree-sitter) imports merge into the imports bucket alongside the
  // regex floor's python-* edges.
  "py-import": "imports",
  "py-from-import": "imports",
  // HTML/CSS (tree-sitter) resource references live with the floor's
  // html-resource-link / reference edges.
  "html-resource": "references",
  "css-import": "references",
  "css-url": "references",
};

function bucketForKind(kind?: string): "imports" | "calls" | "references" {
  const bucket = kind ? BUCKET_BY_KIND[kind] : undefined;
  return bucket ?? "references";
}

function settingFor(
  analyzers: Record<string, AnalyzerSetting> | undefined,
  id: string,
): AnalyzerSetting {
  return analyzers?.[id] ?? "auto";
}

function routeSignature(route: RouteEdge): string {
  return `${route.method ?? ""}\0${route.path}\0${route.handler}`;
}

function mergeRoutes(floor: RouteEdge[], analyzer: RouteEdge[]): RouteEdge[] {
  const deduped = new Map<string, RouteEdge>();
  for (const route of [...floor, ...analyzer]) {
    deduped.set(routeSignature(route), route);
  }
  return [...deduped.values()].sort(
    (a, b) =>
      a.path.localeCompare(b.path) ||
      a.handler.localeCompare(b.handler) ||
      (a.method ?? "").localeCompare(b.method ?? ""),
  );
}

interface RunResolution {
  resolution: AnalyzerResolution;
  path?: string;
  note?: string;
}

type SingleAnalyzerResult =
  | { ok: true; edges: GraphEdge[]; routes: RouteEdge[]; resolution: AnalyzerResolution }
  | { ok: false; note: string; resolution: AnalyzerResolution };

/**
 * Run one analyzer: resolve its dependency, invoke analyze(), and return a
 * discriminated result. Early-exit guards (not_applicable / skip / absent-root)
 * are handled by the caller; this helper starts from a confirmed runnable state.
 */
async function runSingleAnalyzer(
  analyzer: LanguageAnalyzer,
  root: string,
  setting: AnalyzerSetting,
  bundle: ArtifactBundle,
  pathLookup: Map<string, string>,
  includedFiles: string[],
  disposition: ArtifactBundle["file_disposition"],
  cacheRoot?: string,
): Promise<SingleAnalyzerResult> {
  const run = resolveForRun(analyzer, root, setting, cacheRoot);
  if (run.resolution === "absent") {
    return { ok: false, note: run.note ?? "Dependency absent.", resolution: "absent" };
  }
  try {
    const output = await analyzer.analyze(includedFiles.filter((f) => analyzer.supports(f)), {
      root,
      repoManifest: bundle.repo_manifest!,
      disposition,
      includedFiles,
      pathLookup,
      dependencyPath: run.path,
    });
    return {
      ok: true,
      edges: output.edges ?? [],
      routes: output.routes ?? [],
      resolution: run.resolution,
    };
  } catch (error) {
    const note =
      error instanceof Error
        ? `Analyzer failed [${error.name}]: ${error.message}${error.stack ? ` — stack: ${error.stack.split("\n").slice(0, 4).join(" | ")}` : ""}`
        : `Analyzer failed: ${String(error)}.`;
    return { ok: false, note, resolution: run.resolution };
  }
}

/**
 * Assemble the enriched GraphBundle from the regex floor plus per-bucket
 * analyzer edges and merged route edges.
 */
function buildEnrichedGraph(
  floor: GraphBundle,
  bucketEdges: { imports: GraphEdge[]; calls: GraphEdge[]; references: GraphEdge[] },
  routeEdges: RouteEdge[],
  analyzersUsed: string[],
): GraphBundle {
  return {
    ...floor,
    graphs: {
      ...floor.graphs,
      imports: mergeAnalyzerEdges(floor.graphs.imports ?? [], bucketEdges.imports),
      calls: mergeAnalyzerEdges(floor.graphs.calls ?? [], bucketEdges.calls),
      references: mergeAnalyzerEdges(floor.graphs.references ?? [], bucketEdges.references),
      ...(routeEdges.length > 0
        ? { routes: mergeRoutes(floor.graphs.routes ?? [], routeEdges) }
        : {}),
    },
    // Union with the floor's provenance — the floor may already carry analyzers
    // that contributed BEFORE enrichment (e.g. `git-history` co-change merged in
    // the structure executor); replacing the list would silently drop them.
    analyzers_used: [
      ...new Set([...(floor.analyzers_used ?? []), ...analyzersUsed]),
    ].sort(),
  };
}

/**
 * Resolve a dependency for actual execution (may install for ephemeral/permanent).
 * `auto`/`repo` with an absent dependency falls back to the regex floor.
 */
function resolveForRun(
  analyzer: LanguageAnalyzer,
  root: string,
  setting: AnalyzerSetting,
  cacheRoot?: string,
): RunResolution {
  if (!analyzer.dependency) {
    return { resolution: "repo" };
  }
  const options = cacheRoot ? { cacheRoot } : {};
  const resolved = resolveAnalyzerDep(analyzer.dependency, root, options);
  if (resolved.via === "repo" || resolved.via === "cache") {
    return { resolution: resolved.via, path: resolved.path };
  }
  if (setting === "ephemeral" || setting === "permanent") {
    const install = installToCache(analyzer.dependency, options);
    if (install.ok && install.path) {
      return { resolution: "installed", path: install.path };
    }
    return {
      resolution: "absent",
      note: `Install of '${analyzer.dependency}' failed: ${install.error ?? "unknown error"}.`,
    };
  }
  return {
    resolution: "absent",
    note: `Dependency '${analyzer.dependency}' not resolvable; kept regex floor.`,
  };
}

/**
 * Resolve the optional graph-enrichment obligation. Layers language-analyzer
 * edges onto the deterministic regex floor in `graph_bundle.json`
 * (higher-confidence-kind-wins) and records provenance in
 * `analyzer_capability.json`. With no root, or when every analyzer skips / is
 * absent / not-applicable, the graph bundle is left byte-identical to the floor
 * and only the marker is written.
 */
export async function runGraphEnrichmentExecutor(
  bundle: ArtifactBundle,
  options: GraphEnrichmentOptions = {},
): Promise<ExecutorRunResult> {
  const floor = bundle.graph_bundle;
  if (!floor) {
    throw new Error("Cannot run graph enrichment without graph_bundle");
  }
  const registry = options.registry ?? ANALYZER_REGISTRY;
  const root = options.root;
  const disposition = bundle.file_disposition;
  const dispositionMap = buildDispositionMap(disposition);
  const pathLookup = bundle.repo_manifest
    ? buildPathLookup(bundle.repo_manifest, dispositionMap)
    : new Map<string, string>();
  const includedFiles = [...new Set(pathLookup.values())].sort((a, b) =>
    a.localeCompare(b),
  );

  const entries: AnalyzerCapabilityEntry[] = [];
  const bucketEdges = { imports: [] as GraphEdge[], calls: [] as GraphEdge[], references: [] as GraphEdge[] };
  const routeEdges: RouteEdge[] = [];
  const analyzersUsed: string[] = [];

  for (const analyzer of registry) {
    const setting = settingFor(options.analyzers, analyzer.id);
    const supportedFiles = includedFiles.filter((file) => analyzer.supports(file));

    if (supportedFiles.length === 0) {
      entries.push({ id: analyzer.id, resolution: "not_applicable", setting, edges_added: 0, routes_added: 0 });
      continue;
    }
    if (setting === "skip") {
      entries.push({ id: analyzer.id, resolution: "skip", setting, edges_added: 0, routes_added: 0, note: "Analyzer disabled via session config." });
      continue;
    }
    if (!root || !bundle.repo_manifest) {
      entries.push({ id: analyzer.id, resolution: "absent", setting, edges_added: 0, routes_added: 0, note: "No repository root available for analysis." });
      continue;
    }

    const result = await runSingleAnalyzer(analyzer, root, setting, bundle, pathLookup, includedFiles, disposition, options.cacheRoot);
    if (!result.ok) {
      const entry: AnalyzerCapabilityEntry = { id: analyzer.id, resolution: result.resolution, setting, edges_added: 0, routes_added: 0, note: result.note };
      entries.push(entry);
      if (entry.note?.startsWith("Analyzer failed")) {
        process.stderr.write(
          JSON.stringify({
            kind: "graph_enrichment_analyzer_failed",
            analyzer_id: analyzer.id,
            resolution: result.resolution,
            note: entry.note,
            ts: new Date().toISOString(),
          }) + "\n",
        );
      }
      continue;
    }

    const { edges, routes, resolution } = result;
    for (const edge of edges) {
      bucketEdges[bucketForKind(edge.kind)].push(edge);
    }
    routeEdges.push(...routes);
    if (edges.length + routes.length > 0) {
      analyzersUsed.push(analyzer.id);
    }
    entries.push({ id: analyzer.id, resolution, setting, edges_added: edges.length, routes_added: routes.length });
  }

  const applied = analyzersUsed.length > 0;
  const record: AnalyzerCapabilityRecord = {
    status: applied ? "applied" : "omitted",
    analyzers: entries,
  };

  // The graph this obligation produces: the enriched bundle when analyzers
  // contributed, otherwise the regex floor. Phase 4B may then rewrite the
  // reasons of low-confidence edges on whichever graph stands — the floor's
  // heuristic edges exist regardless of analyzers.
  const graphBundle: GraphBundle = applied
    ? buildEnrichedGraph(floor, bucketEdges, routeEdges, analyzersUsed)
    : floor;

  let reasoned: EdgeReasoningSummary = { rewritten: 0, candidates: 0 };
  if (options.llmEdgeReasoning === true && options.edgeReasoning) {
    reasoned = applyEdgeReasoning(graphBundle, options.edgeReasoning);
  }

  const graphChanged = applied || reasoned.rewritten > 0;
  const reasonSuffix =
    reasoned.rewritten > 0
      ? ` Edge reasoning rewrote ${reasoned.rewritten} reason(s).`
      : "";

  if (!graphChanged) {
    const failedEntries = entries.filter((e) => e.note?.startsWith("Analyzer failed"));
    const failureSuffix =
      failedEntries.length > 0
        ? `; ${failedEntries.length} analyzer(s) failed: ${failedEntries.map((e) => e.id).join(", ")} (see analyzer_capability.json)`
        : "";
    return {
      updated: { ...bundle, analyzer_capability: record },
      artifacts_written: ["analyzer_capability.json"],
      progress_summary:
        `Graph enrichment omitted; deterministic regex graph retained.${failureSuffix}`,
    };
  }

  const totalEdges = entries.reduce((sum, entry) => sum + entry.edges_added, 0);
  return {
    updated: { ...bundle, graph_bundle: graphBundle, analyzer_capability: record },
    artifacts_written: ["graph_bundle.json", "analyzer_capability.json"],
    progress_summary: applied
      ? `Graph enrichment applied ${totalEdges} analyzer edge(s) from ${analyzersUsed.join(", ")}.${reasonSuffix}`
      : `Graph enrichment omitted analyzers; edge reasoning rewrote ${reasoned.rewritten} reason(s).`,
  };
}
