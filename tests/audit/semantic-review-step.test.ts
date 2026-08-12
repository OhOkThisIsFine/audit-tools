import { readFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { renderSemanticReviewStep } from "../../src/audit/cli/semanticReviewStep.js";
import type { ActiveReviewRun } from "../../src/audit/supervisor/operatorHandoff.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture(): Promise<{
  root: string;
  artifactsDir: string;
  activeReviewRun: ActiveReviewRun;
  taskCount: number;
}> {
  const root = await mkdtemp(join(tmpdir(), "audit-semantic-review-"));
  roots.push(root);
  const artifactsDir = join(root, ".audit-tools", "audit");
  const runId = "semantic-host-run";
  const runDir = join(artifactsDir, "runs", runId);
  await mkdir(runDir, { recursive: true });
  const tasks = [
    ["task-a", "correctness", "src/a.ts"],
    ["task-b", "security", "src/b.ts"],
    ["task-c", "reliability", "src/c.ts"],
  ].map(([taskId, lens, path], index) => ({
    task_id: taskId,
    unit_id: `unit-${taskId}`,
    pass_id: `pass:${lens}`,
    lens,
    file_paths: [path],
    file_line_counts: { [path]: 2 },
    rationale: `Review ${path}`,
    priority: index === 1 ? "high" : "medium",
    token_estimate: 1_000 + index,
  }));
  const pendingPath = join(runDir, "pending-audit-tasks.json");
  await writeFile(pendingPath, JSON.stringify(tasks), "utf8");
  return {
    root,
    artifactsDir,
    taskCount: tasks.length,
    activeReviewRun: {
      contract_version: "audit-review-run/v1alpha1",
      run_id: runId,
      review_run_path: join(runDir, "review-run.json"),
      pending_audit_tasks_path: pendingPath,
      host_workload_path: join(runDir, "host-workload.json"),
      host_result_map_path: join(runDir, "host-result-map.json"),
    },
  };
}

describe("renderSemanticReviewStep zero-adapter host handoff", () => {
  it("publishes the complete workload with no local dispatch or merge instruction", async () => {
    const { root, artifactsDir, activeReviewRun, taskCount } = await fixture();
    const step = await renderSemanticReviewStep({
      root,
      artifactsDir,
      activeReviewRun,
    });

    expect(step.step_kind).toBe("dispatch_review");
    expect(step.status).toBe("ready");
    expect(step.run_id).toBe(activeReviewRun.run_id);
    expect(step.progress?.pending_tasks).toBe(taskCount);
    expect(step.artifact_paths.host_workload).toEqual(expect.any(String));
    expect(step.artifact_paths.host_result_map).toEqual(expect.any(String));
    expect(step.artifact_paths.dispatch_plan).toBeUndefined();
    expect(step.artifact_paths.dispatch_quota).toBeUndefined();
    expect(step.allowed_commands).toHaveLength(1);
    expect(step.allowed_commands[0]).toMatch(/next-step/u);
    expect(step.allowed_commands[0]).not.toMatch(/merge-and-ingest/u);

    const workload = JSON.parse(
      await readFile(step.artifact_paths.host_workload!, "utf8"),
    ) as { work_items: Array<{ id: string; result_path: string }> };
    expect(workload.work_items.map((item) => item.id)).toEqual([
      "task-a",
      "task-b",
      "task-c",
    ]);
    expect(step.access?.write_paths).toHaveLength(taskCount);
    expect(workload.work_items.every((item) => !item.result_path.startsWith(root))).toBe(
      true,
    );
  });

  it("emits stable workload bytes when the same pending run is rendered again", async () => {
    const { root, artifactsDir, activeReviewRun } = await fixture();
    const first = await renderSemanticReviewStep({
      root,
      artifactsDir,
      activeReviewRun,
    });
    const firstBytes = await readFile(first.artifact_paths.host_workload!, "utf8");
    const second = await renderSemanticReviewStep({
      root,
      artifactsDir,
      activeReviewRun,
    });
    expect(await readFile(second.artifact_paths.host_workload!, "utf8")).toBe(
      firstBytes,
    );
  });
});
