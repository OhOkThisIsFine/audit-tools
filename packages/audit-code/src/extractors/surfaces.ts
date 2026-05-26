import type { RepoManifest } from "../types.js";
import type { FileDisposition } from "../types/disposition.js";
import type { GraphBundle } from "../types/graph.js";
import type { SurfaceManifest, SurfaceRecord } from "../types/surfaces.js";
import { buildBrowserExtensionSurfacesFromGraph } from "./browserExtension.js";
import { isAuditExcludedStatus } from "./disposition.js";
import {
  EXTRACTOR_HEURISTIC_NOTE,
  isBackgroundSurfacePath,
  isNetworkSurfacePath,
  isSurfacePath,
  normalizeExtractorPath,
} from "./pathPatterns.js";

function methodsForPath(path: string): string[] | undefined {
  const normalized = normalizeExtractorPath(path);
  if (isNetworkSurfacePath(normalized)) {
    return ["GET", "POST"];
  }
  return undefined;
}

/**
 * Detects likely execution surfaces from file paths using the shared extractor
 * heuristics, primarily to seed later audit planning.
 */
export function buildSurfaceManifest(
  repoManifest: RepoManifest,
  disposition?: FileDisposition,
  options: { graphBundle?: GraphBundle } = {},
): SurfaceManifest {
  const surfaces: SurfaceRecord[] = [];
  const seen = new Set<string>();
  const dispositionMap = new Map(
    disposition?.files.map((item) => [item.path, item.status]) ?? [],
  );

  function addSurface(surface: SurfaceRecord): void {
    const key = `${surface.kind}:${surface.entrypoint}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    surfaces.push(surface);
  }

  for (const file of repoManifest.files) {
    const status = dispositionMap.get(file.path);
    if (status && isAuditExcludedStatus(status)) {
      continue;
    }

    const normalized = normalizeExtractorPath(file.path);
    if (isSurfacePath(normalized)) {
      addSurface({
        id: `surface:${file.path}`,
        kind: isBackgroundSurfacePath(normalized) ? "background" : "interface",
        entrypoint: file.path,
        exposure: isNetworkSurfacePath(normalized) ? "network" : "local",
        methods: methodsForPath(file.path),
        notes: [EXTRACTOR_HEURISTIC_NOTE],
      });
    }
  }

  for (const surface of buildBrowserExtensionSurfacesFromGraph(
    options.graphBundle,
    disposition,
  )) {
    addSurface(surface);
  }

  return { surfaces };
}
