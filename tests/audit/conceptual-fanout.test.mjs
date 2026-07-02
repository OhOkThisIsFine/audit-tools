/**
 * Tests for N7 — deep conceptual review = real dispatch fan-out.
 *   - perspective selection / clamping
 *   - perspective + judge prompt rendering
 *   - resolveConceptualReviewSettings (checkpoint > config > default-shallow)
 *   - prepareConceptualDispatch (shallow single prompt vs deep N+judge fan-out)
 */
import { test, onTestFinished, expect } from "vitest";
import { mkdtemp, rm, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  renderConceptualPerspectivePrompt,
  renderConceptualJudgePrompt,
  renderSharedStructuralContext,
  selectPerspectives,
  clampPerspectiveCount,
  CONCEPTUAL_PERSPECTIVES,
  DEFAULT_CONCEPTUAL_PERSPECTIVES,
} = await import("../../src/audit/orchestrator/designReviewPrompt.ts");
const { resolveConceptualReviewSettings, prepareConceptualDispatch } =
  await import("../../src/audit/cli/conceptualDispatch.ts");

function minimalBundle(checkpointOverrides = {}) {
  return {
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
    intent_checkpoint: {
      schema_version: "intent-checkpoint/v1",
      confirmed_at: "2026-01-01T00:00:00Z",
      confirmed_by: "host",
      scope_summary: "full",
      intent_summary: "full-audit",
      ...checkpointOverrides,
    },
  };
}

// ── perspective selection / clamping ──────────────────────────────────────────

test("clampPerspectiveCount: default when undefined / non-finite", () => {
  expect(clampPerspectiveCount(undefined)).toBe(DEFAULT_CONCEPTUAL_PERSPECTIVES);
  expect(clampPerspectiveCount(NaN)).toBe(DEFAULT_CONCEPTUAL_PERSPECTIVES);
});

test("clampPerspectiveCount: floors at 2 and caps at the built-in count", () => {
  expect(clampPerspectiveCount(1)).toBe(2);
  expect(clampPerspectiveCount(0)).toBe(2);
  expect(clampPerspectiveCount(999)).toBe(CONCEPTUAL_PERSPECTIVES.length);
  expect(clampPerspectiveCount(3)).toBe(3);
});

test("selectPerspectives: returns the first N distinct built-in perspectives", () => {
  const four = selectPerspectives(4);
  expect(four.length).toBe(4);
  const names = new Set(four.map((p) => p.name));
  expect(names.size, "perspectives must be distinct").toBe(4);
});

// ── perspective prompt rendering ──────────────────────────────────────────────

test("renderConceptualPerspectivePrompt: carries the perspective, independence note, categories, and shared context", () => {
  const bundle = minimalBundle();
  const [p] = selectPerspectives(5);
  const prompt = renderConceptualPerspectivePrompt(bundle, p, 0, 5, { max_units: 5 });
  expect(prompt).toMatch(new RegExp(p.name));
  expect(prompt).toMatch(/one of 5 independent reviewers/);
  expect(prompt).toMatch(/NOT see the other reviewers/);
  // conceptual categories present, contract categories absent
  expect(prompt).toMatch(/tool_opportunity/);
  expect(prompt).not.toMatch(/inferred_contract_gap/);
  // shares the structural-context prefix
  expect(prompt.includes(renderSharedStructuralContext(bundle, 5))).toBeTruthy();
});

test("renderConceptualJudgePrompt: lists every perspective result path and is framed as independent merge", () => {
  const sources = [
    { name: "Pragmatist", path: "/x/p1.json" },
    { name: "Adversary", path: "/x/p2.json" },
  ];
  const prompt = renderConceptualJudgePrompt(sources);
  expect(prompt).toMatch(/independent judge/i);
  expect(prompt).toMatch(/Deduplicate/i);
  expect(prompt).toMatch(/\/x\/p1\.json/);
  expect(prompt).toMatch(/\/x\/p2\.json/);
  expect(prompt).toMatch(/Pragmatist/);
  expect(prompt).toMatch(/Adversary/);
});

// ── resolveConceptualReviewSettings ───────────────────────────────────────────

test("resolveConceptualReviewSettings: defaults to shallow when neither checkpoint nor config set depth", () => {
  const s = resolveConceptualReviewSettings(minimalBundle(), {});
  expect(s.conceptual_depth).toBe("shallow");
});

test("resolveConceptualReviewSettings: checkpoint wins over session config", () => {
  const bundle = minimalBundle({
    design_review: { conceptual_depth: "deep", perspectives: 4 },
  });
  const s = resolveConceptualReviewSettings(bundle, {
    design_review: { conceptual_depth: "shallow", perspectives: 7 },
  });
  expect(s.conceptual_depth).toBe("deep");
  expect(s.perspectives).toBe(4);
});

test("resolveConceptualReviewSettings: session config is the fallback when checkpoint is silent", () => {
  const s = resolveConceptualReviewSettings(minimalBundle(), {
    design_review: { conceptual_depth: "deep", perspectives: 3, max_units: 9 },
  });
  expect(s.conceptual_depth).toBe("deep");
  expect(s.perspectives).toBe(3);
  expect(s.max_units).toBe(9);
});

// ── prepareConceptualDispatch ─────────────────────────────────────────────────

test("prepareConceptualDispatch (shallow): writes one conceptual prompt, no fan-out", async (t) => {
  const artifactsDir = await mkdtemp(join(tmpdir(), "audit-conceptual-"));
  onTestFinished(() => rm(artifactsDir, { recursive: true, force: true }));
  const dispatch = await prepareConceptualDispatch({
    artifactsDir,
    bundle: minimalBundle(),
    settings: { conceptual_depth: "shallow" },
  });
  expect(dispatch.deep).toBe(false);
  expect(dispatch.readPaths.length).toBe(1);
  expect(dispatch.writePaths.length).toBe(1);
  expect(dispatch.conceptualResultsPath).toMatch(/design-review-conceptual-findings\.json$/);
  await access(dispatch.readPaths[0]); // prompt file exists
});

test("prepareConceptualDispatch (deep): writes N perspective prompts + an independent judge", async (t) => {
  const artifactsDir = await mkdtemp(join(tmpdir(), "audit-conceptual-"));
  onTestFinished(() => rm(artifactsDir, { recursive: true, force: true }));
  const dispatch = await prepareConceptualDispatch({
    artifactsDir,
    bundle: minimalBundle(),
    settings: { conceptual_depth: "deep", perspectives: 3 },
  });
  expect(dispatch.deep).toBe(true);
  // readPaths: 3 perspective prompts + 3 perspective result files + 1 judge prompt (COR-60ca1f72)
  // writePaths: 3 perspective results + 1 judged result
  expect(dispatch.readPaths.length).toBe(7);
  expect(dispatch.writePaths.length).toBe(4);
  // the judge writes the single ingested results file
  expect(dispatch.writePaths[dispatch.writePaths.length - 1]).toBe(dispatch.conceptualResultsPath);
  // perspective prompt files exist on disk (result files don't yet — perspectives haven't run)
  const perspectivePromptPaths = dispatch.readPaths.filter((p) => p.includes("-prompt.md"));
  expect(perspectivePromptPaths.length).toBe(4); // 3 perspective prompts + 1 judge prompt
  for (const p of perspectivePromptPaths) {
    await access(p);
  }
  // instruction text names a 3-perspective fan-out and an independent judge
  const instr = dispatch.instructionLines.join("\n");
  expect(instr).toMatch(/3-perspective fan-out/);
  expect(instr).toMatch(/independent judge/i);
  // judge prompt references each perspective result file
  const judgePromptPath = dispatch.artifactPaths.conceptual_judge_prompt;
  const judgePrompt = await readFile(judgePromptPath, "utf8");
  for (let i = 1; i <= 3; i++) {
    expect(judgePrompt.includes(dispatch.artifactPaths[`conceptual_perspective_${i}_results`]), `judge prompt should reference perspective ${i} results`).toBeTruthy();
  }
});

test("prepareConceptualDispatch (deep): perspective count is clamped to the built-in maximum", async (t) => {
  const artifactsDir = await mkdtemp(join(tmpdir(), "audit-conceptual-"));
  onTestFinished(() => rm(artifactsDir, { recursive: true, force: true }));
  const dispatch = await prepareConceptualDispatch({
    artifactsDir,
    bundle: minimalBundle(),
    settings: { conceptual_depth: "deep", perspectives: 999 },
  });
  // readPaths = N perspective prompts + N perspective result files + 1 judge prompt (COR-60ca1f72)
  expect(dispatch.readPaths.length).toBe(CONCEPTUAL_PERSPECTIVES.length * 2 + 1);
});

// ── F4: conceptual fan-out carries model tiers ────────────────────────────────

test("deep fan-out carries standard tier on perspectives and deep on the judge", async (t) => {
  const artifactsDir = await mkdtemp(join(tmpdir(), "audit-conceptual-"));
  onTestFinished(() => rm(artifactsDir, { recursive: true, force: true }));
  const dispatch = await prepareConceptualDispatch({
    artifactsDir,
    bundle: minimalBundle(),
    settings: { conceptual_depth: "deep", perspectives: 3 },
    hostCanSelectSubagentModel: true,
  });
  expect(dispatch.modelHints).toEqual({
    perspectives: { tier: "standard", reasons: ["conceptual_perspective_ideation"] },
    judge: { tier: "deep", reasons: ["conceptual_judge_synthesis"] },
  });
  const instr = dispatch.instructionLines.join("\n");
  const perspectiveTierCount = (instr.match(/\[model_hint\.tier: standard\]/g) ?? []).length;
  expect(perspectiveTierCount, "each perspective line renders its tier").toBe(3);
  expect(instr).toMatch(/independent judge.*\[model_hint\.tier: deep\]/s);
  expect(instr).toMatch(/Map each `model_hint\.tier`/);
});

test("tiers stay inert metadata when the host cannot select subagent models", async (t) => {
  const artifactsDir = await mkdtemp(join(tmpdir(), "audit-conceptual-"));
  onTestFinished(() => rm(artifactsDir, { recursive: true, force: true }));
  const dispatch = await prepareConceptualDispatch({
    artifactsDir,
    bundle: minimalBundle(),
    settings: { conceptual_depth: "deep", perspectives: 3 },
  });
  expect(dispatch.modelHints?.judge.tier).toBe("deep");
  expect(dispatch.instructionLines.join("\n")).not.toMatch(/model_hint/);
});

test("perspective tier is overridable via settings; shallow path carries no hints", async (t) => {
  const artifactsDir = await mkdtemp(join(tmpdir(), "audit-conceptual-"));
  onTestFinished(() => rm(artifactsDir, { recursive: true, force: true }));
  const deep = await prepareConceptualDispatch({
    artifactsDir,
    bundle: minimalBundle(),
    settings: { conceptual_depth: "deep", perspectives: 2, perspective_tier: "deep" },
    hostCanSelectSubagentModel: true,
  });
  expect(deep.modelHints?.perspectives.tier).toBe("deep");

  const shallow = await prepareConceptualDispatch({
    artifactsDir,
    bundle: minimalBundle(),
    settings: { conceptual_depth: "shallow" },
    hostCanSelectSubagentModel: true,
  });
  expect(shallow.modelHints).toBe(undefined);
  expect(shallow.instructionLines.join("\n")).not.toMatch(/model_hint/);
});

test("resolveConceptualReviewSettings threads perspective_tier from session config", () => {
  const s = resolveConceptualReviewSettings(minimalBundle(), {
    design_review: { conceptual_depth: "deep", perspective_tier: "small" },
  });
  expect(s.perspective_tier).toBe("small");
});
