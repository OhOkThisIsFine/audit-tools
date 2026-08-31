import { describe, expect, test } from "vitest";

import {
  buildCandidateInvocation,
  driveCandidateLoop,
  runCandidateArm,
  evaluateBenchmarkScores,
  validateBenchmarkManifest,
} from "../../benchmarks/p0/runner.mjs";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSyncHidden } from "../helpers/spawn.mjs";

const shared = { repo_commit: "0123456789abcdef0123456789abcdef01234567", host_build: "audit-tools@0.50.19", model: "pinned-model", reasoning_effort: "high", tool_inventory: ["codebase-memory"], budgets: { context: 100000, output: 12000, turns: 20, timeout_ms: 300000 } };
const pairs = (prefix: string) => Array.from({ length: 5 }, (_, i) => ({ id: `${prefix}-${i + 1}`, pinned: shared, control_prompt: "user's standalone prompt verbatim codebase-memory", candidate_prompt: "ordinary comprehensive /audit-code P0 behavior" }));

const validManifest = {
  version: 1,
  shared,
  primary: { accepted_reports: ["audit-tools-simplification-workflow-gap-2026-08-26-report-a", "audit-tools-simplification-workflow-gap-2026-08-26-report-b"], normalized_opportunity_ids: ["opportunity-1", "opportunity-2"], pairs: pairs("primary") },
  held_out: { pairs: pairs("held-out"), seeded_positive_classes: ["duplicated_machinery", "duplicated_advancement_state_ownership", "goal_conflict", "disproportionate_lifecycle_ceremony"], negative_controls: ["intentional_bounded_context_duplication", "safety_gate_removal_increases_risk"] },
  graph_disabled_trial: { graph_enabled: false, expected_outcome: "abort_before_comprehensive", notice: "degraded/non-comprehensive" },
  randomization: { pair_order: "randomized", masking: "A/B" },
  evaluation: { independent_evaluators: 2, adjudicator: 1 },
  axes: [
    "structural_recall", "philosophy_telos_recall", "grounding_precision", "telos_to_code_linkage", "reduction_value", "false_positive_discipline",
  ],
};

describe("P0 benchmark harness manifest", () => {
  test("accepts exactly the pinned, blind, independently evaluated benchmark design", () => {
    expect(validateBenchmarkManifest(validManifest)).toBe(true);
  });

  test.each([
    ["primary pair count", { primary: { ...validManifest.primary, pairs: validManifest.primary.pairs.slice(0, 4) } }],
    ["held-out pair count", { held_out: { ...validManifest.held_out, pairs: validManifest.held_out.pairs.slice(0, 4) } }],
    ["seeded positives", { held_out: { ...validManifest.held_out, seeded_positive_classes: [] } }],
    ["negative controls", { held_out: { ...validManifest.held_out, negative_controls: [] } }],
    ["graph-disabled outcome", { graph_disabled_trial: { ...validManifest.graph_disabled_trial, expected_outcome: "run_comprehensive" } }],
    ["blinding", { randomization: { pair_order: "fixed", masking: "none" } }],
    ["evaluators", { evaluation: { independent_evaluators: 1, adjudicator: 0 } }],
    ["axes", { axes: validManifest.axes.slice(0, 5) }],
  ])("fails closed for %s", (_label, change) => expect(validateBenchmarkManifest({ ...validManifest, ...change })).toBe(false));

  test("rejects sentinel operator placeholders in host, model, effort, or seed", () => {
    for (const field of ["host_build", "model", "reasoning_effort"] as const) {
      expect(validateBenchmarkManifest({ ...validManifest, shared: { ...shared, [field]: "operator-pinned" } })).toBe(false);
    }
    expect(validateBenchmarkManifest({ ...validManifest, randomization: { ...validManifest.randomization, seed: "operator-pinned" } })).toBe(false);
  });

  test("requires the real O-01..O-24 manifest and directory snapshot corpus", () => {
    const manifestPath = resolve("benchmarks/p0/manifest.json");
    const corpusPath = resolve("benchmarks/p0/held-out-corpus");
    expect(existsSync(manifestPath)).toBe(true);
    expect(validateBenchmarkManifest(manifestPath)).toBe(true);
    expect(existsSync(corpusPath) && statSync(corpusPath).isDirectory()).toBe(true);
    expect(validateBenchmarkManifest({ ...validManifest, held_out: { ...validManifest.held_out, corpus: { path: corpusPath, labels_outside_root: true, deterministic_tree_digest: true } } })).toBe(true);
  });

  test("rejects incomplete, disputed, or non-inferior score records and accepts a complete pass", () => {
    const passing = { evaluator_coverage: { independent: 2, adjudicated: true }, primary: { ties_or_wins: 4, candidate_runs_recovering_strongest: 4, median_by_axis: Object.fromEntries(validManifest.axes.map((axis) => [axis, { candidate: 1, control: 1 }])) }, admitted_high_confidence_unsupported: 0, held_out: { seeded_positive_rate: { candidate: 1, control: 1 }, negative_control_false_positive_rate: { candidate: 0, control: 0 } } };
    expect(evaluateBenchmarkScores(passing)).toBe(true);
    for (const bad of [
      { evaluator_coverage: { independent: 1, adjudicated: false } },
      { primary: { ...passing.primary, ties_or_wins: 3 } },
      { primary: { ...passing.primary, candidate_runs_recovering_strongest: 3 } },
      { admitted_high_confidence_unsupported: 1 },
      { held_out: { ...passing.held_out, seeded_positive_rate: { candidate: 0, control: 1 } } },
      { held_out: { ...passing.held_out, negative_control_false_positive_rate: { candidate: 1, control: 0 } } },
    ]) expect(evaluateBenchmarkScores({ ...passing, ...bad })).toBe(false);
    expect(evaluateBenchmarkScores({ ...passing, primary: { ...passing.primary, median_by_axis: { ...passing.primary.median_by_axis, structural_recall: { candidate: 0, control: 1 } } } })).toBe(false);
  });

  test("builds an ordinary audit invocation without rubric or labels", () => {
    const argv = buildCandidateInvocation({ audit_code: "audit-code.mjs", snapshot_root: "C:/snapshots/held-out" });
    expect(argv).toEqual(["node", "audit-code.mjs", "next-step", "--root", "C:/snapshots/held-out"]);
    expect(argv.join(" ")).not.toMatch(/rubric|label|opportunity/i);
  });

  test("drives candidate steps through injected seams and fails closed on non-advancement", async () => {
    const requests: unknown[] = [];
    const steps = [
      { step_id: "s1", step_kind: "review", prompt: "inspect snapshot", artifact_path: "a.json" },
      { step_id: "s2", step_kind: "synthesis", prompt: "summarize evidence", artifact_path: "b.json" },
      { step_id: "s3", step_kind: "present_report", complete: true },
    ];
    let cursor = 0;
    const result = await driveCandidateLoop({
      snapshot_root: "C:/snapshots/held-out",
      pinned_profile: shared,
      maxSteps: 3,
      nextStep: async () => steps[cursor++],
      executePrompt: async (request: unknown) => { requests.push(request); },
    });
    expect(result.step.step_id).toBe("s3");
    expect(cursor).toBe(3);
    expect(requests).toHaveLength(2);
    expect(requests).toEqual([
      expect.objectContaining({ step_id: "s1", prompt: "inspect snapshot", artifact_path: "a.json", snapshot_root: "C:/snapshots/held-out", pinned_profile: shared }),
      expect.objectContaining({ step_id: "s2", prompt: "summarize evidence", artifact_path: "b.json", snapshot_root: "C:/snapshots/held-out", pinned_profile: shared }),
    ]);
    expect(JSON.stringify(requests)).not.toMatch(/rubric|corpus|opportunity|A\/B|scoring/i);

    let repeated = 0;
    await expect(driveCandidateLoop({
      snapshot_root: "C:/snapshots/held-out", pinned_profile: shared, maxSteps: 3,
      nextStep: async () => ({ step_id: "same", step_kind: "review", prompt: "repeat" }),
      executePrompt: async () => { repeated += 1; },
    })).rejects.toThrow(/non-advanc|repeat/i);
    expect(repeated).toBeLessThan(3);
  });

  test("composes ordinary next-step argv with prompt reads and external execution", async () => {
    const argvCalls: string[][] = [];
    const promptPaths: string[] = [];
    const requests: unknown[] = [];
    const steps = [
      { step_id: "s1", prompt_path: "p1.md", prompt: "first" },
      { step_id: "s2", prompt_path: "p2.md", prompt: "second" },
      { step_id: "s3", step_kind: "present_report", complete: true },
    ];
    let i = 0;
    const result = await runCandidateArm({
      auditCode: "audit-code.mjs", snapshotRoot: "C:/snapshots/held-out", pinnedProfile: shared, maxSteps: 3,
      invokeCommand: async (argv: string[]) => { argvCalls.push(argv); },
      readCurrentStep: async () => steps[i++],
      readPrompt: async (path: string) => { promptPaths.push(path); return path === "p1.md" ? "first" : "second"; },
      executeExternal: async (request: unknown) => { requests.push(request); },
    });
    expect(result.step_id).toBe("s3");
    expect(argvCalls).toHaveLength(3);
    for (const argv of argvCalls) {
      expect(Array.isArray(argv)).toBe(true);
      expect(argv).toContain("next-step");
      expect(argv).toContain("--root");
      expect(argv).toContain("C:/snapshots/held-out");
      expect(argv.join(" ")).not.toMatch(/[;&|]/);
    }
    expect(promptPaths).toEqual(["p1.md", "p2.md"]);
    expect(requests).toHaveLength(2);

    const help = spawnSyncHidden(process.execPath, ["benchmarks/p0/runner.mjs", "--help"], { encoding: "utf8" });
    expect(help.status).toBe(0);
    expect(help.stdout).toMatch(/preflight/);
    expect(help.stdout).toMatch(/prepare/);
    expect(help.stdout).toMatch(/run/);
    expect(help.stdout).toMatch(/graph-disabled/);
    expect(help.stdout).toMatch(/package-evaluators/);
    expect(help.stdout).toMatch(/score/);
    const unknown = spawnSyncHidden(process.execPath, ["benchmarks/p0/runner.mjs", "unknown-command"], { encoding: "utf8" });
    expect(unknown.status).not.toBe(0);
  });

  test("requires every pair to match the manifest shared pinned profile", () => {
    for (const section of ["primary", "held_out"] as const) {
      const pair = validManifest[section].pairs[0];
      for (const field of ["repo_commit", "host_build", "model", "reasoning_effort", "tool_inventory", "budgets"] as const) {
        const changed = { ...pair.pinned, [field]: field === "tool_inventory" ? ["different-tool"] : field === "budgets" ? { ...shared.budgets, turns: 99 } : field === "model" ? "operator-pinned" : "different-concrete-value" };
        expect(validateBenchmarkManifest({ ...validManifest, [section]: { ...validManifest[section], pairs: [{ ...pair, pinned: changed }, ...validManifest[section].pairs.slice(1)] } })).toBe(false);
      }
    }
  });

  test("checked-in manifest passes the runner preflight", () => {
    const result = spawnSyncHidden(process.execPath, ["benchmarks/p0/runner.mjs", "preflight", "benchmarks/p0/manifest.json"], { encoding: "utf8" });
    expect(result.status).toBe(0);
  });

  test("preflight validates held-out label paths and exactly one of each seeded class", () => {
    const root = resolve(process.cwd());
    const checkedIn = JSON.parse(readFileSync(resolve(root, "benchmarks/p0/manifest.json"), "utf8"));
    const labels = JSON.parse(readFileSync(resolve(root, "benchmarks/p0/corpus/held-out/labels.json"), "utf8"));
    const corpusRoot = resolve(root, checkedIn.held_out.corpus.path);
    const expected = ["duplicated_machinery", "duplicated_advancement_state_ownership", "goal_conflict", "disproportionate_lifecycle_ceremony", "intentional_bounded_context_duplication", "safety_gate_removal_increases_risk"];
    expect(statSync(corpusRoot).isDirectory()).toBe(true);
    expect(labels).toHaveLength(expected.length);
    expect(labels.map((label: { class: string }) => label.class).sort()).toEqual([...expected].sort());
    for (const label of labels) {
      const file = resolve(corpusRoot, label.path);
      expect(file.startsWith(`${corpusRoot}${require("node:path").sep}`)).toBe(true);
      expect(statSync(file).isFile()).toBe(true);
    }
    const checkedInPreflight = spawnSyncHidden(process.execPath, ["benchmarks/p0/runner.mjs", "preflight", "benchmarks/p0/manifest.json"], { encoding: "utf8" });
    expect(checkedInPreflight.status).toBe(0);

    const tempRoot = mkdtempSync(resolve(tmpdir(), "p0-corpus-") );
    try {
      cpSync(resolve(root, "benchmarks/p0"), resolve(tempRoot, "benchmarks/p0"), { recursive: true });
      const tempLabelsPath = resolve(tempRoot, "benchmarks/p0/corpus/held-out/labels.json");
      const tempLabels = JSON.parse(readFileSync(tempLabelsPath, "utf8"));
      tempLabels[0].path = "missing-label-file.js";
      writeFileSync(tempLabelsPath, JSON.stringify(tempLabels));
      const runner = resolve(root, "benchmarks/p0/runner.mjs");
      const stale = spawnSyncHidden(process.execPath, [runner, "preflight", resolve(tempRoot, "benchmarks/p0/manifest.json")], { cwd: tempRoot, encoding: "utf8" });
      expect(stale.status).not.toBe(0);
      expect(`${stale.stdout}\n${stale.stderr}`).toMatch(/label|path|file/i);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
