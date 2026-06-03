import test from "node:test";
import assert from "node:assert/strict";

const { renderWorkerPrompt } = await import(
  "../src/prompts/renderWorkerPrompt.ts"
);
const { usesDeferredWorkerCommand } = await import(
  "../src/types/workerSession.ts"
);

test("renderWorkerPrompt uses argv JSON for agent tasks and falls back to the default task list path", () => {
  const prompt = renderWorkerPrompt({
  contract_version: "audit-code-worker/v1alpha1",
  run_id: "run-1",
  repo_root: "/repo",
  artifacts_dir: "/repo/.audit-artifacts",
  obligation_id: "audit_tasks_completed",
  preferred_executor: "agent",
  result_path: "/repo/.audit-artifacts/runs/run-1/result.json",
  worker_command: [
    "node",
    "/repo/bin/worker.js",
    "--task",
    "/tmp/task with spaces.json",
  ],
  audit_results_path: "/repo/.audit-artifacts/runs/run-1/audit-results.json",
  timeout_ms: 1800000,
  max_retries: 0,
  });

  assert.match(
  prompt,
  /Read: \/repo\/\.audit-artifacts\/audit_tasks\.json/,
  );
  assert.doesNotMatch(prompt, /\.schema\.json/);
  assert.match(prompt, /review only the tasks listed/i);
  assert.match(prompt, /Do not add tasks/i);
  assert.match(prompt, /Do not use shell search commands/i);
  assert.match(prompt, /do not[\s\S]*write result_path/i);
  assert.match(prompt, /tasks tagged lens_verification/i);
  assert.match(prompt, /Write only the JSON array of AuditResult objects to:/i);
  assert.match(prompt, /worker command ingests audit_results_path and writes result_path/i);
  assert.match(
  prompt,
  /Command: \["node","\/repo\/bin\/worker\.js","--task","\/tmp\/task with spaces\.json"\]/,
  );
});

test("renderWorkerPrompt suppresses worker_command execution when the task uses deferred ingestion", () => {
  const prompt = renderWorkerPrompt({
  contract_version: "audit-code-worker/v1alpha1",
  run_id: "run-2",
  repo_root: "/repo",
  artifacts_dir: "/repo/.audit-artifacts",
  obligation_id: "audit_tasks_completed",
  preferred_executor: "agent",
  result_path: "/repo/.audit-artifacts/runs/run-2/result.json",
  worker_command: ["node", "/repo/audit-code.mjs", "worker-run"],
  audit_results_path: "/repo/.audit-artifacts/runs/run-2/audit-results.json",
  pending_audit_tasks_path:
  "/repo/.audit-artifacts/runs/run-2/pending-audit-tasks.json",
  worker_command_mode: "deferred",
  });

  assert.match(
  prompt,
  /Read: \/repo\/\.audit-artifacts\/runs\/run-2\/pending-audit-tasks\.json/,
  );
  assert.match(prompt, /Deferred mode: write results, do not execute worker_command\./i);
  assert.doesNotMatch(prompt, /Then execute worker_command/i);
});

test("usesDeferredWorkerCommand keys solely on worker_command_mode", () => {
  assert.equal(
    usesDeferredWorkerCommand({ worker_command_mode: "deferred" }),
    true,
  );
  assert.equal(usesDeferredWorkerCommand({ worker_command_mode: "run" }), false);
  assert.equal(usesDeferredWorkerCommand({}), false);
});

test("renderWorkerPrompt renders bounded executor prompts from argv data instead of shell-quoted strings", () => {
  const prompt = renderWorkerPrompt({
  contract_version: "audit-code-worker/v1alpha1",
  run_id: "run-3",
  repo_root: "/repo",
  artifacts_dir: "/repo/.audit-artifacts",
  obligation_id: "planning",
  preferred_executor: "planning_executor",
  result_path: "/repo/.audit-artifacts/runs/run-3/result.json",
  worker_command: [
    "node",
    "/repo/audit-code.mjs",
    "worker-run",
    "--task",
    "/repo/.audit-artifacts/runs/run-3/task.json",
  ],
  timeout_ms: 60000,
  });

  assert.match(
  prompt,
  /Execute worker_command from task\.json exactly\./,
  );
  assert.match(
  prompt,
  /Command: \["node","\/repo\/audit-code\.mjs","worker-run","--task","\/repo\/\.audit-artifacts\/runs\/run-3\/task\.json"\]/,
  );
  assert.match(
  prompt,
  /Write result to: \/repo\/\.audit-artifacts\/runs\/run-3\/result\.json/,
  );
});
