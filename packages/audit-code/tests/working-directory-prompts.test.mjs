/**
 * FINDING-008: audit-code generated prompts must be explicit about the
 * repository root and must tell workers to set the shell/tool workdir
 * explicitly, not rely on leaked cwd state from prior shell calls.
 */
import test from "node:test";
import assert from "node:assert/strict";

const { renderWorkerPrompt } = await import(
  "../src/prompts/renderWorkerPrompt.ts"
);
const { renderDispatchReviewPrompt, nextStepCommand, mergeAndIngestCommand } =
  await import("../src/cli/prompts.ts");

function makeAgentTask(overrides = {}) {
  return {
    run_id: "RUN-TEST",
    repo_root: "/repo",
    preferred_executor: "agent",
    audit_results_path: "/repo/.audit-tools/audit/task-results/results.json",
    worker_command: ["node", "audit-code.mjs", "merge-and-ingest"],
    result_path: "/repo/.audit-tools/audit/task-results/task-1.json",
    artifacts_dir: "/repo/.audit-tools/audit",
    ...overrides,
  };
}

function makeReviewRunParams(overrides = {}) {
  return {
    root: "/repo",
    artifactsDir: "/repo/.audit-tools/audit",
    activeReviewRun: {
      run_id: "RUN-TEST",
      wave_index: 0,
      total_waves: 1,
      worker_command: ["node", "audit-code.mjs", "merge-and-ingest"],
    },
    dispatchPlanPath: "/repo/.audit-tools/audit/dispatch-plan.json",
    dispatchQuotaPath: "/repo/.audit-tools/audit/dispatch-quota.json",
    hostCanRestrictSubagentTools: false,
    hostCanSelectSubagentModel: false,
    ...overrides,
  };
}

// ── renderWorkerPrompt — repository root and workdir guidance ────────────────

test("audit worker prompt includes the repository root", () => {
  const task = makeAgentTask({ repo_root: "/my/repo" });
  const prompt = renderWorkerPrompt(task);
  assert.match(prompt, /Repository root:/i);
  assert.ok(
    prompt.includes("/my/repo"),
    `Expected prompt to contain /my/repo, got: ${prompt.slice(0, 200)}`,
  );
});

test("audit worker prompt tells the host to set workdir to the repository root", () => {
  const task = makeAgentTask();
  const prompt = renderWorkerPrompt(task);
  // Must explicitly direct the host to set the workdir, NOT just reference cwd.
  assert.match(
    prompt,
    /workdir|working.?dir/i,
    "Expected prompt to mention workdir setting",
  );
});

test("audit worker prompt does not say 'current working directory' for path resolution", () => {
  const task = makeAgentTask();
  const prompt = renderWorkerPrompt(task);
  // The phrase "current working directory" leaks shell cwd assumptions;
  // use explicit repo root instead.
  assert.doesNotMatch(
    prompt,
    /current working directory/i,
    "Prompt must not rely on 'current working directory' for path resolution",
  );
});

test("audit worker prompt does not instruct workers to use `cd` to establish context", () => {
  const task = makeAgentTask({ repo_root: "/my/repo" });
  const prompt = renderWorkerPrompt(task);
  // `cd /path` should never be the recommended way to set context.
  assert.doesNotMatch(
    prompt,
    /\bcd\s+["'`]?\//,
    "Prompt must not instruct workers to use `cd /path` to set shell context",
  );
});

// ── dispatch review prompts — root and workdir guidance ──────────────────────

test("dispatch review prompt includes repository root path in continuation commands", () => {
  const params = makeReviewRunParams({ root: "/my/repo" });
  const prompt = renderDispatchReviewPrompt(params);
  // The generated merge-and-ingest and next-step commands should carry
  // --artifacts-dir that includes the repo root so a host can run them
  // without a specific cwd.
  assert.ok(
    prompt.includes("/my/repo") || prompt.includes("merge-and-ingest"),
    `Expected prompt to include root or merge command: ${prompt.slice(0, 300)}`,
  );
});

// ── nextStepCommand / mergeAndIngestCommand — slash-safe paths ───────────────

test("nextStepCommand normalizes Windows absolute path tokens to forward slashes", () => {
  const cmd = nextStepCommand("C:\\Code\\my-repo", "C:\\Code\\my-repo\\.audit-tools\\audit");
  assert.doesNotMatch(
    cmd,
    /C:\\|\\audit/,
    `Expected forward slashes in nextStepCommand output: ${cmd}`,
  );
  assert.match(cmd, /C:\/Code\/my-repo/);
});

test("mergeAndIngestCommand normalizes Windows absolute path tokens to forward slashes", () => {
  const cmd = mergeAndIngestCommand("C:\\Code\\my-repo\\.audit-tools\\audit", "RUN-001");
  assert.doesNotMatch(
    cmd,
    /\\audit/,
    `Expected forward slashes in mergeAndIngestCommand output: ${cmd}`,
  );
});

// ── non-agent task prompt — workdir guidance ─────────────────────────────────

test("non-agent worker prompt includes repository root and workdir guidance", () => {
  const task = makeAgentTask({
    preferred_executor: "claude-code",
    repo_root: "/repo",
    audit_results_path: undefined,
  });
  const prompt = renderWorkerPrompt(task);
  assert.match(prompt, /Repository root:/i);
  assert.match(prompt, /workdir|working.?dir/i);
});
