import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import os from "node:os";
import type { AuditorDescriptor } from "audit-tools/shared";
import type { ActiveReviewRun } from "../../src/audit/supervisor/operatorHandoff.js";

const { renderSemanticReviewStep } = await import("../../src/audit/cli/semanticReviewStep.js");
// Step contracts normalize host-facing paths to forward slashes (drift-plan R3).
const { toPromptPathToken } = await import("audit-tools/shared");

// A minimal ambient descriptor (no host handshake) — sufficient for the
// single_task_fallback branch, which doesn't size dispatch packets.
const AMBIENT_DESCRIPTOR: AuditorDescriptor = { self: {} };

// The dispatch branch sizes packets against the host pool, so the handshake must
// report both token limits — an unidentified host with unknown limits is a
// deliberate refusal, not a sizing default.
const DISPATCH_DESCRIPTOR: AuditorDescriptor = {
  self: {
    provider: "worker-command",
    can_dispatch_subagents: true,
    context_tokens: 200_000,
    output_tokens: 8_000,
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTempArtifactsDir(): Promise<string> {
  const dir = await mkdtemp(join(os.tmpdir(), "audit-semantic-review-"));
  await mkdir(join(dir, "steps"), { recursive: true });
  return dir;
}

/**
 * Build a minimal ActiveReviewRun for a given artifactsDir and runId.
 * The paths used here are plausible but the files need not exist for the
 * hostCanDispatch=false branch (which doesn't read them).
 */
function makeActiveReviewRun(artifactsDir: string, runId: string): ActiveReviewRun {
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
  let artifactsDir: string;
  let activeReviewRun: ActiveReviewRun;
  let result: Awaited<ReturnType<typeof renderSemanticReviewStep>>;

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
      descriptor: AMBIENT_DESCRIPTOR,
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
// Always-materialized fan-out (design resolution 2, 2026-08-05): the capability
// branch is replaced by the unconditional form — a host that reports it cannot
// dispatch subagents still receives the SAME materialized dispatch step (packet
// files on disk, dispatch_plan in artifact_paths) with a capability-neutral
// prompt, executing the lanes sequentially itself. Today the branch instead
// emits single_task_fallback, so materialization silently depends on host
// capability — the exact per-IDE artifact divergence the resolution retires.
// Pinned RED via it.fails so the tree stays green: implementing the
// unconditional form makes it.fails itself fail, forcing the flip to it().
// ---------------------------------------------------------------------------

describe("renderSemanticReviewStep is capability-unconditional (always-materialized fan-out)", () => {
  it.fails("hostCanDispatch=false with a full handshake still materializes the dispatch step", async () => {
    const artifactsDir = await makeTempArtifactsDir();
    try {
      const runId = "test-run-unconditional";
      const runDir = join(artifactsDir, "runs", runId);
      await mkdir(join(runDir, "task-results"), { recursive: true });
      await writeFile(
        join(runDir, "pending-audit-tasks.json"),
        JSON.stringify([
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
        ]),
        "utf8",
      );
      const activeRun = makeActiveReviewRun(artifactsDir, runId);
      const step = await renderSemanticReviewStep({
        root: artifactsDir,
        artifactsDir,
        activeReviewRun: activeRun,
        hostCanDispatch: false,
        hostMaxActiveSubagents: null,
        hostCanRestrictSubagentTools: false,
        hostCanSelectSubagentModel: false,
        hostContextTokens: DISPATCH_DESCRIPTOR.self.context_tokens ?? null,
        hostOutputTokens: DISPATCH_DESCRIPTOR.self.output_tokens ?? null,
        descriptor: DISPATCH_DESCRIPTOR,
      });
      expect(step.step_kind).toBe("dispatch_review");
      expect(
        typeof step.artifact_paths.dispatch_plan === "string" &&
          step.artifact_paths.dispatch_plan.length > 0,
        "dispatch_plan must be materialized regardless of host capability",
      ).toBeTruthy();
    } finally {
      await rm(artifactsDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// hostCanDispatch=true — dispatch_review branch
// ---------------------------------------------------------------------------

describe("renderSemanticReviewStep hostCanDispatch=true returns a dispatch_review step contract", () => {
  let artifactsDir: string;
  let activeReviewRun: ActiveReviewRun;
  let result: Awaited<ReturnType<typeof renderSemanticReviewStep>>;

  beforeAll(async () => {
    artifactsDir = await makeTempArtifactsDir();

    const runId = "test-run-dispatch";
    const runDir = join(artifactsDir, "runs", runId);
    await mkdir(join(runDir, "task-results"), { recursive: true });

    // Write a small multi-packet frontier. The host semantic path must hand the
    // whole fit-compatible frontier to the conversation host; audit-tools must
    // not reserve or cold-start-cap it first.
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
      {
        task_id: "t-def456",
        unit_id: "unit-def",
        pass_id: "pass:security",
        lens: "security",
        file_paths: ["src/bar/bar.ts"],
        file_line_counts: { "src/bar/bar.ts": 50 },
        rationale: "review bar",
        priority: "medium",
      },
      {
        task_id: "t-ghi789",
        unit_id: "unit-ghi",
        pass_id: "pass:reliability",
        lens: "reliability",
        file_paths: ["src/baz/baz.ts"],
        file_line_counts: { "src/baz/baz.ts": 50 },
        rationale: "review baz",
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
      // The real caller (nextStepCommand) lifts these from the handshake's
      // self.context_tokens/output_tokens — mirror that derivation here.
      hostContextTokens: DISPATCH_DESCRIPTOR.self.context_tokens ?? null,
      hostOutputTokens: DISPATCH_DESCRIPTOR.self.output_tokens ?? null,
      descriptor: DISPATCH_DESCRIPTOR,
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
    expect(result.progress != null && (result.progress.pending_packets ?? 0) >= 1, "progress.pending_packets must be at least 1").toBeTruthy();
  });

  it("does not expose local quota state or a local grant subset", () => {
    expect(result.artifact_paths?.dispatch_quota).toBeUndefined();
    expect(result.progress?.granted_count).toBe(3);
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
