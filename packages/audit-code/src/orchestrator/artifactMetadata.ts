import { createHash } from "node:crypto";
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

// Stable signature of the overall artifact state, keyed on per-artifact CONTENT
// hashes — deliberately NOT revisions, which only ever increment. A
// deterministic advance loop that revisits a signature it already produced this
// run is cycling (e.g. a runtime_validation <-> synthesis staleness ping-pong);
// the content-hash basis catches that even while revisions churn underneath.
export function computeArtifactStateSignature(bundle: ArtifactBundle): string {
  const metadata = bundle.artifact_metadata;
  if (!metadata) return "no-metadata";
  const entries = Object.entries(metadata.artifacts)
    .map(([name, entry]) => `${name}:${entry.content_hash}`)
    .sort();
  return createHash("sha256").update(entries.join("\n")).digest("hex");
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
