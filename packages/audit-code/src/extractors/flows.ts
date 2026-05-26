import type { RepoManifest } from "../types.js";
import type { FileDisposition } from "../types/disposition.js";
import type { CriticalFlow, CriticalFlowManifest } from "../types/flows.js";
import type { SurfaceManifest } from "../types/surfaces.js";
import { isAuditExcludedStatus } from "./disposition.js";
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

function relatedPaths(entry: string, availablePaths: string[]): string[] {
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

  return [...linked].sort((a, b) => a.localeCompare(b));
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
 * Builds coarse critical-flow coverage from shared path heuristics. These
 * bootstrap flows are intentionally conservative and should be reviewed when a
 * repo uses unconventional naming or layout conventions.
 */
export function buildCriticalFlowManifest(
  repoManifest: RepoManifest,
  surfaceManifest: SurfaceManifest,
  disposition?: FileDisposition,
): CriticalFlowManifest {
  const dispositionMap = new Map(
    disposition?.files.map((item) => [item.path, item.status]) ?? [],
  );
  const availablePaths = repoManifest.files
    .map((file) => file.path)
    .filter((path) => {
      const status = dispositionMap.get(path);
      return !(status && isAuditExcludedStatus(status));
    });

  const flows: CriticalFlow[] = [];

  for (const surface of surfaceManifest.surfaces) {
    const entry = surface.entrypoint;
    const paths = relatedPaths(entry, availablePaths);
    flows.push({
      id: `flow:${surface.id.replace(/[^a-zA-Z0-9:_-]/g, "-")}`,
      name: `${surface.kind} flow for ${entry}`,
      entrypoints: [entry],
      paths,
      concerns: inferConcerns(paths),
      confidence: paths.length > 1 ? "high" : "low",
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
      flows.push({
        id: `flow:data:${path.replace(/[^a-zA-Z0-9:_-]/g, "-")}`,
        name: `data evolution flow for ${path}`,
        entrypoints: [path],
        paths: relatedPaths(path, availablePaths),
        concerns: ["data_integrity", "reliability"],
        confidence: "high",
        notes: [EXTRACTOR_HEURISTIC_NOTE],
      });
    }
  }

  const deduped = dedupeFlows(flows);
  return {
    flows: deduped,
    fallback_required:
      deduped.length === 0 || deduped.some((flow) => flow.confidence === "low"),
  };
}
