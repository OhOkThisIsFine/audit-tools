import { describe, expect, test } from "vitest";

import {
  buildCandidateInvocation,
  currentStepPathFromCliOutput,
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
  primary: { pairs: pairs("primary") },
  held_out: { pairs: pairs("held-out") },
  graph_disabled_trial: { graph_enabled: false, expected_outcome: "abort_before_comprehensive", notice: "degraded/non-comprehensive" },
  randomization: { pair_order: "randomized", masking: "A/B" },
  evaluation: {
    independent_evaluators: 2,
    adjudicator: 1,
    private_gold_schema: "benchmarks/p0/private-gold.schema.json",
  },
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
    ["graph-disabled outcome", { graph_disabled_trial: { ...validManifest.graph_disabled_trial, expected_outcome: "run_comprehensive" } }],
    ["blinding", { randomization: { pair_order: "fixed", masking: "none" } }],
    ["evaluators", { evaluation: { independent_evaluators: 1, adjudicator: 0 } }],
    [
      "private gold schema",
      {
        evaluation: {
          ...validManifest.evaluation,
          private_gold_schema: "benchmarks/p0/other.schema.json",
        },
      },
    ],
    ["axes", { axes: validManifest.axes.slice(0, 5) }],
  ])("fails closed for %s", (_label, change) => expect(validateBenchmarkManifest({ ...validManifest, ...change })).toBe(false));

  test("rejects sentinel operator placeholders and any public randomization seed", () => {
    for (const field of ["host_build", "model", "reasoning_effort"] as const) {
      expect(validateBenchmarkManifest({ ...validManifest, shared: { ...shared, [field]: "operator-pinned" } })).toBe(false);
    }
    expect(validateBenchmarkManifest({ ...validManifest, randomization: { ...validManifest.randomization, seed: "public-seed" } })).toBe(false);
  });

  test.each([
    ["accepted reports", "primary", "accepted_reports"],
    ["scored primary subset", "primary", "normalized_opportunity_ids"],
    ["strongest primary cases", "primary", "strongest_opportunity_ids"],
    ["held signs", "held_out", "seeded_positive_classes"],
    ["held controls", "held_out", "negative_controls"],
  ] as const)("rejects deprecated public gold field %s", (_label, section, field) => {
    expect(
      validateBenchmarkManifest({
        ...validManifest,
        [section]: { ...validManifest[section], [field]: ["public-gold"] },
      }),
    ).toBe(false);
  });

  test("prepare generates private randomization without a public seed", () => {
    const root = mkdtempSync(resolve(tmpdir(), "p0-prepare-"));
    try {
      const runner = resolve("benchmarks/p0/runner.mjs");
      const manifestPath = resolve("benchmarks/p0/manifest.json");
      const first = resolve(root, "first");
      const second = resolve(root, "second");
      for (const output of [first, second]) {
        const prepared = spawnSyncHidden(
          process.execPath,
          [runner, "prepare", "--manifest", manifestPath, "--output", output],
          { encoding: "utf8" },
        );
        expect(prepared.status).toBe(0);
      }
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      const publicRequests = JSON.parse(
        readFileSync(resolve(first, "requests.public.json"), "utf8"),
      );
      const firstIdentity = JSON.parse(
        readFileSync(resolve(first, "identity.private.json"), "utf8"),
      );
      const secondIdentity = JSON.parse(
        readFileSync(resolve(second, "identity.private.json"), "utf8"),
      );
      expect(manifest.randomization).not.toHaveProperty("seed");
      expect(JSON.stringify(publicRequests)).not.toContain(
        firstIdentity.randomization_seed,
      );
      expect(firstIdentity.randomization_seed).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
      expect(secondIdentity.randomization_seed).not.toBe(
        firstIdentity.randomization_seed,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("requires the checked-in pair manifest and directory snapshot corpus", () => {
    const manifestPath = resolve("benchmarks/p0/manifest.json");
    const corpusPath = resolve("benchmarks/p0/held-out-corpus");
    expect(existsSync(manifestPath)).toBe(true);
    expect(validateBenchmarkManifest(manifestPath)).toBe(true);
    expect(existsSync(corpusPath) && statSync(corpusPath).isDirectory()).toBe(true);
    expect(validateBenchmarkManifest({ ...validManifest, held_out: { ...validManifest.held_out, corpus: { path: corpusPath, deterministic_tree_digest: true } } })).toBe(true);
  });

  test("rejects incomplete, disputed, or non-inferior score records and accepts a complete pass", () => {
    const passing = {
      evaluator_coverage: { independent: 2, adjudicated: true },
      primary: {
        ties_or_wins: 4,
        candidate_runs_recovering_strongest: 4,
        median_by_axis: Object.fromEntries(
          validManifest.axes.map((axis) => [
            axis,
            { candidate: 1, control: 1 },
          ]),
        ),
      },
      admitted_high_confidence_unsupported: 0,
      held_out: {
        ties_or_wins: 4,
        median_by_axis: Object.fromEntries(
          validManifest.axes.map((axis) => [
            axis,
            { candidate: 1, control: 1 },
          ]),
        ),
        seeded_positive_rate: { candidate: 1, control: 1 },
        negative_control_false_positive_rate: { candidate: 0, control: 0 },
      },
    };
    expect(evaluateBenchmarkScores(passing)).toBe(true);
    for (const bad of [
      { evaluator_coverage: { independent: 1, adjudicated: false } },
      { primary: { ...passing.primary, ties_or_wins: 3 } },
      { primary: { ...passing.primary, candidate_runs_recovering_strongest: 3 } },
      { admitted_high_confidence_unsupported: 1 },
      { held_out: { ...passing.held_out, ties_or_wins: 3 } },
      { held_out: { ...passing.held_out, seeded_positive_rate: { candidate: 0, control: 1 } } },
      { held_out: { ...passing.held_out, negative_control_false_positive_rate: { candidate: 1, control: 0 } } },
      { held_out: { ...passing.held_out, seeded_positive_rate: { candidate: 0, control: 0 } } },
      { held_out: { ...passing.held_out, negative_control_false_positive_rate: { candidate: 1, control: 1 } } },
    ]) expect(evaluateBenchmarkScores({ ...passing, ...bad })).toBe(false);
    expect(evaluateBenchmarkScores({ ...passing, primary: { ...passing.primary, median_by_axis: { ...passing.primary.median_by_axis, structural_recall: { candidate: 0, control: 1 } } } })).toBe(false);
    expect(evaluateBenchmarkScores({ ...passing, held_out: { ...passing.held_out, median_by_axis: { ...passing.held_out.median_by_axis, structural_recall: { candidate: 0, control: 1 } } } })).toBe(false);
    expect(evaluateBenchmarkScores({
      ...passing,
      held_out: {
        ...passing.held_out,
        median_by_axis: Object.fromEntries(
          validManifest.axes.map((axis) => [
            axis,
            { candidate: 0, control: 0 },
          ]),
        ),
      },
    })).toBe(false);
  });

  test("builds an ordinary audit invocation without rubric or labels", () => {
    const argv = buildCandidateInvocation({ audit_code: "audit-code.mjs", snapshot_root: "C:/snapshots/held-out" });
    expect(argv).toEqual(["node", "audit-code.mjs", "next-step", "--root", "C:/snapshots/held-out"]);
    expect(argv.join(" ")).not.toMatch(/rubric|label|opportunity/i);
  });

  test("reads the authoritative agent-scoped current-step path from CLI output", () => {
    const path =
      "C:/snapshot/.audit-tools/audit/steps/agent-1/current-step.json";
    expect(
      currentStepPathFromCliOutput(
        JSON.stringify({ artifact_paths: { current_step: path } }),
      ),
    ).toBe(path);
    expect(() => currentStepPathFromCliOutput("not json")).toThrow(
      /JSON contract/,
    );
    expect(() => currentStepPathFromCliOutput("{}")).toThrow(
      /artifact_paths\.current_step/,
    );
  });

  test("drives the emitted agent-scoped step contract without legacy fields", async () => {
    const requests: unknown[] = [];
    const steps = [
      {
        step_kind: "analyzer_consent",
        status: "ready",
        run_id: null,
        stop_condition: "Write the decisions artifact, then continue.",
        prompt: "Choose analyzer consent.",
        artifact_paths: {
          analyzer_consent_decisions: "C:/snapshot/.audit-tools/audit/submissions/decisions.json",
          current_step: "C:/snapshot/.audit-tools/audit/steps/agent-1/current-step.json",
          current_prompt: "C:/snapshot/.audit-tools/audit/steps/agent-1/current-prompt.md",
        },
      },
      {
        step_kind: "present_report",
        complete: true,
        artifact_paths: {
          audit_report: "C:/snapshot/.audit-tools/audit/audit-report.md",
        },
      },
    ];
    let cursor = 0;
    const result = await driveCandidateLoop({
      snapshot_root: "C:/snapshot",
      pinned_profile: shared,
      maxSteps: 2,
      nextStep: async () => steps[cursor++],
      executePrompt: async (request: unknown) => requests.push(request),
    });

    expect(result.step.step_kind).toBe("present_report");
    expect(requests).toEqual([
      expect.objectContaining({
        step_id: expect.stringMatching(/^analyzer_consent:[0-9a-f]{24}$/),
        step_kind: "analyzer_consent",
        artifact_path: undefined,
        artifact_paths: expect.objectContaining({
          analyzer_consent_decisions:
            "C:/snapshot/.audit-tools/audit/submissions/decisions.json",
        }),
      }),
    ]);
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

  test("preflight validates only the unlabeled held-out snapshot digest", () => {
    const root = resolve(process.cwd());
    const checkedIn = JSON.parse(readFileSync(resolve(root, "benchmarks/p0/manifest.json"), "utf8"));
    const corpusRoot = resolve(root, checkedIn.held_out.corpus.path);
    expect(statSync(corpusRoot).isDirectory()).toBe(true);
    expect(checkedIn.held_out.corpus).not.toHaveProperty("labels_path");
    expect(checkedIn.held_out).not.toHaveProperty("seeded_positive_classes");
    expect(checkedIn.held_out).not.toHaveProperty("negative_controls");
    const checkedInPreflight = spawnSyncHidden(process.execPath, ["benchmarks/p0/runner.mjs", "preflight", "benchmarks/p0/manifest.json"], { encoding: "utf8" });
    expect(checkedInPreflight.status).toBe(0);

    const tempRoot = mkdtempSync(resolve(tmpdir(), "p0-corpus-") );
    try {
      cpSync(resolve(root, "benchmarks/p0"), resolve(tempRoot, "benchmarks/p0"), { recursive: true });
      const corpusFile = resolve(
        tempRoot,
        "benchmarks/p0/held-out-corpus/src/duplicate.js",
      );
      writeFileSync(corpusFile, `${readFileSync(corpusFile, "utf8")}\n// tampered\n`);
      const runner = resolve(root, "benchmarks/p0/runner.mjs");
      const stale = spawnSyncHidden(process.execPath, [runner, "preflight", resolve(tempRoot, "benchmarks/p0/manifest.json")], { cwd: tempRoot, encoding: "utf8" });
      expect(stale.status).not.toBe(0);
      expect(`${stale.stdout}\n${stale.stderr}`).toMatch(/digest|corpus/i);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
