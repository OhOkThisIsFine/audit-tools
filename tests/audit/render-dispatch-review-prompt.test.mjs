import { test, expect } from "vitest";
import { renderDispatchReviewPrompt, renderRollingDispatchPrompt } from "../../src/audit/cli/prompts.ts";

function makeRun(overrides = {}) {
  return {
    run_id: "run-test-1",
    task_path: "/repo/.audit-tools/audit/tasks.json",
    prompt_path: "/repo/.audit-tools/audit/prompt.md",
    audit_results_path: "/repo/.audit-tools/audit/results.jsonl",
    worker_command: ["audit-code", "merge-and-ingest"],
    ...overrides,
  };
}

function makeParams(overrides = {}) {
  return {
    root: "/repo",
    artifactsDir: "/repo/.audit-tools/audit",
    activeReviewRun: makeRun(),
    dispatchPlanPath: "/repo/.audit-tools/audit/dispatch-plan.json",
    dispatchQuotaPath: "/repo/.audit-tools/audit/dispatch-quota.json",
    hostCanRestrictSubagentTools: true,
    hostCanSelectSubagentModel: true,
    ...overrides,
  };
}

test("hostCanSelectSubagentModel:true — model-hint line is included", () => {
  const result = renderDispatchReviewPrompt(
    makeParams({ hostCanSelectSubagentModel: true }),
  );
  expect(result.includes("map `entry.model_hint.tier`"), "expected model-hint line to be present").toBeTruthy();
});

test("hostCanSelectSubagentModel:false — model-hint line is omitted", () => {
  const result = renderDispatchReviewPrompt(
    makeParams({ hostCanSelectSubagentModel: false }),
  );
  expect(!result.includes("map `entry.model_hint.tier`"), "expected model-hint line to be absent").toBeTruthy();
});

test("hostCanRestrictSubagentTools:true — restrict-tools line is included", () => {
  const result = renderDispatchReviewPrompt(
    makeParams({ hostCanRestrictSubagentTools: true }),
  );
  expect(result.includes("Restrict review subagents"), "expected restrict-tools line to be present").toBeTruthy();
});

test("hostCanRestrictSubagentTools:false — no-restriction-facility line is included", () => {
  const result = renderDispatchReviewPrompt(
    makeParams({ hostCanRestrictSubagentTools: false }),
  );
  expect(result.includes("did not report a callable restriction facility"), "expected no-restriction-facility line to be present").toBeTruthy();
  expect(!result.includes("Restrict review subagents"), "expected restrict-tools line to be absent").toBeTruthy();
});

test("dispatchQuotaPath non-null — quota lines are included", () => {
  const result = renderDispatchReviewPrompt(
    makeParams({ dispatchQuotaPath: "/repo/.audit-tools/audit/dispatch-quota.json" }),
  );
  expect(result.includes("Dispatch quota:"), "expected 'Dispatch quota:' to be present").toBeTruthy();
  expect(result.includes("admission.granted_packet_ids"), "expected granted-set instruction to be present").toBeTruthy();
  expect(result.includes("cooldown_until"), "expected 'cooldown_until' to be present").toBeTruthy();
});

test("dispatchQuotaPath null — quota lines are absent, simple plan instructions present", () => {
  const result = renderDispatchReviewPrompt(
    makeParams({ dispatchQuotaPath: null }),
  );
  expect(!result.includes("Dispatch quota:"), "expected 'Dispatch quota:' to be absent").toBeTruthy();
  expect(result.includes("Launch one subagent for each entry"), "expected simple launch instruction to be present").toBeTruthy();
});

test("prompt does not contain canary-round text", () => {
  const result = renderDispatchReviewPrompt(makeParams());
  expect(!result.includes("CANARY round"), "expected 'CANARY round' to be absent").toBeTruthy();
});

test("FINDING-018: access pre-approval instruction references entry.access read and write paths", () => {
  const result = renderDispatchReviewPrompt(makeParams({ hostCanRestrictSubagentTools: true }));
  expect(result.includes("entry.access.read_paths") && result.includes("entry.access.write_paths"), "expected pre-approval instruction to reference entry.access read_paths and write_paths").toBeTruthy();
});

test("FINDING-018: access pre-approval warns not to grant broad workspace write access", () => {
  const result = renderDispatchReviewPrompt(makeParams({ hostCanRestrictSubagentTools: true }));
  expect(result.includes("Do not grant broad workspace"), "expected warning against broad workspace write access").toBeTruthy();
});

// ── FRIC-006 regression: prompt header uses "packets", not "waves" ─────────────────────────────

test("FRIC-006: renderDispatchReviewPrompt uses 'After all packets complete:' not 'waves'", () => {
  const result = renderDispatchReviewPrompt(makeParams());
  expect(result.includes("After all packets complete:"), "dispatch review prompt must use 'After all packets complete:'").toBeTruthy();
  expect(!result.includes("After all waves complete:"), "dispatch review prompt must not use stale 'After all waves complete:' wording").toBeTruthy();
});

test("FRIC-006: renderRollingDispatchPrompt uses 'After all packets complete:' not 'waves'", () => {
  const result = renderRollingDispatchPrompt({
    root: "/repo",
    artifactsDir: "/repo/.audit-tools/audit",
    runId: "run-test-1",
    dispatchPlanPath: "/repo/.audit-tools/audit/dispatch-plan.json",
    dispatchQuotaPath: "/repo/.audit-tools/audit/dispatch-quota.json",
    hostCanRestrictSubagentTools: false,
    hostCanSelectSubagentModel: false,
  });
  expect(result.includes("After all packets complete:"), "rolling dispatch prompt must use 'After all packets complete:'").toBeTruthy();
  expect(!result.includes("After all waves complete:"), "rolling dispatch prompt must not use stale 'After all waves complete:' wording").toBeTruthy();
});

// ── MNT-7cef02e2 regression: both prompts share the same dispatch-data-lines shape ───────────

test("MNT-7cef02e2: both prompts emit the granted-set instruction when quota path provided", () => {
  const params = makeParams({ dispatchQuotaPath: "/repo/.audit-tools/audit/dispatch-quota.json" });
  const review = renderDispatchReviewPrompt(params);
  const rolling = renderRollingDispatchPrompt({
    root: params.root,
    artifactsDir: params.artifactsDir,
    runId: "run-test-1",
    dispatchPlanPath: params.dispatchPlanPath,
    dispatchQuotaPath: params.dispatchQuotaPath,
    hostCanRestrictSubagentTools: params.hostCanRestrictSubagentTools,
    hostCanSelectSubagentModel: params.hostCanSelectSubagentModel,
  });
  for (const prompt of [review, rolling]) {
    expect(prompt.includes("admission.granted_packet_ids"), "quota prompt must include the granted-set instruction").toBeTruthy();
    expect(prompt.includes("cooldown_until"), "quota prompt must include cooldown_until").toBeTruthy();
    expect(prompt.includes("Dispatch quota:"), "quota prompt must include 'Dispatch quota:' line").toBeTruthy();
  }
});

test("MNT-7cef02e2: both prompts emit simple launch line when quota path is null", () => {
  const params = makeParams({ dispatchQuotaPath: null });
  const review = renderDispatchReviewPrompt(params);
  const rolling = renderRollingDispatchPrompt({
    root: params.root,
    artifactsDir: params.artifactsDir,
    runId: "run-test-1",
    dispatchPlanPath: params.dispatchPlanPath,
    dispatchQuotaPath: null,
    hostCanRestrictSubagentTools: params.hostCanRestrictSubagentTools,
    hostCanSelectSubagentModel: params.hostCanSelectSubagentModel,
  });
  for (const prompt of [review, rolling]) {
    expect(prompt.includes("Launch one subagent for each entry in the plan."), "no-quota prompt must include simple launch line").toBeTruthy();
    expect(!prompt.includes("Dispatch quota:"), "no-quota prompt must not include 'Dispatch quota:' line").toBeTruthy();
  }
});
