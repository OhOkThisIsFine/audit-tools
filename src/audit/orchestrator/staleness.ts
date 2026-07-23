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
import {
  computeDependencySliceHash,
  hasDependencySliceProjection,
} from "./dependencySlices.js";

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

/** Options controlling the staleness pass's observability side effect. */
export interface StalenessOptions {
  /**
   * When `true` (the default), a non-empty stale set is reported to stderr as a
   * single `{ kind: "staleness", … }` JSONL record. `advanceAudit`'s internal
   * drain loop passes `false` for every intermediate re-derivation so a whole
   * regen cascade resolved in one host round-trip emits ONE consolidated record
   * (via `emitStalenessRecord`) at the boundary, not one per drained step.
   */
  emit?: boolean;
}

/**
 * Emit the single canonical staleness stderr record for a computed stale set.
 * Kept separate from `computeStaleArtifacts` so the pure staleness computation
 * has no side effect and callers (notably the `advanceAudit` drain) can emit
 * exactly once per host round-trip. `reason` distinguishes the metadata-schema
 * migration degrade from an ordinary dependency-hash staleness.
 */
export function emitStalenessRecord(
  stale: Set<string>,
  reason?: string,
): void {
  if (stale.size === 0) return;
  process.stderr.write(
    JSON.stringify({
      kind: "staleness",
      stale_artifacts: [...stale].sort(),
      ...(reason ? { reason } : {}),
      ts: new Date().toISOString(),
    }) + "\n",
  );
}

/**
 * True exactly when `computeStaleArtifacts` would take the metadata-schema
 * migration degrade path (an old-shape manifest that must not be trusted to
 * skip work). The boundary emit in `advanceAudit` uses this to tag the
 * consolidated record with the migration `reason`, matching the inline record.
 */
export function isMetadataMigrationStaleness(bundle: ArtifactBundle): boolean {
  const metadata = bundle.artifact_metadata;
  return Boolean(metadata && !isMetadataManifestCurrent(metadata));
}

export function computeStaleArtifacts(
  bundle: ArtifactBundle,
  options: StalenessOptions = {},
): Set<string> {
  const emit = options.emit ?? true;
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
    if (emit) emitStalenessRecord(stale, "metadata_schema_version_migration");
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

        // Per-edge semantic slice (dependencySlices.ts): when a projection is
        // registered AND this entry recorded a slice for the edge, the slice
        // compare REPLACES the whole-hash + revision disjunction — an upstream
        // change outside the consumed slice no longer phantom-stales this
        // artifact. A registered projection with NO recorded slice (old
        // manifest, or the projection errored at stamp time) falls through to
        // the conservative whole-hash compare. A projection that throws at
        // compare time returns the error sentinel, which never equals a
        // recorded sha256 → stale (fail-safe). The dependency-KEY-SET gate
        // above is untouched: re-listing dependencies still stales.
        const recordedSlice = entry.dependency_slices?.[dependencyName];
        if (
          recordedSlice !== undefined &&
          hasDependencySliceProjection(artifactName, dependencyName)
        ) {
          const currentSlice = computeDependencySliceHash(
            artifactName,
            dependencyName,
            bundle,
          );
          if (recordedSlice !== currentSlice) {
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
        if (!present(bundle, downstream) || stale.has(downstream)) continue;
        // A slice-protected edge blocks TRANSITIVE propagation too: the
        // downstream's staleness across this edge is decided by the slice
        // compare AFTER the upstream re-derives, not pre-emptively while the
        // upstream is merely pending (the pre-emptive mark was the live
        // re-fire chain: manifest churn → structure stale → charter re-fired
        // over a byte-identical subsystem set). Safe under PRIORITY ordering:
        // every slice-projected upstream's obligation runs before the
        // downstream's, and staleness re-derives each drain iteration, so a
        // slice moved by the upstream's re-derivation still fires the per-edge
        // compare before the downstream's obligation is reached.
        const entry = metadata?.artifacts[downstream];
        if (
          entry?.dependency_slices?.[upstream] !== undefined &&
          hasDependencySliceProjection(downstream, upstream)
        ) {
          continue;
        }
        stale.add(downstream);
        changed = true;
      }
    }
  }

  if (emit) emitStalenessRecord(stale);

  return stale;
}
