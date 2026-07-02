import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import os from "node:os";

const { renderSemanticReviewStep } = await import("../../src/audit/cli/semanticReviewStep.ts");
// Step contracts normalize host-facing paths to forward slashes (drift-plan R3).
const { toPromptPathToken } = await import("audit-tools/shared");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTempArtifactsDir() {
  const dir = await mkdtemp(join(os.tmpdir(), "audit-semantic-review-"));
  await mkdir(join(dir, "steps"), { recursive: true });
  return dir;
}

/**
 * Build a minimal ActiveReviewRun for a given artifactsDir and runId.
 * The paths used here are plausible but the files need not exist for the
 * hostCanDispatch=false branch (which doesn't read them).
 */
function makeActiveReviewRun(artifactsDir, runId) {
  const runDir = join(artifactsDir, "runs", runId);
  return {
    run_id: runId,
    task_path: join(runDir, "current-task.json"),
    prompt_path: join(runDir, "current-prompt.md"),
    pending_audit_tasks_path: join(runDir, "pending-audit-tasks.json"),
    audit_results_path: join(artifactsDir, "audit-results.jsonl"),
    worker_command: ["audit-code", "submit-packet", "--artifacts-dir", artifactsDir],
  };
}

// ---------------------------------------------------------------------------
// hostCanDispatch=false — single_task_fallback branch
// ---------------------------------------------------------------------------

describe("renderSemanticReviewStep hostCanDispatch=false returns a single_task_fallback step contract", () => {
  let artifactsDir;
  let activeReviewRun;
  let result;

  beforeAll(async () => {
    artifactsDir = await makeTempArtifactsDir();

    const runId = "test-run-fallback";
    activeReviewRun = makeActiveReviewRun(artifactsDir, runId);

    result = await renderSemanticReviewStep({
      root: artifactsDir,
      artifactsDir,
      activeReviewRun,
      hostCanDispatch: false,
      hostMaxActiveSubagents: null,
      hostCanRestrictSubagentTools: false,
      hostCanSelectSubagentModel: false,
    });
  });

  afterAll(() => rm(artifactsDir, { recursive: true, force: true }));

  it("stepKind is single_task_fallback", () => {
    expect(result.step_kind).toBe("single_task_fallback");
  });

  it("status is ready", () => {
    expect(result.status).toBe("ready");
  });

  it("runId matches activeReviewRun.run_id", () => {
    expect(result.run_id).toBe(activeReviewRun.run_id);
  });

  it("artifactPaths.single_task_prompt is a non-empty string", () => {
    expect(typeof result.artifact_paths.single_task_prompt === "string" &&
        result.artifact_paths.single_task_prompt.length > 0, "single_task_prompt must be a non-empty string").toBeTruthy();
  });

  it("artifactPaths.audit_results equals normalized activeReviewRun.audit_results_path", () => {
    expect(result.artifact_paths.audit_results).toBe(toPromptPathToken(activeReviewRun.audit_results_path));
  });

  it("allowedCommands has length >= 1 and contains the rendered worker command", () => {
    expect(result.allowed_commands.length >= 1, "allowed_commands must be non-empty").toBeTruthy();
    // The rendered worker command is built from renderCommand(activeReviewRun.worker_command)
    const hasWorkerCommand = result.allowed_commands.some((cmd) =>
      cmd.includes("audit-code") && cmd.includes("submit-packet"),
    );
    expect(hasWorkerCommand, "allowed_commands must contain the rendered worker command").toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// hostCanDispatch=true — dispatch_review branch
// ---------------------------------------------------------------------------

describe("renderSemanticReviewStep hostCanDispatch=true returns a dispatch_review step contract", () => {
  let artifactsDir;
  let activeReviewRun;
  let result;

  beforeAll(async () => {
    artifactsDir = await makeTempArtifactsDir();

    const runId = "test-run-dispatch";
    const runDir = join(artifactsDir, "runs", runId);
    await mkdir(join(runDir, "task-results"), { recursive: true });

    // Write a minimal pending-audit-tasks.json with one task
    const pendingTasks = [
      {
        task_id: "t-abc123",
        unit_id: "unit-abc",
        pass_id: "pass:correctness",
        lens: "correctness",
        file_paths: ["src/foo/foo.ts"],
        file_line_counts: { "src/foo/foo.ts": 50 },
        rationale: "review foo",
        priority: "medium",
      },
    ];
    await writeFile(
      join(runDir, "pending-audit-tasks.json"),
      JSON.stringify(pendingTasks),
      "utf8",
    );

    activeReviewRun = makeActiveReviewRun(artifactsDir, runId);

    result = await renderSemanticReviewStep({
      root: artifactsDir,
      artifactsDir,
      activeReviewRun,
      hostCanDispatch: true,
      hostMaxActiveSubagents: null,
      hostCanRestrictSubagentTools: false,
      hostCanSelectSubagentModel: false,
    });
  });

  afterAll(() => rm(artifactsDir, { recursive: true, force: true }));

  it("stepKind is dispatch_review", () => {
    expect(result.step_kind).toBe("dispatch_review");
  });

  it("status is ready", () => {
    expect(result.status).toBe("ready");
  });

  it("runId matches activeReviewRun.run_id", () => {
    expect(result.run_id).toBe(activeReviewRun.run_id);
  });

  it("progress.pending_packets >= 1", () => {
    expect(result.progress != null && result.progress.pending_packets >= 1, "progress.pending_packets must be at least 1").toBeTruthy();
  });

  it("artifactPaths.dispatch_plan is a non-empty string", () => {
    expect(typeof result.artifact_paths.dispatch_plan === "string" &&
        result.artifact_paths.dispatch_plan.length > 0, "dispatch_plan must be a non-empty string").toBeTruthy();
  });

  it("allowedCommands contains a merge-and-ingest command", () => {
    expect(result.allowed_commands.some((cmd) => /merge-and-ingest/.test(cmd)), "allowed_commands must include a merge-and-ingest command").toBeTruthy();
  });

  it("allowedCommands contains a next-step command", () => {
    expect(result.allowed_commands.some((cmd) => /next-step/.test(cmd)), "allowed_commands must include a next-step command").toBeTruthy();
  });
});
