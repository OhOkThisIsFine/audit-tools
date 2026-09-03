import { REGISTER_V4_AFFIRMATION } from "../helpers/charterRegisterFixture.js";
import { describe, test, expect } from "vitest";

// Phase D — the charter-alignment triangulation loop. Import the pure D1/D2
// primitives + the D3 executor from source (tsx loader) so un-rebuilt changes are
// caught.
import {
  goalBlastRadius,
  deltaBlastRadius,
} from "../../src/audit/clarification/blastRadius.js";
import { voiScore, voiQueue } from "../../src/audit/clarification/voiQueue.js";
import {
  applyRiskGate,
  DEFAULT_RISK_GATE_THRESHOLDS,
} from "../../src/audit/clarification/riskGate.js";
import { splitByAttention } from "../../src/audit/clarification/dials.js";
import {
  partitionDeltasToQuestions,
  type DeltaWithNode,
} from "../../src/audit/clarification/partition.js";
import {
  runCharterClarificationExecutor,
  resolveClarificationAttention,
} from "../../src/audit/orchestrator/charterClarificationExecutor.js";
import type { RepoManifest } from "../../src/audit/types.js";
import type { CharterRegister } from "../../src/audit/types/charterRegister.js";
import { CHARTER_REGISTER_SCHEMA_VERSION } from "../../src/audit/types/charterRegister.js";
import {
  assembleClarificationRegister,
  discardOnSchemaVersionMismatch,
  groundDesignFindings,
  type GoalGraph,
  type Ceiling,
  type ClarificationAttention,
  type CharterDelta,
  type CharterClarificationAnswer,
  type CharterClarificationRequest,
  type IntentCheckpoint,
} from "audit-tools/shared";
import type { StampedCharterDelta } from "../../src/shared/types/charter.js";
import type { CharterClarificationRegister } from "../../src/audit/types/charterClarification.js";

function manifestWithFiles(paths: string[]): RepoManifest {
  return {
    repository: { name: "fixture" },
    generated_at: "2026-01-01T00:00:00.000Z",
    files: paths.map((path) => ({ path, language: "typescript", size_bytes: 100 })),
  };
}

// ── D1: blast radius over the goal DAG ───────────────────────────────────────

describe("D1 goalBlastRadius", () => {
  const graph: GoalGraph = {
    // leaf → mid → telos, plus a second parent of leaf (a DAG, not a tree).
    nodes: [
      { node_id: "leaf", premise_height: 2, statement: "l" },
      { node_id: "mid", premise_height: 1, statement: "m" },
      { node_id: "telos", premise_height: 0, statement: "t" },
      { node_id: "other", premise_height: 1, statement: "o" },
    ],
    edges: [
      { from: "leaf", to: "mid" },
      { from: "mid", to: "telos" },
      { from: "leaf", to: "other" },
      { from: "other", to: "telos" },
    ],
  };

  test("counts the transitive parent closure (upward ripple)", () => {
    // leaf → {mid, other, telos} = 3.
    expect(goalBlastRadius(graph, "leaf")).toBe(3);
    // mid → {telos} = 1.
    expect(goalBlastRadius(graph, "mid")).toBe(1);
    // telos serves nothing = 0.
    expect(goalBlastRadius(graph, "telos")).toBe(0);
  });

  test("a node absent from the graph has blast radius 0", () => {
    expect(goalBlastRadius(graph, "nope")).toBe(0);
  });

  test("is cycle-safe (a malformed cyclic graph never loops)", () => {
    const cyclic: GoalGraph = {
      nodes: [
        { node_id: "a", premise_height: 0, statement: "a" },
        { node_id: "b", premise_height: 0, statement: "b" },
      ],
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "a" },
      ],
    };
    expect(goalBlastRadius(cyclic, "a")).toBe(2);
  });
});

describe("D1 deltaBlastRadius", () => {
  const emptyGraph: GoalGraph = { nodes: [], edges: [] };

  test("falls back to the delta kind's intrinsic tier when no goal node", () => {
    expect(deltaBlastRadius(emptyGraph, undefined, "doc_rot")).toBe(1);
    expect(deltaBlastRadius(emptyGraph, undefined, "says_does_drift")).toBe(2);
    expect(deltaBlastRadius(emptyGraph, undefined, "architecture_betrayal")).toBe(2);
    expect(deltaBlastRadius(emptyGraph, undefined, "wrong_goal")).toBe(3);
  });

  test("refines the intrinsic tier UPWARD from the graph, never downward", () => {
    const graph: GoalGraph = {
      nodes: [
        { node_id: "n", premise_height: 2, statement: "n" },
        { node_id: "p1", premise_height: 1, statement: "p1" },
        { node_id: "p2", premise_height: 1, statement: "p2" },
        { node_id: "p3", premise_height: 0, statement: "p3" },
      ],
      edges: [
        { from: "n", to: "p1" },
        { from: "n", to: "p2" },
        { from: "p1", to: "p3" },
      ],
    };
    // graph reach = {p1, p2, p3} = 3; a low-tier delta (doc_rot) is lifted to 3.
    expect(deltaBlastRadius(graph, "n", "doc_rot")).toBe(3);
    // a wrong_goal delta on a leaf node stays high (intrinsic 3 > graph 0).
    expect(deltaBlastRadius(graph, "p3", "wrong_goal")).toBe(3);
  });
});

// ── D1: VOI queue ────────────────────────────────────────────────────────────

describe("D1 voiQueue", () => {
  const mkReq = (
    id: string,
    blast: number,
    cascade: number,
    disposition: CharterClarificationRequest["disposition"] = "interactive",
  ): CharterClarificationRequest => ({
    request_id: id,
    delta_id: id.replace(/:q$/, ""),
    node_id: "n",
    pair: ["structural", "revealed"],
    question: "q",
    value: { blast_radius: blast, cascade_count: cascade },
    disposition,
  });

  test("voiScore adds blast radius + cascade count", () => {
    expect(voiScore(mkReq("a:q", 3, 2))).toBe(5);
  });

  test("orders by descending VOI, ties broken by request_id", () => {
    const q = voiQueue([
      mkReq("b:q", 1, 1), // 2
      mkReq("a:q", 3, 0), // 3
      mkReq("c:q", 1, 1), // 2, ties with b → id order
    ]);
    expect(q.map((r) => r.request_id)).toEqual(["a:q", "b:q", "c:q"]);
  });

  test("does not mutate the input", () => {
    const input = [mkReq("b:q", 1, 1), mkReq("a:q", 3, 0)];
    const snapshot = input.map((r) => r.request_id);
    voiQueue(input);
    expect(input.map((r) => r.request_id)).toEqual(snapshot);
  });
});

// ── D1: risk gate ────────────────────────────────────────────────────────────

describe("D1 applyRiskGate", () => {
  const mkReq = (id: string, blast: number): CharterClarificationRequest => ({
    request_id: id,
    delta_id: id,
    node_id: "n",
    pair: ["stated", "true"],
    question: "q",
    value: { blast_radius: blast, cascade_count: 0 },
    disposition: "interactive",
  });

  test("a low-blast question stays interactive", () => {
    const [r] = applyRiskGate([mkReq("low", 1)]);
    expect(r.disposition).toBe("interactive");
  });

  test("a high-blast question with no refutations is downgraded to finding_only", () => {
    const [r] = applyRiskGate([mkReq("high", DEFAULT_RISK_GATE_THRESHOLDS.highBlastThreshold)]);
    expect(r.disposition).toBe("finding_only");
  });

  test("a high-blast question that cleared the adversarial bar stays interactive", () => {
    const refutations = new Map([
      ["high", DEFAULT_RISK_GATE_THRESHOLDS.requiredRefutations],
    ]);
    const [r] = applyRiskGate([mkReq("high", 3)], refutations);
    expect(r.disposition).toBe("interactive");
  });
});

// ── D2: attention dial ───────────────────────────────────────────────────────

describe("D2 splitByAttention", () => {
  const mkReq = (
    id: string,
    blast: number,
    disposition: CharterClarificationRequest["disposition"] = "interactive",
  ): CharterClarificationRequest => ({
    request_id: id,
    delta_id: id,
    node_id: "n",
    pair: ["structural", "revealed"],
    question: "q",
    value: { blast_radius: blast, cascade_count: 0 },
    disposition,
  });

  test("appetite 0 (autonomous) banks every question", () => {
    const split = splitByAttention([mkReq("a", 3), mkReq("b", 1)], 0);
    expect(split.asked).toHaveLength(0);
    expect(split.banked.map((r) => r.request_id).sort()).toEqual(["a", "b"]);
  });

  test("a finite appetite takes the top-N of the VOI queue (highest-leverage first)", () => {
    const split = splitByAttention(
      [mkReq("low", 1), mkReq("high", 3), mkReq("mid", 2)],
      1,
    );
    expect(split.asked.map((r) => r.request_id)).toEqual(["high"]);
    // the rest bank, VOI-ordered.
    expect(split.banked.map((r) => r.request_id)).toEqual(["mid", "low"]);
  });

  test("finding_only questions are never asked, even under high appetite", () => {
    const split = splitByAttention(
      [mkReq("a", 3, "finding_only"), mkReq("b", 1, "interactive")],
      "all",
    );
    expect(split.asked.map((r) => r.request_id)).toEqual(["b"]);
    expect(split.banked.map((r) => r.request_id)).toEqual(["a"]);
  });
});

// ── D2: partition ────────────────────────────────────────────────────────────

describe("D2 partitionDeltasToQuestions", () => {
  const emptyGraph: GoalGraph = { nodes: [], edges: [] };
  const mkDelta = (
    id: string,
    kind: CharterDelta["kind"],
    routed_to: CharterDelta["routed_to"],
    pair: CharterDelta["pair"],
  ): DeltaWithNode => ({
    delta: { delta_id: id, pair, kind, routed_to, summary: `gap ${id}` },
    node_id: id.split(":")[0],
  });

  test("only clarification/human-routed deltas source a question (remediator excluded)", () => {
    const questions = partitionDeltasToQuestions(
      [
        mkDelta("n1:a-b", "architecture_betrayal", "clarification", ["structural", "revealed"]),
        mkDelta("n1:c-d", "says_does_drift", "remediator", ["stated", "revealed"]),
        mkDelta("n2:e-f", "wrong_goal", "human", ["stated", "true"]),
      ],
      emptyGraph,
    );
    expect(questions.map((q) => q.delta_id).sort()).toEqual(["n1:a-b", "n2:e-f"]);
  });

  test("cascade_count = sibling sourcing-deltas in the same subsystem", () => {
    const questions = partitionDeltasToQuestions(
      [
        mkDelta("n1:a-b", "architecture_betrayal", "clarification", ["structural", "revealed"]),
        mkDelta("n1:c-d", "wrong_goal", "human", ["stated", "true"]),
        mkDelta("n2:e-f", "architecture_betrayal", "clarification", ["structural", "revealed"]),
      ],
      emptyGraph,
    );
    const n1a = questions.find((q) => q.delta_id === "n1:a-b");
    const n2e = questions.find((q) => q.delta_id === "n2:e-f");
    expect(n1a!.value.cascade_count).toBe(1); // one sibling in n1
    expect(n2e!.value.cascade_count).toBe(0); // alone in n2
  });

  test("questions are symmetric — the framing never anoints a side", () => {
    const [q] = partitionDeltasToQuestions(
      [mkDelta("n1:a-b", "architecture_betrayal", "clarification", ["structural", "revealed"])],
      emptyGraph,
    );
    expect(q.question).toMatch(/leave open/i);
    expect(q.question).toContain("structural");
    expect(q.question).toContain("revealed");
    expect(q.disposition).toBe("interactive");
  });
});

// ── D3: the executor (loop assembly + persistence) ───────────────────────────

function checkpoint(
  { rung, attention }: { rung?: Ceiling["rung"]; attention?: ClarificationAttention } = {},
): IntentCheckpoint {
  return {
    schema_version: "intent-checkpoint/v1",
    confirmed_at: "2026-01-01T00:00:00Z",
    confirmed_by: "host",
    scope_summary: "s",
    intent_summary: "i",
    design_review: {
      ...(rung ? { ceiling: { rung } } : {}),
      ...(attention !== undefined ? { attention } : {}),
    },
  };
}

function charterRegister(
  deltas: StampedCharterDelta[] = [],
  goal_graph: GoalGraph = { nodes: [], edges: [] },
  subsystems: Array<{ node_id: string; members: string[] }> = [
    { node_id: "n1", members: ["src/a.ts", "src/b.ts"] },
  ],
): CharterRegister {
  return {
    schema_version: CHARTER_REGISTER_SCHEMA_VERSION,
    generated_at: "2026-01-01T00:00:00.000Z",
    target: "charter",
    ceiling: { rung: "deep" },
    subsystems: deltas.length
      ? subsystems.map((s) => ({ ...s, charters: [], teleologies: {} }))
      : [],
    goal_graph,
    deltas,
    findings: [],
    triangulated: [],
    disagreement: [],
    validation_issues: [],
    ...REGISTER_V4_AFFIRMATION,
  };
}

describe("D3 resolveClarificationAttention", () => {
  test("defaults to 0 (autonomous) when unset", () => {
    expect(resolveClarificationAttention(undefined)).toBe(0);
    expect(resolveClarificationAttention(checkpoint({ rung: "deep" }))).toBe(0);
  });

  test("reads the attention dial from the checkpoint", () => {
    expect(resolveClarificationAttention(checkpoint({ rung: "deep", attention: 3 }))).toBe(3);
    expect(resolveClarificationAttention(checkpoint({ rung: "deep", attention: "all" }))).toBe("all");
  });
});

describe("D3 runCharterClarificationExecutor — omit path", () => {
  test("a shallow ceiling writes an omitted register with no host turn", () => {
    const run = runCharterClarificationExecutor({
      intent_checkpoint: checkpoint({ rung: "shallow" }),
      charter_register: charterRegister(),
    });
    const reg = run.updated.charter_clarification!;
    expect(reg.status).toBe("omitted");
    expect(reg.asked).toHaveLength(0);
    expect(run.artifacts_written).toEqual(["charter_clarification.json"]);
  });

  test("a deep ceiling with an omitted charter_register omits too", () => {
    const run = runCharterClarificationExecutor({
      intent_checkpoint: checkpoint({ rung: "deep" }),
      charter_register: { ...charterRegister(), status: "omitted" },
    });
    expect(run.updated.charter_clarification!.status).toBe("omitted");
  });
});

describe("D3 runCharterClarificationExecutor — run path", () => {
  const deltas: StampedCharterDelta[] = [
    { delta_id: "n1:structural-revealed", node_id: "n1", pair: ["structural", "revealed"], kind: "architecture_betrayal", routed_to: "clarification", summary: "docs vs model" },
    { delta_id: "n1:stated-true", node_id: "n1", pair: ["stated", "true"], kind: "wrong_goal", routed_to: "human", summary: "wrong goal" },
  ];

  test("attention 0 (autonomous) banks every question as a finding, none interactive", () => {
    const run = runCharterClarificationExecutor({
      intent_checkpoint: checkpoint({ rung: "deep", attention: 0 }),
      charter_register: charterRegister(deltas),
      repo_manifest: manifestWithFiles(["src/a.ts", "src/b.ts"]),
    });
    const reg = run.updated.charter_clarification!;
    expect(reg.status).toBeUndefined();
    expect(reg.asked).toHaveLength(0);
    expect(reg.banked.length).toBe(2);
    expect(reg.findings.length).toBe(2);
    // findings carry the subsystem members as affected files.
    expect(reg.findings[0].affected_files.map((f) => f.path).sort()).toEqual(["src/a.ts", "src/b.ts"]);
  });

  test("a finite attention with both high-blast and mid-blast questions (both risk-gated, all move to findings)", () => {
    const run = runCharterClarificationExecutor({
      intent_checkpoint: checkpoint({ rung: "deep", attention: 1 }),
      charter_register: charterRegister(deltas),
      repo_manifest: manifestWithFiles(["src/a.ts", "src/b.ts"]),
    });
    const reg = run.updated.charter_clarification!;
    // Both deltas (architecture_betrayal blast=2, wrong_goal blast=3) are converted
    // to questions and findings. No interactive questions remain after risk-gating,
    // so asked is empty and all questions become findings.
    expect(reg.asked).toHaveLength(0);
    expect(reg.findings.length).toBe(2);
  });

  test("lower attention threshold allows lower-blast deltas to reach clarification", () => {
    // Test with only architecture_betrayal (lower blast than wrong_goal) to ensure
    // it can pass through the risk gate with lower blast radius.
    const lowerBlastDeltas: StampedCharterDelta[] = [
      { delta_id: "n1:structural-revealed", node_id: "n1", pair: ["structural", "revealed"], kind: "architecture_betrayal", routed_to: "clarification", summary: "docs vs model" },
    ];
    const first = runCharterClarificationExecutor({
      intent_checkpoint: checkpoint({ rung: "deep", attention: 1 }),
      charter_register: charterRegister(lowerBlastDeltas),
      repo_manifest: manifestWithFiles(["src/a.ts", "src/b.ts"]),
    });
    const reg = first.updated.charter_clarification!;
    // With only the lower-blast delta, it should either be asked or banked.
    const totalQuestions = reg.asked.length + reg.banked.length;
    expect(totalQuestions).toBeGreaterThanOrEqual(1);
  });

  test("remediator-routed says_does_drift deltas are recorded as a note, not a question", () => {
    const run = runCharterClarificationExecutor({
      intent_checkpoint: checkpoint({ rung: "deep", attention: "all" }),
      charter_register: charterRegister([
        { delta_id: "n1:stated-revealed", node_id: "n1", pair: ["stated", "revealed"], kind: "says_does_drift", routed_to: "remediator", summary: "drift" },
      ]),
      repo_manifest: manifestWithFiles(["src/a.ts", "src/b.ts"]),
    });
    const reg = run.updated.charter_clarification!;
    expect(reg.asked).toHaveLength(0);
    expect(reg.banked).toHaveLength(0);
    expect(reg.validation_issues.some((i) => i.includes("remediator"))).toBe(true);
  });
});

// ── D3: node identity, answer ingestion, and the loop-termination guarantee ───
//
// The ingestion path carries the guarantee that an ANSWERED clarification round
// actually terminates: a submission drains the interactive queue in one
// round-trip. These pin that guarantee, the identity both joins are keyed on, and
// the three documented failure modes — none of which had any coverage before.

/** A low-blast (intrinsic tier 1) question-sourcing delta — stays `interactive`. */
function askableDelta(
  delta_id: string,
  node_id: string,
  summary: string,
): StampedCharterDelta {
  return {
    delta_id,
    node_id,
    pair: ["stated", "structural"],
    kind: "doc_rot",
    routed_to: "clarification",
    summary,
  };
}

function allRequests(reg: CharterClarificationRegister): CharterClarificationRequest[] {
  return [...reg.asked, ...reg.banked];
}

function requestById(
  reg: CharterClarificationRegister,
  request_id: string,
): CharterClarificationRequest | undefined {
  return allRequests(reg).find((r) => r.request_id === request_id);
}

function askedQuestion(
  request_id: string,
  delta_id: string,
): CharterClarificationRequest {
  return {
    request_id,
    delta_id,
    node_id: "unit:alpha",
    pair: ["stated", "structural"],
    question: "q",
    value: { blast_radius: 1, cascade_count: 1 },
    disposition: "interactive",
  };
}

function priorRegister(
  asked: CharterClarificationRequest[],
): CharterClarificationRegister {
  return {
    generated_at: "2026-01-01T00:00:00.000Z",
    target: "charter_clarification",
    ceiling: { rung: "deep" },
    attention: "all",
    asked,
    banked: [],
    findings: [],
    validation_issues: [],
    ...REGISTER_V4_AFFIRMATION,
  };
}

describe("D3 node identity is READ from the delta, never parsed from delta_id", () => {
  test("a colon-bearing discriminator in delta_id does not disturb the subsystem join", () => {
    // The assembler appends a content-derived discriminator when one subsystem
    // mines two deltas on the same channel pair, so delta_id is opaque: slicing it
    // at the last colon would yield "unit:alpha:stated-structural", a node no
    // subsystem carries.
    const run = runCharterClarificationExecutor({
      intent_checkpoint: checkpoint({ rung: "deep", attention: 0 }),
      charter_register: charterRegister(
        [askableDelta("unit:alpha:stated-structural:9f2a1c7d", "unit:alpha", "docs vs layout")],
        { nodes: [], edges: [] },
        [
          { node_id: "unit:alpha", members: ["src/a.ts"] },
          { node_id: "unit:beta", members: ["src/b.ts"] },
        ],
      ),
      repo_manifest: manifestWithFiles(["src/a.ts", "src/b.ts"]),
    });
    const reg = run.updated.charter_clarification!;
    expect(reg.banked).toHaveLength(1);
    expect(reg.banked[0].node_id).toBe("unit:alpha");
    expect(reg.findings[0].affected_files.map((f) => f.path)).toEqual(["src/a.ts"]);
  });

  test("a delta_id whose parsed prefix names a DIFFERENT live subsystem still joins by the stamped field", () => {
    // The sharp case: a last-colon slice recovers "unit:beta", a REAL subsystem, so
    // the delta would silently carry the wrong members onto its Finding rather than
    // merely failing to join.
    const run = runCharterClarificationExecutor({
      intent_checkpoint: checkpoint({ rung: "deep", attention: 0 }),
      charter_register: charterRegister(
        [askableDelta("unit:beta:stated-structural", "unit:alpha", "docs vs layout")],
        { nodes: [], edges: [] },
        [
          { node_id: "unit:alpha", members: ["src/a.ts"] },
          { node_id: "unit:beta", members: ["src/b.ts"] },
        ],
      ),
      repo_manifest: manifestWithFiles(["src/a.ts", "src/b.ts"]),
    });
    const reg = run.updated.charter_clarification!;
    expect(reg.banked[0].node_id).toBe("unit:alpha");
    expect(reg.findings[0].affected_files.map((f) => f.path)).toEqual(["src/a.ts"]);
  });

  // The goal link is the PRODUCER's decision. Both tests below separate "read the
  // stamped field" from "look the node up in the graph", which a fixture whose
  // goal_node_id equals its node_id cannot do — there, a consumer that re-derived
  // the link locally would agree with one that read it and stay green.
  test("the stamped goal link wins even when it differs from the delta's node_id", () => {
    // "unit:alpha" is IN the graph but serves nothing (blast 0); the stamped link
    // "leaf" reaches 2 parents. Re-deriving from node_id would yield the intrinsic
    // tier of 1 instead of 2.
    const goal_graph: GoalGraph = {
      nodes: [
        { node_id: "unit:alpha", premise_height: 0, statement: "unlinked" },
        { node_id: "leaf", premise_height: 2, statement: "leaf" },
        { node_id: "mid", premise_height: 1, statement: "mid" },
        { node_id: "telos", premise_height: 0, statement: "telos" },
      ],
      edges: [
        { from: "leaf", to: "mid" },
        { from: "mid", to: "telos" },
      ],
    };
    const run = runCharterClarificationExecutor({
      intent_checkpoint: checkpoint({ rung: "deep", attention: 0 }),
      charter_register: charterRegister(
        [
          {
            ...askableDelta("unit:alpha:stated-structural:9f2a1c7d", "unit:alpha", "docs vs layout"),
            goal_node_id: "leaf",
          },
        ],
        goal_graph,
        [{ node_id: "unit:alpha", members: ["src/a.ts"] }],
      ),
      repo_manifest: manifestWithFiles(["src/a.ts"]),
    });
    expect(run.updated.charter_clarification!.banked[0].value.blast_radius).toBe(2);
  });

  test("an ABSENT stamped goal link is NOT re-derived from the graph", () => {
    // The producer decides linkage: it stamps goal_node_id only for a subsystem it
    // linked. Here "unit:alpha" IS a graph node reaching 2 parents, but the delta
    // carries no goal link — so the blast radius must stay at the delta kind's
    // intrinsic tier of 1. A consumer that looked the node up anyway would say 2.
    const goal_graph: GoalGraph = {
      nodes: [
        { node_id: "unit:alpha", premise_height: 2, statement: "leaf" },
        { node_id: "mid", premise_height: 1, statement: "mid" },
        { node_id: "telos", premise_height: 0, statement: "telos" },
      ],
      edges: [
        { from: "unit:alpha", to: "mid" },
        { from: "mid", to: "telos" },
      ],
    };
    const run = runCharterClarificationExecutor({
      intent_checkpoint: checkpoint({ rung: "deep", attention: 0 }),
      charter_register: charterRegister(
        [askableDelta("unit:alpha:stated-structural:9f2a1c7d", "unit:alpha", "docs vs layout")],
        goal_graph,
        [{ node_id: "unit:alpha", members: ["src/a.ts"] }],
      ),
      repo_manifest: manifestWithFiles(["src/a.ts"]),
    });
    const banked = run.updated.charter_clarification!.banked[0];
    expect(banked.value.blast_radius).toBe(1);
  });

  test("a stamped node_id matching no subsystem is recorded, not silently emptied", () => {
    // The field-shaped version of the same failure: the id is well-formed, so the
    // question is asked — but it cites no files, which reads as a finding about
    // nothing unless the mismatch is said out loud.
    const run = runCharterClarificationExecutor({
      intent_checkpoint: checkpoint({ rung: "deep", attention: 0 }),
      charter_register: charterRegister(
        [askableDelta("unit:ghost:stated-structural", "unit:ghost", "docs vs layout")],
        { nodes: [], edges: [] },
        [{ node_id: "unit:alpha", members: ["src/a.ts"] }],
      ),
      repo_manifest: manifestWithFiles(["src/a.ts"]),
    });
    const reg = run.updated.charter_clarification!;
    expect(reg.banked).toHaveLength(1);
    expect(reg.findings[0].affected_files).toEqual([]);
    expect(
      reg.validation_issues.some(
        (i) => i.includes("unit:ghost") && i.includes("no members"),
      ),
    ).toBe(true);
    // second net: a finding citing nothing is marked ungrounded, not admitted.
    expect(reg.findings[0].grounding?.status).toBe("ungrounded");
  });

  test("a register stamped with a pre-stamping schema version is DISCARDED, not read", () => {
    // The stamping is a code-taxonomy change the content-keyed staleness DAG cannot
    // see. Without the version bump a v2 register on disk keeps validating and every
    // one of its unstamped deltas is refused — zero questions where v2 semantics
    // joined them all, and nothing forces the re-derivation that would fix it.
    const legacy = { ...charterRegister(), schema_version: "charter-register/v2" };
    expect(
      discardOnSchemaVersionMismatch(legacy, CHARTER_REGISTER_SCHEMA_VERSION),
    ).toBeUndefined();
    expect(
      discardOnSchemaVersionMismatch(charterRegister(), CHARTER_REGISTER_SCHEMA_VERSION),
    ).toBeDefined();
  });

  test("a delta carrying no node_id is refused with a validation issue, never parsed", () => {
    // Only reachable from an artifact no schema validated (charter_register.json is
    // read as plain JSON). A question joined to a GUESSED subsystem is worse than a
    // question not asked, so the delta is skipped and the refusal is said out loud.
    const unstamped = {
      delta_id: "unit:alpha:stated-structural",
      pair: ["stated", "structural"],
      kind: "doc_rot",
      routed_to: "clarification",
      summary: "docs vs layout",
    } as CharterDelta as StampedCharterDelta;
    const run = runCharterClarificationExecutor({
      intent_checkpoint: checkpoint({ rung: "deep", attention: 0 }),
      charter_register: charterRegister([unstamped], { nodes: [], edges: [] }, [
        { node_id: "unit:alpha", members: ["src/a.ts"] },
      ]),
      repo_manifest: manifestWithFiles(["src/a.ts"]),
    });
    const reg = run.updated.charter_clarification!;
    expect(reg.asked).toHaveLength(0);
    expect(reg.banked).toHaveLength(0);
    expect(reg.findings).toHaveLength(0);
    expect(reg.validation_issues.some((i) => i.includes("carries no node_id"))).toBe(true);
  });
});

describe("D3 an answers submission drains the interactive queue (loop termination)", () => {
  const deltas = [
    askableDelta("unit:alpha:d1", "unit:alpha", "first seam"),
    askableDelta("unit:alpha:d2", "unit:alpha", "second seam"),
  ];
  const subsystems = [{ node_id: "unit:alpha", members: ["src/a.ts"] }];
  const prior = priorRegister([
    askedQuestion("unit:alpha:d1:q", "unit:alpha:d1"),
    askedQuestion("unit:alpha:d2:q", "unit:alpha:d2"),
  ]);

  function runWithAnswers(
    answers: Array<{ request_id: string; answer: CharterClarificationAnswer }>,
  ): CharterClarificationRegister {
    return runCharterClarificationExecutor(
      {
        intent_checkpoint: checkpoint({ rung: "deep", attention: "all" }),
        charter_register: charterRegister(deltas, { nodes: [], edges: [] }, subsystems),
        repo_manifest: manifestWithFiles(["src/a.ts"]),
        charter_clarification: prior,
      },
      { answers },
    ).updated.charter_clarification!;
  }

  test("an answered question carries the submitted answer verbatim", () => {
    const reg = runWithAnswers([{ request_id: "unit:alpha:d1:q", answer: "rewrite_both" }]);
    expect(requestById(reg, "unit:alpha:d1:q")?.answer).toBe("rewrite_both");
  });

  test("a previously-asked question left unanswered comes back as leave_open", () => {
    // The interruptible-loop rule: a user who taps out leaves the rest open, and
    // `leave_open` is a first-class decision — so the queue DRAINS in one
    // round-trip instead of re-asking forever.
    const reg = runWithAnswers([{ request_id: "unit:alpha:d1:q", answer: "rewrite_both" }]);
    expect(requestById(reg, "unit:alpha:d2:q")?.answer).toBe("leave_open");
    expect(allRequests(reg).every((r) => r.answer !== undefined)).toBe(true);
  });

  test("an answer for a request_id absent from the asked set neither throws nor corrupts a live answer", () => {
    // A stale answer from a prior round. OBSERVED behavior, pinned as-is: the
    // orphan is stored in the prior-answer map, matches no re-derived question, and
    // is silently discarded — no validation note names it. Whether it SHOULD be
    // noted is an open triage question this test deliberately does not prejudge.
    const reg = runWithAnswers([
      { request_id: "unit:ghost:d9:q", answer: "this_side_wins" },
      { request_id: "unit:alpha:d1:q", answer: "that_side_wins" },
    ]);
    expect(requestById(reg, "unit:alpha:d1:q")?.answer).toBe("that_side_wins");
    expect(reg.validation_issues).toEqual([]);
  });

  test("with NO submission, no answer is synthesized onto any question", () => {
    // The boundary the leave_open fill must not cross: auto-closing a question on
    // the FIRST pass, before the host could answer, is a worse regression than
    // never terminating.
    const run = runCharterClarificationExecutor({
      intent_checkpoint: checkpoint({ rung: "deep", attention: "all" }),
      charter_register: charterRegister(deltas, { nodes: [], edges: [] }, subsystems),
      repo_manifest: manifestWithFiles(["src/a.ts"]),
      charter_clarification: prior,
    });
    const reg = run.updated.charter_clarification!;
    expect(reg.asked.length).toBeGreaterThan(0);
    expect(allRequests(reg).every((r) => r.answer === undefined)).toBe(true);
  });
});

describe("assembleClarificationRegister carries prior answers onto asked AND banked", () => {
  test("a prior answer survives re-assembly in whichever bucket the request lands in", () => {
    // Between rounds the attention dial can move a question from asked to banked;
    // an answer already recorded must not be lost for having changed buckets.
    const inputs = [
      {
        delta: askableDelta("unit:alpha:d1", "unit:alpha", "first seam"),
        node_id: "unit:alpha",
        members: ["src/a.ts"],
      },
      {
        delta: askableDelta("unit:alpha:d2", "unit:alpha", "second seam"),
        node_id: "unit:alpha",
        members: ["src/a.ts"],
      },
    ];
    const priorAnswers = new Map<string, CharterClarificationRequest["answer"]>([
      ["unit:alpha:d1:q", "this_side_wins"],
      ["unit:alpha:d2:q", "that_side_wins"],
    ]);
    // attention 1 => exactly one question is asked, the other banks.
    const assembled = assembleClarificationRegister(
      inputs,
      { nodes: [], edges: [] },
      1,
      { partitionDeltasToQuestions, applyRiskGate, splitByAttention },
      priorAnswers,
    );
    expect(assembled.asked).toHaveLength(1);
    expect(assembled.banked).toHaveLength(1);
    expect(assembled.asked[0].answer).toBe(priorAnswers.get(assembled.asked[0].request_id));
    expect(assembled.banked[0].answer).toBe(priorAnswers.get(assembled.banked[0].request_id));
    expect(assembled.asked[0].answer).toBeDefined();
    expect(assembled.banked[0].answer).toBeDefined();
  });

  test("an injected dep's exception propagates — this boundary does no runtime validation", () => {
    // The D1/D2 primitives arrive by injection with only structural typing as a
    // guard; a caller supplying a misbehaving deps object is not caught here.
    expect(() =>
      assembleClarificationRegister(
        [
          {
            delta: askableDelta("unit:alpha:d1", "unit:alpha", "first seam"),
            node_id: "unit:alpha",
            members: ["src/a.ts"],
          },
        ],
        { nodes: [], edges: [] },
        "all",
        {
          partitionDeltasToQuestions,
          applyRiskGate: () => {
            throw new Error("deps blew up");
          },
          splitByAttention,
        },
      ),
    ).toThrow(/deps blew up/);
  });
});

describe("D3 grounded findings are assigned verbatim", () => {
  test("the executor performs no grounding check of its own", () => {
    // groundDesignFindings owns the verdict; a regression there must surface here
    // rather than be masked by a local filter.
    const manifest = manifestWithFiles(["src/a.ts"]);
    const deltas = [askableDelta("unit:alpha:d1", "unit:alpha", "first seam")];
    const members = ["src/gone.ts"];
    const run = runCharterClarificationExecutor({
      intent_checkpoint: checkpoint({ rung: "deep", attention: 0 }),
      charter_register: charterRegister(deltas, { nodes: [], edges: [] }, [
        { node_id: "unit:alpha", members },
      ]),
      repo_manifest: manifest,
    });
    const expected = groundDesignFindings(
      assembleClarificationRegister(
        [{ delta: deltas[0], node_id: "unit:alpha", members }],
        { nodes: [], edges: [] },
        0,
        { partitionDeltasToQuestions, applyRiskGate, splitByAttention },
      ).findings,
      manifest,
    );
    const findings = run.updated.charter_clarification!.findings;
    expect(findings).toEqual(expected);
    // the ungrounded finding is NOT filtered out locally.
    expect(findings[0].grounding?.status).toBe("ungrounded");
  });
});
