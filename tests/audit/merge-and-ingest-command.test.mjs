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
import { test, expect } from "vitest";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { withTempDir } from "./helpers/withTempDir.mjs";
import { captureConsole } from "./helpers/captureConsole.mjs";

const { cmdMergeAndIngest, validateAndCollectResults } = await import("../../src/audit/cli/mergeAndIngestCommand.ts");

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

    expect(code, "idempotent replay must exit 0").toBe(0);
    const payload = JSON.parse(stdout.trim());
    expect(payload.idempotent_replay, "must mark the replay").toBe(true);
    expect(payload.status).toBe("completed");
    expect(payload.finding_count, "must replay the prior summary verbatim").toBe(5);
    expect(payload.accepted_count).toBe(3);

    // The completion marker is untouched (no re-processing happened).
    const marker = JSON.parse(await readFile(mergeCompletePath, "utf8"));
    expect(marker.finding_count).toBe(5);
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
    expect(failed.length).toBe(2);
    const ids = failed.map((f) => f.task_id).sort();
    expect(ids).toEqual(["u1:security", "u2:correctness"]);
    for (const entry of failed) {
      expect(entry.errors.some((e) => /missing audit result/i.test(e)), `expected a missing-result error for ${entry.task_id}`).toBeTruthy();
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

// ── CP-NODE-2 pinning regression tests (invariants already fixed at HEAD) ────

test("cmdMergeAndIngest discards a STALE completion marker when a pending task has an un-ingested on-disk result (staleness self-heal), and re-processes", async () => {
  await withTempDir("merge-ingest-cmd-", async (artifactsDir) => {
    const repoRoot = artifactsDir;
    const { taskResultsDir, mergeCompletePath, failedTasksPath } = await scaffoldRun(artifactsDir, repoRoot, {
      entries: [],
      // Selective deepening re-listed this task as pending on the SAME run-id
      // after the marker was written.
      pendingTasks: [
        { task_id: "u9:security", unit_id: "u9", pass_id: "p", lens: "security", file_paths: ["src/x.ts"] },
      ],
    });

    await writeJson(mergeCompletePath, {
      run_id: RUN_ID,
      status: "completed",
      accepted_count: 1,
      rejected_count: 0,
      finding_count: 0,
    });

    // The pending task's answer is on disk — the marker is now stale. The
    // answer is deliberately INVALID (lens mismatch) so re-processing blocks
    // before runAuditStep, keeping the test bundle-free; what matters is that
    // the run RE-PROCESSES (throws) instead of replaying the stale summary.
    await writeJson(join(taskResultsDir, "u9.json"), {
      task_id: "u9:security",
      unit_id: "u9",
      pass_id: "p",
      lens: "correctness",
      file_coverage: [{ path: "src/x.ts", total_lines: 5 }],
      findings: [],
    });

    await assert.rejects(
      () =>
        captureConsole(() =>
          cmdMergeAndIngest(["--artifacts-dir", artifactsDir, "--run-id", RUN_ID]),
        ),
      /blocked before ingestion/i,
      "a stale marker must be discarded and the run re-processed, not replayed",
    );

    // The stale marker was removed (self-heal), not replayed.
    await assert.rejects(
      () => readFile(mergeCompletePath, "utf8"),
      "the stale completion marker must be deleted",
    );
    const failed = JSON.parse(await readFile(failedTasksPath, "utf8"));
    expect(failed.map((f) => f.task_id)).toEqual(["u9:security"]);
  });
});

test("cmdMergeAndIngest exit-code contract: a round where every pending task was held back (notDispatched) exits 0, preserves run-results.json, writes no marker, and never counts schema pointer files spurious", async () => {
  await withTempDir("merge-ingest-cmd-", async (artifactsDir) => {
    const repoRoot = artifactsDir;
    const { runDir, taskResultsDir, mergeCompletePath } = await scaffoldRun(artifactsDir, repoRoot, {
      // No dispatch entries: the pending task was never dispatched this round
      // (budget-capped / planning-deferred) — NOT a failure.
      entries: [],
      pendingTasks: [
        { task_id: "u1:security", unit_id: "u1", pass_id: "p", lens: "security", file_paths: ["src/a.ts"] },
      ],
    });

    // Schema pointer support artifacts prepare-dispatch copies into
    // task-results/ — expected, never spurious, never results.
    await writeJson(join(taskResultsDir, "audit_result.schema.json"), { $schema: "stub" });

    // A prior successful round's run-results.json must survive this no-op
    // round untouched (no destructive truncation).
    const runResultsPath = join(runDir, "run-results.json");
    const prior = [{ task_id: "prior-task" }];
    await writeJson(runResultsPath, prior);

    const { code, stdout } = await captureConsole(() =>
      cmdMergeAndIngest(["--artifacts-dir", artifactsDir, "--run-id", RUN_ID]),
    );

    expect(code, "notDispatched > 0 with zero failures must exit 0").toBe(0);
    const payload = JSON.parse(stdout.trim());
    expect(payload.status).toBe("partial");
    expect(payload.not_dispatched_count).toBe(1);
    expect(payload.rejected_count).toBe(0);
    expect(payload.accepted_count).toBe(0);
    expect(payload.spurious_file_count, "schema pointer files are support artifacts, not spurious").toBe(0);

    const preserved = JSON.parse(await readFile(runResultsPath, "utf8"));
    expect(preserved, "run-results.json must not be truncated by a held-back round").toEqual(prior);

    let markerExists = true;
    try {
      await readFile(mergeCompletePath, "utf8");
    } catch {
      markerExists = false;
    }
    expect(markerExists, "a held-back round must not write the completion marker").toBe(false);
  });
});

test("validateAndCollectResults rejects a duplicate task_id at ingest (dedup via seenTaskIds) instead of double-ingesting", async () => {
  await withTempDir("merge-ingest-cmd-", async (dir) => {
    const t1 = { task_id: "t1", unit_id: "u", pass_id: "p", lens: "security", file_paths: ["src/a.ts"] };
    const t2 = { task_id: "t2", unit_id: "u2", pass_id: "p", lens: "security", file_paths: ["src/b.ts"] };
    const mk = (tid, unit, path) => ({
      task_id: tid,
      unit_id: unit,
      pass_id: "p",
      lens: "security",
      file_coverage: [{ path, total_lines: 3 }],
      findings: [],
    });
    const r1Path = join(dir, "r1.json");
    const r2Path = join(dir, "r2.json");
    await writeJson(r1Path, mk("t1", "u", "src/a.ts"));
    // t2's assigned result file contains a SECOND copy of t1's result.
    await writeJson(r2Path, mk("t1", "u", "src/a.ts"));

    const entryByTaskId = new Map([
      ["t1", { result_path: r1Path, task_id: "t1", packet_id: "pkt" }],
      ["t2", { result_path: r2Path, task_id: "t2", packet_id: "pkt" }],
    ]);

    const { passing, failing } = await validateAndCollectResults(
      [t1, t2],
      entryByTaskId,
      new Map(),
      new Map(),
    );

    expect(passing.map((r) => r.task_id), "exactly one copy may ingest").toEqual(["t1"]);
    expect(failing.length).toBe(1);
    expect(
      failing[0].errors.some((e) => /duplicate audit result/i.test(e)),
      `expected a duplicate-task_id rejection, got: ${JSON.stringify(failing[0].errors)}`,
    ).toBeTruthy();
  });
});
