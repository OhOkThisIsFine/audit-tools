import { test, expect } from "vitest";

const { renderWorkerPrompt } = await import("../../src/audit/prompts/renderWorkerPrompt.ts");
const { usesDeferredWorkerCommand } = await import("../../src/audit/types/workerSession.ts");

test("renderWorkerPrompt uses argv JSON for agent tasks and falls back to the default task list path", () => {
  const prompt = renderWorkerPrompt({
  contract_version: "audit-code-worker/v1alpha1",
  run_id: "run-1",
  repo_root: "/repo",
  artifacts_dir: "/repo/.audit-tools/audit",
  obligation_id: "audit_tasks_completed",
  preferred_executor: "agent",
  result_path: "/repo/.audit-tools/audit/runs/run-1/result.json",
  worker_command: [
    "node",
    "/repo/bin/worker.js",
    "--task",
    "/tmp/task with spaces.json",
  ],
  audit_results_path: "/repo/.audit-tools/audit/runs/run-1/run-results.json",
  timeout_ms: 1800000,
  max_retries: 0,
  });

  expect(prompt).toMatch(/Read: \/repo\/\.audit-tools\/audit\/audit_tasks\.json/);
  expect(prompt).not.toMatch(/\.schema\.json/);
  expect(prompt).toMatch(/review only the tasks listed/i);
  expect(prompt).toMatch(/Repository root: \/repo/);
  expect(prompt).toMatch(/Set the shell\/tool workdir to the repository root/i);
  expect(prompt).toMatch(/Do not add tasks/i);
  expect(prompt).toMatch(/Do not use shell search commands/i);
  expect(prompt).toMatch(/do not[\s\S]*write result_path/i);
  expect(prompt).toMatch(/tasks tagged lens_verification/i);
  expect(prompt).toMatch(/Write only the JSON array of AuditResult objects to:/i);
  expect(prompt).toMatch(/do not pipe an inline foreach statement directly into ConvertTo-Json/i);
  expect(prompt).toMatch(/Assign the foreach output to a variable first/i);
  expect(prompt).toMatch(/unwraps single-element arrays/i);
  expect(prompt).toMatch(/worker command ingests audit_results_path and writes result_path/i);
  expect(prompt).toMatch(/Command: \["node","\/repo\/bin\/worker\.js","--task","\/tmp\/task with spaces\.json"\]/);
});

test("renderWorkerPrompt suppresses worker_command execution when the task uses deferred ingestion", () => {
  const prompt = renderWorkerPrompt({
  contract_version: "audit-code-worker/v1alpha1",
  run_id: "run-2",
  repo_root: "/repo",
  artifacts_dir: "/repo/.audit-tools/audit",
  obligation_id: "audit_tasks_completed",
  preferred_executor: "agent",
  result_path: "/repo/.audit-tools/audit/runs/run-2/result.json",
  worker_command: ["node", "/repo/audit-code.mjs", "worker-run"],
  audit_results_path: "/repo/.audit-tools/audit/runs/run-2/run-results.json",
  pending_audit_tasks_path:
  "/repo/.audit-tools/audit/runs/run-2/pending-audit-tasks.json",
  worker_command_mode: "deferred",
  });

  expect(prompt).toMatch(/Read: \/repo\/\.audit-tools\/audit\/runs\/run-2\/pending-audit-tasks\.json/);
  expect(prompt).toMatch(/Deferred mode: write results, do not execute worker_command\./i);
  expect(prompt).not.toMatch(/Then execute worker_command/i);
  // OBL-INV-APR-09: deferred mode must NOT embed the Command: [argv] execution line
  // (the worker writes its own results file; no inlined execution instruction).
  expect(prompt, "deferred-mode prompt must not contain an embedded Command: argv execution line").not.toMatch(/Command: \[/);
});

test("renderWorkerPrompt renders a ## File access section when the task includes an access property", () => {
  const prompt = renderWorkerPrompt({
    contract_version: "audit-code-worker/v1alpha1",
    run_id: "run-access",
    repo_root: "/repo",
    artifacts_dir: "/repo/.audit-tools/audit",
    obligation_id: "audit_tasks_completed",
    preferred_executor: "agent",
    result_path: "/repo/.audit-tools/audit/runs/run-access/result.json",
    worker_command: ["node", "/repo/bin/worker.js"],
    audit_results_path: "/repo/.audit-tools/audit/runs/run-access/run-results.json",
    access: {
      read_paths: ["/repo/src/foo.ts", "/repo/src/bar.ts"],
      write_paths: ["/repo/out/result.json"],
    },
  });

  expect(prompt, "section heading is present").toMatch(/## File access/i);
  // read_paths render as a single comma-joined "Read:" line.
  expect(prompt, "both read paths are listed on the Read line").toMatch(/Read: \/repo\/src\/foo\.ts, \/repo\/src\/bar\.ts/);
  expect(prompt, "write path is listed").toMatch(/Write: \/repo\/out\/result\.json/);
});

test("renderWorkerPrompt omits the ## File access section when no access property is supplied", () => {
  const prompt = renderWorkerPrompt({
    contract_version: "audit-code-worker/v1alpha1",
    run_id: "run-no-access",
    repo_root: "/repo",
    artifacts_dir: "/repo/.audit-tools/audit",
    obligation_id: "audit_tasks_completed",
    preferred_executor: "agent",
    result_path: "/repo/.audit-tools/audit/runs/run-no-access/result.json",
    worker_command: ["node", "/repo/bin/worker.js"],
    audit_results_path: "/repo/.audit-tools/audit/runs/run-no-access/run-results.json",
  });

  expect(prompt, "section heading is absent when access is not provided").not.toMatch(/## File access/i);
});

test("usesDeferredWorkerCommand keys solely on worker_command_mode", () => {
  expect(usesDeferredWorkerCommand({ worker_command_mode: "deferred" })).toBe(true);
  expect(usesDeferredWorkerCommand({ worker_command_mode: "run" })).toBe(false);
  expect(usesDeferredWorkerCommand({})).toBe(false);
});

test("renderWorkerPrompt renders bounded executor prompts from argv data instead of shell-quoted strings", () => {
  const prompt = renderWorkerPrompt({
  contract_version: "audit-code-worker/v1alpha1",
  run_id: "run-3",
  repo_root: "/repo",
  artifacts_dir: "/repo/.audit-tools/audit",
  obligation_id: "planning",
  preferred_executor: "planning_executor",
  result_path: "/repo/.audit-tools/audit/runs/run-3/result.json",
  worker_command: [
    "node",
    "/repo/audit-code.mjs",
    "worker-run",
    "--task",
    "/repo/.audit-tools/audit/runs/run-3/task.json",
  ],
  timeout_ms: 60000,
  });

  expect(prompt).toMatch(/Execute worker_command from task\.json exactly\./);
  expect(prompt).toMatch(/Command: \["node","\/repo\/audit-code\.mjs","worker-run","--task","\/repo\/\.audit-tools\/audit\/runs\/run-3\/task\.json"\]/);
  expect(prompt).toMatch(/Write result to: \/repo\/\.audit-tools\/audit\/runs\/run-3\/result\.json/);
});

test("renderWorkerPrompt invites an optional agent reflection inline, without referencing a schema file", () => {
  const prompt = renderWorkerPrompt({
    contract_version: "audit-code-worker/v1alpha1",
    run_id: "run-reflect",
    repo_root: "/repo",
    artifacts_dir: "/repo/.audit-tools/audit",
    obligation_id: "audit_tasks_completed",
    preferred_executor: "agent",
    result_path: "/repo/.audit-tools/audit/runs/run-reflect/result.json",
    worker_command: ["node", "/repo/bin/worker.js"],
    audit_results_path: "/repo/.audit-tools/audit/runs/run-reflect/run-results.json",
  });

  expect(prompt, "points at the feedback artifact").toMatch(/agent-feedback\.jsonl/);
  expect(prompt, "describes the reflection shape inline").toMatch(/instruction_clarity/);
  expect(prompt, "frames the reflection as strictly optional").toMatch(/never let this delay or replace the audit result/i);
  // The reflection invitation must not reintroduce a schema-file reference.
  expect(prompt).not.toMatch(/\.schema\.json/);
});
