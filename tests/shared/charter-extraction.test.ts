import { test, expect, describe } from "vitest";
import {
  assembleCharters,
  assembleDeltas,
  CharterSubmissionSchema,
  CharterDeltaSubmissionSchema,
} from "../../src/shared/decompose/charterExtraction.js";
import type { Charter, CharterKind, CharterConfidence, GoalGraph } from "../../src/shared/types/charter.js";

/** Minimal charter-input factory (no charter_id — the tool assigns it). */
function charterInput(overrides: Partial<Omit<Charter, "charter_id">> = {}): Omit<Charter, "charter_id"> {
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

describe("assembleCharters — id assignment + grounding", () => {
  test("assigns charter_id = node_id:kind and joins members from the scaffold", () => {
    const out = assembleCharters(
      { subsystems: [{ node_id: "a.ts", charters: [charterInput()] }] },
      members,
    );
    expect(out.subsystems).toHaveLength(1);
    expect(out.subsystems[0].charters[0].charter_id).toBe("a.ts:stated");
    expect(out.subsystems[0].members).toEqual(["a.ts", "b.ts"]);
    expect(out.validation_issues).toHaveLength(0);
  });

  test("drops a subsystem whose node_id is not a consensus node (invented boundary)", () => {
    const out = assembleCharters(
      { subsystems: [{ node_id: "ghost.ts", charters: [charterInput()] }] },
      members,
    );
    expect(out.subsystems).toHaveLength(0);
    expect(out.validation_issues[0]).toContain("not a consensus node");
  });

  test("keeps the first of a duplicated charter kind and flags the rest", () => {
    const out = assembleCharters(
      {
        subsystems: [
          {
            node_id: "a.ts",
            charters: [
              charterInput({ purpose: "first" }),
              charterInput({ purpose: "second" }),
            ],
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

describe("assembleDeltas — delta routing table (tool-enforced)", () => {
  function withDelta(
    pair: [CharterKind, CharterKind],
    charterKinds: CharterKind[],
    confidences: Partial<Record<CharterKind, CharterConfidence>> = {},
  ) {
    const charters = charterKinds.map((k) =>
      charterInput({
        kind: k,
        confidence: confidences[k] ?? "high",
        ...(k === "true"
          ? { nominated_alternative: "Quicken", nominated_cost: "rebuild worse" }
          : {}),
      }),
    );
    const { subsystems } = assembleCharters(
      { subsystems: [{ node_id: "a.ts", charters }] },
      members,
    );
    return assembleDeltas(
      { subsystems: [{ node_id: "a.ts", deltas: [{ pair, summary: "gap" }] }] },
      subsystems,
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
    expect(out.findings[0].severity).toBeDefined();
  });

  test("a pair with no routing (inferred|revealed) is dropped as a validation issue", () => {
    const out = withDelta(["inferred", "revealed"], ["inferred", "revealed"]);
    expect(out.deltas).toHaveLength(0);
    expect(out.validation_issues.join()).toContain("no routing");
  });

  test("a delta referencing a dropped/absent charter side is dropped", () => {
    // revealed|true, but the true charter is un-falsifiable → dropped by the gate,
    // so the delta has no true side left.
    const { subsystems } = assembleCharters(
      {
        subsystems: [
          {
            node_id: "a.ts",
            charters: [
              charterInput({ kind: "revealed" }),
              charterInput({ kind: "true", nominated_alternative: "X" }), // missing cost → dropped
            ],
          },
        ],
      },
      members,
    );
    const out = assembleDeltas(
      {
        subsystems: [
          { node_id: "a.ts", deltas: [{ pair: ["revealed", "true"], summary: "gap" }] },
        ],
      },
      subsystems,
    );
    expect(out.deltas).toHaveLength(0);
    expect(out.validation_issues.join()).toContain("missing/dropped charter");
  });

  test("a delta whose node_id has no assembled charters is dropped", () => {
    const { subsystems } = assembleCharters(
      { subsystems: [{ node_id: "a.ts", charters: [charterInput()] }] },
      members,
    );
    const out = assembleDeltas(
      { subsystems: [{ node_id: "ghost.ts", deltas: [{ pair: ["stated", "revealed"], summary: "gap" }] }] },
      subsystems,
    );
    expect(out.deltas).toHaveLength(0);
    expect(out.validation_issues.join()).toContain("no assembled charters");
  });
});

describe("assembleDeltas — low-confidence gate overrides routing", () => {
  test("a low-confidence side forces spec_drift off the remediator to the human", () => {
    const { subsystems } = assembleCharters(
      {
        subsystems: [
          {
            node_id: "a.ts",
            charters: [
              charterInput({ kind: "stated", confidence: "low" }),
              charterInput({ kind: "revealed", confidence: "high" }),
            ],
          },
        ],
      },
      members,
    );
    const out = assembleDeltas(
      { subsystems: [{ node_id: "a.ts", deltas: [{ pair: ["stated", "revealed"], summary: "gap" }] }] },
      subsystems,
    );
    expect(out.deltas[0].kind).toBe("spec_drift");
    expect(out.deltas[0].routed_to).toBe("human");
  });
});

describe("assembleDeltas — deltas surface as Finding leads", () => {
  function findingsFor(
    charters: Omit<Charter, "charter_id">[],
    delta: { pair: [CharterKind, CharterKind]; summary: string },
  ) {
    const { subsystems } = assembleCharters(
      { subsystems: [{ node_id: "a.ts", charters }] },
      members,
    );
    return assembleDeltas(
      { subsystems: [{ node_id: "a.ts", deltas: [delta] }] },
      subsystems,
    );
  }

  test("each surviving delta becomes a systemic architecture finding on the members", () => {
    const out = findingsFor(
      [charterInput({ kind: "stated" }), charterInput({ kind: "revealed" })],
      { pair: ["stated", "revealed"], summary: "code drifted from intent" },
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
    const out = findingsFor(
      [
        charterInput({ kind: "stated", confidence: "medium" }),
        charterInput({ kind: "revealed", confidence: "high" }),
      ],
      { pair: ["stated", "revealed"], summary: "gap" },
    );
    // stated medium, revealed high → weaker = medium.
    expect(out.findings[0].confidence).toBe("medium");
  });
});

describe("assembleCharters / assembleDeltas — determinism + goal graph", () => {
  test("subsystems are sorted by content-derived key", () => {
    const twoMembers = new Map([
      ["a.ts", ["a.ts"]],
      ["z.ts", ["z.ts"]],
    ]);
    const out = assembleCharters(
      {
        subsystems: [
          { node_id: "z.ts", charters: [charterInput()] },
          { node_id: "a.ts", charters: [charterInput()] },
        ],
      },
      twoMembers,
    );
    expect(out.subsystems.map((s) => s.node_id)).toEqual(["a.ts", "z.ts"]);
  });

  test("goal_graph defaults to empty when the delta submission omits it", () => {
    const out = assembleDeltas({ subsystems: [] }, []);
    expect(out.goal_graph).toEqual({ nodes: [], edges: [] });
  });

  test("goal_graph passes through from the delta submission", () => {
    const gg: GoalGraph = { nodes: [{ node_id: "n1", premise_height: 0, statement: "n1" }], edges: [] };
    const out = assembleDeltas({ subsystems: [], goal_graph: gg }, []);
    expect(out.goal_graph).toEqual(gg);
  });

  test("CharterSubmissionSchema rejects an unknown top-level key (strict)", () => {
    const parsed = CharterSubmissionSchema.safeParse({ subsystems: [], bogus: 1 });
    expect(parsed.success).toBe(false);
  });

  test("CharterSubmissionSchema is charters-only per subsystem (no deltas key)", () => {
    const parsed = CharterSubmissionSchema.parse({
      subsystems: [{ node_id: "a.ts", charters: [] }],
    });
    expect(parsed.subsystems[0].charters).toEqual([]);
    expect("deltas" in parsed.subsystems[0]).toBe(false);
  });

  test("CharterDeltaSubmissionSchema defaults subsystem deltas to []", () => {
    const parsed = CharterDeltaSubmissionSchema.parse({
      subsystems: [{ node_id: "a.ts" }],
      no_deltas: true,
    });
    expect(parsed.subsystems[0].deltas).toEqual([]);
  });

  // Success-shaped-empty closed for the delta miner: "found nothing" must be
  // AFFIRMED, so a dead miner (which submits nothing) can never read as clean —
  // the reviewed_clean contract carried to the charter-delta submission.
  test("a zero-delta submission is REFUSED without the no_deltas affirmation", () => {
    const parsed = CharterDeltaSubmissionSchema.safeParse({
      subsystems: [{ node_id: "a.ts" }],
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(JSON.stringify(parsed.error.issues)).toMatch(/no_deltas/);
    }
  });

  test("no_deltas alongside mined deltas is contradictory and REFUSED", () => {
    const parsed = CharterDeltaSubmissionSchema.safeParse({
      subsystems: [
        {
          node_id: "a.ts",
          deltas: [{ pair: ["stated", "revealed"], summary: "gap" }],
        },
      ],
      no_deltas: true,
    });
    expect(parsed.success).toBe(false);
  });

  test("CharterDeltaSubmissionSchema rejects an unknown top-level key (strict)", () => {
    const parsed = CharterDeltaSubmissionSchema.safeParse({ subsystems: [], bogus: 1 });
    expect(parsed.success).toBe(false);
  });
});
