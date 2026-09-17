import { EMPTY_REGISTER_BODY } from "../helpers/charterRegisterFixture.js";
import { describe, test, expect } from "vitest";

// Phase D — the charter-difference clarification loop over the five-step
// charter layer. Import the pure D1/D2 primitives + the D3 executor from source
// (tsx loader) so un-rebuilt changes are caught.
import {
  goalBlastRadius,
  differenceBlastRadius,
} from "../../src/audit/clarification/blastRadius.js";
import { voiScore, voiQueue } from "../../src/audit/clarification/voiQueue.js";
import {
  applyRiskGate,
  DEFAULT_RISK_GATE_THRESHOLDS,
} from "../../src/audit/clarification/riskGate.js";
import { splitByAttention } from "../../src/audit/clarification/dials.js";
import { partitionDifferencesToQuestions } from "../../src/audit/clarification/partition.js";
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
  type Ceiling,
  type ClarificationAttention,
  type ClarificationDifferenceInput,
  type CharterCorrespondence,
  type CharterDifference,
  type CharterDifferenceAnswer,
  type CharterDifferenceQuestion,
  type CharterLaneGraph,
  type IntentCheckpoint,
} from "audit-tools/shared";
import type { CharterClarificationRegister } from "../../src/audit/types/charterClarification.js";

function manifestWithFiles(paths: string[]): RepoManifest {
  return {
    repository: { name: "fixture" },
    generated_at: "2026-01-01T00:00:00.000Z",
    files: paths.map((path) => ({ path, language: "typescript", size_bytes: 100 })),
  };
}

const DEPS = { partitionDifferencesToQuestions, applyRiskGate, splitByAttention };

/** One lane DAG with the given nodes (files default to src/a.ts) and serves-edges. */
function laneGraph(
  kind: CharterLaneGraph["kind"],
  nodes: Array<{ id: string; files?: string[] }>,
  edges: Array<[string, string]> = [],
): CharterLaneGraph {
  return {
    kind,
    nodes: nodes.map((n) => ({
      node_id: n.id,
      purpose: `purpose of ${n.id}`,
      premise_height: 0,
      files: n.files ?? ["src/a.ts"],
      provenance: [],
      confidence: "high",
    })),
    edges: edges.map(([from, to]) => ({ from, to, provenance: [] })),
  };
}

function correspondence(
  correspondence_id: string,
  members: Array<[CharterLaneGraph["kind"], string]>,
): CharterCorrespondence {
  return {
    correspondence_id,
    members: members.map(([kind, id]) => ({ kind, node_ids: [id] })),
    basis: "tool",
    evidence: [],
  };
}

/** A SUPPORTED, clarification-routed difference (the shape that sources a question). */
function difference(
  difference_id: string,
  correspondence_id: string,
  over: Partial<CharterDifference> = {},
): CharterDifference {
  return {
    difference_id,
    correspondence_id,
    dimension: "scope",
    relation: "incompatible",
    split: { kind: "two_against_one", odd: "revealed" },
    accounts: [
      { kind: "stated", claim: "covers every lens", provenance: [] },
      { kind: "revealed", claim: "covers the security lens only", provenance: [] },
    ],
    gap: `gap ${difference_id}`,
    routed_to: "clarification",
    finding_candidate: true,
    fidelity: { verdict: "supported", rationale: "both slices say so", decided_by: "lane" },
    ...over,
  };
}

function input(
  d: CharterDifference,
  corr: CharterCorrespondence | undefined,
  members: string[] = ["src/a.ts"],
  subsystem_id?: string,
): ClarificationDifferenceInput {
  return { difference: d, correspondence: corr, members, ...(subsystem_id ? { subsystem_id } : {}) };
}

// ── D1: blast radius over a lane goal DAG ─────────────────────────────────────

describe("D1 goalBlastRadius", () => {
  const graph = laneGraph("stated", [{ id: "telos" }, { id: "a" }, { id: "b" }, { id: "leaf" }], [
    ["a", "telos"],
    ["b", "telos"],
    ["leaf", "a"],
    ["leaf", "b"],
  ]);

  test("counts the transitive parent closure (upward ripple)", () => {
    expect(goalBlastRadius(graph, "leaf")).toBe(3); // a, b, telos
    expect(goalBlastRadius(graph, "a")).toBe(1);
    expect(goalBlastRadius(graph, "telos")).toBe(0);
  });

  test("a node absent from the graph has blast radius 0", () => {
    expect(goalBlastRadius(graph, "ghost")).toBe(0);
  });

  test("is cycle-safe (a malformed cyclic graph never loops)", () => {
    const cyclic = { edges: [{ from: "x", to: "y" }, { from: "y", to: "x" }] };
    expect(goalBlastRadius(cyclic, "x")).toBe(2);
  });
});

describe("D1 differenceBlastRadius — the MAX over the three lane DAGs, floored at the tier", () => {
  test("falls back to the dimension's intrinsic tier with no corresponding node reach", () => {
    expect(differenceBlastRadius(difference("d", "c", { dimension: "standard" }), undefined, [])).toBe(1);
    expect(differenceBlastRadius(difference("d", "c", { dimension: "purpose" }), undefined, [])).toBe(2);
    expect(
      differenceBlastRadius(difference("d", "c", { split: { kind: "three_way" } }), undefined, []),
    ).toBe(3);
  });

  test("refines the tier UPWARD from whichever lane's graph reaches highest, never downward", () => {
    const stated = laneGraph("stated", [{ id: "n" }, { id: "p1" }, { id: "p2" }, { id: "p3" }], [
      ["n", "p1"],
      ["n", "p2"],
      ["p1", "p3"],
    ]);
    const revealed = laneGraph("revealed", [{ id: "r" }]);
    const corr = correspondence("c", [
      ["stated", "n"],
      ["revealed", "r"],
    ]);
    // stated reach = {p1, p2, p3} = 3; revealed reach = 0 — the max lifts a tier-1 record to 3.
    expect(differenceBlastRadius(difference("d", "c", { dimension: "scope" }), corr, [stated, revealed])).toBe(3);
    // a leaf-only correspondence stays at the purpose tier (intrinsic 2 > graph 0).
    const leafCorr = correspondence("c", [["stated", "p3"]]);
    expect(differenceBlastRadius(difference("d", "c", { dimension: "purpose" }), leafCorr, [stated])).toBe(2);
  });
});

// ── D1: VOI queue ────────────────────────────────────────────────────────────

const mkReq = (
  id: string,
  blast: number,
  cascade = 0,
  disposition: CharterDifferenceQuestion["disposition"] = "interactive",
): CharterDifferenceQuestion => ({
  request_id: id,
  difference_id: id.replace(/:q$/, ""),
  dimension: "scope",
  relation: "incompatible",
  split: { kind: "two_against_one", odd: "revealed" },
  accounts: difference("x", "c").accounts,
  question: "q",
  value: { blast_radius: blast, cascade_count: cascade },
  disposition,
});

describe("D1 voiQueue", () => {
  test("voiScore adds blast radius + cascade count", () => {
    expect(voiScore(mkReq("a:q", 3, 2))).toBe(5);
  });

  test("orders by descending VOI, ties broken by request_id", () => {
    const q = voiQueue([mkReq("b:q", 1, 1), mkReq("a:q", 3, 0), mkReq("c:q", 1, 1)]);
    expect(q.map((r) => r.request_id)).toEqual(["a:q", "b:q", "c:q"]);
  });

  test("does not mutate the input", () => {
    const inputs = [mkReq("b:q", 1, 1), mkReq("a:q", 3, 0)];
    const snapshot = inputs.map((r) => r.request_id);
    voiQueue(inputs);
    expect(inputs.map((r) => r.request_id)).toEqual(snapshot);
  });
});

// ── D1: risk gate ────────────────────────────────────────────────────────────

describe("D1 applyRiskGate", () => {
  test("a low-blast question stays interactive", () => {
    const [r] = applyRiskGate([mkReq("low", 1)]);
    expect(r!.disposition).toBe("interactive");
  });

  test("a high-blast question with no refutations is downgraded to finding_only", () => {
    const [r] = applyRiskGate([mkReq("high", DEFAULT_RISK_GATE_THRESHOLDS.highBlastThreshold)]);
    expect(r!.disposition).toBe("finding_only");
  });

  test("a high-blast question that cleared the adversarial bar stays interactive", () => {
    const refutations = new Map([["high", DEFAULT_RISK_GATE_THRESHOLDS.requiredRefutations]]);
    const [r] = applyRiskGate([mkReq("high", 3)], refutations);
    expect(r!.disposition).toBe("interactive");
  });
});

// ── D2: attention dial ───────────────────────────────────────────────────────

describe("D2 splitByAttention", () => {
  test("appetite 0 (autonomous) banks every question", () => {
    const split = splitByAttention([mkReq("a", 3), mkReq("b", 1)], 0);
    expect(split.asked).toHaveLength(0);
    expect(split.banked.map((r) => r.request_id).sort()).toEqual(["a", "b"]);
  });

  test("a finite appetite takes the top-N of the VOI queue (highest-leverage first)", () => {
    const split = splitByAttention([mkReq("low", 1), mkReq("high", 3), mkReq("mid", 2)], 1);
    expect(split.asked.map((r) => r.request_id)).toEqual(["high"]);
    expect(split.banked.map((r) => r.request_id)).toEqual(["mid", "low"]);
  });

  test("finding_only questions are never asked, even under high appetite", () => {
    const split = splitByAttention([mkReq("a", 3, 0, "finding_only"), mkReq("b", 1)], "all");
    expect(split.asked.map((r) => r.request_id)).toEqual(["b"]);
    expect(split.banked.map((r) => r.request_id)).toEqual(["a"]);
  });
});

// ── D2: partition ────────────────────────────────────────────────────────────

describe("D2 partitionDifferencesToQuestions", () => {
  const corr = correspondence("c1", [
    ["stated", "s"],
    ["revealed", "r"],
  ]);

  test("only clarification/human-routed SUPPORTED differences source a question", () => {
    const questions = partitionDifferencesToQuestions(
      [
        input(difference("d1", "c1"), corr),
        input(difference("d2", "c1", { routed_to: "remediator" }), corr),
        input(difference("d3", "c1", { routed_to: "human" }), corr),
        input(difference("d4", "c1", { fidelity: { verdict: "interpretation", over_read_side: "stated", rationale: "r", decided_by: "lane" } }), corr),
        input(difference("d5", "c1", { fidelity: undefined }), corr),
      ],
      [],
    );
    expect(questions.map((q) => q.difference_id)).toEqual(["d1", "d3"]);
  });

  test("cascade_count = sibling question-sourcing differences on the same correspondence", () => {
    const other = correspondence("c2", [["stated", "s2"]]);
    const questions = partitionDifferencesToQuestions(
      [
        input(difference("d1", "c1"), corr),
        input(difference("d2", "c1", { routed_to: "human" }), corr),
        input(difference("d3", "c2"), other),
      ],
      [],
    );
    expect(questions.find((q) => q.difference_id === "d1")!.value.cascade_count).toBe(1);
    expect(questions.find((q) => q.difference_id === "d3")!.value.cascade_count).toBe(0);
  });

  test("questions are n-ary and symmetric — every account is shown, none anointed", () => {
    const [q] = partitionDifferencesToQuestions([input(difference("d1", "c1"), corr)], []);
    expect(q!.question).toMatch(/leave open/i);
    expect(q!.question).toContain("**stated**");
    expect(q!.question).toContain("**revealed**");
    expect(q!.question).toContain("revealed against the rest");
    expect(q!.accounts).toHaveLength(2);
    expect(q!.disposition).toBe("interactive");
    expect(q!.request_id).toBe("d1:q");
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
      answered_at: "2026-01-01T00:00:00Z",
      ...(rung ? { ceiling: { rung } } : {}),
      ...(attention !== undefined ? { attention } : {}),
    },
  };
}

/** A deep register: two lanes over src/a.ts + src/b.ts, one correspondence, the given differences. */
function charterRegister(
  differences: CharterDifference[] = [],
  over: Partial<CharterRegister> = {},
): CharterRegister {
  return {
    schema_version: CHARTER_REGISTER_SCHEMA_VERSION,
    generated_at: "2026-01-01T00:00:00.000Z",
    target: "charter",
    ceiling: { rung: "deep" },
    ...EMPTY_REGISTER_BODY,
    lanes: [
      laneGraph("stated", [{ id: "s", files: ["src/a.ts", "src/b.ts"] }]),
      laneGraph("revealed", [{ id: "r", files: ["src/a.ts"] }]),
    ],
    correspondences: [
      correspondence("c1", [
        ["stated", "s"],
        ["revealed", "r"],
      ]),
    ],
    differences,
    ...over,
  };
}

describe("D3 resolveClarificationAttention", () => {
  test("defaults to 0 (autonomous) when unset", () => {
    expect(resolveClarificationAttention(undefined)).toBe(0);
    expect(resolveClarificationAttention(checkpoint({ rung: "deep" }))).toBe(0);
  });

  test("reads the attention dial from the checkpoint", () => {
    expect(resolveClarificationAttention(checkpoint({ attention: 3 }))).toBe(3);
    expect(resolveClarificationAttention(checkpoint({ attention: "all" }))).toBe("all");
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
      charter_register: charterRegister([], { status: "omitted" }),
    });
    expect(run.updated.charter_clarification!.status).toBe("omitted");
  });
});

describe("D3 runCharterClarificationExecutor — run path", () => {
  const differences = [
    difference("d1", "c1", { dimension: "purpose" }),
    difference("d2", "c1", { dimension: "hierarchy", routed_to: "human" }),
  ];

  test("attention 0 (autonomous) banks every question as a finding, none interactive", () => {
    const run = runCharterClarificationExecutor({
      intent_checkpoint: checkpoint({ rung: "deep", attention: 0 }),
      charter_register: charterRegister(differences),
      repo_manifest: manifestWithFiles(["src/a.ts", "src/b.ts"]),
    });
    const reg = run.updated.charter_clarification!;
    expect(reg.status).toBeUndefined();
    expect(reg.asked).toHaveLength(0);
    expect(reg.banked).toHaveLength(2);
    expect(reg.findings).toHaveLength(2);
    // findings cite the union of the corresponding nodes' files.
    expect(reg.findings[0]!.affected_files.map((f) => f.path).sort()).toEqual(["src/a.ts", "src/b.ts"]);
  });

  test("a finite attention with only high-blast (tier 2) questions banks them all after the risk gate", () => {
    const run = runCharterClarificationExecutor({
      intent_checkpoint: checkpoint({ rung: "deep", attention: 1 }),
      charter_register: charterRegister(differences),
      repo_manifest: manifestWithFiles(["src/a.ts", "src/b.ts"]),
    });
    const reg = run.updated.charter_clarification!;
    expect(reg.asked).toHaveLength(0);
    expect(reg.findings).toHaveLength(2);
  });

  test("a low-blast (tier 1) difference reaches the interactive queue under a finite attention", () => {
    const run = runCharterClarificationExecutor({
      intent_checkpoint: checkpoint({ rung: "deep", attention: 1 }),
      charter_register: charterRegister([difference("d1", "c1", { dimension: "scope" })]),
      repo_manifest: manifestWithFiles(["src/a.ts", "src/b.ts"]),
    });
    const reg = run.updated.charter_clarification!;
    expect(reg.asked.map((q) => q.request_id)).toEqual(["d1:q"]);
    expect(reg.banked).toHaveLength(0);
  });

  test("a remediator-routed difference is recorded as a note, not a question", () => {
    const run = runCharterClarificationExecutor({
      intent_checkpoint: checkpoint({ rung: "deep", attention: "all" }),
      charter_register: charterRegister([difference("d1", "c1", { routed_to: "remediator" })]),
      repo_manifest: manifestWithFiles(["src/a.ts", "src/b.ts"]),
    });
    const reg = run.updated.charter_clarification!;
    expect(reg.asked).toHaveLength(0);
    expect(reg.banked).toHaveLength(0);
    expect(reg.validation_issues.some((i) => i.includes("remediator"))).toBe(true);
  });

  test("the question is placed in the structure-decomposition unit its files overlap most", () => {
    const run = runCharterClarificationExecutor({
      intent_checkpoint: checkpoint({ rung: "deep", attention: 0 }),
      charter_register: charterRegister([difference("d1", "c1")]),
      repo_manifest: manifestWithFiles(["src/a.ts", "src/b.ts"]),
      structure_decomposition: {
        generated_at: "2026-01-01T00:00:00.000Z",
        target: "structure",
        node_universe_size: 2,
        source_ids: ["call_import"],
        consensus: [
          { node_id: "unit:alpha", members: ["src/a.ts", "src/b.ts"], agreed_across_source: 1, stable_across_scale: 1, contested: false },
          { node_id: "unit:beta", members: ["src/z.ts"], agreed_across_source: 1, stable_across_scale: 1, contested: false },
        ],
        contested: [],
        findings: [],
      },
    });
    const reg = run.updated.charter_clarification!;
    expect(reg.banked[0]!.subsystem_id).toBe("unit:alpha");
    expect(reg.findings[0]!.title).toContain("unit:alpha");
  });

  test("a register stamped with an earlier schema version is DISCARDED, not read", () => {
    const legacy = { ...charterRegister(), schema_version: "charter-register/v4" };
    expect(discardOnSchemaVersionMismatch(legacy, CHARTER_REGISTER_SCHEMA_VERSION)).toBeUndefined();
    expect(discardOnSchemaVersionMismatch(charterRegister(), CHARTER_REGISTER_SCHEMA_VERSION)).toBeDefined();
  });
});

// ── D3: answer ingestion and the loop-termination guarantee ───────────────────

function allRequests(reg: CharterClarificationRegister): CharterDifferenceQuestion[] {
  return [...reg.asked, ...reg.banked];
}

function requestById(reg: CharterClarificationRegister, request_id: string) {
  return allRequests(reg).find((r) => r.request_id === request_id);
}

function priorRegister(asked: CharterDifferenceQuestion[]): CharterClarificationRegister {
  return {
    generated_at: "2026-01-01T00:00:00.000Z",
    target: "charter_clarification",
    ceiling: { rung: "deep" },
    attention: "all",
    asked,
    banked: [],
    findings: [],
    validation_issues: [],
  };
}

describe("D3 an answers submission drains the interactive queue (loop termination)", () => {
  const differences = [difference("d1", "c1"), difference("d2", "c1")];
  const prior = priorRegister([mkReq("d1:q", 1), mkReq("d2:q", 1)]);

  function runWithAnswers(
    answers: Array<{ request_id: string; answer: CharterDifferenceAnswer }>,
  ): CharterClarificationRegister {
    return runCharterClarificationExecutor(
      {
        intent_checkpoint: checkpoint({ rung: "deep", attention: "all" }),
        charter_register: charterRegister(differences),
        repo_manifest: manifestWithFiles(["src/a.ts", "src/b.ts"]),
        charter_clarification: prior,
      },
      { answers },
    ).updated.charter_clarification!;
  }

  test("an answered question carries the submitted n-ary answer verbatim", () => {
    const reg = runWithAnswers([{ request_id: "d1:q", answer: { governs: "revealed" } }]);
    expect(requestById(reg, "d1:q")?.answer).toEqual({ governs: "revealed" });
  });

  test("a previously-asked question left unanswered comes back as leave_open", () => {
    const reg = runWithAnswers([{ request_id: "d1:q", answer: "rewrite_all" }]);
    expect(requestById(reg, "d2:q")?.answer).toBe("leave_open");
    expect(allRequests(reg).every((r) => r.answer !== undefined)).toBe(true);
  });

  // This case USED to assert the opposite — that an unasked id "neither throws
  // nor corrupts a live answer". That reading was measured wrong on 2026-09-17:
  // an unasked id is not inert. `request_id` is a free string at the gate, so a
  // mistyped or placeholder id parses, lands in a map nothing reads, and every
  // question the run DID ask falls to the `leave_open` default — the register
  // then records a success over a round whose answers were discarded in silence.
  // Owner decision, 2026-09-17: refuse the whole submission.
  test("an answer for a request_id this run never asked REFUSES the whole submission", () => {
    expect(() =>
      runWithAnswers([
        { request_id: "ghost:q", answer: "rewrite_all" },
        { request_id: "d1:q", answer: { governs: "stated" } },
      ]),
    ).toThrow(/never asked/u);
  });

  test("the refusal names the offending id AND the ids the run did ask", () => {
    let message = "";
    try {
      runWithAnswers([{ request_id: "ghost:q", answer: "rewrite_all" }]);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message, "a refusal that names neither half is unactionable").toContain('"ghost:q"');
    expect(message).toContain("d1:q");
    expect(message).toContain("d2:q");
  });

  // The CONTROL. A submission whose ids are all asked must pass untouched —
  // without it the refusal above is satisfied by a check that refuses everything.
  test("a submission naming only asked ids is accepted", () => {
    const reg = runWithAnswers([
      { request_id: "d1:q", answer: { governs: "stated" } },
      { request_id: "d2:q", answer: "rewrite_all" },
    ]);
    expect(requestById(reg, "d1:q")?.answer).toEqual({ governs: "stated" });
    expect(requestById(reg, "d2:q")?.answer).toBe("rewrite_all");
    expect(reg.validation_issues).toEqual([]);
  });

  test("with NO submission, no answer is synthesized onto any question", () => {
    const run = runCharterClarificationExecutor({
      intent_checkpoint: checkpoint({ rung: "deep", attention: "all" }),
      charter_register: charterRegister(differences),
      repo_manifest: manifestWithFiles(["src/a.ts", "src/b.ts"]),
      charter_clarification: prior,
    });
    const reg = run.updated.charter_clarification!;
    expect(reg.asked.length).toBeGreaterThan(0);
    expect(allRequests(reg).every((r) => r.answer === undefined)).toBe(true);
  });
});

describe("assembleClarificationRegister carries prior answers onto asked AND banked", () => {
  const corr = correspondence("c1", [["stated", "s"]]);

  test("a prior answer survives re-assembly in whichever bucket the request lands in", () => {
    const inputs = [input(difference("d1", "c1"), corr), input(difference("d2", "c1"), corr)];
    const priorAnswers = new Map<string, CharterDifferenceAnswer>([
      ["d1:q", { governs: "stated" }],
      ["d2:q", "leave_open"],
    ]);
    // attention 1 => exactly one question is asked, the other banks.
    const assembled = assembleClarificationRegister(inputs, [], 1, DEPS, priorAnswers);
    expect(assembled.asked).toHaveLength(1);
    expect(assembled.banked).toHaveLength(1);
    expect(assembled.asked[0]!.answer).toEqual(priorAnswers.get(assembled.asked[0]!.request_id));
    expect(assembled.banked[0]!.answer).toEqual(priorAnswers.get(assembled.banked[0]!.request_id));
  });

  test("an injected dep's exception propagates — this boundary does no runtime validation", () => {
    expect(() =>
      assembleClarificationRegister([input(difference("d1", "c1"), corr)], [], "all", {
        ...DEPS,
        applyRiskGate: () => {
          throw new Error("deps blew up");
        },
      }),
    ).toThrow(/deps blew up/);
  });
});

describe("D3 grounded findings are assigned verbatim", () => {
  test("the executor performs no grounding check of its own", () => {
    // groundDesignFindings owns the verdict; a regression there must surface here
    // rather than be masked by a local filter.
    const manifest = manifestWithFiles(["src/a.ts"]);
    const register = charterRegister([difference("d1", "c1")], {
      lanes: [laneGraph("stated", [{ id: "s", files: ["src/gone.ts"] }]), laneGraph("revealed", [{ id: "r", files: ["src/gone.ts"] }])],
    });
    const run = runCharterClarificationExecutor({
      intent_checkpoint: checkpoint({ rung: "deep", attention: 0 }),
      charter_register: register,
      repo_manifest: manifest,
    });
    const expected = groundDesignFindings(
      assembleClarificationRegister(
        [input(register.differences[0]!, register.correspondences[0], ["src/gone.ts"])],
        register.lanes,
        0,
        DEPS,
      ).findings,
      manifest,
    );
    const findings = run.updated.charter_clarification!.findings;
    expect(findings).toEqual(expected);
    expect(findings[0]!.grounding?.status).toBe("ungrounded");
  });
});

describe("a correspondence with no scoped files is STATED, not silently ungrounded", () => {
  const corr = correspondence("c1", [["stated", "s"]]);

  test("a question whose files are empty gets a note naming the consequence", () => {
    const assembled = assembleClarificationRegister([input(difference("d1", "c1"), corr, [])], [], 0, DEPS);
    expect(assembled.validation_issues).toHaveLength(1);
    expect(assembled.validation_issues[0]).toContain("d1");
    expect(assembled.validation_issues[0]).toContain("no scoped files");
    expect(assembled.findings[0]?.affected_files).toEqual([]);
  });

  test("a question WITH files gets no such note", () => {
    const assembled = assembleClarificationRegister([input(difference("d1", "c1"), corr)], [], 0, DEPS);
    expect(assembled.validation_issues).toEqual([]);
  });
});
