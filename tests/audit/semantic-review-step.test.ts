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

/**
 * The text a host actually reads. The step's JSON fields have their own tests
 * above; these pin the PROMPT, because the prompt is what the reader obeys and
 * the JSON is the fallback (owner review 2026-09-17, prompt 13).
 */
describe("the semantic-review prompt states the right remedy for each refusal", () => {
  /** The body of one `## ` section, up to the next heading or the end. */
  function section(prompt: string, heading: string): string {
    const start = prompt.indexOf(heading);
    if (start === -1) return "";
    const rest = prompt.slice(start + heading.length);
    const end = rest.indexOf("\n## ");
    return end === -1 ? rest : rest.slice(0, end);
  }

  async function renderWithIssues(): Promise<string> {
    const { root, artifactsDir, activeReviewRun, bundle } = await fixture();
    const step = await renderSemanticReviewStep({
      root,
      artifactsDir,
      activeReviewRun,
      bundle,
      ingestIssues: [
        {
          code: "submission_missing",
          work_item_id: "task-a",
          message: "no result file exists at the bound path",
          result_path: "runs/semantic-host-run/results/task-a.json",
        },
        {
          code: "submission_contract_invalid",
          work_item_id: "task-b",
          message: "file_coverage[0].total_lines is 40 but src/b.ts holds 2 lines",
          result_path: "runs/semantic-host-run/results/task-b.json",
        },
        {
          code: "duplicate_submission_id",
          work_item_id: "task-c",
          message:
            "work item 'task-c' was already accepted by a concurrent ingest of this run",
          result_path: "runs/semantic-host-run/results/task-c.json",
        },
        {
          code: "workload_stale",
          message:
            "the persisted audit host workload is STALE — re-prepare the handoff",
        },
      ],
    });
    return await readFile(step.prompt_path, "utf8");
  }

  it("puts a SETTLED refusal under its own heading, never under the repair heading", async () => {
    // `duplicate_submission_id` means a CONCURRENT ingest already ACCEPTED that
    // work item (`ingestAuditHostResults` raises it only after the accepted-
    // results ledger refuses the addition), so the item is no longer pending and
    // the republished workload does not carry it. `workload_stale` names no work
    // item at all and the tool re-prepares it in the same call. Both used to land
    // under "Result status requiring attention", whose one paragraph told the
    // reader to repair the result and write it again — an instruction that sends
    // the reader looking for a bound path the workload does not hold.
    const prompt = await renderWithIssues();

    expect(section(prompt, "## Results not yet written")).toContain("task-a");
    expect(section(prompt, "## Results to repair and write again")).toContain(
      "task-b",
    );
    expect(
      section(prompt, "## Results to repair and write again"),
      "a settled work item must not appear under the repair heading",
    ).not.toContain("task-c");
    const settled = section(prompt, "## Settled — no action needed");
    expect(settled).toContain("task-c");
    expect(settled).toContain("workload_stale");
    expect(prompt).not.toContain("## Result status requiring attention");
  });

  it("states the repair paragraph only when something is repairable", async () => {
    // The paragraph is the repair instruction. A run whose only refusals are
    // settled has nothing to repair, so stating it there re-introduces the same
    // wrong instruction the section split exists to remove.
    const { root, artifactsDir, activeReviewRun, bundle } = await fixture();
    const step = await renderSemanticReviewStep({
      root,
      artifactsDir,
      activeReviewRun,
      bundle,
      ingestIssues: [
        {
          code: "duplicate_submission_id",
          work_item_id: "task-c",
          message: "already accepted by a concurrent ingest of this run",
          result_path: "runs/semantic-host-run/results/task-c.json",
        },
      ],
    });
    const prompt = await readFile(step.prompt_path, "utf8");

    expect(prompt).toContain("## Settled — no action needed");
    expect(prompt).not.toContain("## Results to repair and write again");
    // The paragraph's OWN opening words, not a phrase the current wording
    // happens to carry: an assertion on wording that a rewrite drops stops
    // reaching the property it names, and then it passes against a tree that
    // states the paragraph unconditionally.
    expect(
      prompt,
      "the repair instruction must not be stated when nothing is repairable",
    ).not.toContain("Each item above is still pending");
  });

  it("prints every path in the prompt BODY the way it prints them in the JSON fields", async () => {
    // `writeStepContract` normalizes every host-facing path FIELD through
    // `toPromptPathToken`, and its header states why: raw Windows backslashes
    // break in the bash-like shells a host may use. A prompt body is not a
    // field, so the same file used to be printed twice in one step — forward-
    // slashed in `artifact_paths.host_workload`, backslashed in the text the
    // reader acts on.
    const { root, artifactsDir, activeReviewRun, bundle } = await fixture();
    const step = await renderSemanticReviewStep({
      root,
      artifactsDir,
      activeReviewRun,
      bundle,
    });
    const prompt = await readFile(step.prompt_path, "utf8");

    expect(prompt).toContain(step.artifact_paths.host_workload!);
    expect(
      prompt,
      "no rendered prompt may carry a Windows-style absolute path",
    ).not.toMatch(/[A-Za-z]:\\/u);
  });
});
