import { createHash } from "node:crypto";
import type {
  ArtifactMetadataEntry,
  ArtifactMetadataManifest,
} from "../types/artifactMetadata.js";
import { METADATA_SCHEMA_VERSION } from "../types/artifactMetadata.js";
import type { ArtifactBundle } from "../io/artifacts.js";
import { getArtifactValue } from "../io/artifacts.js";
import { ALL_DAG_ARTIFACTS, ARTIFACT_DEPENDS_ON_MAP } from "./dependencyMap.js";
import {
  hashArtifactValue,
  stableStringify,
} from "./artifactFreshness.js";

// The canonical "X depends on Y" table (ARC-cebe3421). computeArtifactMetadata
// records each artifact's upstream dependency revisions, so it reads the
// dependsOn direction directly from the single source of truth.
const ARTIFACT_DEPENDENCIES_MAP: DependencyLookup = ARTIFACT_DEPENDS_ON_MAP;

type DependencyLookup = Partial<Record<string, string[]>>;

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

    const dependencies = (ARTIFACT_DEPENDENCIES_MAP[artifactName] ?? [])
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
  // Metadata-migration fail-safe (CE-007): an old-shape (pre-F1) manifest —
  // absent/older `metadata_schema_version` — must NOT be trusted to skip work off
  // its still-matching whole-artifact hashes/revisions, and its per-element
  // baselines (if any) cannot be safely interpreted. Treat it as absent for
  // reuse/carry-forward so every artifact is recomputed fresh and every element
  // fails safe to re-derive. The output is always stamped F1-current.
  const previousIsCurrent =
    typeof previous?.metadata_schema_version === "number" &&
    previous.metadata_schema_version >= METADATA_SCHEMA_VERSION;
  const usablePrevious = previousIsCurrent ? previous : undefined;
  // Enumerate the FULL DAG artifact universe (not just those that depend on
  // something): a pure-input artifact (scope.json, intent_checkpoint.json, …)
  // must still get a metadata entry so its dependents can compare revisions.
  const presentArtifacts = [...ALL_DAG_ARTIFACTS].filter(
    (artifactName) =>
      artifactName !== "artifact_metadata.json" &&
      present(bundle, artifactName),
  );
  const orderedArtifacts = computeDependencyFirstOrder(presentArtifacts);

  for (const artifactName of orderedArtifacts) {
    if (artifactName === "artifact_metadata.json") continue;
    const value = getArtifactValue(bundle, artifactName);
    if (value === undefined || value === null) continue;

    const previousEntry = usablePrevious?.artifacts[artifactName];
    if (previousEntry && !updated.has(artifactName)) {
      artifacts[artifactName] = previousEntry;
      continue;
    }

    const contentHash = hashArtifactValue(artifactName, value);
    const dependencyRevisions = Object.fromEntries(
      (ARTIFACT_DEPENDENCIES_MAP[artifactName] ?? [])
        .filter((dependencyName) => dependencyName !== "artifact_metadata.json")
        .sort()
        .map((dependencyName) => [
          dependencyName,
          artifacts[dependencyName]?.revision ??
            usablePrevious?.artifacts[dependencyName]?.revision ??
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

  const manifest: ArtifactMetadataManifest = {
    metadata_schema_version: METADATA_SCHEMA_VERSION,
    artifacts,
  };
  // Carry forward the O2↔F1 per-result baseline store ONLY from a recognized
  // F1-current manifest — an old-shape store cannot be safely reused (its keys
  // predate the discriminated coordinate), so dropping it makes every element
  // fail safe to re-derive (CE-007).
  if (usablePrevious?.result_baselines) {
    manifest.result_baselines = usablePrevious.result_baselines;
  }
  return manifest;
}
