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
    // a,b agreed by 1/3 sources → below the confident bar → contested.
    const all = [...result.consensus, ...result.contested];
    expect(all).toHaveLength(1);
    expect(result.consensus).toEqual([]);
    expect(result.contested[0].contested).toBe(true);
    expect(result.contested[0].agreed_across_source).toBeLessThan(0.6);
  });

  it("behavior-agreed but scale-unstable boundary is contested", () => {
    // Two behavior sources place a,b together, but only in half their scales.
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
    const all = [...result.consensus, ...result.contested];
    expect(all).toHaveLength(1);
    // agreed = 0.5 (each source co-locates in 1/2 its partitions) but stable = 0.5.
    expect(result.contested[0].stable_across_scale).toBeCloseTo(0.5, 5);
    expect(result.contested[0].contested).toBe(true);
  });

  it("no sources → empty result", () => {
    expect(decompose([], "structure")).toEqual({
      target: "structure",
      consensus: [],
      contested: [],
    });
  });
});
