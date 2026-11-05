// sites-pinned: tests/audit/critical-flow-graph-neighborhood.test.ts, tests/audit/extractors-remediation.test.ts
import type { RepoManifest } from "../types.js";
import type {
  FileDisposition,
  CriticalFlow,
  CriticalFlowManifest,
  CriticalFlowFallbackResult,
  GraphBundle,
  SurfaceManifest,
} from "audit-tools/shared";
import { CriticalFlowSchema, compareCodeUnits } from "audit-tools/shared";
import { buildDispositionMap, isAuditExcludedStatus } from "./disposition.js";
import { structuralImportEdges } from "./graphSignals.js";
import {
  EXTRACTOR_HEURISTIC_NOTE,
  isAsyncTaskPath,
  isBillingPath,
  isIdentityPath,
  isSecuritySensitivePath,
  isTestPath,
  isDataLayerPath,
  isConcurrencyPath,
  isInterfacePath,
  isDeploymentConfigPath,
  normalizeExtractorPath,
} from "./pathPatterns.js";

function inferConcerns(paths: string[]): string[] {
  const concerns = new Set<string>();
  for (const path of paths) {
    const normalized = normalizeExtractorPath(path);
    if (isSecuritySensitivePath(normalized)) concerns.add("security");
    if (isDataLayerPath(normalized) || isBillingPath(normalized))
      concerns.add("data_integrity");
    if (isConcurrencyPath(normalized)) concerns.add("reliability");
    if (isInterfacePath(normalized)) concerns.add("correctness");
  }
  return concerns.size > 0 ? [...concerns] : ["correctness"];
}

function isSchemaContractPath(normalized: string): boolean {
  return normalized.endsWith(".schema.json");
}

function isSupportArtifactPath(normalized: string): boolean {
  return isTestPath(normalized) || normalized.startsWith("examples/");
}

/**
 * Undirected structural adjacency (the `imports` + `calls` buckets only — a
 * prose `references` mention or a co-change edge is not a load-order neighbor),
 * restricted to in-scope paths.
 */
function buildStructuralAdjacency(
  graphBundle: GraphBundle,
  inScope: ReadonlySet<string>,
): Map<string, Set<string>> {
  const adjacency = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    let neighbors = adjacency.get(a);
    if (!neighbors) {
      neighbors = new Set<string>();
      adjacency.set(a, neighbors);
    }
    neighbors.add(b);
  };
  for (const edge of structuralImportEdges(graphBundle)) {
    if (edge.from === edge.to) continue;
    if (!inScope.has(edge.from) || !inScope.has(edge.to)) continue;
    link(edge.from, edge.to);
    link(edge.to, edge.from);
  }
  return adjacency;
}

interface FlowPathEvidence {
  paths: string[];
  confidence: "high" | "low";
}

/**
 * A flow's paths are its entrypoint's OWN neighborhood. When the dependency
 * graph gives the entrypoint structural neighbors (what it imports and what
 * imports it), those are the paths and only they earn `high`. Otherwise — no
 * graph, or a graph with no import/call edge for this entry (a migration, seed
 * or schema file; a language the graph cannot parse) — the keyword heuristic is
 * the evidence. It links every same-category path in the repository, so
 * unrelated entrypoints can share one path set: it is kept, but never `high`,
 * so the host fallback pass reviews it.
 */
function flowPathEvidence(
  entry: string,
  availablePaths: string[],
  adjacency: Map<string, Set<string>> | undefined,
): FlowPathEvidence {
  const neighbors = adjacency?.get(entry);
  if (neighbors && neighbors.size > 0) {
    const paths = [entry, ...neighbors].sort((a, b) => compareCodeUnits(a, b));
    return { paths, confidence: "high" };
  }
  return { paths: keywordRelatedPaths(entry, availablePaths), confidence: "low" };
}

function keywordRelatedPaths(entry: string, availablePaths: string[]): string[] {
  const normalized = normalizeExtractorPath(entry);
  const linked = new Set<string>([entry]);

  for (const path of availablePaths) {
    const lower = normalizeExtractorPath(path);
    if (path === entry) continue;

    // Auth / session flows: link sibling auth, session, token, user paths
    if (isSecuritySensitivePath(normalized) && isIdentityPath(lower)) {
      linked.add(path);
    }

    // Billing / payment flows: link ledger and subscription paths
    if (isBillingPath(normalized) && isBillingPath(lower)) {
      linked.add(path);
    }

    // Async / queue flows: link worker, job, retry, and task paths
    if (isConcurrencyPath(normalized) && isAsyncTaskPath(lower)) {
      linked.add(path);
    }

    // Deployment / infra flows: link docker, k8s, terraform, workflow paths
    if (isDeploymentConfigPath(normalized) && isDeploymentConfigPath(lower)) {
      linked.add(path);
    }
  }

  return [...linked].sort((a, b) => compareCodeUnits(a, b));
}

function dedupeFlows(flows: CriticalFlow[]): CriticalFlow[] {
  const seen = new Set<string>();
  const deduped: CriticalFlow[] = [];
  for (const flow of flows) {
    const signature = `${flow.name}|${[...flow.paths].sort().join(",")}|${[...flow.concerns].sort().join(",")}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    deduped.push(flow);
  }
  return deduped;
}

/**
 * Builds critical-flow coverage. Surfaces and data-layer files are chosen by
 * shared path heuristics; each flow's paths are that entrypoint's own graph
 * neighborhood when a dependency graph is supplied (see `flowPathEvidence`).
 * Flows without graph corroboration are `low` confidence and request the host
 * fallback pass.
 */
export function buildCriticalFlowManifest(
  repoManifest: RepoManifest,
  surfaceManifest: SurfaceManifest,
  disposition?: FileDisposition,
  options: { graphBundle?: GraphBundle } = {},
): CriticalFlowManifest {
  const dispositionMap = buildDispositionMap(disposition);
  const availablePaths = repoManifest.files
    .map((file) => file.path)
    .filter((path) => {
      const status = dispositionMap.get(path);
      return !(status && isAuditExcludedStatus(status));
    });
  const adjacency = options.graphBundle
    ? buildStructuralAdjacency(options.graphBundle, new Set(availablePaths))
    : undefined;

  const flows: CriticalFlow[] = [];

  for (const surface of surfaceManifest.surfaces) {
    const entry = surface.entrypoint;
    const { paths, confidence } = flowPathEvidence(entry, availablePaths, adjacency);
    flows.push({
      id: `flow:${surface.id.replace(/[^a-zA-Z0-9:_-]/g, "-")}`,
      name: `${surface.kind} flow for ${entry}`,
      entrypoints: [entry],
      paths,
      concerns: inferConcerns(paths),
      confidence,
      notes: [EXTRACTOR_HEURISTIC_NOTE],
    });
  }

  for (const path of availablePaths) {
    const normalized = normalizeExtractorPath(path);
    if (
      isDataLayerPath(normalized) &&
      !isSchemaContractPath(normalized) &&
      !isSupportArtifactPath(normalized)
    ) {
      const { paths, confidence } = flowPathEvidence(path, availablePaths, adjacency);
      flows.push({
        id: `flow:data:${path.replace(/[^a-zA-Z0-9:_-]/g, "-")}`,
        name: `data evolution flow for ${path}`,
        entrypoints: [path],
        paths,
        concerns: ["data_integrity", "reliability"],
        confidence,
        notes: [EXTRACTOR_HEURISTIC_NOTE],
      });
    }
  }

  const deduped = dedupeFlows(flows);
  return {
    flows: deduped,
    fallback_required: computeFlowFallbackRequired(deduped),
  };
}

/**
 * The deterministic confidence bar for critical-flow inference: a fallback pass
 * is required when no flows were found at all, or any inferred flow is
 * low-confidence. Single-sourced so `buildCriticalFlowManifest` and the
 * host-fallback merge recompute it identically over their respective flow sets.
 */
function computeFlowFallbackRequired(flows: CriticalFlow[]): boolean {
  return flows.length === 0 || flows.some((flow) => flow.confidence === "low");
}

/**
 * Upper bound on host-authored fallback flows folded into the manifest — a
 * mechanical run-safety cap (mirrors the edge-reasoning `MAX_REASONED_EDGES`
 * bound) so a malformed/oversized host submission can never blow up the manifest.
 */
export const MAX_FALLBACK_FLOWS = 200;

/**
 * Merge a host-authored critical-flow fallback submission into a deterministic
 * manifest — the enrichment the LLM fallback pass produces when the deterministic
 * inference marked itself below the confidence bar. Additive and idempotent:
 * each host flow either UPGRADES an existing flow (same `id`) or ADDS a new one;
 * the merged set is re-sorted by id (stable content-derived order — a manifest
 * array must never carry incidental order) and `fallback_required` is recomputed
 * over the merged flows. Invalid host flows are skipped with a stderr diagnostic
 * (the manifest never throws on a malformed submission). Structure re-runs this
 * on every build off the persisted submission, so it must be a pure function of
 * (deterministic manifest, host submission).
 */
export function mergeCriticalFlowFallback(
  manifest: CriticalFlowManifest,
  fallback: CriticalFlowFallbackResult,
): CriticalFlowManifest {
  const byId = new Map<string, CriticalFlow>(
    manifest.flows.map((flow) => [flow.id, flow]),
  );
  let accepted = 0;
  for (const candidate of fallback.flows) {
    if (accepted >= MAX_FALLBACK_FLOWS) {
      process.stderr.write(
        `[audit-code] criticalFlowFallback: host submission exceeded MAX_FALLBACK_FLOWS=${MAX_FALLBACK_FLOWS}; remaining flows ignored\n`,
      );
      break;
    }
    const parsed = CriticalFlowSchema.safeParse(candidate);
    if (!parsed.success) {
      process.stderr.write(
        `[audit-code] criticalFlowFallback: skipped an invalid host flow (${parsed.error.issues[0]?.message ?? "schema mismatch"})\n`,
      );
      continue;
    }
    if (parsed.data.id.trim().length === 0) {
      process.stderr.write(
        "[audit-code] criticalFlowFallback: skipped a host flow with an empty id\n",
      );
      continue;
    }
    byId.set(parsed.data.id, parsed.data);
    accepted += 1;
  }

  const merged = [...byId.values()].sort((a, b) => compareCodeUnits(a.id, b.id));
  return {
    flows: merged,
    fallback_required: computeFlowFallbackRequired(merged),
  };
}
