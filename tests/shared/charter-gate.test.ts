import { test, expect, describe } from "vitest";
import {
  applyTrueCharterGate,
  charterReviewDisposition,
} from "../../src/shared/validation/charterGate.js";
import type { Charter, LaneGoalNode } from "../../src/shared/types/charter.js";

/** Minimal charter factory keeping the tests declarative. */
function charter(overrides: Partial<Charter> = {}): Charter {
  return {
    charter_id: overrides.charter_id ?? "c1",
    kind: overrides.kind ?? "stated",
    purpose: overrides.purpose ?? "exists so the pipeline extracts max value",
    provenance: overrides.provenance ?? [],
    confidence: overrides.confidence ?? "high",
    ...(overrides.nominated_alternative !== undefined
      ? { nominated_alternative: overrides.nominated_alternative }
      : {}),
    ...(overrides.nominated_cost !== undefined
      ? { nominated_cost: overrides.nominated_cost }
      : {}),
  };
}

describe("applyTrueCharterGate", () => {
  test("drops a `true` charter missing the cost half of the falsifiable payload", () => {
    const c = charter({
      charter_id: "t1",
      kind: "true",
      nominated_alternative: "Quicken exists",
    });
    const { kept, dropped } = applyTrueCharterGate([c]);
    expect(kept).toHaveLength(0);
    expect(dropped).toHaveLength(1);
    expect(dropped[0].charter_id).toBe("t1");
    expect(dropped[0].reason).toContain("nominated_cost");
  });

  test("keeps a `true` charter with BOTH a concrete alternative and cost", () => {
    const c = charter({
      charter_id: "t2",
      kind: "true",
      nominated_alternative: "Quicken exists",
      nominated_cost: "you're rebuilding a worse one",
    });
    const { kept, dropped } = applyTrueCharterGate([c]);
    expect(kept).toHaveLength(1);
    expect(kept[0].charter_id).toBe("t2");
    expect(dropped).toHaveLength(0);
  });

  test("drops a `true` charter whose gate fields are whitespace-only", () => {
    const c = charter({
      charter_id: "t3",
      kind: "true",
      nominated_alternative: "   ",
      nominated_cost: "\t",
    });
    const { kept, dropped } = applyTrueCharterGate([c]);
    expect(kept).toHaveLength(0);
    expect(dropped[0].reason).toContain("nominated_alternative");
    expect(dropped[0].reason).toContain("nominated_cost");
  });

  test("never drops non-`true` charters regardless of gate fields", () => {
    const charters = [
      charter({ charter_id: "s", kind: "stated" }),
      charter({ charter_id: "i", kind: "structural" }),
      charter({ charter_id: "r", kind: "revealed" }),
    ];
    const { kept, dropped } = applyTrueCharterGate(charters);
    expect(kept).toHaveLength(3);
    expect(dropped).toHaveLength(0);
  });
});

describe("charterReviewDisposition", () => {
  test("flags for human on a low-confidence charter", () => {
    expect(charterReviewDisposition(charter({ confidence: "low" }))).toBe(
      "flag_for_human",
    );
  });

  test("opines on high/medium-confidence charters", () => {
    expect(charterReviewDisposition(charter({ confidence: "high" }))).toBe(
      "opine",
    );
    expect(charterReviewDisposition(charter({ confidence: "medium" }))).toBe(
      "opine",
    );
  });

  test("accepts a lane goal node (the five-step layer's unit) on the same rule", () => {
    const node: LaneGoalNode = {
      node_id: "g1",
      purpose: "exists so the pipeline extracts max value",
      premise_height: 0,
      provenance: [],
      confidence: "low",
    };
    expect(charterReviewDisposition(node)).toBe("flag_for_human");
    expect(charterReviewDisposition({ ...node, confidence: "high" })).toBe("opine");
  });
});
