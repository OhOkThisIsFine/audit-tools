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
import { buildDependencySlices } from "./dependencySlices.js";
import { computeGateVersion } from "./intentCheckpointGate.js";

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

  // DD-9 revision authority: while a GATE-CURRENT intent baseline exists, the
  // intent entry's revision MIRRORS `baseline.revision` — the baseline (written
  // only by the intent-equivalence executor at resolution commits) is the single
  // thing that advances it. A provenance re-confirm or a pending prose judgment
  // therefore never bumps the revision downstream compares see; a committed
  // resolution (structured delta / judged-`changed` / stale gate) does, exactly
  // once. Prefer the bundle manifest's copy (the executor commits onto
  // `run.updated`'s manifest this same advance) over the pre-executor previous.
  const bundleMetadata = bundle.artifact_metadata;
  const bundleIsCurrent =
    typeof bundleMetadata?.metadata_schema_version === "number" &&
    bundleMetadata.metadata_schema_version >= METADATA_SCHEMA_VERSION;
  const carriedIntentBaseline =
    (bundleIsCurrent ? bundleMetadata?.intent_baseline : undefined) ??
    usablePrevious?.intent_baseline;
  const intentRevisionAuthority =
    carriedIntentBaseline &&
    carriedIntentBaseline.gate_version === computeGateVersion()
      ? carriedIntentBaseline.revision
      : undefined;

  for (const artifactName of orderedArtifacts) {
    if (artifactName === "artifact_metadata.json") continue;
    const value = getArtifactValue(bundle, artifactName);
    if (value === undefined || value === null) continue;

    const previousEntry = usablePrevious?.artifacts[artifactName];
    const isUpdated = updated.has(artifactName);
    const contentHash = hashArtifactValue(artifactName, value);
    // Carry-forward is CONTENT-VERIFIED, never trusted from the executor's
    // hand-maintained `artifacts_written` list alone: `writeCoreArtifacts`
    // persists EVERY present bundle artifact, so an executor that mutates an
    // artifact it forgot to list would otherwise advance the file on disk while
    // its metadata entry stays frozen at the old revision/hash/deps — a
    // permanent-staleness livelock for the artifact's obligation (the file can
    // never catch up to its own stale record). A hash mismatch therefore
    // restamps the hash and bumps the revision below. An UNCHANGED unlisted
    // artifact still carries its entry verbatim.
    if (previousEntry && !isUpdated && previousEntry.content_hash === contentHash) {
      artifacts[artifactName] = previousEntry;
      continue;
    }
    // dependency_revisions refresh ONLY on a LISTED (declared) re-derivation.
    // An UNLISTED mismatch-restamp preserves the previous deps: refreshing them
    // here would silently clear a legitimately-pending dep-staleness without
    // the re-derivation it demands (e.g. the one-time hash-scheme migration
    // when the non-semantic strip list changes, or an executor's forgotten
    // listing). With deps preserved, a dep-stale artifact stays stale, its
    // obligation re-fires, and the proper listed re-derive restamps fully —
    // that is what converges; the frozen-record livelock cannot recur because
    // the hash/revision always advance with the file.
    const dependencyNames = (ARTIFACT_DEPENDENCIES_MAP[artifactName] ?? [])
      .filter((dependencyName) => dependencyName !== "artifact_metadata.json")
      .sort();
    const dependencyRevisions =
      !isUpdated && previousEntry
        ? previousEntry.dependency_revisions
        : Object.fromEntries(
            dependencyNames.map((dependencyName) => [
              dependencyName,
              artifacts[dependencyName]?.revision ??
                usablePrevious?.artifacts[dependencyName]?.revision ??
                0,
            ]),
          );
    // dependency_slices ride EXACTLY the dependency_revisions terms: rebuilt on
    // a LISTED re-derivation, preserved verbatim on an unlisted mismatch-restamp
    // (rebuilding them there would silently clear a legitimately-pending
    // slice-staleness without the re-derivation it demands).
    const dependencySlices =
      !isUpdated && previousEntry
        ? previousEntry.dependency_slices
        : buildDependencySlices(artifactName, dependencyNames, bundle);

    const sameContent = previousEntry?.content_hash === contentHash;
    const sameDependencies =
      previousEntry &&
      stableStringify(previousEntry.dependency_revisions) ===
        stableStringify(dependencyRevisions);
    // DD-9: the intent entry's revision mirrors the gate-current baseline (see
    // `intentRevisionAuthority` above); every other artifact keeps the ordinary
    // content/deps-change bump. The mirror can never REWIND below the previous
    // entry revision: while the mirror is active the two are always equal, so a
    // previous revision ABOVE the authority means ordinary bumps happened while
    // the mirror was inactive (a gate-version-stale window) — snapping back
    // would mask them from downstream `dependency_revisions` compares.
    const revision =
      artifactName === "intent_checkpoint.json" &&
      intentRevisionAuthority !== undefined
        ? Math.max(intentRevisionAuthority, previousEntry?.revision ?? 0)
        : sameContent && sameDependencies
          ? previousEntry.revision
          : (previousEntry?.revision ?? 0) + 1;

    artifacts[artifactName] = {
      revision,
      content_hash: contentHash,
      dependency_revisions: dependencyRevisions,
      ...(dependencySlices ? { dependency_slices: dependencySlices } : {}),
    };
  }

  const manifest: ArtifactMetadataManifest = {
    metadata_schema_version: METADATA_SCHEMA_VERSION,
    artifacts,
  };
  // Carry forward the O2↔F1 per-result baseline store ONLY from a recognized
  // F1-current manifest — an old-shape store cannot be safely reused (its keys
  // predate the discriminated coordinate), so dropping it makes every element
  // fail safe to re-derive (CE-007). The ingestion executor records refreshed
  // baselines onto the *bundle's* manifest (run.updated), so prefer those over
  // the pre-executor `usablePrevious` — but only when the bundle manifest is
  // itself F1-current (same CE-007 gate); otherwise fall back, then drop.
  const carriedBaselines =
    (bundleIsCurrent ? bundleMetadata?.result_baselines : undefined) ??
    usablePrevious?.result_baselines;
  if (carriedBaselines) {
    manifest.result_baselines = carriedBaselines;
  }
  // Carry the T5 #12 coverage-element baselines forward on the SAME terms as the
  // result baselines (CE-007: only from an F1-current store; prefer the bundle's
  // freshly-recorded set over the pre-executor `usablePrevious`). Dropping an
  // old-shape store makes every coverage element fail safe to re-audit.
  const carriedCoverageBaselines =
    (bundleIsCurrent ? bundleMetadata?.coverage_element_baselines : undefined) ??
    usablePrevious?.coverage_element_baselines;
  if (carriedCoverageBaselines) {
    manifest.coverage_element_baselines = carriedCoverageBaselines;
  }
  // Carry the T5 #12 git-history baseline forward on the SAME terms (CE-007:
  // only from an F1-current store; prefer the bundle's freshly-recorded baseline
  // — the structure executor stamps it on run.updated — over the pre-executor
  // `usablePrevious`). Dropping an old-shape baseline makes the next structure
  // run re-mine git history (fail-safe).
  const carriedGitHistoryBaseline =
    (bundleIsCurrent ? bundleMetadata?.git_history_baseline : undefined) ??
    usablePrevious?.git_history_baseline;
  if (carriedGitHistoryBaseline) {
    manifest.git_history_baseline = carriedGitHistoryBaseline;
  }
  // Carry the DD-9 intent-equivalence baseline on the SAME CE-007 terms (the
  // hoisted `carriedIntentBaseline` already preferred the bundle manifest's
  // freshly-committed copy over the pre-executor `usablePrevious`).
  if (carriedIntentBaseline) {
    manifest.intent_baseline = carriedIntentBaseline;
  }
  return manifest;
}
