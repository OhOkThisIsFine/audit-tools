import type { ArtifactBundle } from "../io/artifacts.js";
import { getArtifactValue } from "../io/artifacts.js";
import {
  ALL_DAG_ARTIFACTS,
  ARTIFACT_DEPENDENTS_MAP,
  ARTIFACT_DEPENDS_ON_MAP,
} from "./dependencyMap.js";
import { present } from "./artifactMetadata.js";
import { isMetadataManifestCurrent } from "./resultBaseline.js";
import {
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

// The canonical "X depends on Y" table (ARC-cebe3421) — same single source of
// truth computeArtifactMetadata records against.
const ARTIFACT_DEPENDENCIES_MAP: Partial<Record<string, string[]>> =
  ARTIFACT_DEPENDS_ON_MAP;

export function computeStaleArtifacts(bundle: ArtifactBundle): Set<string> {
  const stale = new Set<string>();
  const metadata = bundle.artifact_metadata;

  // Metadata-migration fail-safe (CE-007): an old-shape (pre-F1) manifest —
  // present but absent/older `metadata_schema_version`, or that would not decode
  // to the F1 shape — must NOT be trusted to skip work off its still-matching
  // whole-artifact hashes. Degrade to ALL-STALE (every present DAG artifact),
  // never false-skip and never throw on a shape mismatch. A genuinely-absent
  // manifest stays "nothing to compare ⇒ nothing stale" (handled below).
  if (metadata && !isMetadataManifestCurrent(metadata)) {
    for (const artifactName of ALL_DAG_ARTIFACTS) {
      if (artifactName === "artifact_metadata.json") continue;
      if (present(bundle, artifactName)) stale.add(artifactName);
    }
    if (stale.size > 0) {
      process.stderr.write(
        JSON.stringify({
          kind: "staleness",
          stale_artifacts: [...stale].sort(),
          reason: "metadata_schema_version_migration",
          ts: new Date().toISOString(),
        }) + "\n",
      );
    }
    return stale;
  }

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
      if (!downstreamList) continue;
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
      if (!downstreamList) continue;
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

  if (stale.size > 0) {
    process.stderr.write(
      JSON.stringify({
        kind: "staleness",
        stale_artifacts: [...stale].sort(),
        ts: new Date().toISOString(),
      }) + "\n",
    );
  }

  return stale;
}
