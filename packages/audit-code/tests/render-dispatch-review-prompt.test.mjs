import test from "node:test";
import assert from "node:assert/strict";
import { renderDispatchReviewPrompt } from "../src/cli/prompts.ts";

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
