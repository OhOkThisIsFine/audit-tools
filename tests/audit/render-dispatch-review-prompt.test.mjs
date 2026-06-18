import test from "node:test";
import assert from "node:assert/strict";
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
  assert.ok(
    result.includes("map `entry.model_hint.tier`"),
    "expected model-hint line to be present",
  );
});

test("hostCanSelectSubagentModel:false — model-hint line is omitted", () => {
  const result = renderDispatchReviewPrompt(
    makeParams({ hostCanSelectSubagentModel: false }),
  );
  assert.ok(
    !result.includes("map `entry.model_hint.tier`"),
    "expected model-hint line to be absent",
  );
});

test("hostCanRestrictSubagentTools:true — restrict-tools line is included", () => {
  const result = renderDispatchReviewPrompt(
    makeParams({ hostCanRestrictSubagentTools: true }),
  );
  assert.ok(
    result.includes("Restrict review subagents"),
    "expected restrict-tools line to be present",
  );
});

test("hostCanRestrictSubagentTools:false — no-restriction-facility line is included", () => {
  const result = renderDispatchReviewPrompt(
    makeParams({ hostCanRestrictSubagentTools: false }),
  );
  assert.ok(
    result.includes("did not report a callable restriction facility"),
    "expected no-restriction-facility line to be present",
  );
  assert.ok(
    !result.includes("Restrict review subagents"),
    "expected restrict-tools line to be absent",
  );
});

test("dispatchQuotaPath non-null — quota lines are included", () => {
  const result = renderDispatchReviewPrompt(
    makeParams({ dispatchQuotaPath: "/repo/.audit-tools/audit/dispatch-quota.json" }),
  );
  assert.ok(result.includes("Dispatch quota:"), "expected 'Dispatch quota:' to be present");
  assert.ok(result.includes("max_concurrent_agents"), "expected 'max_concurrent_agents' to be present");
  assert.ok(result.includes("cooldown_until"), "expected 'cooldown_until' to be present");
});

test("dispatchQuotaPath null — quota lines are absent, simple plan instructions present", () => {
  const result = renderDispatchReviewPrompt(
    makeParams({ dispatchQuotaPath: null }),
  );
  assert.ok(
    !result.includes("Dispatch quota:"),
    "expected 'Dispatch quota:' to be absent",
  );
  assert.ok(
    result.includes("Launch one subagent for each entry"),
    "expected simple launch instruction to be present",
  );
});

test("prompt does not contain canary-round text", () => {
  const result = renderDispatchReviewPrompt(makeParams());
  assert.ok(!result.includes("CANARY round"), "expected 'CANARY round' to be absent");
});

test("FINDING-018: access pre-approval instruction references entry.access read and write paths", () => {
  const result = renderDispatchReviewPrompt(makeParams({ hostCanRestrictSubagentTools: true }));
  assert.ok(
    result.includes("entry.access.read_paths") && result.includes("entry.access.write_paths"),
    "expected pre-approval instruction to reference entry.access read_paths and write_paths",
  );
});

test("FINDING-018: access pre-approval warns not to grant broad workspace write access", () => {
  const result = renderDispatchReviewPrompt(makeParams({ hostCanRestrictSubagentTools: true }));
  assert.ok(
    result.includes("Do not grant broad workspace"),
    "expected warning against broad workspace write access",
  );
});

// ── FRIC-006 regression: prompt header uses "packets", not "waves" ─────────────────────────────

test("FRIC-006: renderDispatchReviewPrompt uses 'After all packets complete:' not 'waves'", () => {
  const result = renderDispatchReviewPrompt(makeParams());
  assert.ok(
    result.includes("After all packets complete:"),
    "dispatch review prompt must use 'After all packets complete:'",
  );
  assert.ok(
    !result.includes("After all waves complete:"),
    "dispatch review prompt must not use stale 'After all waves complete:' wording",
  );
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
  assert.ok(
    result.includes("After all packets complete:"),
    "rolling dispatch prompt must use 'After all packets complete:'",
  );
  assert.ok(
    !result.includes("After all waves complete:"),
    "rolling dispatch prompt must not use stale 'After all waves complete:' wording",
  );
});

// ── MNT-7cef02e2 regression: both prompts share the same dispatch-data-lines shape ───────────

test("MNT-7cef02e2: both prompts emit 'max_concurrent_agents' when quota path provided", () => {
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
    assert.ok(prompt.includes("max_concurrent_agents"), "quota prompt must include max_concurrent_agents");
    assert.ok(prompt.includes("cooldown_until"), "quota prompt must include cooldown_until");
    assert.ok(prompt.includes("Dispatch quota:"), "quota prompt must include 'Dispatch quota:' line");
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
    assert.ok(prompt.includes("Launch one subagent for each entry in the plan."), "no-quota prompt must include simple launch line");
    assert.ok(!prompt.includes("Dispatch quota:"), "no-quota prompt must not include 'Dispatch quota:' line");
  }
});
