import { afterEach, expect, test, vi } from "vitest";
import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runClosePhase } from "../../src/remediate/phases/close.js";
import { decideNextStep } from "../../src/remediate/steps/nextStep.js";
import { executionPlanPaths, readApprovedExecutionPlan, readCanonicalPlan } from "../../src/remediate/contractPipeline/executionPlan.js";
import { REMEDIATION_STATE_CONTRACT_VERSION, type RemediationState } from "../../src/remediate/state/store.js";
import { writeJsonFile } from "../../src/shared/io/json.js";
import { createExecutablePlanFixture, approveExecutablePlanFixture } from "./helpers/executablePlanFixture.js";
import { canonicalPlanFixture, writeApprovedPlanFixture } from "./helpers/canonicalPlanFixture.js";
import { createNextStepHarness } from "./helpers/nextStepHarness.js";
import { spawnSyncHidden } from "../helpers/spawn.mjs";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function approvedClose() {
  const f = await createExecutablePlanFixture();
  roots.push(f.root);
  await writeFile(join(f.root, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  const canonical = (await readCanonicalPlan(f.artifactsDir))!;
  await writeJsonFile(join(f.paths.directory, "risk-decisions.json"), {
    revision_sha256: canonical.revision_sha256, confirmed_by: "host", accepted_counterexample_ids: [],
  });
  await approveExecutablePlanFixture(f);
  const approved = (await readApprovedExecutionPlan(f.artifactsDir))!;
  expect(approved).toBeDefined();
  const state: RemediationState = {
    contract_version: REMEDIATION_STATE_CONTRACT_VERSION,
    status: "closing",
    plan: canonicalPlanFixture({ ...approved.canonical.plan, findings: approved.source.findings,
      request: approved.source.request, audit_read: approved.source.audit_read,
      review_revision_sha256: approved.canonical.revision_sha256 }),
    items: Object.fromEntries(approved.canonical.plan.units.map(unit => [unit.id, { unit_id: unit.id, status: "resolved" }])),
    closing_plan: { action: "custom", pre_authorized: true,
      custom_command: [process.execPath, "-e", 'require("node:fs").writeFileSync("closed.txt", "closed")'] },
  };
  const statePath = join(f.artifactsDir, "state.json");
  await writeJsonFile(statePath, state);
  await writeFile(join(f.artifactsDir, "accepted-evidence.txt"), "Keep the accepted evidence");
  const before = await readFile(statePath, "utf8");
  const runner = vi.fn(async () => ({ status: 0 }));
  return { ...f, state, statePath, before, runner };
}

async function expectPreserved(f: Awaited<ReturnType<typeof approvedClose>>) {
  expect(existsSync(join(f.root, "closed.txt"))).toBe(false);
  expect(existsSync(join(f.root, ".audit-tools", "remediation-outcomes.json"))).toBe(false);
  expect(await readFile(f.statePath, "utf8")).toBe(f.before);
  expect(await readFile(join(f.artifactsDir, "accepted-evidence.txt"), "utf8")).toBe("Keep the accepted evidence");
}

test.each([
  "approval-deleted", "approval-replaced", "owner-deleted", "owner-replaced",
  "risk-deleted", "risk-replaced", "history-deleted", "history-replaced", "source-input", "runtime-plan",
] as const)("direct close rejects changed %s before verification or closing actions", async mutation => {
  const f = await approvedClose();
  const paths = {
    approval: f.paths.approval, owner: join(f.paths.directory, "owner-decision.json"),
    risk: join(f.paths.directory, "risk-decisions.json"), history: f.paths.history,
  };
  if (mutation === "source-input") await writeFile(f.input, "A different unreviewed request");
  else if (mutation === "runtime-plan") f.state.plan!.units[0]!.allowed_files.push("unreviewed.ts");
  else {
    const [kind, action] = mutation.split("-") as [keyof typeof paths, string];
    if (action === "deleted") await rm(paths[kind]);
    else if (kind === "history") await writeJsonFile(paths.history, { counterexamples: [], accepted_ids: [], repair_rounds: 1 });
    else await writeJsonFile(paths[kind], { unreviewed: true });
  }
  await expect(runClosePhase(f.state, { root: f.root, artifactsDir: f.artifactsDir, finalGateRunner: f.runner }))
    .rejects.toThrow(/approved|approval|reviewed|authority|provenance/i);
  expect(f.runner).not.toHaveBeenCalled();
  await expectPreserved(f);
});

test("authority revoked during green verification prevents the closing action and retains evidence", async () => {
  const f = await approvedClose();
  f.runner.mockImplementation(async () => { await rm(f.paths.approval, { force: true }); return { status: 0 }; });
  await expect(runClosePhase(f.state, { root: f.root, artifactsDir: f.artifactsDir, finalGateRunner: f.runner }))
    .rejects.toThrow(/approved|approval|reviewed|authority|provenance/i);
  expect(f.runner).toHaveBeenCalled();
  await expectPreserved(f);
});

test("unchanged approval permits real closing action and completion", async () => {
  const f = await approvedClose();
  const result = await runClosePhase(f.state, { root: f.root, artifactsDir: f.artifactsDir, finalGateRunner: f.runner });
  expect(result.status).toBe("complete");
  expect(f.runner).toHaveBeenCalled();
  expect(await readFile(join(f.root, "closed.txt"), "utf8")).toBe("closed");
});

test("an approved empty no-change plan still requires current authority", async () => {
  const f = await approvedClose();
  f.state.plan = canonicalPlanFixture({ ...f.state.plan!, requirements: [], units: [],
    request_disposition: { status: "already_satisfied", reason: "Existing behavior satisfies the request", evidence: ["Inspected the implementation"] } });
  f.state.items = {};
  await writeApprovedPlanFixture(f.artifactsDir, f.state);
  await writeJsonFile(f.statePath, f.state);
  f.before = await readFile(f.statePath, "utf8");
  await rm(f.paths.approval);
  await expect(runClosePhase(f.state, { root: f.root, artifactsDir: f.artifactsDir, finalGateRunner: f.runner }))
    .rejects.toThrow(/approved|approval|reviewed|authority|provenance/i);
  await expectPreserved(f);
});

test("unexplained repository context drift is not laundered by green final verification", async () => {
  const f = await approvedClose();
  await writeFile(join(f.root, "greeting.ts"), "Unreviewed changed premise");
  await expect(runClosePhase(f.state, { root: f.root, artifactsDir: f.artifactsDir, finalGateRunner: f.runner }))
    .rejects.toThrow(/context|reviewed/i);
  expect(f.runner).not.toHaveBeenCalled();
  await expectPreserved(f);
});

test("accepted landed execution explains its own reviewed-context changes at close", async () => {
  const f = await approvedClose();
  const git = (...args: string[]) => {
    const result = spawnSyncHidden("git", args, { cwd: f.root, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    return String(result.stdout).trim();
  };
  git("init", "-q");
  git("config", "user.email", "close-test@example.test");
  git("config", "user.name", "Close test");
  git("add", "request.txt", "package.json");
  git("commit", "-qm", "base");
  await writeFile(join(f.root, "greeting.ts"), "export const greeting = 'hello';\n");
  git("add", "greeting.ts");
  git("commit", "-qm", "accepted implementation");
  f.state.items!["UNIT-greeting"]!.host_landed_commit = git("rev-parse", "HEAD");
  const result = await runClosePhase(f.state, { root: f.root, artifactsDir: f.artifactsDir, finalGateRunner: f.runner });
  expect(result.status).toBe("complete");
  expect(await readFile(join(f.root, "closed.txt"), "utf8")).toBe("closed");
});

test("next-step pauses stale closing authority with a resumable repair prompt", async () => {
  const harness = createNextStepHarness(".test-close-plan-authority-next-step");
  await harness.resetTestRepo();
  try {
    await harness.writeIntentCheckpoint();
    const state: RemediationState = { status: "closing", plan: canonicalPlanFixture(), items: {},
      closing_plan: { action: "custom", pre_authorized: true,
        custom_command: [process.execPath, "-e", 'require("node:fs").writeFileSync("closed.txt", "closed")'] } };
    await writeApprovedPlanFixture(harness.ARTIFACTS_DIR, state);
    await harness.saveState(state);
    await harness.acknowledgeResume();
    await rm(executionPlanPaths(harness.ARTIFACTS_DIR).approval);
    const runner = vi.fn(async () => ({ status: 0 }));
    const step = await decideNextStep({ root: harness.REPO_DIR, finalGateRunner: runner });
    expect(step.step_kind).toBe("contract_pipeline");
    expect(step.status).toBe("blocked");
    expect(await readFile(step.prompt_path, "utf8")).toContain("Closing is paused");
    expect(runner).not.toHaveBeenCalled();
    expect(existsSync(join(harness.REPO_DIR, "closed.txt"))).toBe(false);
    const saved = JSON.parse(await readFile(join(harness.ARTIFACTS_DIR, "state.json"), "utf8"));
    expect(saved.status).toBe("closing");
    expect(saved.plan).toEqual(state.plan);
  } finally {
    await harness.cleanupTestRepo();
  }
});
