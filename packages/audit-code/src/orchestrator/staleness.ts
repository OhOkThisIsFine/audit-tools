import type { ArtifactBundle } from "../io/artifacts.js";
import { getArtifactValue } from "../io/artifacts.js";
import { ARTIFACT_DEPENDENTS_MAP } from "./dependencyMap.js";
import { present } from "./artifactMetadata.js";
import {
  buildArtifactDependenciesMap,
  hashArtifactValue,
  stableStringify,
} from "./artifactFreshness.js";

function computeContentHash(
  artifactName: string,
  bundle: ArtifactBundle,
): string | undefined {
  const value = getArtifactValue(bundle, artifactName);
  if (value === undefined || value === null) return undefined;
  return hashArtifactValue(artifactName, value);
}

const ARTIFACT_DEPENDENCIES_MAP = buildArtifactDependenciesMap();

export function computeStaleArtifacts(bundle: ArtifactBundle): Set<string> {
  const stale = new Set<string>();
  const metadata = bundle.artifact_metadata;

  if (metadata) {
    for (const [artifactName, entry] of Object.entries(metadata.artifacts)) {
      if (!present(bundle, artifactName)) continue;
      const expectedDependencies = [...(ARTIFACT_DEPENDENCIES_MAP[artifactName] ?? [])]
        .filter((dependencyName) => dependencyName !== "artifact_metadata.json")
        .sort();
      const recordedDependencies = Object.keys(entry.dependency_revisions).sort();
      if (
        stableStringify(expectedDependencies) !==
        stableStringify(recordedDependencies)
      ) {
        stale.add(artifactName);
        continue;
      }
      let isStale = false;
      for (const [dependencyName, recordedRevision] of Object.entries(
        entry.dependency_revisions,
      )) {
        if (!present(bundle, dependencyName)) {
          if (recordedRevision > 0) {
            isStale = true;
            break;
          }
          continue;
        }
        const dependencyEntry = metadata.artifacts[dependencyName];
        if (!dependencyEntry) {
          if (present(bundle, dependencyName) || recordedRevision > 0) {
            isStale = true;
            break;
          }
          continue;
        }

        const currentHash = computeContentHash(dependencyName, bundle);
        if (
          !currentHash ||
          dependencyEntry.content_hash !== currentHash ||
          dependencyEntry.revision !== recordedRevision
        ) {
          isStale = true;
          break;
        }
      }
      if (isStale) stale.add(artifactName);
    }
  }

  if (metadata) {
    for (const [upstream, downstreamList] of Object.entries(
      ARTIFACT_DEPENDENTS_MAP,
    )) {
      if (upstream === "tooling_manifest.json" && !present(bundle, upstream)) {
        continue;
      }
      if (!present(bundle, upstream)) {
        for (const downstream of downstreamList) {
          const hasMetadataEntry = Boolean(metadata.artifacts[downstream]);
          if (present(bundle, downstream) && !hasMetadataEntry) {
            stale.add(downstream);
          }
        }
      }
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const [upstream, downstreamList] of Object.entries(
      ARTIFACT_DEPENDENTS_MAP,
    )) {
      if (!stale.has(upstream)) {
        continue;
      }
      for (const downstream of downstreamList) {
        if (present(bundle, downstream) && !stale.has(downstream)) {
          stale.add(downstream);
          changed = true;
        }
      }
    }
  }

  return stale;
}
