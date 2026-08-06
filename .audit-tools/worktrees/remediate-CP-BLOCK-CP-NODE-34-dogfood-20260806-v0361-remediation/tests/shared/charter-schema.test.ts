import { test, expect, describe } from "vitest";
import {
  GoalGraphSchema,
  CharterSchema,
  CharterDeltaSchema,
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

describe("CharterDeltaSchema", () => {
  test("accepts a symmetric charter-kind pair tuple", () => {
    const d = CharterDeltaSchema.parse({
      delta_id: "d1",
      pair: ["structural", "revealed"],
      kind: "architecture_betrayal",
      routed_to: "clarification",
      summary: "the organization's promise vs what the implementation does",
    });
    expect(d.pair).toEqual(["structural", "revealed"]);
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
