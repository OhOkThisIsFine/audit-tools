/**
 * merge-and-ingest-command.test.mjs (TST-5f5deb87) — command-level behavioral
 * coverage for `cmdMergeAndIngest`. The per-finding grounding pass and the
 * flatten/merge wiring are unit-tested in grounding-ingest-pass.test.mjs; this
 * file covers the COMMAND behaviors that previously had none:
 *
 *   1. Idempotency replay — a fully-merged run with a completion marker and no
 *      pending task answered on disk replays its prior summary (idempotent_replay)
 *      and does NOT re-ingest.
 *   2. Blocked-before-ingestion — when every assigned task result is missing, the
 *      command writes failed-tasks.json and throws "blocked before ingestion"
 *      rather than truncating the cumulative store.
 *
 * Both paths exit before runAuditStep, so no full audit bundle is needed —
 * keeping the test deterministic and bundle-independent.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { withTempDir } from "./helpers/withTempDir.mjs";
import { captureConsole } from "./helpers/captureConsole.mjs";

const { cmdMergeAndIngest } = await import("../src/cli/mergeAndIngestCommand.ts");

const RUN_ID = "run-merge-test";

async function writeJson(path, value) {
  await writeFile(path, JSON.stringify(value, null, 2), "utf8");
}

/**
 * Lay down the minimal run-dir scaffolding cmdMergeAndIngest reads before the
 * ingest step: task.json (WorkerTask), the dispatch result map, and the
 * pending-audit-tasks list. Returns the per-run paths the tests assert on.
 */
async function scaffoldRun(artifactsDir, repoRoot, { entries, pendingTasks }) {
  const runDir = join(artifactsDir, "runs", RUN_ID);
  const taskResultsDir = join(runDir, "task-results");
  await mkdir(taskResultsDir, { recursive: true });

  await writeJson(join(runDir, "task.json"), {
    contract_version: "audit-code-worker/v1alpha1",
    run_id: RUN_ID,
    repo_root: repoRoot,
    artifacts_dir: artifactsDir,
    obligation_id: "audit_tasks_completed",
    preferred_executor: "claude-code",
    result_path: join(runDir, "worker-result.json"),
    worker_command: ["noop"],
  });

  await writeJson(join(runDir, "dispatch-result-map.json"), {
    contract_version: "audit-code-dispatch-results/v1alpha1",
    run_id: RUN_ID,
    entries,
  });

  await writeJson(join(runDir, "pending-audit-tasks.json"), pendingTasks);

  return {
    runDir,
    taskResultsDir,
    mergeCompletePath: join(runDir, "merge-complete.json"),
    failedTasksPath: join(runDir, "failed-tasks.json"),
  };
}

test("cmdMergeAndIngest replays a completed run's summary without re-ingesting (idempotency)", async () => {
  await withTempDir("merge-ingest-cmd-", async (artifactsDir) => {
    const repoRoot = artifactsDir; // no source read on this path
    const { runDir, mergeCompletePath } = await scaffoldRun(artifactsDir, repoRoot, {
      // One task, but it is NOT present in the pending list, so a stale marker
      // cannot be invalidated by a "pending task answered on disk".
      entries: [
        { packet_id: "pkt-1", task_id: "u1:security", result_path: join(artifactsDir, "runs", RUN_ID, "task-results", "u1.json") },
      ],
      pendingTasks: [],
    });

    const priorSummary = {
      run_id: RUN_ID,
      status: "completed",
      accepted_count: 3,
      rejected_count: 0,
      finding_count: 5,
    };
    await writeJson(mergeCompletePath, priorSummary);

    const { code, stdout } = await captureConsole(() =>
      cmdMergeAndIngest(["--artifacts-dir", artifactsDir, "--run-id", RUN_ID]),
    );

    assert.equal(code, 0, "idempotent replay must exit 0");
    const payload = JSON.parse(stdout.trim());
    assert.equal(payload.idempotent_replay, true, "must mark the replay");
    assert.equal(payload.status, "completed");
    assert.equal(payload.finding_count, 5, "must replay the prior summary verbatim");
    assert.equal(payload.accepted_count, 3);

    // The completion marker is untouched (no re-processing happened).
    const marker = JSON.parse(await readFile(mergeCompletePath, "utf8"));
    assert.equal(marker.finding_count, 5);
  });
});

test("cmdMergeAndIngest blocks (throws + writes failed-tasks.json) when every assigned result is missing", async () => {
  await withTempDir("merge-ingest-cmd-", async (artifactsDir) => {
    const repoRoot = artifactsDir;
    const { failedTasksPath } = await scaffoldRun(artifactsDir, repoRoot, {
      entries: [
        { packet_id: "pkt-1", task_id: "u1:security", result_path: join(artifactsDir, "runs", RUN_ID, "task-results", "missing-1.json") },
        { packet_id: "pkt-1", task_id: "u2:correctness", result_path: join(artifactsDir, "runs", RUN_ID, "task-results", "missing-2.json") },
      ],
      // Both tasks are pending and assigned, but no result file exists for either.
      pendingTasks: [
        { task_id: "u1:security", unit_id: "u1", pass_id: "p", lens: "security", file_paths: ["src/a.ts"] },
        { task_id: "u2:correctness", unit_id: "u2", pass_id: "p", lens: "correctness", file_paths: ["src/b.ts"] },
      ],
    });

    await assert.rejects(
      () =>
        captureConsole(() =>
          cmdMergeAndIngest(["--artifacts-dir", artifactsDir, "--run-id", RUN_ID]),
        ),
      /blocked before ingestion/i,
      "all-missing results must block before ingestion, not truncate the store",
    );

    // failed-tasks.json records both missing assignments for retry.
    const failed = JSON.parse(await readFile(failedTasksPath, "utf8"));
    assert.equal(failed.length, 2);
    const ids = failed.map((f) => f.task_id).sort();
    assert.deepEqual(ids, ["u1:security", "u2:correctness"]);
    for (const entry of failed) {
      assert.ok(
        entry.errors.some((e) => /missing audit result/i.test(e)),
        `expected a missing-result error for ${entry.task_id}`,
      );
    }
  });
});

test("cmdMergeAndIngest requires --run-id", async () => {
  await withTempDir("merge-ingest-cmd-", async (artifactsDir) => {
    await assert.rejects(
      () => cmdMergeAndIngest(["--artifacts-dir", artifactsDir]),
      /requires --run-id/,
    );
  });
});
