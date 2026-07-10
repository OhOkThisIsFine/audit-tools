import { describe, it, expect } from "vitest";
import {
  louvain,
  resolutionSweep,
  DEFAULT_RESOLUTIONS,
  decompose,
  clustersFromPartitions,
} from "audit-tools/shared";

/** Build a WeightedGraph from a compact edge list [a,b,w?]. */
function graph(nodes, edgeList) {
  return {
    nodes,
    edges: edgeList.map(([a, b, w]) => ({ a, b, weight: w ?? 1 })),
  };
}

/** Map a Partition to a canonical `member → community-representative` object. */
function partitionObject(partition) {
  return Object.fromEntries([...partition.entries()].sort());
}

/** Group members by their community for readable assertions. */
function communities(partition) {
  const byComm = new Map();
  for (const [node, comm] of partition) {
    const list = byComm.get(comm) ?? [];
    list.push(node);
    byComm.set(comm, list);
  }
  return [...byComm.values()]
    .map((g) => g.sort())
    .sort((a, b) => a[0].localeCompare(b[0]));
}

describe("modularity — louvain", () => {
  it("separates two cliques joined by a single weak bridge", () => {
    // Two triangles {a,b,c} and {x,y,z}, one weak c-x bridge.
    const g = graph(
      ["a", "b", "c", "x", "y", "z"],
      [
        ["a", "b"],
        ["b", "c"],
        ["a", "c"],
        ["x", "y"],
        ["y", "z"],
        ["x", "z"],
        ["c", "x", 0.1],
      ],
    );
    const parts = communities(louvain(g, 1));
    expect(parts).toEqual([
      ["a", "b", "c"],
      ["x", "y", "z"],
    ]);
  });

  it("is deterministic — identical input yields identical partition", () => {
    const g = graph(
      ["a", "b", "c", "x", "y", "z"],
      [
        ["a", "b"],
        ["b", "c"],
        ["a", "c"],
        ["x", "y"],
        ["y", "z"],
        ["x", "z"],
        ["c", "x", 0.1],
      ],
    );
    expect(partitionObject(louvain(g, 1))).toEqual(
      partitionObject(louvain(g, 1)),
    );
  });

  it("uses the lexicographically smallest member as the community id", () => {
    const g = graph(
      ["b", "c", "a"],
      [
        ["a", "b"],
        ["b", "c"],
        ["a", "c"],
      ],
    );
    const part = louvain(g, 1);
    expect(new Set(part.values())).toEqual(new Set(["a"]));
  });

  it("returns singletons for an edgeless graph", () => {
    const g = graph(["a", "b", "c"], []);
    expect(communities(louvain(g, 1))).toEqual([["a"], ["b"], ["c"]]);
  });

  it("empty graph → empty partition", () => {
    expect(louvain(graph([], []), 1).size).toBe(0);
  });

  it("finer resolution never yields fewer communities than coarser", () => {
    // A chain of 4 triangles lightly bridged: coarse γ merges, fine γ splits.
    const g = graph(
      ["a1", "a2", "a3", "b1", "b2", "b3", "c1", "c2", "c3", "d1", "d2", "d3"],
      [
        ["a1", "a2"], ["a2", "a3"], ["a1", "a3"],
        ["b1", "b2"], ["b2", "b3"], ["b1", "b3"],
        ["c1", "c2"], ["c2", "c3"], ["c1", "c3"],
        ["d1", "d2"], ["d2", "d3"], ["d1", "d3"],
        ["a3", "b1", 0.3], ["b3", "c1", 0.3], ["c3", "d1", 0.3],
      ],
    );
    const coarse = communities(louvain(g, 0.25)).length;
    const fine = communities(louvain(g, 4)).length;
    expect(fine).toBeGreaterThanOrEqual(coarse);
  });
});

describe("resolutionSweep", () => {
  it("returns one partition per resolution, in ladder order", () => {
    const g = graph(
      ["a", "b", "x", "y"],
      [
        ["a", "b"],
        ["x", "y"],
      ],
    );
    const sweep = resolutionSweep(g);
    expect(sweep).toHaveLength(DEFAULT_RESOLUTIONS.length);
    for (const part of sweep) expect(part.size).toBe(4);
  });
});

describe("clustersFromPartitions", () => {
  it("clusters pairs co-located in at least the given fraction of partitions", () => {
    const p1 = new Map([
      ["a", "a"],
      ["b", "a"],
      ["c", "c"],
    ]);
    const p2 = new Map([
      ["a", "a"],
      ["b", "a"],
      ["c", "c"],
    ]);
    // a,b together in 2/2 partitions → clustered; c alone.
    expect(clustersFromPartitions([p1, p2], 0.5)).toEqual([["a", "b"]]);
  });

  it("drops pairs below the fraction threshold", () => {
    const p1 = new Map([
      ["a", "a"],
      ["b", "a"],
    ]);
    const p2 = new Map([
      ["a", "a"],
      ["b", "b"],
    ]);
    // a,b together in only 1/2 → below 0.75 → no cluster.
    expect(clustersFromPartitions([p1, p2], 0.75)).toEqual([]);
  });

  it("empty input → no clusters", () => {
    expect(clustersFromPartitions([], 0.5)).toEqual([]);
  });
});

describe("decompose — consensus vs contested", () => {
  it("a boundary all sources and scales agree on is consensus", () => {
    const stable = new Map([
      ["a", "a"],
      ["b", "a"],
      ["c", "a"],
    ]);
    const sources = [
      { id: "call_import", family: "behavior", partitions: [stable, stable] },
      { id: "co_change", family: "behavior", partitions: [stable] },
      { id: "directory", family: "intent", partitions: [stable] },
    ];
    const result = decompose(sources, "structure");
    expect(result.target).toBe("structure");
    expect(result.consensus).toHaveLength(1);
    expect(result.consensus[0].members).toEqual(["a", "b", "c"]);
    expect(result.consensus[0].agreed_across_source).toBe(1);
    expect(result.consensus[0].stable_across_scale).toBe(1);
    expect(result.consensus[0].contested).toBe(false);
    expect(result.contested).toEqual([]);
  });

  it("a boundary only one source draws is contested (low agreement)", () => {
    const grouped = new Map([
      ["a", "a"],
      ["b", "a"],
    ]);
    const split = new Map([
      ["a", "a"],
      ["b", "b"],
    ]);
    const sources = [
      { id: "call_import", family: "behavior", partitions: [grouped] },
      { id: "co_change", family: "behavior", partitions: [split] },
      { id: "directory", family: "intent", partitions: [split] },
    ];
    const result = decompose(sources, "structure", { agreementThreshold: 0.3 });
    // Only call_import has a grouping opinion; co_change + directory split a,b into
    // singletons → they ABSTAIN. A single signalling source is not "several agree",
    // so the cluster is contested (below the ≥2-sources-together floor).
    const all = [...result.consensus, ...result.contested];
    expect(all).toHaveLength(1);
    expect(result.consensus).toEqual([]);
    expect(result.contested[0].contested).toBe(true);
  });

  it("a cluster both sources hold together at its natural scale is consensus", () => {
    // Two behavior sources place a,b together at one resolution, apart at another.
    // Under the size-robust metric a source votes together when it holds the cluster
    // at its BEST resolution (max-over-scales); scale-instability is recorded as an
    // informational stable_across_scale, not a gate. (The old two-axis metric marked
    // this contested; coarse-gullibility is now handled by the community-size cap,
    // not by requiring cross-scale stability — which would re-introduce the very
    // size-hostility this metric fixes.)
    const together = new Map([
      ["a", "a"],
      ["b", "a"],
    ]);
    const apart = new Map([
      ["a", "a"],
      ["b", "b"],
    ]);
    const sources = [
      { id: "call_import", family: "behavior", partitions: [together, apart] },
      { id: "co_change", family: "behavior", partitions: [together, apart] },
    ];
    const result = decompose(sources, "structure", { agreementThreshold: 0.5 });
    expect(result.consensus).toHaveLength(1);
    // Both sources vote together (2/2) → consensus; fit holds in 1 of 2 behavior
    // scales per source → stable_across_scale = 0.5 (informational).
    expect(result.consensus[0].agreed_across_source).toBe(1);
    expect(result.consensus[0].stable_across_scale).toBeCloseTo(0.5, 5);
    expect(result.consensus[0].contested).toBe(false);
  });

  it("disagreeing sources (members grouped apart) vote no, not abstain", () => {
    // {a,b,c,d}: call_import holds all four together (votes yes), but co_change and
    // directory each group them into DIFFERENT pairs — they have an opinion
    // (topHit 2) so they vote NO (no majority community), they do NOT abstain. Only
    // 1 of 3 signalling sources votes together → below the ≥2 floor → contested.
    const allFour = new Map([
      ["a", "g"], ["b", "g"], ["c", "g"], ["d", "g"],
    ]);
    const pairsAB = new Map([
      ["a", "x"], ["b", "x"], ["c", "y"], ["d", "y"],
    ]);
    const pairsAC = new Map([
      ["a", "p"], ["c", "p"], ["b", "q"], ["d", "q"],
    ]);
    const sources = [
      { id: "call_import", family: "behavior", partitions: [allFour] },
      { id: "co_change", family: "behavior", partitions: [pairsAB] },
      { id: "directory", family: "intent", partitions: [pairsAC] },
    ];
    const result = decompose(sources, "structure", { agreementThreshold: 0.3 });
    expect(result.consensus).toEqual([]);
    expect(result.contested).toHaveLength(1);
    expect(result.contested[0].contested).toBe(true);
  });

  it("size-robust: a real N-file subsystem is consensus even with loose internal pairs", () => {
    // Oracle for the fix: a 6-file subsystem where the directory + a coarse behavior
    // view hold all 6 together, while a finer behavior view splits it into two
    // 3-cliques. The OLD mean-over-all-pairs score collapsed below 0.6 on the cross-
    // clique pairs and dumped this to contested (the bug). The size-robust metric
    // credits the natural-resolution community → consensus.
    const all6 = new Map([
      ["m1", "g"], ["m2", "g"], ["m3", "g"],
      ["m4", "g"], ["m5", "g"], ["m6", "g"],
    ]);
    const twoCliques = new Map([
      ["m1", "x"], ["m2", "x"], ["m3", "x"],
      ["m4", "y"], ["m5", "y"], ["m6", "y"],
    ]);
    const sources = [
      { id: "directory", family: "intent", partitions: [all6] },
      { id: "call_import", family: "behavior", partitions: [all6, twoCliques] },
      { id: "co_change", family: "behavior", partitions: [all6, twoCliques] },
    ];
    const result = decompose(sources, "structure", { agreementThreshold: 0.5 });
    expect(result.consensus).toHaveLength(1);
    expect(result.consensus[0].members).toHaveLength(6);
  });

  it("size-robust: an oversized transitive blob is dropped, never promoted", () => {
    // Oracle negative: a 40-file transitive chain that no source holds a majority of
    // in one small community (each source scatters it). It must NOT be consensus, and
    // as an oversized non-consensus artifact it is dropped entirely (not even
    // contested noise) — the .gitignore-mega-cluster class.
    // Two shifted pairings chain all 40 via union-find but leave every community a
    // size-2 pair — so no single community holds a majority of the blob.
    const chainA = new Map(); // pairs (0,1),(2,3),…,(38,39)
    for (let i = 0; i < 40; i++) chainA.set(`f${i}`, `a${Math.floor(i / 2)}`);
    const chainB = new Map(); // pairs (1,2),(3,4),…,(37,38); f0 and f39 singletons
    chainB.set("f0", "b0");
    chainB.set("f39", "b39");
    for (let i = 1; i < 39; i += 2) {
      chainB.set(`f${i}`, `bpair${i}`);
      chainB.set(`f${i + 1}`, `bpair${i}`);
    }
    const sources = [
      { id: "call_import", family: "behavior", partitions: [chainA] },
      { id: "co_change", family: "behavior", partitions: [chainB] },
    ];
    const result = decompose(sources, "structure", {
      agreementThreshold: 0.5,
      maxCommunityFraction: 0.2, // cap = max(50, 8) = 50; blob 40 < 50 but no comm holds a majority
    });
    // No community holds a majority of the 40-node blob → no source votes together →
    // dropped. Nothing promoted; the blob does not appear as consensus.
    expect(result.consensus).toEqual([]);
  });

  it("no sources → empty result", () => {
    expect(decompose([], "structure")).toEqual({
      target: "structure",
      consensus: [],
      contested: [],
    });
  });
});
