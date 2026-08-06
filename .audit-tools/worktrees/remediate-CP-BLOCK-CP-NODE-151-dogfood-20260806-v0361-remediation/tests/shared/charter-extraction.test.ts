import { test, expect, describe } from "vitest";
import {
  assembleCharters,
  assembleDeltas,
  CharterSubmissionSchema,
  CharterDeltaSubmissionSchema,
  type CharterSubmission,
} from "../../src/shared/decompose/charterExtraction.js";
import type {
  CharterKind,
  CharterConfidence,
  GoalGraph,
} from "../../src/shared/types/charter.js";
import { CharterKindSchema } from "../../src/shared/types/charter.js";

type NodeInput = CharterSubmission["nodes"][number];

/** Minimal teleology-node factory (no charter_id — the tool assigns unit ids). */
function nodeInput(overrides: Partial<NodeInput> = {}): NodeInput {
  return {
    kind: overrides.kind ?? "stated",
    purpose:
      overrides.purpose ?? "exists so the pipeline extracts max value from budgets",
    premise_height: overrides.premise_height ?? 0,
    files: overrides.files ?? ["a.ts"],
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

const hint = new Map([["a.ts", ["a.ts", "b.ts"]]]);
const universe = new Set(["a.ts", "b.ts", "c.ts", "d.ts", "z.ts"]);
const params = { hint, universe };

describe("assembleCharters — grounding + the file-set-overlap join", () => {
  test("joins a node to the overlapping hint unit; charter_id = unit:kind", () => {
    const out = assembleCharters({ nodes: [nodeInput()] }, params);
    expect(out.subsystems).toHaveLength(1);
    expect(out.subsystems[0].node_id).toBe("a.ts");
    expect(out.subsystems[0].charters[0].charter_id).toBe("a.ts:stated");
    expect(out.subsystems[0].members).toEqual(["a.ts", "b.ts"]);
    expect(out.validation_issues).toHaveLength(0);
  });

  test("drops a node whose scope cites files outside the repo universe", () => {
    const out = assembleCharters(
      { nodes: [nodeInput({ files: ["a.ts", "ghost.ts"] })] },
      params,
    );
    expect(out.subsystems).toHaveLength(0);
    expect(out.validation_issues[0]).toContain("outside the repo universe");
    expect(out.validation_issues[0]).toContain("ghost.ts");
  });

  test("nodes overlapping no hint unit union-find into a residual unit by shared files", () => {
    const out = assembleCharters(
      {
        nodes: [
          nodeInput({ kind: "stated", files: ["c.ts"] }),
          nodeInput({ kind: "revealed", files: ["c.ts", "d.ts"], purpose: "behaviour" }),
        ],
      },
      params,
    );
    expect(out.subsystems).toHaveLength(1);
    // Unit id = lexicographically first file of the residual scope union.
    expect(out.subsystems[0].node_id).toBe("c.ts");
    expect(out.subsystems[0].members).toEqual(["c.ts", "d.ts"]);
    // Charters sort by charter_id (content-derived), so `revealed` < `stated`.
    expect(out.subsystems[0].charters.map((c) => c.kind)).toEqual([
      "revealed",
      "stated",
    ]);
  });

  test("a residual unit never collides with a hint unit id (scope shares no hint member)", () => {
    const out = assembleCharters(
      {
        nodes: [
          nodeInput({ files: ["a.ts"] }),
          nodeInput({ kind: "revealed", files: ["z.ts"], purpose: "z island" }),
        ],
      },
      params,
    );
    expect(out.subsystems.map((s) => s.node_id)).toEqual(["a.ts", "z.ts"]);
  });

  test("every joined node persists in the unit's per-kind teleology, levels intact", () => {
    const out = assembleCharters(
      {
        nodes: [
          nodeInput({ premise_height: 0, purpose: "root telos", files: ["a.ts", "b.ts"] }),
          nodeInput({ premise_height: 2, purpose: "leaf mechanism serves root", files: ["b.ts"] }),
        ],
      },
      params,
    );
    const teleology = out.subsystems[0].teleologies.stated!;
    expect(teleology).toHaveLength(2);
    expect(teleology.map((n) => n.premise_height)).toEqual([0, 2]);
    // The unit's selected charter is the best-overlap node (the 2-file scope).
    expect(out.subsystems[0].charters[0].purpose).toBe("root telos");
  });

  test("assembly is input-order independent (content-derived ordering)", () => {
    const a = assembleCharters(
      {
        nodes: [
          nodeInput({ purpose: "one", files: ["a.ts"] }),
          nodeInput({ kind: "revealed", purpose: "two", files: ["b.ts"] }),
        ],
      },
      params,
    );
    const b = assembleCharters(
      {
        nodes: [
          nodeInput({ kind: "revealed", purpose: "two", files: ["b.ts"] }),
          nodeInput({ purpose: "one", files: ["a.ts"] }),
        ],
      },
      params,
    );
    expect(a).toEqual(b);
  });

  test("units sort by content-derived unit id", () => {
    const twoHints = new Map([
      ["a.ts", ["a.ts"]],
      ["z.ts", ["z.ts"]],
    ]);
    const out = assembleCharters(
      {
        nodes: [
          nodeInput({ files: ["z.ts"], purpose: "z" }),
          nodeInput({ files: ["a.ts"], purpose: "a" }),
        ],
      },
      { hint: twoHints, universe },
    );
    expect(out.subsystems.map((s) => s.node_id)).toEqual(["a.ts", "z.ts"]);
  });
});

// Delta-assembly fixtures: build a unit carrying the given kinds, then mine.
function assembled(
  charterKinds: CharterKind[],
  confidences: Partial<Record<CharterKind, CharterConfidence>> = {},
) {
  const nodes = charterKinds.map((k) =>
    nodeInput({
      kind: k,
      confidence: confidences[k] ?? "high",
      purpose: `${k} purpose`,
    }),
  );
  return assembleCharters({ nodes }, params).subsystems;
}

function mineOne(
  pair: [CharterKind, CharterKind],
  charterKinds: CharterKind[],
  confidences: Partial<Record<CharterKind, CharterConfidence>> = {},
) {
  return assembleDeltas(
    {
      subsystems: [{ node_id: "a.ts", deltas: [{ pair, summary: "gap" }] }],
      triangulated: [],
      true_nominations: [],
    },
    assembled(charterKinds, confidences),
    { allowTrueNominations: false },
  );
}

describe("assembleDeltas — channel-pair routing table (tool-enforced)", () => {
  test("stated|revealed → says_does_drift / remediator (order-insensitive)", () => {
    const out = mineOne(["revealed", "stated"], ["stated", "revealed"]);
    expect(out.deltas).toHaveLength(1);
    expect(out.deltas[0].kind).toBe("says_does_drift");
    expect(out.deltas[0].routed_to).toBe("remediator");
    expect(out.deltas[0].delta_id).toBe("a.ts:stated-revealed");
    expect(out.deltas[0].pair).toEqual(["stated", "revealed"]);
  });

  test("stated|structural → doc_rot / remediator", () => {
    const out = mineOne(["stated", "structural"], ["stated", "structural"]);
    expect(out.deltas[0].kind).toBe("doc_rot");
    expect(out.deltas[0].routed_to).toBe("remediator");
  });

  test("structural|revealed → architecture_betrayal / clarification", () => {
    const out = mineOne(["structural", "revealed"], ["structural", "revealed"]);
    expect(out.deltas[0].kind).toBe("architecture_betrayal");
    expect(out.deltas[0].routed_to).toBe("clarification");
  });

  test("a delta pairing a kind with itself is dropped", () => {
    const out = mineOne(["stated", "stated"], ["stated", "revealed"]);
    expect(out.deltas).toHaveLength(0);
    expect(out.validation_issues.join()).toContain("with itself");
  });

  test("a delta referencing a kind the unit does not carry is dropped", () => {
    const out = mineOne(["stated", "structural"], ["stated", "revealed"]);
    expect(out.deltas).toHaveLength(0);
    expect(out.validation_issues.join()).toContain("missing/dropped charter");
  });

  test("a delta whose node_id has no assembled charters is dropped", () => {
    const out = assembleDeltas(
      {
        subsystems: [
          { node_id: "ghost.ts", deltas: [{ pair: ["stated", "revealed"], summary: "gap" }] },
        ],
        triangulated: [],
        true_nominations: [],
      },
      assembled(["stated", "revealed"]),
      { allowTrueNominations: false },
    );
    expect(out.deltas).toHaveLength(0);
    expect(out.validation_issues.join()).toContain("no assembled charters");
  });
});

describe("assembleDeltas — True nominations (deepest-rung consent gate)", () => {
  const nomination = {
    node_id: "a.ts",
    purpose: "the shining city",
    nominated_alternative: "Quicken",
    nominated_cost: "rebuilding a worse one",
    confidence: "high" as const,
    provenance: [],
  };

  test("a nomination at deepest joins the unit's charters and is delta-eligible", () => {
    const out = assembleDeltas(
      {
        subsystems: [
          { node_id: "a.ts", deltas: [{ pair: ["revealed", "true"], summary: "wrong goal" }] },
        ],
        triangulated: [],
        true_nominations: [nomination],
      },
      assembled(["stated", "revealed"]),
      { allowTrueNominations: true },
    );
    const unit = out.subsystems[0];
    expect(unit.charters.some((c) => c.kind === "true")).toBe(true);
    expect(out.deltas[0].kind).toBe("wrong_goal");
    expect(out.deltas[0].routed_to).toBe("human");
  });

  test("nominations are REFUSED whole below the deepest rung", () => {
    const out = assembleDeltas(
      {
        subsystems: [],
        triangulated: [],
        true_nominations: [nomination],
        no_deltas: true,
      },
      assembled(["stated", "revealed"]),
      { allowTrueNominations: false },
    );
    expect(out.subsystems[0].charters.some((c) => c.kind === "true")).toBe(false);
    expect(out.validation_issues.join()).toContain("deepest");
  });

  test("an un-falsifiable nomination is dropped by the True gate", () => {
    const out = assembleDeltas(
      {
        subsystems: [],
        triangulated: [],
        true_nominations: [{ ...nomination, nominated_cost: "" }],
        no_deltas: true,
      },
      assembled(["stated", "revealed"]),
      { allowTrueNominations: true },
    );
    expect(out.subsystems[0].charters.some((c) => c.kind === "true")).toBe(false);
    expect(out.validation_issues.join()).toContain("not falsifiable");
  });

  test("a nomination naming no joined subsystem is dropped", () => {
    const out = assembleDeltas(
      {
        subsystems: [],
        triangulated: [],
        true_nominations: [{ ...nomination, node_id: "ghost.ts" }],
        no_deltas: true,
      },
      assembled(["stated", "revealed"]),
      { allowTrueNominations: true },
    );
    expect(out.validation_issues.join()).toContain("names no joined subsystem");
  });
});

describe("assembleDeltas — triangulated telos + disagreement density", () => {
  test("a telos for a joined unit persists; unknown/duplicate ones drop with issues", () => {
    const out = assembleDeltas(
      {
        subsystems: [],
        triangulated: [
          { node_id: "a.ts", telos: "unified opinion", confidence: "medium" },
          { node_id: "a.ts", telos: "second opinion", confidence: "low" },
          { node_id: "ghost.ts", telos: "nowhere", confidence: "low" },
        ],
        true_nominations: [],
        no_deltas: true,
      },
      assembled(["stated", "revealed"]),
      { allowTrueNominations: false },
    );
    expect(out.triangulated).toEqual([
      { node_id: "a.ts", telos: "unified opinion", confidence: "medium" },
    ]);
    expect(out.validation_issues.join()).toContain("more than one triangulated telos");
    expect(out.validation_issues.join()).toContain("names no joined subsystem");
  });

  test("disagreement density counts kept deltas per unit per channel pair", () => {
    const out = assembleDeltas(
      {
        subsystems: [
          {
            node_id: "a.ts",
            deltas: [
              { pair: ["stated", "revealed"], summary: "gap one" },
              { pair: ["revealed", "stated"], summary: "gap two" },
              { pair: ["stated", "structural"], summary: "doc gap" },
            ],
          },
        ],
        triangulated: [],
        true_nominations: [],
      },
      assembled(["stated", "structural", "revealed"]),
      { allowTrueNominations: false },
    );
    // Sorted lexically by (node_id, pair) — content-derived, not kind order.
    expect(out.disagreement).toEqual([
      { node_id: "a.ts", pair: ["stated", "revealed"], count: 2 },
      { node_id: "a.ts", pair: ["stated", "structural"], count: 1 },
    ]);
  });
});

describe("assembleDeltas — low-confidence gate overrides routing", () => {
  test("a low-confidence side forces says_does_drift off the remediator to the human", () => {
    const out = mineOne(["stated", "revealed"], ["stated", "revealed"], {
      stated: "low",
    });
    expect(out.deltas[0].kind).toBe("says_does_drift");
    expect(out.deltas[0].routed_to).toBe("human");
  });
});

describe("assembleDeltas — deltas surface as Finding leads", () => {
  test("each surviving delta becomes a systemic architecture finding on the members", () => {
    const out = mineOne(["stated", "revealed"], ["stated", "revealed"]);
    expect(out.findings).toHaveLength(1);
    const f = out.findings[0];
    expect(f.id).toBe("a.ts:stated-revealed");
    expect(f.category).toBe("charter_delta:says_does_drift");
    expect(f.lens).toBe("architecture");
    expect(f.systemic).toBe(true);
    expect(f.summary).toBe("gap");
    expect(f.affected_files.map((x) => x.path)).toEqual(["a.ts", "b.ts"]);
  });

  test("finding confidence is the weaker of the two charter sides", () => {
    const out = mineOne(["stated", "revealed"], ["stated", "revealed"], {
      stated: "medium",
    });
    expect(out.findings[0].confidence).toBe("medium");
  });
});

describe("submission schemas — strictness + affirmations", () => {
  test("goal_graph defaults to empty when the delta submission omits it", () => {
    const out = assembleDeltas(
      { subsystems: [], triangulated: [], true_nominations: [], no_deltas: true },
      [],
      { allowTrueNominations: false },
    );
    expect(out.goal_graph).toEqual({ nodes: [], edges: [] });
  });

  test("goal_graph passes through from the delta submission", () => {
    const gg: GoalGraph = {
      nodes: [{ node_id: "n1", premise_height: 0, statement: "n1" }],
      edges: [],
    };
    const out = assembleDeltas(
      {
        subsystems: [],
        triangulated: [],
        true_nominations: [],
        goal_graph: gg,
        no_deltas: true,
      },
      [],
      { allowTrueNominations: false },
    );
    expect(out.goal_graph).toEqual(gg);
  });

  test("CharterSubmissionSchema rejects an unknown top-level key (strict)", () => {
    const parsed = CharterSubmissionSchema.safeParse({ nodes: [], bogus: 1 });
    expect(parsed.success).toBe(false);
  });

  test("CharterSubmissionSchema rejects the retired subsystems shape", () => {
    const parsed = CharterSubmissionSchema.safeParse({
      subsystems: [{ node_id: "a.ts", charters: [] }],
    });
    expect(parsed.success).toBe(false);
  });

  test("a teleology node requires a non-empty file scope", () => {
    const parsed = CharterSubmissionSchema.safeParse({
      nodes: [{ ...nodeInput(), files: [] }],
    });
    expect(parsed.success).toBe(false);
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

  test("triangulated teloses still ride a no_deltas submission (affirmation is deltas-only)", () => {
    const parsed = CharterDeltaSubmissionSchema.safeParse({
      subsystems: [],
      triangulated: [{ node_id: "a.ts", telos: "opinion", confidence: "high" }],
      no_deltas: true,
    });
    expect(parsed.success).toBe(true);
  });

  test("CharterDeltaSubmissionSchema rejects an unknown top-level key (strict)", () => {
    const parsed = CharterDeltaSubmissionSchema.safeParse({ subsystems: [], bogus: 1 });
    expect(parsed.success).toBe(false);
  });
});

// Design resolution 4 pins (design-check 2026-08-05, record in
// docs/reviews/prompt-process-critique-2026-08-05.md) — pinned red before the
// implementation, green since it landed; kept as the contract's anchor tests.
describe("design resolution 4 — channel-pure charter kinds (landed)", () => {
  test("charter kinds are the channel-pure estimator set (stated/structural/revealed/true)", () => {
    expect(CharterKindSchema.options).toEqual([
      "stated",
      "structural",
      "revealed",
      "true",
    ]);
  });

  test("the intent-model↔revealed channel pair routes as work instead of dropping", () => {
    // The middle channel derived at runtime so this pin survives any future
    // kind migration the same way it survived inferred→structural.
    const middle = CharterKindSchema.options.find(
      (k) => k !== "stated" && k !== "revealed" && k !== "true",
    )!;
    const out = mineOne([middle, "revealed"], [middle, "revealed"]);
    expect(out.deltas).toHaveLength(1);
    expect(out.validation_issues).toHaveLength(0);
  });
});
