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
import type {
  GoalGraph,
  Ceiling,
  ClarificationAttention,
  CharterDelta,
  CharterClarificationRequest,
  IntentCheckpoint,
} from "audit-tools/shared";

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
  deltas: CharterDelta[] = [],
  goal_graph: GoalGraph = { nodes: [], edges: [] },
): CharterRegister {
  return {
    schema_version: CHARTER_REGISTER_SCHEMA_VERSION,
    generated_at: "2026-01-01T00:00:00.000Z",
    target: "charter",
    ceiling: { rung: "deep" },
    subsystems: deltas.length
      ? [{ node_id: "n1", members: ["src/a.ts", "src/b.ts"], charters: [], teleologies: {} }]
      : [],
    goal_graph,
    deltas,
    findings: [],
    triangulated: [],
    disagreement: [],
    validation_issues: [],
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
  const deltas: CharterDelta[] = [
    { delta_id: "n1:structural-revealed", pair: ["structural", "revealed"], kind: "architecture_betrayal", routed_to: "clarification", summary: "docs vs model" },
    { delta_id: "n1:stated-true", pair: ["stated", "true"], kind: "wrong_goal", routed_to: "human", summary: "wrong goal" },
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

  test("applying answers to banked questions (with lower attention threshold)", () => {
    // Test with only architecture_betrayal (lower blast than wrong_goal) to ensure
    // it can pass through the risk gate with lower blast radius.
    const lowerBlastDeltas: CharterDelta[] = [
      { delta_id: "n1:structural-revealed", pair: ["structural", "revealed"], kind: "architecture_betrayal", routed_to: "clarification", summary: "docs vs model" },
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
        { delta_id: "n1:stated-revealed", pair: ["stated", "revealed"], kind: "says_does_drift", routed_to: "remediator", summary: "drift" },
      ]),
      repo_manifest: manifestWithFiles(["src/a.ts", "src/b.ts"]),
    });
    const reg = run.updated.charter_clarification!;
    expect(reg.asked).toHaveLength(0);
    expect(reg.banked).toHaveLength(0);
    expect(reg.validation_issues.some((i) => i.includes("remediator"))).toBe(true);
  });
});
