import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { decideNextStep } from "../../src/remediate/steps/nextStep.js";
import { runClosePhase } from "../../src/remediate/phases/close.js";
import { StateStore } from "../../src/remediate/state/store.js";
import type { RemediationState } from "../../src/remediate/state/store.js";
import { createNextStepHarness } from "./helpers/nextStepHarness.js";
import { writeApprovedPlanFixture } from "./helpers/canonicalPlanFixture.js";

const harness = createNextStepHarness(".test-final-acceptance-window");
const { REPO_DIR: root, ARTIFACTS_DIR: artifactsDir } = harness;

function resolvedState(): RemediationState {
  return {
    status: "implementing",
    plan: {
      plan_id: "PLAN-WINDOW", objective: "Verify integrated changes", non_goals: [], findings: [],
      review_revision_sha256: "a".repeat(64), project_type: "unknown", candidate_closing_actions: ["none"],
      source_dispositions: [], review_counterexamples: [],
      test_command: "npm test", test_command_source: "project_facts",
      requirements: [0, 1].map(i => ({ id: `R${i}`, description: `Preserve module ${i}`, source_finding_ids: [], change_kind: "structural" as const, assertions: [] })),
      units: [0, 1].map(i => ({
        id: `U${i}`, title: `Module ${i}`, description: `Update module ${i}`, source_finding_ids: [],
        requirement_ids: [`R${i}`], dependencies: [], read_paths: [`src/${i}.ts`], allowed_files: [`src/${i}.ts`],
        required_tests: [], affected_interfaces: [], addresses_counterexample_ids: [],
      })),
    },
    items: { U0: { unit_id: "U0", status: "resolved" }, U1: { unit_id: "U1", status: "resolved" } },
    closing_plan: { action: "none" },
  };
}

async function counterRepo() {
  await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "node count.cjs" } }));
  await writeFile(join(root, "count.cjs"), 'const fs = require("node:fs"); fs.appendFileSync("runs.log", "test\\n"); if (fs.existsSync("fail")) process.exit(1);');
}

async function prepare(state = resolvedState()) {
  await harness.writeIntentCheckpoint();
  await writeApprovedPlanFixture(artifactsDir, state);
  await harness.saveState(state);
  await harness.acknowledgeResume();
  await harness.walkFriction(state.plan!.plan_id);
  return state;
}

beforeEach(async () => { await harness.resetTestRepo(); await counterRepo(); });
afterEach(async () => { await harness.cleanupTestRepo(); });

describe("final acceptance execution window", () => {
  it("executes one planned operation for identical final-floor and combined-suite requirements", async () => {
    await prepare();
    const step = await decideNextStep({ root });
    expect(step.step_kind).toBe("present_report");
    expect(await readFile(join(root, "runs.log"), "utf8")).toBe("test\n");
  });
  it("does not execute final acceptance before the user approves the closing preview", async () => {
    const state = resolvedState();
    state.closing_plan = { action: "commit", pre_authorized: false };
    await prepare(state);
    const log = vi.spyOn(console, "log");
    const step = await decideNextStep({ root });
    expect(step.step_kind).toBe("close_run");
    expect(log.mock.calls.filter(args => args[0] === "Running Close Phase...")).toHaveLength(1);
    log.mockRestore();
    expect(existsSync(join(root, "runs.log"))).toBe(false);
  });
  it("an unchanged approved preview opens one fresh final acceptance window", async () => {
    const state = resolvedState();
    state.closing_plan = { action: "commit", pre_authorized: false };
    await prepare(state);
    expect((await decideNextStep({ root })).step_kind).toBe("close_run");
    expect((await decideNextStep({ root, finalizeClosing: true })).step_kind).toBe("present_report");
    expect(await readFile(join(root, "runs.log"), "utf8")).toBe("test\n");
  });
  it("direct close cannot bypass the floor when no combined suite is configured", async () => {
    const state = resolvedState();
    state.status = "closing";
    delete state.plan!.test_command;
    await writeFile(join(root, "fail"), "");
    await writeApprovedPlanFixture(artifactsDir, state);
    const result = await runClosePhase(state, { root, artifactsDir });
    expect(result.status).toBe("closing");
    expect(Object.values(result.items!).map(item => item.status)).toEqual(["resolved", "resolved"]);
    expect(existsSync(join(root, ".audit-tools", "remediation-report.md"))).toBe(false);
    expect(await readFile(join(root, "runs.log"), "utf8")).toBe("test\n");
  });
  it("does not merge e2e with the terminal unit operation merely because argv match", async () => {
    const state = resolvedState();
    state.status = "closing";
    state.plan!.e2e_command = "npm test";
    await writeApprovedPlanFixture(artifactsDir, state);
    const result = await runClosePhase(state, { root, artifactsDir });
    expect(result.status).toBe("complete");
    expect(await readFile(join(root, "runs.log"), "utf8")).toBe("test\ntest\n");
  });
  it("keeps a differently configured floor unit command separate from the combined suite", async () => {
    for (const directory of ["src/shared", "src/audit", "src/remediate", "scripts/shared"]) {
      await mkdir(join(root, directory), { recursive: true });
    }
    await writeFile(join(root, "audit-code.mjs"), "");
    await writeFile(join(root, "remediate-code.mjs"), "");
    await writeFile(join(root, "scripts/shared/run-vitest-gate.mjs"), 'import fs from "node:fs"; fs.appendFileSync("runs.log", "floor\\n");');
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: {
      build: "node count.cjs build", check: "node count.cjs check", "check:tests": "node count.cjs check-tests", test: "node count.cjs combined",
    } }));
    await writeFile(join(root, "count.cjs"), 'require("node:fs").appendFileSync("runs.log", process.argv[2]+"\\n");');
    const state = resolvedState();
    state.status = "closing";
    await writeApprovedPlanFixture(artifactsDir, state);
    expect((await runClosePhase(state, { root, artifactsDir })).status).toBe("complete");
    expect(await readFile(join(root, "runs.log"), "utf8")).toBe("build\ncheck\ncheck-tests\nfloor\ncombined\n");
  });
  it("a fresh close reruns the operation after a red instead of consuming a persisted verdict", async () => {
    const state = resolvedState();
    state.status = "closing";
    await writeFile(join(root, "fail"), "");
    await writeApprovedPlanFixture(artifactsDir, state);
    expect((await runClosePhase(state, { root, artifactsDir })).status).toBe("closing");
    await rm(join(root, "fail"));
    expect((await runClosePhase(state, { root, artifactsDir })).status).toBe("complete");
    expect(await readFile(join(root, "runs.log"), "utf8")).toBe("test\ntest\n");
  });
  it("all-skipped close records a disabled floor while still running its configured combined suite", async () => {
    const state = resolvedState();
    state.status = "closing";
    for (const item of Object.values(state.items!)) item.status = "ignored";
    await writeApprovedPlanFixture(artifactsDir, state);
    expect((await runClosePhase(state, { root, artifactsDir })).status).toBe("complete");
    expect(await readFile(join(root, "runs.log"), "utf8")).toBe("test\n");
    const outcomes = JSON.parse(await readFile(join(root, ".audit-tools", "remediation-outcomes.json"), "utf8"));
    expect(outcomes.final_gate.outcome).toBe("disabled");
    expect(outcomes.final_gate.passed).toBeNull();
  });
  it("preserves command admission when an earlier build changes the test declaration", async () => {
    const state = resolvedState();
    state.status = "closing";
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { build: "node mutate.cjs", test: "node count.cjs" } }));
    await writeFile(join(root, "mutate.cjs"), 'require("node:fs").writeFileSync("package.json", JSON.stringify({scripts:{}}));');
    await writeApprovedPlanFixture(artifactsDir, state);
    expect((await runClosePhase(state, { root, artifactsDir })).status).toBe("closing");
    expect(existsSync(join(root, "runs.log"))).toBe(false);
    expect(Object.values(state.items!).every(item => item.status === "resolved")).toBe(true);
  });
  it("approval of a commit preview cannot authorize a different closing action", async () => {
    const state = resolvedState();
    state.status = "closing";
    state.closing_plan = { action: "commit" };
    await writeApprovedPlanFixture(artifactsDir, state);
    const previewed = await runClosePhase(state, { root, artifactsDir });
    expect(previewed.closing_plan!.closing_action_preview!.action).toBe("commit");
    previewed.closing_plan!.action = "publish";
    const next = await runClosePhase(previewed, { root, artifactsDir, finalizeClosing: true });
    expect(next.status).toBe("closing");
    expect(next.closing_plan!.pre_authorized).not.toBe(true);
    expect(next.closing_plan!.closing_action_preview!.action).toBe("publish");
    expect(existsSync(join(root, "runs.log"))).toBe(false);
  });
  it("a shared final operation failure pauses without reblocking resolved items", async () => {
    await prepare();
    await writeFile(join(root, "fail"), "");
    const step = await decideNextStep({ root });
    expect(step.step_kind).toBe("final_gate_red");
    const state = await new StateStore(artifactsDir).loadState();
    expect(Object.values(state!.items!).map(item => item.status)).toEqual(["resolved", "resolved"]);
    expect(await readFile(join(root, "runs.log"), "utf8")).toBe("test\n");
  });
  it("the shared operation preserves its observed exit code in the floor diagnostic", async () => {
    const state = resolvedState();
    state.status = "closing";
    await writeFile(join(root, "count.cjs"), 'process.stderr.write("specific failure"); process.exit(7);');
    await writeApprovedPlanFixture(artifactsDir, state);
    expect((await runClosePhase(state, { root, artifactsDir })).status).toBe("closing");
    const red = JSON.parse(await readFile(join(artifactsDir, "final-gate.json"), "utf8"));
    expect(red.exit_code).toBe(7);
    expect(red.stderr_tail).toContain("specific failure");
  });
  it("a source-free force-close retains diagnostics for pending or missing execution units", async () => {
    const state = resolvedState();
    state.status = "closing";
    state.items!.U0.status = "pending";
    delete state.items!.U1;
    await writeApprovedPlanFixture(artifactsDir, state);
    await runClosePhase(state, { root, artifactsDir });
    expect(existsSync(artifactsDir)).toBe(true);
    const verification = JSON.parse(await readFile(join(root, ".audit-tools", "verification_report.json"), "utf8"));
    expect(verification.findings).toEqual([]);
    expect(verification.units).toHaveLength(2);
    expect(verification.overall_status).toBe("failed");
  });
});
