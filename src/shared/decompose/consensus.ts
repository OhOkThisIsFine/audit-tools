// The overlay-and-delta operator — consensus / ensemble decomposition (Phase B;
// design of record spec/conceptual-design-review-design.md §"The one operator").
//
//   decompose(sources, target) → { consensus, contested }
//
// Feed several INDEPENDENTLY-SOURCED views of a target; where they AGREE you have
// a node (a real subsystem boundary), where they DISAGREE you have a finding and a
// hotspot. The views are NEVER reconciled into one truth — the disagreement is the
// product. A node carries two robustness scores:
//   - agreed_across_source: the fraction of the SIGNALLING sources (those that can
//                           speak to the cluster) that place most of its members in
//                           a single right-sized community (best-fit F1 ≥ bar).
//   - stable_across_scale:  the fraction of behavior resolution levels at which that
//                           same best-fit holds — how scale-robust the cohesion is.
// A cluster is consensus when a MAJORITY of its signalling sources vote together;
// low agreement = contested (a hotspot, itself a finding). The score is size-robust:
// it measures how well the cluster FITS a community (precision × recall), skipping
// whole-area buckets, so real N-file subsystems surface — not only 2-file dyads.
//
// PURE + DETERMINISTIC + language-neutral: operates only on abstract partitions of
// string node ids, so the SAME primitive runs at the structure layer (this phase)
// and, in Phase C, at the charter layer (sources = the four charters). No IO.

import type { Partition } from "./modularity.js";

/**
 * One independently-sourced view of the target, contributing a family of
 * partitions over the shared node universe. A multi-resolution behavior source
 * (call/import, co-change, data/state) supplies several partitions (one per
 * resolution); an intent-declared source (directory, docs, comments) typically
 * supplies one.
 */
export interface DecompositionSource {
  /** Stable source id, e.g. `call_import` / `co_change` / `directory`. */
  id: string;
  /**
   * Which decomposition family this source belongs to (design §"two families"):
   * `behavior` = what the system does (coupling / co-change / data-state);
   * `intent` = what humans assert the pieces are (dirs / docs / comments). Only
   * `behavior` partitions feed the scale-stability score.
   */
  family: "behavior" | "intent";
  partitions: Partition[];
}

/** A discovered subsystem candidate — an emergent node, never pre-defined. */
export interface DecomposedNode {
  /** Stable id: the lexicographically smallest member. */
  node_id: string;
  /** Member node ids, lexically sorted. */
  members: string[];
  /** Fraction of signalling sources that best-fit the members together, in [0,1]. */
  agreed_across_source: number;
  /** Fraction of behavior resolution levels at which the best-fit holds, in [0,1]. */
  stable_across_scale: number;
  /** True when source agreement is below the consensus majority. */
  contested: boolean;
}

export interface DecomposeResult {
  target: string;
  /** Nodes high on BOTH scores — confident subsystems. */
  consensus: DecomposedNode[];
  /** Nodes low on EITHER score — contested boundaries (each a hotspot/finding). */
  contested: DecomposedNode[];
}

export interface DecomposeOptions {
  /**
   * Minimum agreed-across-source a pair needs for its members to be unioned into
   * the same candidate node. The co-association edge threshold.
   */
  agreementThreshold?: number;
  /**
   * Per-source best-fit F1 bar. A source "votes together" for a cluster when it
   * places (most of) the cluster inside a single right-sized community with F1
   * (precision × recall of cluster-vs-community) at or above this bar.
   */
  fitThreshold?: number;
  /**
   * Fraction of the *signalling* sources that must vote together for a cluster to
   * be consensus. A source "signals" on a cluster when it contains ≥2 of its
   * members (a source that can't speak to the cluster does not dilute the vote).
   */
  sourceMajority?: number;
  /**
   * A community larger than this fraction of the node universe is a whole-area
   * bucket (directory-depth-1 "src", a coarse-Louvain blob), not cohesion
   * evidence, and is skipped when scoring fit. This is what stops the metric from
   * being gullible to coarse partitions.
   */
  maxCommunityFraction?: number;
}

const DEFAULT_AGREEMENT_THRESHOLD = 0.5;
const DEFAULT_FIT_THRESHOLD = 0.5;
const DEFAULT_SOURCE_MAJORITY = 0.5;
const DEFAULT_MAX_COMMUNITY_FRACTION = 0.2;
/** Cap floor so the community-size gate doesn't collapse on tiny (test) universes. */
const MIN_COMMUNITY_CAP = 50;
/**
 * Consensus needs SEVERAL independently-sourced views to agree (design of record
 * §"The one operator"). At least this many sources must vote the cluster together —
 * a boundary only ONE source draws is not consensus, even if every other source
 * abstains (has no opinion on those files).
 */
const MIN_TOGETHER_SOURCES = 2;

/** Canonical unordered-pair key (`minmax`, a text-safe unit separator that
 * cannot appear in a node id) so (u,v) and (v,u) collide. */
function pairKey(a: string, b: string): string {
  return a.localeCompare(b) <= 0 ? `${a}\u001f${b}` : `${b}\u001f${a}`;
}

function splitPairKey(key: string): [string, string] {
  const idx = key.indexOf("\u001f");
  return [key.slice(0, idx), key.slice(idx + 1)];
}

/** Minimal deterministic union-find over string ids. */
class UnionFind {
  private parent = new Map<string, string>();

  private find(x: string): string {
    let root = this.parent.get(x);
    if (root === undefined) {
      this.parent.set(x, x);
      return x;
    }
    while (root !== this.parent.get(root)) {
      const grand = this.parent.get(root)!;
      this.parent.set(root, this.parent.get(grand)!);
      root = this.parent.get(root)!;
    }
    return root;
  }

  add(x: string): void {
    if (!this.parent.has(x)) this.parent.set(x, x);
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    // Attach the lexically larger root under the smaller so the representative is
    // stable and independent of union order.
    if (ra.localeCompare(rb) < 0) this.parent.set(rb, ra);
    else this.parent.set(ra, rb);
  }

  groups(): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const node of this.parent.keys()) {
      const root = this.find(node);
      const list = out.get(root);
      if (list) list.push(node);
      else out.set(root, [node]);
    }
    for (const list of out.values()) list.sort((a, b) => a.localeCompare(b));
    return out;
  }
}

/**
 * Per-pair co-membership counts over a set of partitions. Only pairs that are
 * co-located in at least one partition get an entry (so the result is bounded by
 * Σ|community|² rather than |universe|²). Returns the counts + partition total.
 */
function coMembershipCounts(
  partitions: Partition[],
): { counts: Map<string, number>; total: number } {
  const counts = new Map<string, number>();
  for (const partition of partitions) {
    // Group nodes by community for this partition.
    const communities = new Map<string, string[]>();
    for (const [node, comm] of partition) {
      const list = communities.get(comm);
      if (list) list.push(node);
      else communities.set(comm, [node]);
    }
    for (const members of communities.values()) {
      if (members.length < 2) continue;
      const sorted = [...members].sort((a, b) => a.localeCompare(b));
      for (let i = 0; i < sorted.length; i++) {
        for (let j = i + 1; j < sorted.length; j++) {
          const key = pairKey(sorted[i]!, sorted[j]!);
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
      }
    }
  }
  return { counts, total: partitions.length };
}

/**
 * Cluster nodes that co-locate in at least `minFraction` of the given partitions
 * (a consensus over the partition family). Returns member groups of size ≥ 2,
 * lexically sorted, in a deterministic order. Shared by {@link decompose} and by
 * the non-co-localization finding detectors, which need behavior-only and
 * intent-only cluster views separately.
 */
export function clustersFromPartitions(
  partitions: Partition[],
  minFraction = DEFAULT_AGREEMENT_THRESHOLD,
): string[][] {
  const { counts, total } = coMembershipCounts(partitions);
  if (total === 0) return [];
  const uf = new UnionFind();
  for (const [key, count] of counts) {
    if (count / total + 1e-12 >= minFraction) {
      const [a, b] = splitPairKey(key);
      uf.add(a);
      uf.add(b);
      uf.union(a, b);
    }
  }
  const groups = [...uf.groups().values()].filter((g) => g.length >= 2);
  groups.sort((a, b) => a[0]!.localeCompare(b[0]!));
  return groups;
}

/**
 * The overlay-and-delta operator. Builds a co-association over all sources,
 * unions strongly-agreed pairs into candidate nodes, scores each node on the two
 * orthogonal robustness axes, and splits confident (consensus) from contested.
 */
export function decompose(
  sources: DecompositionSource[],
  target: string,
  options: DecomposeOptions = {},
): DecomposeResult {
  const agreementThreshold =
    options.agreementThreshold ?? DEFAULT_AGREEMENT_THRESHOLD;
  const fitThreshold = options.fitThreshold ?? DEFAULT_FIT_THRESHOLD;
  const sourceMajority = options.sourceMajority ?? DEFAULT_SOURCE_MAJORITY;
  const maxCommunityFraction =
    options.maxCommunityFraction ?? DEFAULT_MAX_COMMUNITY_FRACTION;

  // Candidate formation (unchanged): a per-PAIR co-association over sources, used
  // ONLY to decide which files join the same candidate cluster. Scoring below does
  // NOT use this pair mean — the old size-hostile mean-over-all-pairs is gone.
  const agreedSum = new Map<string, number>();
  const activeSources = sources.filter((s) => s.partitions.length > 0);
  for (const source of activeSources) {
    const { counts, total } = coMembershipCounts(source.partitions);
    for (const [key, count] of counts) {
      agreedSum.set(key, (agreedSum.get(key) ?? 0) + count / total);
    }
  }
  const numSources = activeSources.length;
  const agreedOf = (key: string): number =>
    numSources === 0 ? 0 : (agreedSum.get(key) ?? 0) / numSources;

  const uf = new UnionFind();
  for (const key of agreedSum.keys()) {
    if (agreedOf(key) + 1e-12 >= agreementThreshold) {
      const [a, b] = splitPairKey(key);
      uf.add(a);
      uf.add(b);
      uf.union(a, b);
    }
  }

  // Scoring — size-robust cohesion (design of record §"REVISION after adversarial
  // review"). A cluster is a real subsystem when a MAJORITY of the sources that can
  // speak to it each place (most of) its members inside a SINGLE, RIGHT-SIZED
  // community. Per source we take the best-fit F1 (precision × recall of
  // cluster-vs-community) at that source's most favourable resolution. A community
  // larger than maxCommunityFraction of the universe is a whole-area bucket
  // (directory-depth-1 "src", a coarse-Louvain blob), NOT cohesion evidence, so it
  // is skipped — this is what keeps the metric from being gullible to coarse
  // partitions the way a coverage-only score would be. The old mean-over-all-pairs
  // was monotonically hostile to size (only 2-file dyads could clear it).
  const universe = new Set<string>();
  const perSource = activeSources.map((source) => {
    const partitions = source.partitions.map((map) => {
      const commSize = new Map<string, number>();
      for (const [node, comm] of map) {
        universe.add(node);
        commSize.set(comm, (commSize.get(comm) ?? 0) + 1);
      }
      return { map, commSize };
    });
    return { family: source.family, partitions };
  });
  const maxCommSize = Math.max(
    MIN_COMMUNITY_CAP,
    Math.floor(maxCommunityFraction * universe.size),
  );

  // Per (source-partition, cluster): the best-fit F1 against a single right-sized
  // community, and topHit = the largest single-community overlap (the source's raw
  // "grouping opinion" on the cluster, ignoring the cap/majority gates).
  const fitInPartition = (
    memberSet: Set<string>,
    entry: { map: Partition; commSize: Map<string, number> },
  ): { f1: number; topHit: number } => {
    const tally = new Map<string, number>();
    for (const node of memberSet) {
      const comm = entry.map.get(node);
      if (comm !== undefined) tally.set(comm, (tally.get(comm) ?? 0) + 1);
    }
    let f1 = 0;
    let topHit = 0;
    for (const [comm, hit] of tally) {
      if (hit > topHit) topHit = hit;
      // The community must hold a STRICT MAJORITY of the cluster to count as
      // "holding it together" — otherwise a source that splits the members into
      // singletons would score a spurious F1 (a lone member gives precision 1,
      // recall 1/n) and vote together for a cluster it actually tore apart.
      if (hit * 2 <= memberSet.size) continue;
      const size = entry.commSize.get(comm)!;
      if (size > maxCommSize) continue; // whole-area bucket — not cohesion
      const recall = hit / memberSet.size;
      const precision = hit / size;
      const val =
        precision + recall === 0
          ? 0
          : (2 * precision * recall) / (precision + recall);
      if (val > f1) f1 = val;
    }
    return { f1, topHit };
  };

  const consensus: DecomposedNode[] = [];
  const contested: DecomposedNode[] = [];
  for (const members of uf.groups().values()) {
    if (members.length < 2) continue;
    const memberSet = new Set(members);
    let signalCount = 0;
    let togetherCount = 0;
    let behaviorPartitionsSeen = 0;
    let behaviorPartitionsFit = 0;
    for (const src of perSource) {
      let bestF1 = 0;
      let sourceTopHit = 0;
      for (const entry of src.partitions) {
        const { f1, topHit } = fitInPartition(memberSet, entry);
        if (f1 > bestF1) bestF1 = f1;
        if (topHit > sourceTopHit) sourceTopHit = topHit;
        if (src.family === "behavior") {
          behaviorPartitionsSeen += 1;
          if (f1 + 1e-12 >= fitThreshold) behaviorPartitionsFit += 1;
        }
      }
      // A source ABSTAINS (excluded from the vote) when it never groups ≥2 of the
      // cluster's members together — it has no opinion on this cluster, so counting
      // it as a "no" would dilute genuine agreement among the sources that DO model
      // these files. A source that groups members into *different* communities has
      // an opinion (topHit ≥ 2) and correctly votes "no" when no majority holds.
      if (sourceTopHit < 2) continue;
      signalCount += 1;
      if (bestF1 + 1e-12 >= fitThreshold) togetherCount += 1;
    }
    const sourceAgreement = signalCount === 0 ? 0 : togetherCount / signalCount;
    const stableAcrossScale =
      behaviorPartitionsSeen === 0
        ? 0
        : behaviorPartitionsFit / behaviorPartitionsSeen;
    const isConsensus =
      togetherCount >= MIN_TOGETHER_SOURCES &&
      sourceAgreement + 1e-12 >= sourceMajority;
    // Drop pure union-find artifacts: a cluster no source holds together, or an
    // oversized non-consensus component (a transitive blob like the 449-file
    // .gitignore mega-cluster), is noise — neither a subsystem nor a useful hotspot.
    if (!isConsensus && (togetherCount === 0 || members.length > maxCommSize)) {
      continue;
    }
    const node: DecomposedNode = {
      node_id: members[0]!,
      members,
      agreed_across_source: round(sourceAgreement),
      stable_across_scale: round(stableAcrossScale),
      contested: !isConsensus,
    };
    if (isConsensus) consensus.push(node);
    else contested.push(node);
  }

  const byId = (a: DecomposedNode, b: DecomposedNode) =>
    a.node_id.localeCompare(b.node_id);
  consensus.sort(byId);
  contested.sort(byId);
  return { target, consensus, contested };
}

/** Round a score to 4 decimals so persisted artifacts don't churn on float noise. */
function round(value: number): number {
  return Math.round(value * 1e4) / 1e4;
}
