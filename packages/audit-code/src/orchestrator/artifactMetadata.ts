import type {
  ArtifactMetadataEntry,
  ArtifactMetadataManifest,
} from "../types/artifactMetadata.js";
import type { ArtifactBundle } from "../io/artifacts.js";
import { getArtifactValue } from "../io/artifacts.js";
import {
  buildReverseDependencyMap,
  hashArtifactValue,
  stableStringify,
} from "./artifactFreshness.js";

const REVERSE_DEPENDENCY_MAP = buildReverseDependencyMap();

function computeDependencyFirstOrder(
  artifactNames: Iterable<string>,
): string[] {
  const target = new Set(artifactNames);
  const ordered: string[] = [];
  const temporary = new Set<string>();
  const permanent = new Set<string>();

  const visit = (artifactName: string) => {
    if (permanent.has(artifactName)) return;
    if (temporary.has(artifactName)) return;
    temporary.add(artifactName);

    const dependencies = (REVERSE_DEPENDENCY_MAP[artifactName] ?? [])
      .filter((dependencyName) => target.has(dependencyName))
      .sort();
    for (const dependencyName of dependencies) {
      visit(dependencyName);
    }

    temporary.delete(artifactName);
    permanent.add(artifactName);
    ordered.push(artifactName);
  };

  for (const artifactName of Array.from(target).sort()) {
    visit(artifactName);
  }

  return ordered;
}

export function present(bundle: ArtifactBundle, artifactName: string): boolean {
  const value = getArtifactValue(bundle, artifactName);
  return value !== undefined && value !== null;
}

export function computeArtifactMetadata(
  bundle: ArtifactBundle,
  previous?: ArtifactMetadataManifest,
  updatedArtifacts: Iterable<string> = [],
): ArtifactMetadataManifest {
  const artifacts: Record<string, ArtifactMetadataEntry> = {};
  const updated = new Set(updatedArtifacts);
  const presentArtifacts = Object.keys(REVERSE_DEPENDENCY_MAP).filter(
    (artifactName) =>
      artifactName !== "artifact_metadata.json" &&
      present(bundle, artifactName),
  );
  const orderedArtifacts = computeDependencyFirstOrder(presentArtifacts);

  for (const artifactName of orderedArtifacts) {
    if (artifactName === "artifact_metadata.json") continue;
    const value = getArtifactValue(bundle, artifactName);
    if (value === undefined || value === null) continue;

    const previousEntry = previous?.artifacts[artifactName];
    if (previousEntry && !updated.has(artifactName)) {
      artifacts[artifactName] = previousEntry;
      continue;
    }

    const contentHash = hashArtifactValue(artifactName, value);
    const dependencyRevisions = Object.fromEntries(
      (REVERSE_DEPENDENCY_MAP[artifactName] ?? [])
        .filter((dependencyName) => dependencyName !== "artifact_metadata.json")
        .sort()
        .map((dependencyName) => [
          dependencyName,
          artifacts[dependencyName]?.revision ??
            previous?.artifacts[dependencyName]?.revision ??
            0,
        ]),
    );

    const sameContent = previousEntry?.content_hash === contentHash;
    const sameDependencies =
      previousEntry &&
      stableStringify(previousEntry.dependency_revisions) ===
        stableStringify(dependencyRevisions);
    const revision =
      sameContent && sameDependencies
        ? previousEntry.revision
        : (previousEntry?.revision ?? 0) + 1;

    artifacts[artifactName] = {
      revision,
      content_hash: contentHash,
      dependency_revisions: dependencyRevisions,
    };
  }

  return { artifacts };
}
