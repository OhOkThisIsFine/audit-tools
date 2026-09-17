import { test, expect, describe } from "vitest";
import {
  GoalGraphSchema,
  CharterSchema,
  CharterDifferenceSchema,
} from "../../src/shared/types/charter.js";
import { IntentCheckpointSchema } from "../../src/shared/types/intentCheckpoint.js";

describe("GoalGraphSchema", () => {
  test("accepts a multi-parent DAG (a node serving two parents)", () => {
    const parsed = GoalGraphSchema.parse({
      nodes: [
        { node_id: "telos", premise_height: 0, statement: "the top goal" },
        { node_id: "a", premise_height: 1, statement: "goal a" },
        { node_id: "b", premise_height: 1, statement: "goal b" },
        { node_id: "leaf", premise_height: 2, statement: "a mechanism" },
      ],
      edges: [
        { from: "a", to: "telos" },
        { from: "b", to: "telos" },
        // leaf serves BOTH a and b — DAG, not a tree
        { from: "leaf", to: "a" },
        { from: "leaf", to: "b" },
      ],
    });
    expect(parsed.edges).toHaveLength(4);
  });

  test("strict: rejects an unknown key on a goal node", () => {
    expect(() =>
      GoalGraphSchema.parse({
        nodes: [
          { node_id: "x", premise_height: 0, statement: "s", level: "L0" },
        ],
        edges: [],
      }),
    ).toThrow();
  });

  test("rejects a negative premise_height", () => {
    expect(() =>
      GoalGraphSchema.parse({
        nodes: [{ node_id: "x", premise_height: -1, statement: "s" }],
        edges: [],
      }),
    ).toThrow();
  });
});

describe("CharterSchema", () => {
  test("round-trips a `true` nomination with empty provenance", () => {
    const c = {
      charter_id: "t",
      kind: "true",
      purpose: "you want a personal-finance product, not a tax calculator",
      provenance: [],
      confidence: "medium",
      nominated_alternative: "Quicken",
      nominated_cost: "rebuilding a worse one",
    };
    expect(CharterSchema.parse(c)).toEqual(c);
  });

  test("strict: rejects an unknown charter key", () => {
    expect(() =>
      CharterSchema.parse({
        charter_id: "c",
        kind: "stated",
        purpose: "p",
        provenance: [],
        confidence: "high",
        weight: 3,
      }),
    ).toThrow();
  });
});

describe("CharterDifferenceSchema", () => {
  const base = {
    difference_id: "d1",
    correspondence_id: "c1",
    dimension: "purpose",
    relation: "incompatible",
    accounts: [
      { kind: "structural", claim: "the module organizes a cache", provenance: [] },
      { kind: "revealed", claim: "the module recomputes on every call", provenance: [] },
    ],
    gap: "the organization's promise vs what the implementation does",
    routed_to: "clarification",
    finding_candidate: true,
  };

  test("accepts an n-ary record with a two-against-one split naming the odd channel", () => {
    const d = CharterDifferenceSchema.parse({
      ...base,
      split: { kind: "two_against_one", odd: "revealed" },
    });
    expect(d.accounts.map((a) => a.kind)).toEqual(["structural", "revealed"]);
    expect(d.split).toEqual({ kind: "two_against_one", odd: "revealed" });
  });

  test("accepts a three-way split and strict-rejects an unknown split kind", () => {
    expect(CharterDifferenceSchema.parse({ ...base, split: { kind: "three_way" } }).split).toEqual({
      kind: "three_way",
    });
    expect(() =>
      CharterDifferenceSchema.parse({ ...base, split: { kind: "pairwise" } }),
    ).toThrow();
  });

  test("rejects a dimension outside the closed seven", () => {
    expect(() => CharterDifferenceSchema.parse({ ...base, dimension: "detail" })).toThrow();
  });

  // The DECLARED record must accept what `assembleComparison` produces. A
  // `presence` difference names its silent channel by omitting it, so on a
  // two-channel correspondence it carries exactly one account. The input half
  // was relaxed for that on 2026-09-17; this record was left at a flat minimum
  // of two and refused its own assembler's output (owner, 2026-09-17).
  test("accepts a ONE-account presence record and still needs two on every other dimension", () => {
    const one = [
      { kind: "revealed", claim: "the code serves this goal", provenance: [] },
    ];
    expect(
      CharterDifferenceSchema.parse({
        ...base,
        dimension: "presence",
        relation: "complementary",
        accounts: one,
        covered_channel_gap: true,
        routed_to: "remediator",
      }).accounts,
    ).toHaveLength(1);

    for (const dimension of [
      "purpose",
      "responsibility",
      "hierarchy",
      "scope",
      "standing",
      "standard",
    ]) {
      expect(
        CharterDifferenceSchema.safeParse({ ...base, dimension, accounts: one })
          .success,
        `${dimension} must still need two accounts`,
      ).toBe(false);
    }
  });
});

describe("IntentCheckpointSchema back-compat", () => {
  const base = {
    schema_version: "intent-checkpoint/v1",
    confirmed_at: "2026-07-05T00:00:00Z",
    confirmed_by: "host",
    scope_summary: "full audit",
    intent_summary: "audit everything",
  };

  test("accepts the legacy design_review shape (conceptual_depth/perspectives only)", () => {
    const parsed = IntentCheckpointSchema.parse({
      ...base,
      design_review: { conceptual_depth: "deep", perspectives: 5 },
    });
    expect(parsed.design_review!.perspectives).toBe(5);
  });

  test("strict: rejects the never-written charters/goal_graph embeds in design_review", () => {
    // Retired by design resolution 4: charters live on charter_register.json
    // (the output artifact), never on the checkpoint input (creates staleness).
    expect(() =>
      IntentCheckpointSchema.parse({
        ...base,
        design_review: {
          conceptual_depth: "shallow",
          goal_graph: {
            nodes: [{ node_id: "telos", premise_height: 0, statement: "the goal" }],
            edges: [],
          },
          charters: [
            {
              charter_id: "s1",
              kind: "stated",
              purpose: "the pipeline exists to extract max value",
              provenance: [{ kind: "doc", ref: "docs/HANDOFF.md" }],
              confidence: "high",
            },
          ],
          ceiling: { rung: "deep" },
        },
      }),
    ).toThrow();
  });

  test("strict: rejects an unknown key inside design_review", () => {
    expect(() =>
      IntentCheckpointSchema.parse({
        ...base,
        design_review: { conceptual_depth: "shallow", bogus: true },
      }),
    ).toThrow();
  });
});
