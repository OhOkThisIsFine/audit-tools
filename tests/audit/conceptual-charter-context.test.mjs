/**
 * CP-NODE-8 — Phase C residual: charters threaded into the conceptual prompt.
 *   - renderCharterContext renders per-subsystem charters + opine/flag disposition
 *   - shallow + deep conceptual prompts carry the charter block when present
 *   - byte-identical charter-unaware fallback when register is
 *     absent / omitted / empty (no surviving charters)
 */
import { test, expect } from "vitest";

const {
  renderCharterContext,
  renderConceptualReviewPrompt,
  renderConceptualPerspectivePrompt,
  selectPerspectives,
} = await import("../../src/audit/orchestrator/designReviewPrompt.ts");

function baseBundle(charterRegister) {
  const bundle = {
    repo_manifest: {
      repository: { name: "test-repo" },
      files: [{ path: "src/a.ts", language: "typescript", size_bytes: 100 }],
    },
    unit_manifest: { units: [] },
    surface_manifest: { surfaces: [] },
    graph_bundle: { graphs: {} },
    critical_flows: { flows: [] },
    risk_register: { items: [] },
    design_assessment: { generated_at: "2026-01-01T00:00:00Z", findings: [] },
  };
  if (charterRegister !== undefined) bundle.charter_register = charterRegister;
  return bundle;
}

function charter(kind, purpose, confidence = "high") {
  return {
    charter_id: `${kind}-1`,
    kind,
    purpose,
    provenance: [],
    confidence,
  };
}

function populatedRegister() {
  return {
    generated_at: "2026-01-01T00:00:00Z",
    target: "charter",
    ceiling: { rung: "deep" },
    subsystems: [
      {
        node_id: "quota",
        members: ["src/shared/quota/a.ts", "src/shared/quota/b.ts"],
        charters: [
          charter("stated", "quota exists so cooperating auditors share finite budgets"),
          charter("revealed", "quota actually optimizes for single-auditor throughput", "low"),
        ],
      },
    ],
    goal_graph: { nodes: [], edges: [] },
    deltas: [],
    findings: [],
    validation_issues: [],
  };
}

// ── renderCharterContext ──────────────────────────────────────────────────────

test("renderCharterContext: renders per-subsystem charters with telos framing", () => {
  const block = renderCharterContext(baseBundle(populatedRegister()));
  expect(block).toMatch(/Subsystem charters/);
  expect(block).toMatch(/\*\*quota\*\*/);
  expect(block).toMatch(/src\/shared\/quota\/a\.ts/);
  expect(block).toMatch(/\[stated\] quota exists so cooperating auditors/);
  expect(block).toMatch(/\[revealed\] quota actually optimizes/);
  // per-charter opine framing present
  expect(block).toMatch(/Opine PER CHARTER/);
});

test("renderCharterContext: low-confidence charter is FLAGGED not opined", () => {
  const block = renderCharterContext(baseBundle(populatedRegister()));
  // the low-confidence revealed charter carries the flag-for-human disposition
  expect(block).toMatch(/\[revealed\] quota actually optimizes.*LOW-CONFIDENCE charter: FLAG for human/);
  // the confident stated charter carries no such marker on its own line
  const statedLine = block
    .split("\n")
    .find((l) => l.includes("[stated] quota exists"));
  expect(statedLine).not.toMatch(/LOW-CONFIDENCE/);
});

test("renderCharterContext: empty when register absent / omitted / no surviving charters", () => {
  // absent (old bundle)
  expect(renderCharterContext(baseBundle(undefined))).toBe("");
  // omitted (shallow ceiling)
  expect(
    renderCharterContext(
      baseBundle({
        generated_at: "2026-01-01T00:00:00Z",
        target: "charter",
        ceiling: { rung: "shallow" },
        status: "omitted",
        subsystems: [],
        goal_graph: { nodes: [], edges: [] },
        deltas: [],
        findings: [],
        validation_issues: [],
      }),
    ),
  ).toBe("");
  // present but no subsystem carries a charter
  expect(
    renderCharterContext(
      baseBundle({
        generated_at: "2026-01-01T00:00:00Z",
        target: "charter",
        ceiling: { rung: "deep" },
        subsystems: [{ node_id: "x", members: ["src/x.ts"], charters: [] }],
        goal_graph: { nodes: [], edges: [] },
        deltas: [],
        findings: [],
        validation_issues: [],
      }),
    ),
  ).toBe("");
});

// ── threading into the conceptual prompts ─────────────────────────────────────

test("shallow conceptual prompt carries the charter block when the register is populated", () => {
  const prompt = renderConceptualReviewPrompt(baseBundle(populatedRegister()), {
    max_units: 5,
  });
  expect(prompt).toMatch(/Subsystem charters/);
  expect(prompt).toMatch(/\[stated\] quota exists/);
});

test("deep perspective prompt carries the charter block when the register is populated", () => {
  const [p] = selectPerspectives(5);
  const prompt = renderConceptualPerspectivePrompt(
    baseBundle(populatedRegister()),
    p,
    0,
    5,
    { max_units: 5 },
  );
  expect(prompt).toMatch(/Subsystem charters/);
  expect(prompt).toMatch(/\[revealed\] quota actually optimizes/);
});

// ── byte-identical charter-unaware fallback ───────────────────────────────────

test("shallow conceptual prompt is byte-identical with an absent vs omitted vs empty register", () => {
  const absent = renderConceptualReviewPrompt(baseBundle(undefined), { max_units: 5 });
  const omitted = renderConceptualReviewPrompt(
    baseBundle({
      generated_at: "2026-01-01T00:00:00Z",
      target: "charter",
      ceiling: { rung: "shallow" },
      status: "omitted",
      subsystems: [],
      goal_graph: { nodes: [], edges: [] },
      deltas: [],
      findings: [],
      validation_issues: [],
    }),
    { max_units: 5 },
  );
  expect(omitted).toBe(absent);
  // and neither mentions the charter block
  expect(absent).not.toMatch(/Subsystem charters/);
});

test("deep perspective prompt is byte-identical when the register is absent vs omitted", () => {
  const [p] = selectPerspectives(5);
  const absent = renderConceptualPerspectivePrompt(baseBundle(undefined), p, 0, 5, {
    max_units: 5,
  });
  const omitted = renderConceptualPerspectivePrompt(
    baseBundle({
      generated_at: "2026-01-01T00:00:00Z",
      target: "charter",
      ceiling: { rung: "shallow" },
      status: "omitted",
      subsystems: [],
      goal_graph: { nodes: [], edges: [] },
      deltas: [],
      findings: [],
      validation_issues: [],
    }),
    p,
    0,
    5,
    { max_units: 5 },
  );
  expect(omitted).toBe(absent);
  expect(absent).not.toMatch(/Subsystem charters/);
});
