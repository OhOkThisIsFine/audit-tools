import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import os from "node:os";
import type { AuditorDescriptor } from "audit-tools/shared";
import type { ActiveReviewRun } from "../../src/audit/supervisor/operatorHandoff.js";

const { renderSemanticReviewStep } = await import("../../src/audit/cli/semanticReviewStep.js");

// A minimal ambient descriptor (no host handshake): under the unconditional
// materialized form this sizes DEGENERATELY (one task per packet, no fit
// claim) instead of refusing or falling back — change-2 constraint 2.
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
// Always-materialized fan-out (design resolution 2, 2026-08-05): there is no
// capability branch — renderSemanticReviewStep no longer takes hostCanDispatch,
// and every host receives the SAME materialized dispatch step (packet files on
// disk, dispatch_plan in artifact_paths) with a capability-neutral prompt. This
// was the design-check's pinned-red test (it.fails until the branch deletion);
// it is now the standing contract for the unconditional form.
// ---------------------------------------------------------------------------

describe("renderSemanticReviewStep is capability-unconditional (always-materialized fan-out)", () => {
  it("a full-handshake host gets the materialized dispatch step with no capability flag consumed", async () => {
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
        hostMaxActiveSubagents: null,
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

  // Change-2 constraint 2 (settled): a handshake-less host is sized
  // DEGENERATELY — one task per packet, no fit claim — never refused (that
  // would strand the weakest hosts) and never silently fitted to an invented
  // window. The missing handshake surfaces as a loud dispatch warning.
  it("a handshake-less host degrades to one-task-per-packet with a loud warning, never a refusal", async () => {
    const artifactsDir = await makeTempArtifactsDir();
    try {
      const runId = "test-run-degenerate";
      const runDir = join(artifactsDir, "runs", runId);
      await mkdir(join(runDir, "task-results"), { recursive: true });
      const tasks = ["abc", "def", "ghi"].map((tag, i) => ({
        task_id: `t-${tag}`,
        unit_id: `unit-${tag}`,
        pass_id: `pass:correctness`,
        lens: "correctness",
        file_paths: [`src/${tag}/${tag}.ts`],
        file_line_counts: { [`src/${tag}/${tag}.ts`]: 50 + i },
        rationale: `review ${tag}`,
        priority: "medium",
      }));
      await writeFile(
        join(runDir, "pending-audit-tasks.json"),
        JSON.stringify(tasks),
        "utf8",
      );
      const activeRun = makeActiveReviewRun(artifactsDir, runId);
      const step = await renderSemanticReviewStep({
        root: artifactsDir,
        artifactsDir,
        activeReviewRun: activeRun,
        hostMaxActiveSubagents: null,
        descriptor: AMBIENT_DESCRIPTOR,
      });
      expect(step.step_kind).toBe("dispatch_review");
      // One task per packet: no merge is a fit claim the tool cannot make.
      expect(step.progress?.pending_packets).toBe(tasks.length);
      // The integration gap stays loud: a dispatch warning names the missing
      // handshake instead of the degradation shipping silently forever.
      expect(
        typeof step.artifact_paths.dispatch_warnings === "string" &&
          step.artifact_paths.dispatch_warnings.length > 0,
        "unknown-window degradation must surface a dispatch warning",
      ).toBeTruthy();
    } finally {
      await rm(artifactsDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// hostCanDispatch=true — dispatch_review branch
// ---------------------------------------------------------------------------

describe("renderSemanticReviewStep returns a dispatch_review step contract", () => {
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
      hostMaxActiveSubagents: null,
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
