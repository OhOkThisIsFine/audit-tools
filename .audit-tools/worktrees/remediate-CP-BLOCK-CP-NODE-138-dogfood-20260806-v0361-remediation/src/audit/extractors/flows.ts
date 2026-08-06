import type { RepoManifest } from "../types.js";
import type {
  FileDisposition,
  CriticalFlow,
  CriticalFlowManifest,
  CriticalFlowFallbackResult,
  SurfaceManifest,
} from "audit-tools/shared";
import { CriticalFlowSchema } from "audit-tools/shared";
import { buildDispositionMap, isAuditExcludedStatus } from "./disposition.js";
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
  const dispositionMap = buildDispositionMap(disposition);
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

  const merged = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  return {
    flows: merged,
    fallback_required: computeFlowFallbackRequired(merged),
  };
}
