import { readFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { renderSemanticReviewStep } from "../../src/audit/cli/semanticReviewStep.js";
import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";
import { LaneDemandSchema } from "../../src/shared/types/stepContract.js";
import { bannedLaneExecutionKeys } from "../helpers/recognizers.js";
import type { ActiveReviewRun } from "../../src/audit/supervisor/operatorHandoff.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture(
  completedTaskIds: readonly string[] = [],
): Promise<{
  root: string;
  artifactsDir: string;
  activeReviewRun: ActiveReviewRun;
  taskCount: number;
  /**
   * The artifact bundle the review obligation's pending partition is derived
   * from. A caller that has results already accepted is modelled by results
   * already IN it — never by a `completed_tasks` number handed in beside the
   * task list.
   */
  bundle: ArtifactBundle;
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
  // The manifest is refreshed by the pause from the partition, never the other
  // way round — so the fixture writes what the pause would have: the tasks the
  // bundle's results do not already cover.
  const covered = new Set(completedTaskIds);
  await writeFile(
    pendingPath,
    JSON.stringify(tasks.filter((task) => !covered.has(task.task_id))),
    "utf8",
  );
  return {
    root,
    artifactsDir,
    taskCount: tasks.length,
    bundle: {
      audit_tasks: tasks as ArtifactBundle["audit_tasks"],
      ...(completedTaskIds.length === 0
        ? {}
        : {
            audit_results: completedTaskIds.map((taskId) => ({
              task_id: taskId,
              unit_id: `unit-${taskId}`,
              pass_id: "pass:correctness",
              lens: "correctness",
              file_coverage: [],
              findings: [],
              reviewed_clean: true,
              run_id: runId,
            })),
          }),
    },
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
    const { root, artifactsDir, activeReviewRun, taskCount, bundle } =
      await fixture();
    const step = await renderSemanticReviewStep({
      root,
      artifactsDir,
      activeReviewRun,
      bundle,
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

  it("states each emitted lane's demand, and nothing execution-shaped", async () => {
    // The step contract that emits an audit lane is what the host reads to match
    // a backend to the work, so the ranking has to be ON the emitted item — not
    // merely derivable from the task. `demand` names size / complexity / risk
    // and nothing else: a `model`, `provider`, `tier` or `backend` key here
    // would move execution selection into the tool, which is the boundary this
    // package exists downstream of.
    const { root, artifactsDir, activeReviewRun, bundle } = await fixture();
    const step = await renderSemanticReviewStep({
      root,
      artifactsDir,
      activeReviewRun,
      bundle,
    });
    const workload = JSON.parse(
      await readFile(step.artifact_paths.host_workload!, "utf8"),
    ) as { work_items: Array<Record<string, unknown>> };

    expect(workload.work_items.length).toBeGreaterThan(0);
    for (const item of workload.work_items) {
      const metadata = item.metadata as Record<string, unknown>;
      expect(LaneDemandSchema.safeParse(metadata.demand).success).toBe(true);
      expect(Object.keys(metadata).sort()).toEqual(["demand", "token_estimate"]);
      // The emitted item, walked whole, carries no execution choice — the
      // demand shape alone would not catch a field bolted onto the item beside
      // `prompt` and `result_path`.
      expect(bannedLaneExecutionKeys(item)).toEqual([]);
    }
  });

  it("counts the completed tasks from the pending-set partition, not from what the publish hid", async () => {
    // `completed_tasks` used to be `tasks.length - work_items.length` — a
    // subtraction that measured how many items the handoff boundary WITHHELD,
    // which is nothing now that the boundary publishes every task it is handed,
    // so it read a flat 0 for a run that had accepted results. The count comes
    // from the same partition the pending list is projected from instead.
    const { root, artifactsDir, activeReviewRun, bundle } = await fixture([
      "task-b",
    ]);
    const step = await renderSemanticReviewStep({
      root,
      artifactsDir,
      activeReviewRun,
      bundle,
    });

    expect(step.progress?.completed_tasks).toBe(1);
    expect(step.progress?.pending_tasks).toBe(2);
    const workload = JSON.parse(
      await readFile(step.artifact_paths.host_workload!, "utf8"),
    ) as { work_items: Array<{ id: string }> };
    expect(workload.work_items.map((item) => item.id)).toEqual([
      "task-a",
      "task-c",
    ]);
  });

  it("emits stable workload bytes when the same pending run is rendered again", async () => {
    const { root, artifactsDir, activeReviewRun, bundle } = await fixture();
    const first = await renderSemanticReviewStep({
      root,
      artifactsDir,
      activeReviewRun,
      bundle,
    });
    const firstBytes = await readFile(first.artifact_paths.host_workload!, "utf8");
    const second = await renderSemanticReviewStep({
      root,
      artifactsDir,
      activeReviewRun,
      bundle,
    });
    expect(await readFile(second.artifact_paths.host_workload!, "utf8")).toBe(
      firstBytes,
    );
  });
});
