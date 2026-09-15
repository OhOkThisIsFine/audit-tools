// Contract tests for the five-step charter layer's deterministic half
// (src/shared/decompose/charterLayer.ts; spec §"The estimator charters").
import { test, expect, describe } from "vitest";
import {
  CharterSubmissionSchema,
  CharterComparisonSubmissionSchema,
  CharterFidelitySubmissionSchema,
  assembleLaneGraph,
  proposeCorrespondences,
  assembleComparison,
  precheckFidelity,
  applyFidelity,
  differenceFindings,
  routeDifference,
  provenancePath,
} from "../../src/shared/decompose/charterLayer.js";
import type { CharterLaneGraph, CharterProvenance } from "../../src/shared/types/charter.js";

const universe = new Set(["src/a.ts", "src/b.ts", "docs/goals.md"]);
const doc = (ref: string, quote = "q"): CharterProvenance => ({ kind: "doc", ref, quote });
const code = (ref: string, quote = "q"): CharterProvenance => ({ kind: "code", ref, quote });

function lane(kind: "stated" | "structural" | "revealed", overrides: Partial<Parameters<typeof assembleLaneGraph>[0]> = {}) {
  return assembleLaneGraph(
    CharterSubmissionSchema.parse({
      kind,
      nodes: [
        { node_id: "top", purpose: "keep audits trustworthy", provenance: [code("src/a.ts#Top")], confidence: "high", files: ["src/a.ts"] },
        { node_id: "leaf", purpose: "share quota fairly", provenance: [code("src/b.ts#Leaf")], confidence: "medium", files: ["src/b.ts"] },
      ],
      edges: [{ from: "leaf", to: "top", provenance: [code("src/b.ts:3")] }],
      ...overrides,
    }),
    { universe },
  );
}

describe("step 1 — assembleLaneGraph", () => {
  test("derives premise_height from the edges: a root is 0, its child 1", () => {
    const { graph, validation_issues } = lane("revealed");
    expect(validation_issues).toEqual([]);
    expect(graph.nodes.find((n) => n.node_id === "top")?.premise_height).toBe(0);
    expect(graph.nodes.find((n) => n.node_id === "leaf")?.premise_height).toBe(1);
  });

  test("a Stated node may carry provenance only (no files)", () => {
    const { graph } = assembleLaneGraph(
      CharterSubmissionSchema.parse({
        kind: "stated",
        nodes: [{ node_id: "g", purpose: "a goal the docs state", provenance: [doc("docs/goals.md:2")], confidence: "high" }],
      }),
      { universe },
    );
    expect(graph.nodes[0]?.files).toBeUndefined();
  });

  test("a cycle refuses every edge among its nodes and names them", () => {
    const { graph, validation_issues } = lane("structural", {
      edges: [
        { from: "leaf", to: "top", provenance: [] },
        { from: "top", to: "leaf", provenance: [] },
      ],
    });
    expect(graph.edges).toEqual([]);
    expect(validation_issues.join("\n")).toMatch(/cycle through "leaf", "top"/);
  });

  test("a file outside the universe is dropped from the scope with an issue; an all-unknown scope becomes provenance-only", () => {
    const { graph, validation_issues } = assembleLaneGraph(
      CharterSubmissionSchema.parse({
        kind: "revealed",
        nodes: [{ node_id: "x", purpose: "p", files: ["nope.ts"], provenance: [], confidence: "low" }],
      }),
      { universe },
    );
    expect(graph.nodes[0]?.files).toBeUndefined();
    expect(validation_issues[0]).toMatch(/outside the repo universe/);
  });

  test("an edge naming an unknown node is dropped, a duplicate node keeps the first", () => {
    const { graph, validation_issues } = lane("revealed", {
      nodes: [
        { node_id: "top", purpose: "first", provenance: [], confidence: "high" },
        { node_id: "top", purpose: "second", provenance: [], confidence: "high" },
      ],
      edges: [{ from: "top", to: "ghost", provenance: [] }],
    });
    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0]?.purpose).toBe("first");
    expect(graph.edges).toEqual([]);
    expect(validation_issues).toHaveLength(2);
  });
});

describe("step 2 — proposeCorrespondences", () => {
  test("file overlap and a provenance cross-ref each propose one candidate; ids are content-keyed", () => {
    const revealed = lane("revealed").graph;
    const stated = assembleLaneGraph(
      CharterSubmissionSchema.parse({
        kind: "stated",
        nodes: [{ node_id: "g", purpose: "docs say", provenance: [doc("src/a.ts#Top")], confidence: "high" }],
      }),
      { universe },
    ).graph;
    const structural = lane("structural").graph;
    const candidates = proposeCorrespondences([revealed, stated, structural]);
    // revealed↔structural: top/top and leaf/leaf share a file (2 overlaps);
    // stated g cites src/a.ts#Top, which both code lanes' `top` scope holds (2 cross-refs).
    const bases = candidates.map((c) => c.basis).sort();
    expect(bases).toEqual(["cross_ref", "cross_ref", "file_overlap", "file_overlap"]);
    const again = proposeCorrespondences([structural, stated, revealed]);
    expect(again.map((c) => c.candidate_id)).toEqual(candidates.map((c) => c.candidate_id));
  });

  test("provenancePath strips a symbol or a line suffix", () => {
    expect(provenancePath("src/a.ts#Top")).toBe("src/a.ts");
    expect(provenancePath("docs/goals.md:12")).toBe("docs/goals.md");
    expect(provenancePath("src/a.ts")).toBe("src/a.ts");
  });
});

function threeLanes(): CharterLaneGraph[] {
  const revealed = lane("revealed").graph;
  const structural = lane("structural").graph;
  const stated = assembleLaneGraph(
    CharterSubmissionSchema.parse({
      kind: "stated",
      nodes: [{ node_id: "g", purpose: "docs say SSO is planned", provenance: [doc("docs/goals.md:2", "SSO planned")], confidence: "high", files: ["src/a.ts"] }],
    }),
    { universe },
  ).graph;
  return [stated, structural, revealed];
}

describe("step 3 — assembleComparison", () => {
  const graphs = threeLanes();
  const candidates = proposeCorrespondences(graphs);

  test("an empty submission must affirm no_correspondences", () => {
    expect(CharterComparisonSubmissionSchema.safeParse({}).success).toBe(false);
    expect(CharterComparisonSubmissionSchema.safeParse({ no_correspondences: true }).success).toBe(true);
  });

  test("a confirmed candidate becomes a tool-basis correspondence; an n-ary difference is routed and typed", () => {
    const cand = candidates.find((c) => c.members.every((m) => m.kind !== "structural"))!;
    const submission = CharterComparisonSubmissionSchema.parse({
      correspondences: [
        { candidate_id: cand.candidate_id, verdict: "widen", members: [
          { kind: "stated", node_ids: ["g"] }, { kind: "structural", node_ids: ["top"] }, { kind: "revealed", node_ids: ["top"] },
        ] },
      ],
      differences: [
        {
          correspondence: cand.candidate_id,
          dimension: "standing",
          relation: "incompatible",
          split: { kind: "two_against_one", odd: "stated" },
          accounts: [
            { kind: "stated", claim: "planned", provenance: [doc("docs/goals.md:2", "SSO planned")] },
            { kind: "structural", claim: "shipped module", provenance: [code("src/a.ts#Top")] },
            { kind: "revealed", claim: "wired", provenance: [code("src/a.ts#Top")] },
          ],
          gap: "the roadmap calls planned what the code ships",
        },
      ],
    });
    const out = assembleComparison(submission, { candidates, graphs, universe });
    expect(out.validation_issues).toEqual([]);
    expect(out.correspondences[0]?.basis).toBe("tool");
    expect(out.correspondences[0]?.members).toHaveLength(3);
    const d = out.differences[0]!;
    expect(d.routed_to).toBe("clarification");
    expect(d.finding_candidate).toBe(true);
    expect(d.accounts.map((a) => a.kind)).toEqual(["revealed", "stated", "structural"]);
  });

  test("a host-added correspondence needs two checkable refs on different sides", () => {
    const submission = CharterComparisonSubmissionSchema.parse({
      correspondences: [
        { verdict: "confirm", members: [{ kind: "stated", node_ids: ["g"] }, { kind: "revealed", node_ids: ["leaf"] }], evidence: [doc("docs/goals.md:2")] },
      ],
    });
    const out = assembleComparison(submission, { candidates, graphs, universe });
    expect(out.correspondences).toEqual([]);
    expect(out.validation_issues[0]).toMatch(/fewer than two checkable evidence refs/);
  });

  test("incompatible without a split, a split on complementary, and three_way on two lanes are each dropped", () => {
    const cand = candidates[0]!;
    const base = { correspondence: cand.candidate_id, dimension: "purpose", accounts: [
      { kind: cand.members[0]!.kind, claim: "a", provenance: [] }, { kind: cand.members[1]!.kind, claim: "b", provenance: [] },
    ], gap: "g" };
    const submission = CharterComparisonSubmissionSchema.parse({
      correspondences: [{ candidate_id: cand.candidate_id, verdict: "confirm", members: cand.members }],
      differences: [
        { ...base, relation: "incompatible" },
        { ...base, relation: "complementary", split: { kind: "three_way" } },
        { ...base, relation: "incompatible", split: { kind: "three_way" } },
      ],
    });
    const out = assembleComparison(submission, { candidates, graphs, universe });
    expect(out.differences).toEqual([]);
    expect(out.validation_issues).toHaveLength(3);
  });
});

describe("step 5 — routeDifference (the fixed table)", () => {
  test("Stated-odd purpose is doc rot for the remediator; three_way is always a clarification", () => {
    expect(routeDifference({ dimension: "purpose", relation: "incompatible", split: { kind: "two_against_one", odd: "stated" } }).routed_to).toBe("remediator");
    expect(routeDifference({ dimension: "purpose", relation: "incompatible", split: { kind: "three_way" } }).routed_to).toBe("clarification");
    expect(routeDifference({ dimension: "responsibility", relation: "incompatible", split: { kind: "two_against_one", odd: "revealed" } }).routed_to).toBe("clarification");
  });
  test("complementary routes nowhere unless it is a covered-channel presence gap", () => {
    expect(routeDifference({ dimension: "scope", relation: "complementary" }).routed_to).toBe("none");
    expect(routeDifference({ dimension: "presence", relation: "complementary", covered_channel_gap: true, silent: "stated" }).routed_to).toBe("remediator");
  });
});

describe("step 4 — fidelity", () => {
  const graphs = threeLanes();
  const candidates = proposeCorrespondences(graphs);
  const cand = candidates.find((c) => c.members.some((m) => m.kind === "stated"))!;
  const out = assembleComparison(
    CharterComparisonSubmissionSchema.parse({
      correspondences: [{ candidate_id: cand.candidate_id, verdict: "confirm", members: cand.members }],
      differences: [
        {
          correspondence: cand.candidate_id, dimension: "standing", relation: "incompatible",
          split: { kind: "two_against_one", odd: "stated" },
          accounts: cand.members.map((m) => ({ kind: m.kind, claim: `${m.kind} claim`, provenance: [m.kind === "stated" ? doc("docs/goals.md:2", "SSO planned") : code("src/a.ts#Top", "class Top")] })),
          gap: "planned vs shipped",
        },
        {
          correspondence: cand.candidate_id, dimension: "scope", relation: "incompatible",
          split: { kind: "two_against_one", odd: "stated" },
          accounts: cand.members.map((m) => ({ kind: m.kind, claim: `${m.kind} scope`, provenance: [code("src/a.ts#Top", "missing quote")] })),
          gap: "admins vs everyone",
        },
      ],
    }),
    { candidates, graphs, universe },
  );

  test("the pre-check settles a missing quote as unverifiable and leaves the rest to the lane", () => {
    const pre = precheckFidelity(out.differences, (p) => p.quote !== "missing quote");
    const settled = pre.differences.filter((d) => d.fidelity?.decided_by === "tool");
    expect(settled).toHaveLength(1);
    expect(settled[0]?.fidelity?.verdict).toBe("unverifiable");
    expect(pre.pendingLane).toHaveLength(1);
  });

  test("a lane verdict stamps; an unknown id and a tool-settled id are issues; only supported records become findings", () => {
    const pre = precheckFidelity(out.differences, (p) => p.quote !== "missing quote");
    const pending = pre.pendingLane[0]!;
    const settledId = pre.differences.find((d) => d.fidelity?.decided_by === "tool")!.difference_id;
    const applied = applyFidelity(
      pre.differences,
      CharterFidelitySubmissionSchema.parse({
        verdicts: [
          { difference_id: pending, verdict: "supported", rationale: "both sources say so" },
          { difference_id: settledId, verdict: "supported", rationale: "ignored" },
          { difference_id: "diff-nope", verdict: "unverifiable", rationale: "?" },
        ],
      }),
    );
    expect(applied.validation_issues).toHaveLength(2);
    expect(applied.still_pending).toEqual([]);
    const findings = differenceFindings(applied.differences, out.correspondences, graphs);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.id).toBe(pending);
    expect(findings[0]?.category).toBe("charter_difference:standing");
    expect(findings[0]?.affected_files.map((f) => f.path)).toEqual(["src/a.ts"]);
  });

  test("an interpretation verdict must name the over-read side", () => {
    expect(CharterFidelitySubmissionSchema.safeParse({ verdicts: [{ difference_id: "d", verdict: "interpretation", rationale: "r" }] }).success).toBe(false);
  });
});
