import { test, expect, describe } from "vitest";

const {
  assembleCharterRegister,
  CharterSubmissionSchema,
} = await import("../../src/shared/decompose/charterExtraction.ts");

/** Minimal charter-input factory (no charter_id — the tool assigns it). */
function charterInput(overrides = {}) {
  return {
    kind: overrides.kind ?? "stated",
    purpose:
      overrides.purpose ?? "exists so the pipeline extracts max value from budgets",
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

const members = new Map([["a.ts", ["a.ts", "b.ts"]]]);

describe("assembleCharterRegister — id assignment + grounding", () => {
  test("assigns charter_id = node_id:kind and joins members from the scaffold", () => {
    const out = assembleCharterRegister(
      { subsystems: [{ node_id: "a.ts", charters: [charterInput()], deltas: [] }] },
      members,
    );
    expect(out.subsystems).toHaveLength(1);
    expect(out.subsystems[0].charters[0].charter_id).toBe("a.ts:stated");
    expect(out.subsystems[0].members).toEqual(["a.ts", "b.ts"]);
    expect(out.validation_issues).toHaveLength(0);
  });

  test("drops a subsystem whose node_id is not a consensus node (invented boundary)", () => {
    const out = assembleCharterRegister(
      { subsystems: [{ node_id: "ghost.ts", charters: [charterInput()], deltas: [] }] },
      members,
    );
    expect(out.subsystems).toHaveLength(0);
    expect(out.validation_issues[0]).toContain("not a consensus node");
  });

  test("keeps the first of a duplicated charter kind and flags the rest", () => {
    const out = assembleCharterRegister(
      {
        subsystems: [
          {
            node_id: "a.ts",
            charters: [
              charterInput({ purpose: "first" }),
              charterInput({ purpose: "second" }),
            ],
            deltas: [],
          },
        ],
      },
      members,
    );
    expect(out.subsystems[0].charters).toHaveLength(1);
    expect(out.subsystems[0].charters[0].purpose).toBe("first");
    expect(out.validation_issues.join()).toContain("more than one");
  });
});

describe("assembleCharterRegister — delta routing table (tool-enforced)", () => {
  function withDelta(pair, charterKinds, confidences = {}) {
    const charters = charterKinds.map((k) =>
      charterInput({
        kind: k,
        confidence: confidences[k] ?? "high",
        ...(k === "true"
          ? { nominated_alternative: "Quicken", nominated_cost: "rebuild worse" }
          : {}),
      }),
    );
    return assembleCharterRegister(
      { subsystems: [{ node_id: "a.ts", charters, deltas: [{ pair, summary: "gap" }] }] },
      members,
    );
  }

  test("inferred|stated → unstated_assumption / clarification (order-insensitive)", () => {
    const out = withDelta(["stated", "inferred"], ["stated", "inferred"]);
    expect(out.deltas).toHaveLength(1);
    expect(out.deltas[0].kind).toBe("unstated_assumption");
    expect(out.deltas[0].routed_to).toBe("clarification");
    expect(out.deltas[0].delta_id).toBe("a.ts:stated-inferred");
    expect(out.deltas[0].pair).toEqual(["stated", "inferred"]);
  });

  test("stated|revealed → spec_drift / remediator", () => {
    const out = withDelta(["revealed", "stated"], ["stated", "revealed"]);
    expect(out.deltas[0].kind).toBe("spec_drift");
    expect(out.deltas[0].routed_to).toBe("remediator");
  });

  test("stated|true → wrong_goal / human", () => {
    const out = withDelta(["stated", "true"], ["stated", "true"]);
    expect(out.deltas[0].kind).toBe("wrong_goal");
    expect(out.deltas[0].routed_to).toBe("human");
    expect(out.deltas[0].severity ?? out.findings[0].severity).toBeDefined();
  });

  test("a pair with no routing (inferred|revealed) is dropped as a validation issue", () => {
    const out = withDelta(["inferred", "revealed"], ["inferred", "revealed"]);
    expect(out.deltas).toHaveLength(0);
    expect(out.validation_issues.join()).toContain("no routing");
  });

  test("a delta referencing a dropped/absent charter side is dropped", () => {
    // revealed|true, but the true charter is un-falsifiable → dropped by the gate,
    // so the delta has no true side left.
    const out = assembleCharterRegister(
      {
        subsystems: [
          {
            node_id: "a.ts",
            charters: [
              charterInput({ kind: "revealed" }),
              charterInput({ kind: "true", nominated_alternative: "X" }), // missing cost → dropped
            ],
            deltas: [{ pair: ["revealed", "true"], summary: "gap" }],
          },
        ],
      },
      members,
    );
    expect(out.deltas).toHaveLength(0);
    expect(out.validation_issues.join()).toContain("missing/dropped charter");
  });
});

describe("assembleCharterRegister — low-confidence gate overrides routing", () => {
  test("a low-confidence side forces spec_drift off the remediator to the human", () => {
    const out = assembleCharterRegister(
      {
        subsystems: [
          {
            node_id: "a.ts",
            charters: [
              charterInput({ kind: "stated", confidence: "low" }),
              charterInput({ kind: "revealed", confidence: "high" }),
            ],
            deltas: [{ pair: ["stated", "revealed"], summary: "gap" }],
          },
        ],
      },
      members,
    );
    expect(out.deltas[0].kind).toBe("spec_drift");
    expect(out.deltas[0].routed_to).toBe("human");
  });
});

describe("assembleCharterRegister — deltas surface as Finding leads", () => {
  test("each surviving delta becomes a systemic architecture finding on the members", () => {
    const out = assembleCharterRegister(
      {
        subsystems: [
          {
            node_id: "a.ts",
            charters: [
              charterInput({ kind: "stated" }),
              charterInput({ kind: "revealed" }),
            ],
            deltas: [{ pair: ["stated", "revealed"], summary: "code drifted from intent" }],
          },
        ],
      },
      members,
    );
    expect(out.findings).toHaveLength(1);
    const f = out.findings[0];
    expect(f.id).toBe("a.ts:stated-revealed");
    expect(f.category).toBe("charter_delta:spec_drift");
    expect(f.lens).toBe("architecture");
    expect(f.systemic).toBe(true);
    expect(f.summary).toBe("code drifted from intent");
    expect(f.affected_files.map((x) => x.path)).toEqual(["a.ts", "b.ts"]);
  });

  test("finding confidence is the weaker of the two charter sides", () => {
    const out = assembleCharterRegister(
      {
        subsystems: [
          {
            node_id: "a.ts",
            charters: [
              charterInput({ kind: "stated", confidence: "medium" }),
              charterInput({ kind: "revealed", confidence: "high" }),
            ],
            deltas: [{ pair: ["stated", "revealed"], summary: "gap" }],
          },
        ],
      },
      members,
    );
    // stated is low-confidence? no — medium; revealed high → weaker = medium.
    expect(out.findings[0].confidence).toBe("medium");
  });
});

describe("assembleCharterRegister — determinism + goal graph", () => {
  test("subsystems, deltas, and findings are sorted by content-derived key", () => {
    const twoMembers = new Map([
      ["a.ts", ["a.ts"]],
      ["z.ts", ["z.ts"]],
    ]);
    const out = assembleCharterRegister(
      {
        subsystems: [
          { node_id: "z.ts", charters: [charterInput()], deltas: [] },
          { node_id: "a.ts", charters: [charterInput()], deltas: [] },
        ],
      },
      twoMembers,
    );
    expect(out.subsystems.map((s) => s.node_id)).toEqual(["a.ts", "z.ts"]);
  });

  test("goal_graph defaults to empty when the submission omits it", () => {
    const out = assembleCharterRegister({ subsystems: [] }, members);
    expect(out.goal_graph).toEqual({ nodes: [], edges: [] });
  });

  test("CharterSubmissionSchema rejects an unknown top-level key (strict)", () => {
    const parsed = CharterSubmissionSchema.safeParse({ subsystems: [], bogus: 1 });
    expect(parsed.success).toBe(false);
  });

  test("CharterSubmissionSchema defaults subsystem deltas to []", () => {
    const parsed = CharterSubmissionSchema.parse({
      subsystems: [{ node_id: "a.ts", charters: [] }],
    });
    expect(parsed.subsystems[0].deltas).toEqual([]);
  });
});
