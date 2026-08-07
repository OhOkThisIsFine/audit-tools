import { test, expect, vi } from "vitest";
import assert from "node:assert/strict";

// Heavy spawn suite: real tarball packs + real subprocess round-trips, and the
// cases are `concurrent`, so under a full-suite run they contend with siblings.
// Single-sourced ceiling — see tests/helpers/heavy-timeout.mjs for the rationale.
import { HEAVY_AUDIT_TEST_TIMEOUT_MS } from "../helpers/heavy-timeout.mjs";
vi.setConfig({ testTimeout: HEAVY_AUDIT_TEST_TIMEOUT_MS });
import { stat, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AUDITOR_ARGS,
  runWrapper,
  setupMergeFixture,
  startDispatchRun,
  submitAllPackets,
  validAuditResultForTask,
  withTempRepo,
  type TaskRecord,
} from "./helpers/wrapper-harness.js";

test.concurrent("merge-and-ingest blocks when assigned task results are missing", async () => {
  await withTempRepo(async (root) => {
    const step = await startDispatchRun(root);
    const runId = step.run_id;
    const artifactsDir = step.artifacts_dir;

    expect(runId).toBeTruthy();
    expect(artifactsDir).toBeTruthy();

    await runWrapper(
      [
        "prepare-dispatch",
        "--run-id",
        runId,
        "--artifacts-dir",
        artifactsDir,
        ...AUDITOR_ARGS,
      ],
      { cwd: root },
    );

    await assert.rejects(
      runWrapper(
        ["merge-and-ingest", "--run-id", runId, "--artifacts-dir", artifactsDir],
        { cwd: root },
      ),
      /missing or invalid|blocked before ingestion/i,
    );
  });
});

test.concurrent("merge-and-ingest accepts packet task result files as the legacy result array", async () => {
  await withTempRepo(async (root) => {
    const { runId, artifactsDir, runDir, tasks, taskById, plan, resultMap } =
      await setupMergeFixture(root);

    await submitAllPackets(root, runId, artifactsDir, plan, resultMap, taskById);

    const merge = await runWrapper(
      ["merge-and-ingest", "--run-id", runId, "--artifacts-dir", artifactsDir],
      { cwd: root },
    );
    const mergeSummary = JSON.parse(merge.stdout);
    expect(mergeSummary.status).toBe("completed");
    expect(mergeSummary.accepted_count).toBe(tasks.length);
    expect(mergeSummary.rejected_count).toBe(0);
    expect(mergeSummary.finding_count).toBe(0);
    expect(mergeSummary.selected_executor).toBe("result_ingestion_executor");
    expect("next_likely_step" in mergeSummary).toBeTruthy();

    const merged: TaskRecord[] = JSON.parse(
      await readFile(join(runDir, "run-results.json"), "utf8"),
    );
    expect(merged.map((result) => result.task_id).sort()).toEqual(tasks.map((task) => task.task_id).sort());
    // Structured observability logs (e.g. selectiveDeepening strategy_summary) are
    // emitted to stderr at info level; only reject lines that indicate actual errors.
    const stderrLines = merge.stderr.split("\n").filter((l) => l.trim());
    for (const line of stderrLines) {
      try {
        const parsed = JSON.parse(line);
        expect(parsed.level, `Unexpected error-level stderr: ${line}`).not.toBe("error");
      } catch {
        assert.fail(`Unexpected non-JSON stderr from merge-and-ingest: ${line}`);
      }
    }
  });
});

test.concurrent("merge-and-ingest is idempotent on re-run and never truncates results", async () => {
  await withTempRepo(async (root) => {
    const { runId, artifactsDir, runDir, tasks, taskById, plan, resultMap } =
      await setupMergeFixture(root);

    await submitAllPackets(root, runId, artifactsDir, plan, resultMap, taskById);

    const first = await runWrapper(
      ["merge-and-ingest", "--run-id", runId, "--artifacts-dir", artifactsDir],
      { cwd: root },
    );
    expect(JSON.parse(first.stdout).status).toBe("completed");
    const resultsPath = join(runDir, "run-results.json");
    const mergedAfterFirst = await readFile(resultsPath, "utf8");

    // A fully-merged run advances to the next round, which rewrites this run
    // dir's pending-audit-tasks.json to the *next* round's tasks. A stray
    // re-invocation must be a clean no-op (exit 0, replayed summary) and must
    // NOT truncate the transient results file to an empty array.
    const second = await runWrapper(
      ["merge-and-ingest", "--run-id", runId, "--artifacts-dir", artifactsDir],
      { cwd: root },
    );
    const replaySummary = JSON.parse(second.stdout);
    expect(replaySummary.idempotent_replay).toBe(true);
    expect(replaySummary.status).toBe("completed");
    expect(replaySummary.accepted_count).toBe(tasks.length);
    expect(await readFile(resultsPath, "utf8"), "the second merge must not rewrite the transient results file").toBe(mergedAfterFirst);
  });
});

test.concurrent("merge-and-ingest self-heals a stale completion marker by re-ingesting a stranded on-disk result", async () => {
  await withTempRepo(async (root) => {
    const fileExists = async (p: string) => {
      try {
        await stat(p);
        return true;
      } catch {
        return false;
      }
    };
    const dispatchStep = await startDispatchRun(root);
    const runId = dispatchStep.run_id;
    const artifactsDir = dispatchStep.artifacts_dir;
    const runDir = join(artifactsDir, "runs", runId);
    const pendingPath = join(runDir, "pending-audit-tasks.json");
    const resultMapPath = join(runDir, "dispatch-result-map.json");
    const markerPath = join(runDir, "merge-complete.json");

    await runWrapper(
      [
        "prepare-dispatch",
        "--run-id",
        runId,
        "--artifacts-dir",
        artifactsDir,
        ...AUDITOR_ARGS,
      ],
      { cwd: root },
    );
    const tasks: TaskRecord[] = JSON.parse(await readFile(pendingPath, "utf8"));
    const taskById = new Map<string, TaskRecord>(
      tasks.map((task) => [task.task_id, task]),
    );
    const plan = JSON.parse(
      await readFile(join(runDir, "dispatch-plan.json"), "utf8"),
    );
    const resultMap = JSON.parse(await readFile(resultMapPath, "utf8"));
    for (const packet of plan) {
      const packetResults = resultMap.entries
        .filter((item: any) => item.packet_id === packet.packet_id)
        .map((entry: any) => validAuditResultForTask(taskById.get(entry.task_id)));
      await runWrapper(
        ["submit-packet", "--run-id", runId, "--packet-id", packet.packet_id, "--artifacts-dir", artifactsDir],
        { cwd: root, input: JSON.stringify(packetResults) },
      );
    }
    const first = JSON.parse(
      (await runWrapper(
        ["merge-and-ingest", "--run-id", runId, "--artifacts-dir", artifactsDir],
        { cwd: root },
      )).stdout,
    );
    expect(first.status).toBe("completed");
    expect(await fileExists(markerPath), "a fully-merged round writes the completion marker").toBeTruthy();

    // Reproduce the no-progress-loop precondition: selective deepening re-derives
    // follow-up tasks onto the SAME run-id, so an already-answered task is
    // re-listed as pending while its result file is still on disk, and a 0-packet
    // re-plan blanks the dispatch result map. Without the stale-marker guard the
    // next merge replays idempotently and strands that answer forever.
    const victim = tasks[0];
    const victimEntry = resultMap.entries.find((e: any) => e.task_id === victim.task_id);
    expect(victimEntry, "victim task was dispatched in round 1").toBeTruthy();
    expect(await fileExists(victimEntry.result_path), "victim's answer is on disk").toBeTruthy();
    await writeFile(pendingPath, JSON.stringify([victim], null, 2));
    await writeFile(
      resultMapPath,
      JSON.stringify({ ...resultMap, entries: [] }, null, 2),
    );
    expect(await fileExists(markerPath), "the completion marker persists into the stuck state").toBeTruthy();

    const reheal = JSON.parse(
      (await runWrapper(
        ["merge-and-ingest", "--run-id", runId, "--artifacts-dir", artifactsDir],
        { cwd: root },
      )).stdout,
    );
    expect(reheal.idempotent_replay, "a stale completion marker must re-process, not replay").not.toBe(true);
    expect(reheal.accepted_count >= 1, "the stranded on-disk result is recovered by task_id and ingested").toBeTruthy();
  });
});
