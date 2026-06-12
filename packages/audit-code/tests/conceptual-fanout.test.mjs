/**
 * Tests for N7 — deep conceptual review = real dispatch fan-out.
 *   - perspective selection / clamping
 *   - perspective + judge prompt rendering
 *   - resolveConceptualReviewSettings (checkpoint > config > default-shallow)
 *   - prepareConceptualDispatch (shallow single prompt vs deep N+judge fan-out)
 */
import test from "node:test";
import assert from "node:assert/strict";
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
} = await import("../src/orchestrator/designReviewPrompt.ts");
const { resolveConceptualReviewSettings, prepareConceptualDispatch } =
  await import("../src/cli/conceptualDispatch.ts");

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
  assert.equal(clampPerspectiveCount(undefined), DEFAULT_CONCEPTUAL_PERSPECTIVES);
  assert.equal(clampPerspectiveCount(NaN), DEFAULT_CONCEPTUAL_PERSPECTIVES);
});

test("clampPerspectiveCount: floors at 2 and caps at the built-in count", () => {
  assert.equal(clampPerspectiveCount(1), 2);
  assert.equal(clampPerspectiveCount(0), 2);
  assert.equal(clampPerspectiveCount(999), CONCEPTUAL_PERSPECTIVES.length);
  assert.equal(clampPerspectiveCount(3), 3);
});

test("selectPerspectives: returns the first N distinct built-in perspectives", () => {
  const four = selectPerspectives(4);
  assert.equal(four.length, 4);
  const names = new Set(four.map((p) => p.name));
  assert.equal(names.size, 4, "perspectives must be distinct");
});

// ── perspective prompt rendering ──────────────────────────────────────────────

test("renderConceptualPerspectivePrompt: carries the perspective, independence note, categories, and shared context", () => {
  const bundle = minimalBundle();
  const [p] = selectPerspectives(5);
  const prompt = renderConceptualPerspectivePrompt(bundle, p, 0, 5, { max_units: 5 });
  assert.match(prompt, new RegExp(p.name));
  assert.match(prompt, /one of 5 independent reviewers/);
  assert.match(prompt, /NOT see the other reviewers/);
  // conceptual categories present, contract categories absent
  assert.match(prompt, /tool_opportunity/);
  assert.doesNotMatch(prompt, /inferred_contract_gap/);
  // shares the structural-context prefix
  assert.ok(prompt.includes(renderSharedStructuralContext(bundle, 5)));
});

test("renderConceptualJudgePrompt: lists every perspective result path and is framed as independent merge", () => {
  const sources = [
    { name: "Pragmatist", path: "/x/p1.json" },
    { name: "Adversary", path: "/x/p2.json" },
  ];
  const prompt = renderConceptualJudgePrompt(sources);
  assert.match(prompt, /independent judge/i);
  assert.match(prompt, /Deduplicate/i);
  assert.match(prompt, /\/x\/p1\.json/);
  assert.match(prompt, /\/x\/p2\.json/);
  assert.match(prompt, /Pragmatist/);
  assert.match(prompt, /Adversary/);
});

// ── resolveConceptualReviewSettings ───────────────────────────────────────────

test("resolveConceptualReviewSettings: defaults to shallow when neither checkpoint nor config set depth", () => {
  const s = resolveConceptualReviewSettings(minimalBundle(), {});
  assert.equal(s.conceptual_depth, "shallow");
});

test("resolveConceptualReviewSettings: checkpoint wins over session config", () => {
  const bundle = minimalBundle({
    design_review: { conceptual_depth: "deep", perspectives: 4 },
  });
  const s = resolveConceptualReviewSettings(bundle, {
    design_review: { conceptual_depth: "shallow", perspectives: 7 },
  });
  assert.equal(s.conceptual_depth, "deep");
  assert.equal(s.perspectives, 4);
});

test("resolveConceptualReviewSettings: session config is the fallback when checkpoint is silent", () => {
  const s = resolveConceptualReviewSettings(minimalBundle(), {
    design_review: { conceptual_depth: "deep", perspectives: 3, max_units: 9 },
  });
  assert.equal(s.conceptual_depth, "deep");
  assert.equal(s.perspectives, 3);
  assert.equal(s.max_units, 9);
});

// ── prepareConceptualDispatch ─────────────────────────────────────────────────

test("prepareConceptualDispatch (shallow): writes one conceptual prompt, no fan-out", async (t) => {
  const artifactsDir = await mkdtemp(join(tmpdir(), "audit-conceptual-"));
  t.after(() => rm(artifactsDir, { recursive: true, force: true }));
  const dispatch = await prepareConceptualDispatch({
    artifactsDir,
    bundle: minimalBundle(),
    settings: { conceptual_depth: "shallow" },
  });
  assert.equal(dispatch.deep, false);
  assert.equal(dispatch.readPaths.length, 1);
  assert.equal(dispatch.writePaths.length, 1);
  assert.match(dispatch.conceptualResultsPath, /design-review-conceptual-findings\.json$/);
  await access(dispatch.readPaths[0]); // prompt file exists
});

test("prepareConceptualDispatch (deep): writes N perspective prompts + an independent judge", async (t) => {
  const artifactsDir = await mkdtemp(join(tmpdir(), "audit-conceptual-"));
  t.after(() => rm(artifactsDir, { recursive: true, force: true }));
  const dispatch = await prepareConceptualDispatch({
    artifactsDir,
    bundle: minimalBundle(),
    settings: { conceptual_depth: "deep", perspectives: 3 },
  });
  assert.equal(dispatch.deep, true);
  // 3 perspective prompts + 1 judge prompt are read; 3 perspective results + 1 judged result written
  assert.equal(dispatch.readPaths.length, 4);
  assert.equal(dispatch.writePaths.length, 4);
  // the judge writes the single ingested results file
  assert.equal(
    dispatch.writePaths[dispatch.writePaths.length - 1],
    dispatch.conceptualResultsPath,
  );
  // every declared prompt file exists on disk
  for (const p of dispatch.readPaths) {
    await access(p);
  }
  // instruction text names a 3-perspective fan-out and an independent judge
  const instr = dispatch.instructionLines.join("\n");
  assert.match(instr, /3-perspective fan-out/);
  assert.match(instr, /independent judge/i);
  // judge prompt references each perspective result file
  const judgePromptPath = dispatch.artifactPaths.conceptual_judge_prompt;
  const judgePrompt = await readFile(judgePromptPath, "utf8");
  for (let i = 1; i <= 3; i++) {
    assert.ok(
      judgePrompt.includes(dispatch.artifactPaths[`conceptual_perspective_${i}_results`]),
      `judge prompt should reference perspective ${i} results`,
    );
  }
});

test("prepareConceptualDispatch (deep): perspective count is clamped to the built-in maximum", async (t) => {
  const artifactsDir = await mkdtemp(join(tmpdir(), "audit-conceptual-"));
  t.after(() => rm(artifactsDir, { recursive: true, force: true }));
  const dispatch = await prepareConceptualDispatch({
    artifactsDir,
    bundle: minimalBundle(),
    settings: { conceptual_depth: "deep", perspectives: 999 },
  });
  // readPaths = N perspectives + 1 judge
  assert.equal(dispatch.readPaths.length, CONCEPTUAL_PERSPECTIVES.length + 1);
});

// ── F4: conceptual fan-out carries model tiers ────────────────────────────────

test("deep fan-out carries standard tier on perspectives and deep on the judge", async (t) => {
  const artifactsDir = await mkdtemp(join(tmpdir(), "audit-conceptual-"));
  t.after(() => rm(artifactsDir, { recursive: true, force: true }));
  const dispatch = await prepareConceptualDispatch({
    artifactsDir,
    bundle: minimalBundle(),
    settings: { conceptual_depth: "deep", perspectives: 3 },
    hostCanSelectSubagentModel: true,
  });
  assert.deepEqual(dispatch.modelHints, {
    perspectives: { tier: "standard", reasons: ["conceptual_perspective_ideation"] },
    judge: { tier: "deep", reasons: ["conceptual_judge_synthesis"] },
  });
  const instr = dispatch.instructionLines.join("\n");
  const perspectiveTierCount = (instr.match(/\[model_hint\.tier: standard\]/g) ?? []).length;
  assert.equal(perspectiveTierCount, 3, "each perspective line renders its tier");
  assert.match(instr, /independent judge.*\[model_hint\.tier: deep\]/s);
  assert.match(instr, /Map each `model_hint\.tier`/);
});

test("tiers stay inert metadata when the host cannot select subagent models", async (t) => {
  const artifactsDir = await mkdtemp(join(tmpdir(), "audit-conceptual-"));
  t.after(() => rm(artifactsDir, { recursive: true, force: true }));
  const dispatch = await prepareConceptualDispatch({
    artifactsDir,
    bundle: minimalBundle(),
    settings: { conceptual_depth: "deep", perspectives: 3 },
  });
  assert.equal(dispatch.modelHints?.judge.tier, "deep");
  assert.doesNotMatch(dispatch.instructionLines.join("\n"), /model_hint/);
});

test("perspective tier is overridable via settings; shallow path carries no hints", async (t) => {
  const artifactsDir = await mkdtemp(join(tmpdir(), "audit-conceptual-"));
  t.after(() => rm(artifactsDir, { recursive: true, force: true }));
  const deep = await prepareConceptualDispatch({
    artifactsDir,
    bundle: minimalBundle(),
    settings: { conceptual_depth: "deep", perspectives: 2, perspective_tier: "deep" },
    hostCanSelectSubagentModel: true,
  });
  assert.equal(deep.modelHints?.perspectives.tier, "deep");

  const shallow = await prepareConceptualDispatch({
    artifactsDir,
    bundle: minimalBundle(),
    settings: { conceptual_depth: "shallow" },
    hostCanSelectSubagentModel: true,
  });
  assert.equal(shallow.modelHints, undefined);
  assert.doesNotMatch(shallow.instructionLines.join("\n"), /model_hint/);
});

test("resolveConceptualReviewSettings threads perspective_tier from session config", () => {
  const s = resolveConceptualReviewSettings(minimalBundle(), {
    design_review: { conceptual_depth: "deep", perspective_tier: "small" },
  });
  assert.equal(s.perspective_tier, "small");
});
