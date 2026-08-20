import type { ArtifactBundle } from "../io/artifacts.js";
import { getArtifactValue } from "../io/artifacts.js";
import {
  ALL_DAG_ARTIFACTS,
  ARTIFACT_DEPENDENTS_MAP,
  ARTIFACT_DEPENDS_ON_MAP,
} from "./dependencyMap.js";
import { present } from "./artifactMetadata.js";
import { isMetadataManifestCurrent } from "./resultBaseline.js";
import { hashArtifactValue } from "../../shared/artifactFreshness.js";
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

/**
 * The staleness pass's result: the stale set, carrying the DEFERRED set beside
 * it (INV-SSP-DEFERRED-SET-REPORTED).
 *
 * `deferred` names every present downstream whose staleness this call declined
 * to decide because the edge from a stale-and-pending upstream is
 * slice-projected — the compare only becomes meaningful once that upstream has
 * actually re-derived and restamped its metadata (see the transitive-closure
 * comment below). A deferral is NOT "not stale": it is "not decided yet", and a
 * caller that treats a single result as the full truth while `deferred` is
 * non-empty is under-reporting. Reporting it is what makes that visible instead
 * of silent — the consolidated staleness record NAMES the deferred artifacts.
 *
 * It is a `Set<string>` SUBCLASS on purpose: every consumer that only wants the
 * stale set (`deriveAuditState`, the drain boundary) keeps its `Set<string>`
 * type and behaviour unchanged, so the deferred channel can never be dropped by
 * a caller "forgetting" a second return value.
 */
export class StaleArtifactSet extends Set<string> {
  /** Downstreams held behind a slice projection this call — always disjoint from the stale set. */
  readonly deferred: ReadonlySet<string>;

  constructor(stale: Iterable<string> = [], deferred: Iterable<string> = []) {
    super(stale);
    // A downstream that ended up stale by some OTHER path was decided, not
    // deferred — the two sets are disjoint by construction.
    this.deferred = new Set([...deferred].filter((name) => !this.has(name)));
  }
}

/** Present-artifact readability, as this module can determine it from the bundle. */
type ArtifactPresence =
  /** No value in the bundle at all. */
  | "absent"
  /**
   * Present, but its body no longer hashes to the `content_hash` recorded for
   * it — a partially-written / truncated / externally-mutated copy. The
   * distinguishable THIRD state: neither fully-fresh-and-present nor absent.
   */
  | "partial"
  /** Present and byte-consistent with what the manifest recorded for it. */
  | "intact";

/**
 * Classify one artifact's readability against its recorded metadata entry.
 * An artifact the manifest does not track has nothing to compare against, so it
 * reads as `intact` (the downstream-of-absent fail-safe below is what covers
 * that case).
 *
 * `partial` is reported only for an artifact with declared upstreams: the
 * exemption is literally the `.length === 0` gate on `ARTIFACT_DEPENDS_ON_MAP`
 * below — a MAP-DECLARED LEAF, which is NOT a synonym for an input (several
 * leaves are pipeline-produced). For a true host-append input the exemption is
 * FORCED: an appended input stales only its DOWNSTREAM, pinned by
 * agent-feedback-reflections.test.ts. For a leaf whose own producing obligation
 * gates on its staleness (state.ts's `syntax_resolved`, `confirm_intent`) it is
 * a recorded CHOICE, not a necessity — this pass simply never asserts `partial`
 * for it. Either way a truncated leaf body is caught only through its
 * dependents' hash compare, or at its producer's next restamp.
 */
function classifyArtifactPresence(
  bundle: ArtifactBundle,
  metadata: NonNullable<ArtifactBundle["artifact_metadata"]>,
  artifactName: string,
): ArtifactPresence {
  if (!present(bundle, artifactName)) return "absent";
  const entry = metadata.artifacts[artifactName];
  if (!entry) return "intact";
  if ((ARTIFACT_DEPENDENCIES_MAP[artifactName] ?? []).length === 0) {
    return "intact";
  }
  // An UNHASHABLE body is `partial` too, and the classification must happen
  // here rather than escaping: `hashArtifactValue`'s canonicalizer throws on a
  // malformed `audit_tasks.json` / `task_affinity_graph.json`
  // (shared/affinityArtifacts.ts — a dangling edge, a duplicate id, a missing
  // field), and this pass reaches every tracked artifact unconditionally, so a
  // truncated affinity body would otherwise take down the whole staleness
  // computation — the shape-mismatch throw the migration fail-safe below
  // forbids. A body that cannot be hashed is definitionally not what the
  // manifest describes, which is exactly `partial`, and it converges the same
  // way: the next `computeArtifactMetadata` restamps (or fails loudly in the
  // producer, where a malformed body IS an error).
  let currentHash: string | undefined;
  try {
    currentHash = computeContentHash(artifactName, bundle);
  } catch {
    return "partial";
  }
  if (currentHash === undefined) return "absent";
  return entry.content_hash === currentHash ? "intact" : "partial";
}

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
 *
 * Content-deduped within the process (2026-08-05 friction: 28×/~15× identical
 * lines in single next-steps — every state re-derivation outside the advance
 * drain emits by default). A repeat of the exact last-emitted stale set (+
 * reason) is dropped at this single writer; a CHANGED set still emits.
 */
let lastEmittedStalenessKey: string | null = null;

/**
 * Scope the dedupe to ONE `advanceAudit` call: the boundary resets before each
 * call so a later call legitimately re-reporting the same stale set still
 * emits, while the intra-call repeats (the observed 28×/~15× spam) collapse.
 */
export function resetStalenessDedup(): void {
  lastEmittedStalenessKey = null;
}

export function emitStalenessRecord(
  stale: Set<string>,
  reason?: string,
): void {
  // INV-SSP-DEFERRED-SET-REPORTED: a stale set computed by this module carries
  // its deferred downstreams; a bare `Set` (a caller reporting a hand-built set)
  // simply has none. The record NAMES them — omitting a deferred downstream is
  // exactly the silent under-report this reporting exists to make impossible.
  const deferred =
    stale instanceof StaleArtifactSet ? [...stale.deferred].sort() : [];
  if (stale.size === 0 && deferred.length === 0) return;
  const key = JSON.stringify([[...stale].sort(), deferred, reason ?? null]);
  if (key === lastEmittedStalenessKey) return;
  lastEmittedStalenessKey = key;
  process.stderr.write(
    JSON.stringify({
      kind: "staleness",
      stale_artifacts: [...stale].sort(),
      ...(deferred.length > 0 ? { deferred_artifacts: deferred } : {}),
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
): StaleArtifactSet {
  const emit = options.emit ?? true;
  const stale = new Set<string>();
  // Downstreams the transitive-closure walk declined to decide because a slice
  // projection guards the edge from a stale-and-pending upstream — reported to
  // the caller and named in the emitted record (INV-SSP-DEFERRED-SET-REPORTED).
  const deferred = new Set<string>();
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
    // Everything present is already stale — nothing is held back, so the
    // degrade reports an EMPTY deferred set (never an absent one).
    const migrationStale = new StaleArtifactSet(stale);
    if (emit) {
      emitStalenessRecord(migrationStale, "metadata_schema_version_migration");
    }
    return migrationStale;
  }

  if (metadata) {
    for (const [artifactName, entry] of Object.entries(metadata.artifacts)) {
      if (!present(bundle, artifactName)) continue;
      const expectedDependencies = [...(ARTIFACT_DEPENDENCIES_MAP[artifactName] ?? [])]
        .filter((dependencyName) => dependencyName !== "artifact_metadata.json")
        .sort();
      const recordedDependencies = Object.keys(entry.dependency_revisions).sort();
      if (
        expectedDependencies.length !== recordedDependencies.length ||
        expectedDependencies.some(
          (dependencyName, i) => dependencyName !== recordedDependencies[i],
        )
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
    // Presence pass over every artifact this manifest tracks (plus every DAG
    // upstream), classifying each into the THREE states an ArtifactBundle can
    // actually hold — `absent`, `partial`, `intact` — rather than the
    // present/absent pair alone.
    //
    // `partial` is the one that used to be invisible: an artifact PRESENT in the
    // bundle whose body no longer hashes to the `content_hash` recorded for it
    // (a truncated / partially-written / externally-mutated copy). Present/absent
    // logic misclassifies it as fully-fresh-and-present — its own obligation
    // never re-fires, so a downstream re-derives against a body nobody re-derived
    // and then RECORDS that corrupt input as its new baseline. It is stale: the
    // manifest no longer describes what is there. Fail-safe direction, and it
    // converges — the next `computeArtifactMetadata` restamps the entry.
    //
    // `absent` keeps the original downstream-of-absent fail-safe: a present
    // downstream with NO metadata entry of its own has nothing to compare, so a
    // vanished upstream must stale it directly.
    const trackedArtifacts = new Set<string>([
      ...Object.keys(metadata.artifacts),
      ...Object.keys(ARTIFACT_DEPENDENTS_MAP),
    ]);
    for (const artifactName of [...trackedArtifacts].sort()) {
      if (artifactName === "artifact_metadata.json") continue;
      const presence = classifyArtifactPresence(bundle, metadata, artifactName);
      if (presence === "partial") {
        stale.add(artifactName);
        continue;
      }
      if (presence === "intact") continue;
      // tooling_manifest.json is an OPTIONAL probe: its absence is the normal
      // case, never an upstream that vanished.
      // ORDERING: the `partial` branch above runs FIRST, so this exemption only
      // ever sees `absent` — a tooling_manifest classified `partial` would be
      // staled before reaching here, inert today only because it declares no
      // upstreams and so short-circuits as `intact` at the leaf gate.
      if (artifactName === "tooling_manifest.json") continue;
      for (const downstream of ARTIFACT_DEPENDENTS_MAP[artifactName] ?? []) {
        const hasMetadataEntry = Boolean(metadata.artifacts[downstream]);
        if (present(bundle, downstream) && !hasMetadataEntry) {
          stale.add(downstream);
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
        //
        // That deferral is a DECISION POSTPONED, not a verdict of "fresh", so it
        // is REPORTED rather than silent: the downstream is recorded as deferred
        // and rides out on the result (INV-SSP-DEFERRED-SET-REPORTED). This
        // module states the ordering it is safe under; it does not police it —
        // the PRIORITY-ordering guarantee is the CALLER's precondition, owned and
        // tested there. What this module owes the caller is that a held-back
        // downstream is never mistaken for a decided-clean one.
        const entry = metadata?.artifacts[downstream];
        if (
          entry?.dependency_slices?.[upstream] !== undefined &&
          hasDependencySliceProjection(downstream, upstream)
        ) {
          deferred.add(downstream);
          continue;
        }
        stale.add(downstream);
        changed = true;
      }
    }
  }

  const result = new StaleArtifactSet(stale, deferred);
  if (emit) emitStalenessRecord(result);

  return result;
}
