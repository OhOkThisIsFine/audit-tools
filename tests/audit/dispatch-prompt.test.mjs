import test from "node:test";
import assert from "node:assert/strict";

const { DISPATCH_PROMPT_HANDOFF_NOTE } = await import("audit-tools/shared");
const { renderDispatchReviewPrompt, renderEdgeReasoningDispatchPrompt } =
  await import("../../src/audit/cli/prompts.ts");

const MINIMAL_ACTIVE_RUN = {
  run_id: "run-1",
  task_path: "/artifacts/tasks.json",
  prompt_path: "/artifacts/prompt.md",
  audit_results_path: "/artifacts/results.json",
  worker_command: ["audit-code", "worker"],
};

test("renderDispatchReviewPrompt includes DISPATCH_PROMPT_HANDOFF_NOTE", () => {
  const prompt = renderDispatchReviewPrompt({
    root: "/repo",
    artifactsDir: "/repo/.audit-tools/audit",
    activeReviewRun: MINIMAL_ACTIVE_RUN,
    dispatchPlanPath: "/repo/.audit-tools/audit/dispatch-plan.json",
    dispatchQuotaPath: "/repo/.audit-tools/audit/dispatch-quota.json",
    hostCanRestrictSubagentTools: false,
    hostCanSelectSubagentModel: false,
  });

  assert.ok(
    prompt.includes(DISPATCH_PROMPT_HANDOFF_NOTE),
    "dispatch review prompt must contain DISPATCH_PROMPT_HANDOFF_NOTE",
  );
});

test("renderDispatchReviewPrompt without quota path includes DISPATCH_PROMPT_HANDOFF_NOTE", () => {
  const prompt = renderDispatchReviewPrompt({
    root: "/repo",
    artifactsDir: "/repo/.audit-tools/audit",
    activeReviewRun: MINIMAL_ACTIVE_RUN,
    dispatchPlanPath: "/repo/.audit-tools/audit/dispatch-plan.json",
    dispatchQuotaPath: null,
    hostCanRestrictSubagentTools: false,
    hostCanSelectSubagentModel: false,
  });

  assert.ok(
    prompt.includes(DISPATCH_PROMPT_HANDOFF_NOTE),
    "dispatch review prompt (no-quota variant) must contain DISPATCH_PROMPT_HANDOFF_NOTE",
  );
});

test("renderEdgeReasoningDispatchPrompt includes DISPATCH_PROMPT_HANDOFF_NOTE", () => {
  const prompt = renderEdgeReasoningDispatchPrompt({
    promptPath: "/repo/.audit-tools/audit/edge-reasoning.md",
    resultsPath: "/repo/.audit-tools/audit/edge-results.json",
    continueCommand: "audit-code next-step --root /repo --artifacts-dir /repo/.audit-tools/audit",
    contentHash: "abc123def456",
    candidateCount: 3,
  });

  assert.ok(
    prompt.includes(DISPATCH_PROMPT_HANDOFF_NOTE),
    "edge reasoning dispatch prompt must contain DISPATCH_PROMPT_HANDOFF_NOTE",
  );
});
