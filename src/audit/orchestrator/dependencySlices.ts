/**
 * Per-EDGE semantic-slice projections for the staleness DAG (the charter
 * phantom-staleness fix, re-dogfood 2026-07-22 #6).
 *
 * The whole-artifact dependency compare keys staleness on the upstream's full
 * content hash — so an upstream change in a region the downstream never reads
 * still re-stales it (live-observed: charter re-extraction re-fired over a
 * byte-identical subsystem set because unrelated `repo_manifest` file hashes
 * moved). A registered projection narrows the compared surface to the slice the
 * downstream actually consumes: the edge is stale iff the SLICE hash moved.
 *
 * SLICE-DIRECTION INVARIANT: a projection must be a SUPERSET of what the
 * consuming path reads — narrower under-stales (the dangerous direction: a real
 * change that never re-fires). `charter_register.json` has TWO producers and
 * the slices cover the union of their verified consumption:
 * charterExtractionExecutor / charterExtractionPrompt read
 * `consensus[*].{node_id, members}` + member/doc file content (via
 * `repo_manifest.files[].hash`), and charterDeltaExecutor grounds submitted
 * findings against the COMPLETE `files[].path` set (`groundDesignFindings`).
 * WIDEN the projection in the same commit as any producer change that consumes
 * more — the contract test pins the current slice content.
 *
 * Projections take the WHOLE bundle (not just the upstream) because a slice can
 * be cross-artifact: the member-file slice of `repo_manifest` needs the
 * consensus membership from `structure_decomposition` to know which files
 * matter. A membership change therefore moves the slice on BOTH edges — the
 * over-fire direction, which is safe.
 */
import { createHash } from "node:crypto";
import type { ArtifactBundle } from "../io/artifacts.js";
import { stableStringify } from "../../shared/stableStringify.js";
import {
  charterPacketReadSet,
  memberDependencyEdgeLines,
} from "./charterPackets.js";

type SliceProjection = (bundle: ArtifactBundle) => unknown;

/**
 * Sentinel slice hash for a projection that THREW (malformed upstream shape).
 * Never equal to a recorded sha256, so a compare against it reads as
 * slice-changed → stale (fail-safe). The stamping path skips recording it so
 * the edge falls back to the whole-hash compare instead of pinning an error
 * marker.
 */
export const SLICE_PROJECTION_ERROR = "slice-projection-error";

/** `consensus[*].{node_id, members}` — the membership scaffold charters ground on. */
function consensusMembershipSlice(bundle: ArtifactBundle): unknown {
  return (bundle.structure_decomposition?.consensus ?? [])
    .map((node) => ({
      node_id: node.node_id,
      members: [...node.members].sort(),
    }))
    .sort((a, b) => a.node_id.localeCompare(b.node_id));
}

/**
 * The `repo_manifest` surface the charter_register producers consume:
 *
 *  - `files`: `{path → content proxy}` over the charter layer's read-set —
 *    DERIVED from `charterPacketReadSet` (the packet materializer's own
 *    read-set function, `charterPackets.ts`), the single home of "what does
 *    charter extraction read" (design-check resolution-4 constraint 6: the
 *    slice and the packets can never drift). That set is consensus MEMBER
 *    paths (every channel is a projection of member content) plus every
 *    doc-intent path (the stated channel's doc universe). The content proxy is
 *    the manifest hash, falling back to a size marker for oversized files the
 *    intake leaves unhashed (>1 MiB carries only `size_bytes`; `hash ?? ""`
 *    erased a real change signal).
 *  - `paths`: the COMPLETE sorted path list, content-free. The register's
 *    SECOND producer — the delta executor — grounds submitted findings against
 *    the full path set (`groundDesignFindings`: exact-path membership +
 *    basename-unique resolution), and charter assembly grounds every teleology
 *    node's file scope against the repo universe, so an add/delete/rename
 *    anywhere changes what a re-derive would produce even when member∪doc
 *    content is untouched. Paths-only keeps the phantom-staleness win: pure
 *    hash churn on an unchanged path set (the live incident) still never fires
 *    this edge.
 */
function charterReadFileSlice(bundle: ArtifactBundle): unknown {
  const { memberPaths, docPaths } = charterPacketReadSet(bundle);
  const relevant = new Set<string>([...memberPaths, ...docPaths]);
  const files: Record<string, string> = {};
  const paths: string[] = [];
  for (const file of bundle.repo_manifest?.files ?? []) {
    paths.push(file.path);
    if (relevant.has(file.path)) {
      files[file.path] = file.hash ?? `size:${file.size_bytes}`;
    }
  }
  return { files, paths: paths.sort() };
}

/**
 * The edge registry: `downstream → upstream → projection`. ONLY
 * `charter_register.json` (the expensive extraction step, the live incident
 * driver) is registered:
 *
 *  - `charter_clarification` / `systemic_challenge` keep their whole-artifact
 *    `repo_manifest` edges — HEAD trace shows `systemic_challenge` consumes the
 *    total file count and grounds findings against the COMPLETE path set
 *    (aggregateMetricsDigest / designFindingGrounding), so a member slice is
 *    directly refuted there, and clarification's consumption is unverified.
 *    Residual: they still over-stale on unrelated manifest churn (cheap steps;
 *    revisit with a verified consumption trace).
 *  - `intent_checkpoint.json` edges are handled by the intent-equivalence gate
 *    (revision authority via `intent_baseline`), NOT by a slice projection.
 */
/**
 * The `graph_bundle` surface the charter_register consumes: exactly the
 * member-member dependency-edge lines the STRUCTURAL channel's packet embeds —
 * single-sourced from `memberDependencyEdgeLines` (the packet renders the same
 * list), so what the packet shows and what re-stales it can never drift.
 * Analyzer-enrichment churn OUTSIDE the member set (and `node_metrics` /
 * `routes` churn entirely) never re-fires the expensive extraction, while an
 * enrichment that merges a new member-member edge — packet-visible — fires.
 */
function charterGraphEdgeSlice(bundle: ArtifactBundle): unknown {
  return memberDependencyEdgeLines(bundle);
}

export const DEPENDENCY_SLICE_PROJECTIONS: Partial<
  Record<string, Partial<Record<string, SliceProjection>>>
> = {
  "charter_register.json": {
    "structure_decomposition.json": consensusMembershipSlice,
    "repo_manifest.json": charterReadFileSlice,
    "graph_bundle.json": charterGraphEdgeSlice,
  },
};

/** True when a slice projection is registered for the (downstream, upstream) edge. */
export function hasDependencySliceProjection(
  downstream: string,
  upstream: string,
): boolean {
  return Boolean(DEPENDENCY_SLICE_PROJECTIONS[downstream]?.[upstream]);
}

/**
 * The current slice hash for a registered edge, `undefined` when no projection
 * is registered, `SLICE_PROJECTION_ERROR` when the projection threw (compare
 * sites read that as slice-changed; the stamping site skips recording it).
 */
export function computeDependencySliceHash(
  downstream: string,
  upstream: string,
  bundle: ArtifactBundle,
): string | undefined {
  const projection = DEPENDENCY_SLICE_PROJECTIONS[downstream]?.[upstream];
  if (!projection) return undefined;
  try {
    return createHash("sha256")
      .update(stableStringify(projection(bundle)))
      .digest("hex");
  } catch {
    return SLICE_PROJECTION_ERROR;
  }
}

/**
 * Build the `dependency_slices` record to stamp on a LISTED re-derivation of
 * `downstream`: one entry per registered edge whose projection succeeded.
 * Returns `undefined` when nothing is recordable (no registered edges, or every
 * projection errored) so entries without projections stay shape-identical to
 * today's.
 */
export function buildDependencySlices(
  downstream: string,
  dependencyNames: readonly string[],
  bundle: ArtifactBundle,
): Record<string, string> | undefined {
  const slices: Record<string, string> = {};
  for (const upstream of dependencyNames) {
    const hash = computeDependencySliceHash(downstream, upstream, bundle);
    if (hash !== undefined && hash !== SLICE_PROJECTION_ERROR) {
      slices[upstream] = hash;
    }
  }
  return Object.keys(slices).length > 0 ? slices : undefined;
}
