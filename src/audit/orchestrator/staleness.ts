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
 *
 * THE CARRY IS A FIELD OF THE VALUE, so it lives exactly as long as the value.
 * A consumer that rebuilds, forwards or re-types the set into a fresh object
 * holds a value without it, whatever that consumer's `instanceof` says.
 *
 * The residual is real and is NOT papered over. `Set.prototype.union` builds a
 * PLAIN `Set` — measured, not assumed. It consults neither the receiver's
 * constructor nor `Set[Symbol.species]` (the property exists and is
 * configurable, and is ignored), and the subclass constructor is never invoked,
 * so NOTHING inside this class can reach the copy. `structuredClone` likewise
 * rebuilds a plain `Set` and has no hook at all. Both results are still
 * iterable, still `instanceof`-false, and so still type-acceptable to every
 * consumer — the silently-DISCARDED deferral this class was introduced to make
 * impossible, one derivation away.
 *
 * So the contract is stated LOUDLY at the read instead: {@link deferredArtifactsOf}
 * returns the carried set for a {@link StaleArtifactSet} and `undefined` for
 * everything else — which is distinguishable from "this one deferred nothing"
 * (an EMPTY set on a `StaleArtifactSet`). A caller that unions or clones a stale
 * set therefore gets `undefined` — an explicit "I lost the deferrals", not an
 * empty set that reads as "nothing was deferred". The ONLY carry that survives a
 * derivation is the constructor's: a `StaleArtifactSet` built FROM another one
 * describes the same computation, so it inherits the source's carry (see the
 * constructor). Nothing else does — neither derivation is a staleness result.
 */
export class StaleArtifactSet extends Set<string> {
  /** Downstreams held behind a slice projection this call — always disjoint from the stale set. */
  readonly deferred: ReadonlySet<string>;

  constructor(stale: Iterable<string> = [], deferred: Iterable<string> = []) {
    super(stale);
    // A downstream that ended up stale by some OTHER path was decided, not
    // deferred — the two sets are disjoint by construction.
    const disjoint = new Set([...deferred].filter((name) => !this.has(name)));
    // A StaleArtifactSet built FROM another one (the `new StaleArtifactSet(a)`
    // re-construction a caller writes when it wants the type back) inherits the
    // source's carry beside any deferrals of its own: the copy describes the
    // same computation, so losing the deferrals there would be the same silent
    // under-report through a different door.
    this.deferred =
      stale instanceof StaleArtifactSet && stale.deferred.size > 0
        ? new Set([...disjoint, ...stale.deferred])
        : disjoint;
  }
}

/**
 * The deferred downstreams a stale set carries, `undefined` when the argument
 * is not a staleness result at all. A `StaleArtifactSet` that deferred nothing
 * reports an empty set — never `undefined`, so "deferred nothing" and "was
 * never a staleness result" stay distinguishable.
 *
 * The `instanceof` test here is EXACT, not a widening: only a
 * `StaleArtifactSet` has a carry, and its constructor is the only thing that
 * puts the deferrals back on a DERIVED value. A plain `Set` — from `union`,
 * `structuredClone`, or `new Set(...)` — is simply not a staleness result, so
 * answering `undefined` for it is the honest answer, not a lost lookup.
 */
export function deferredArtifactsOf(
  stale: ReadonlySet<string> | Iterable<string>,
): ReadonlySet<string> | undefined {
  return stale instanceof StaleArtifactSet ? stale.deferred : undefined;
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
 * EVERY tracked artifact is classified, map-declared LEAF included — the
 * `.length === 0` exemption that used to stand here is DELETED. It was a
 * suppression of the third state over exactly the artifacts most likely to be
 * truncated mid-write, and `audit-findings.json` — the pipeline's primary
 * machine contract — is one of them: a body that no longer hashes to the
 * manifest's `content_hash` is definitionally not what the manifest describes,
 * whether or not anything downstream reads it. The stated reason for the
 * exemption was that a leaf has no dependents to catch it, which is an argument
 * for the CHECK, not against it: for a true host-append input (an appended
 * input stales only its downstream, pinned by
 * agent-feedback-reflections.test.ts) the exemption was FORCED because that
 * input's own producing obligation does not gate on its staleness — so what
 * preserves its behaviour is not the leaf exemption but the exemption's
 * replacement below, which states exactly which artifacts a `partial` verdict
 * must not gate.
 *
 * `partial` is therefore reported for every tracked artifact whose body does not
 * match its record. The one carve-out that remains is not a leaf rule but a
 * CONTENT-SOURCE rule (see `HOST_APPENDED_ARTIFACTS`).
 */
function classifyArtifactPresence(
  bundle: ArtifactBundle,
  metadata: NonNullable<ArtifactBundle["artifact_metadata"]>,
  artifactName: string,
): ArtifactPresence {
  if (!present(bundle, artifactName)) return "absent";
  const entry = metadata.artifacts[artifactName];
  if (!entry) return "intact";
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

/**
 * Artifacts whose content an EXTERNAL writer appends to, so a body that does not
 * match the manifest's record is the normal state rather than a damaged one.
 *
 * This is the honest replacement for the deleted map-declared-leaf exemption,
 * and it is deliberately a named registry rather than a structural rule:
 * "declares no upstreams" was never the property that mattered (several leaves
 * are pipeline-produced and SHOULD be caught), and the property that does matter
 * — "this artifact is mutated by something other than its producing obligation"
 * — is not derivable from the dependency map at all. Naming the members is what
 * keeps the set from silently growing to cover whatever is inconvenient: a new
 * entry here is a deliberate statement that its producer does not own its bytes.
 *
 * `agent-feedback.jsonl` is the sole member: workers append opt-in reflections
 * to it after the pass that created it, so it stales only its DOWNSTREAM —
 * `agent-feedback-reflections.test.ts` pins that behaviour and this registry is
 * what makes it survive the leaf exemption's deletion.
 */
const HOST_APPENDED_ARTIFACTS: ReadonlySet<string> = new Set([
  "agent-feedback.jsonl",
]);

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

/**
 * The recovery a stale set describes, when it describes one — or `undefined`
 * for the ordinary case of staling work that had not been done yet.
 *
 * WHY THIS EXISTS AT ALL (the 2026-07-16 self-audit dogfood entry): fixing this
 * tool WHILE it audits a tree changes the audited tree, the dependency DAG
 * correctly marks the planning chain stale, and the run restarts from
 * `charter_extraction`. The cascade is RIGHT — the planning was derived from a
 * tree that no longer exists — and it is deliberately NOT narrowed here. The
 * defect was that a large, expensive, correct action happened SILENTLY, so an
 * operator could not tell it from a wedge and would eventually be trained to
 * defeat it. The DAG stays truth; the explanation is added.
 *
 * "Expensive" is what makes this a recovery rather than routine planning: a
 * stale artifact that ALREADY HAS A BODY is prior work being redone. One that
 * was never written is simply the next thing to do, and announcing it would
 * make the signal fire constantly — which is the same as not having it. So the
 * trigger is: this set reaches at least one artifact that already exists.
 *
 * The CAUSES are the upstreams that moved. A stale artifact with tracked
 * dependencies attributes to whichever of them is itself absent-or-stale (the
 * head of the cascade); a stale artifact with none is its own cause — for the
 * dogfood case that is `repo_manifest.json`, the artifact that actually
 * noticed the tool's source change.
 */
export interface StalenessRecovery {
  /** The upstream artifact(s) whose change triggered this cascade, sorted. */
  caused_by: string[];
  /** How many artifacts are being re-derived, including the causes. */
  rederiving: number;
}

export function describeStalenessRecovery(
  stale: ReadonlySet<string>,
  bundle: ArtifactBundle,
): StalenessRecovery | undefined {
  // Only work that was already done is a recovery; a first pass is not.
  const alreadyWritten = [...stale].filter((name) => present(bundle, name));
  if (alreadyWritten.length === 0) return undefined;
  const staleSet = new Set(stale);
  // Why a stale artifact is stale, decided per artifact — the head is the FIRST
  // artifact in the chain that nothing upstream explains.
  //
  //  - It is stale because an UPSTREAM moved (a downstream of the change). Its
  //    own body is not the cause; recurse up.
  //  - It is stale with every upstream intact. Nothing above it moved, so the
  //    change entered AT it — it is the head, whether it was tampered with
  //    directly or whether it is a root like `tooling_manifest.json` (rebuilt
  //    every call, so it never appears in the stale set itself).
  // The walk returns this branch's heads rather than memoizing them: `seen` is
  // a copy per branch, so whether a node is a head depends on the ROUTE taken to
  // reach it, and a memo keyed on the name alone would answer a later branch
  // with a head computed on an earlier one. Nothing here is keyed on the name —
  // the map is small and the walk is per-call.
  const causes = new Set<string>();
  const walk = (name: string, seen: ReadonlySet<string>): string[] => {
    if (seen.has(name)) return [];
    const movedUpstreams = (ARTIFACT_DEPENDENCIES_MAP[name] ?? []).filter(
      (upstream) => staleSet.has(upstream) || !present(bundle, upstream),
    );
    if (movedUpstreams.length === 0) {
      causes.add(name);
      return [name];
    }
    const heads = new Set<string>();
    for (const upstream of movedUpstreams) {
      const next = new Set([...seen, name]);
      for (const head of walk(upstream, next)) heads.add(head);
    }
    for (const head of heads) causes.add(head);
    return [...heads];
  };
  for (const name of alreadyWritten) walk(name, new Set());

  return {
    caused_by: [...causes].sort(),
    rederiving: alreadyWritten.length,
  };
}

export function emitStalenessRecord(
  stale: Set<string>,
  reason?: string,
  bundle?: ArtifactBundle,
): void {
  // INV-SSP-DEFERRED-SET-REPORTED: a stale set computed by this module carries
  // its deferred downstreams; a bare `Set` (a caller reporting a hand-built set,
  // or a copy derived from a stale one) has none. The record NAMES them —
  // omitting a deferred downstream is exactly the silent under-report this
  // reporting exists to make impossible. Read through the accessor, which
  // answers for a `StaleArtifactSet` — the only value that can carry a carry —
  // and `undefined` for anything else.
  const deferred = [...(deferredArtifactsOf(stale) ?? [])].sort();
  if (stale.size === 0 && deferred.length === 0) return;
  const recovery = bundle ? describeStalenessRecovery(stale, bundle) : undefined;
  const key = JSON.stringify([
    [...stale].sort(),
    deferred,
    reason ?? null,
    recovery ?? null,
  ]);
  if (key === lastEmittedStalenessKey) return;
  lastEmittedStalenessKey = key;
  process.stderr.write(
    JSON.stringify({
      kind: "staleness",
      stale_artifacts: [...stale].sort(),
      ...(deferred.length > 0 ? { deferred_artifacts: deferred } : {}),
      ...(reason ? { reason } : {}),
      ...(recovery
        ? {
            recovery: {
              caused_by: recovery.caused_by,
              rederiving: recovery.rederiving,
              // The one message, at the moment it happens: this is not a wedge,
              // it is a correct re-derivation, and here is what invalidated it.
              message:
                `re-deriving ${recovery.rederiving} completed artifact(s) invalidated by ` +
                `${recovery.caused_by.join(", ")} — the dependency graph is the source of truth, ` +
                `so this is a correct recovery, not a restart from scratch`,
            },
          }
        : {}),
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
      // A HOST-APPENDED artifact is exempt from the `partial` verdict, not from
      // classification: its body is expected to run ahead of the manifest, so
      // `partial` there is the steady state and staling it would re-fire its
      // producer forever. Its staleness reaches its DOWNSTREAM through the
      // absent-path fail-safe below, which is the behaviour it always had.
      const presence = HOST_APPENDED_ARTIFACTS.has(artifactName)
        ? "intact"
        : classifyArtifactPresence(bundle, metadata, artifactName);
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
