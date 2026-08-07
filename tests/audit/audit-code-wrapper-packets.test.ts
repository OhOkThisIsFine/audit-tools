import { test, expect, vi } from "vitest";
import assert from "node:assert/strict";

// Heavy spawn suite: real tarball packs + real subprocess round-trips, and the
// cases are `concurrent`, so under a full-suite run they contend with siblings.
// Single-sourced ceiling — see tests/helpers/heavy-timeout.mjs for the rationale.
import { HEAVY_AUDIT_TEST_TIMEOUT_MS } from "../helpers/heavy-timeout.mjs";
vi.setConfig({ testTimeout: HEAVY_AUDIT_TEST_TIMEOUT_MS });
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AUDITOR_ARGS,
  assertPacketResultFilesMissing,
  runWrapper,
  setupMergeFixture,
  setupSubmitPacketFixture,
  startDispatchRun,
  submitAllPackets,
  validAuditResultForTask,
  withTempRepo,
  type TaskRecord,
} from "./helpers/wrapper-harness.js";
const { isCanonicalResultFilename } = await import("../../src/audit/cli/args.js");

test.concurrent("all packets dispatched in one round, merge ingests everything", async () => {
  await withTempRepo(async (root) => {
    const dispatchStep = await startDispatchRun(root);
    const runId = dispatchStep.run_id;
    const artifactsDir = dispatchStep.artifacts_dir;
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
    const runDir = join(artifactsDir, "runs", runId);

    // Submit every packet currently in the plan (reads the live result map).
    async function submitPlannedPackets() {
      const tasks: TaskRecord[] = JSON.parse(
        await readFile(join(runDir, "pending-audit-tasks.json"), "utf8"),
      );
      const taskById = new Map<string, TaskRecord>(
        tasks.map((task) => [task.task_id, task]),
      );
      const plan = JSON.parse(
        await readFile(join(runDir, "dispatch-plan.json"), "utf8"),
      );
      const resultMap = JSON.parse(
        await readFile(join(runDir, "dispatch-result-map.json"), "utf8"),
      );
      for (const packet of plan) {
        const packetResults = resultMap.entries
          .filter((item: any) => item.packet_id === packet.packet_id)
          .map((entry: any) => validAuditResultForTask(taskById.get(entry.task_id)));
        await runWrapper(
          ["submit-packet", "--run-id", runId, "--packet-id", packet.packet_id, "--artifacts-dir", artifactsDir],
          { cwd: root, input: JSON.stringify(packetResults) },
        );
      }
      return plan;
    }

    // All packets dispatch in one round.
    const active = JSON.parse(
      await readFile(join(artifactsDir, "active-dispatch.json"), "utf8"),
    );
    expect(active.packet_count >= 1).toBeTruthy();
    await submitPlannedPackets();

    // Merge ingests everything, no tasks held back.
    const mergeResult = await runWrapper(
      ["merge-and-ingest", "--run-id", runId, "--artifacts-dir", artifactsDir],
      { cwd: root },
    );
    const summary = JSON.parse(mergeResult.stdout);
    expect(summary.rejected_count).toBe(0);
    expect(summary.not_dispatched_count, "no tasks held back").toBe(0);
    expect(summary.accepted_count >= 1).toBeTruthy();
  });
});

test.concurrent("submit-packet rejects duplicate task result ids", async () => {
  await withTempRepo(async (root) => {
    const { runId, artifactsDir, packet, entries, packetTasks } =
      await setupSubmitPacketFixture(root);
    const [firstTask] = packetTasks;
    const packetResults = [
      validAuditResultForTask(firstTask),
      validAuditResultForTask(firstTask),
    ];

    await assert.rejects(
      runWrapper(
        [
          "submit-packet",
          "--run-id",
          runId,
          "--packet-id",
          packet.packet_id,
          "--artifacts-dir",
          artifactsDir,
        ],
        { cwd: root, input: JSON.stringify(packetResults) },
      ),
      /Duplicate audit result for assigned task/i,
    );
    await assertPacketResultFilesMissing(entries);
  });
});

test.concurrent("submit-packet rejects task results outside the packet", async () => {
  await withTempRepo(async (root) => {
    const { runId, artifactsDir, packet, entries, packetTasks, tasks } =
      await setupSubmitPacketFixture(root);
    const outsideTask = tasks.find(
      (task) => !entries.some((entry: any) => entry.task_id === task.task_id),
    );
    expect(outsideTask, "expected a task outside the selected packet").toBeTruthy();
    const packetResults = [
      validAuditResultForTask(packetTasks[0]),
      validAuditResultForTask(outsideTask),
    ];

    await assert.rejects(
      runWrapper(
        [
          "submit-packet",
          "--run-id",
          runId,
          "--packet-id",
          packet.packet_id,
          "--artifacts-dir",
          artifactsDir,
        ],
        { cwd: root, input: JSON.stringify(packetResults) },
      ),
      /not assigned to packet/i,
    );
    await assertPacketResultFilesMissing(entries);
  });
});

test.concurrent("submit-packet rejects missing assigned task results", async () => {
  await withTempRepo(async (root) => {
    const { runId, artifactsDir, packet, entries, packetTasks } =
      await setupSubmitPacketFixture(root);
    const packetResults = [validAuditResultForTask(packetTasks[0])];

    await assert.rejects(
      runWrapper(
        [
          "submit-packet",
          "--run-id",
          runId,
          "--packet-id",
          packet.packet_id,
          "--artifacts-dir",
          artifactsDir,
        ],
        { cwd: root, input: JSON.stringify(packetResults) },
      ),
      /Missing audit result for assigned task/i,
    );
    await assertPacketResultFilesMissing(entries);
  });
});

test.concurrent("merge-and-ingest proceeds despite unexpected files in task-results/", async () => {
  await withTempRepo(async (root) => {
    const { runId, artifactsDir, runDir, tasks, taskById, plan, resultMap } =
      await setupMergeFixture(root);

    await submitAllPackets(root, runId, artifactsDir, plan, resultMap, taskById);

    // Write a spurious file into task-results/ as a subagent might do
    const taskResultsDir = join(runDir, "task-results");
    await writeFile(
      join(taskResultsDir, "packet_spurious_results.json"),
      JSON.stringify({ unexpected: true }),
    );

    const merge = await runWrapper(
      ["merge-and-ingest", "--run-id", runId, "--artifacts-dir", artifactsDir],
      { cwd: root },
    );
    const mergeSummary = JSON.parse(merge.stdout);
    expect(mergeSummary.status).toBe("completed");
    expect(mergeSummary.accepted_count).toBe(tasks.length);
    expect(mergeSummary.rejected_count).toBe(0);
    expect(mergeSummary.spurious_file_count).toBe(1);
    expect(merge.stderr).toMatch(/unexpected file.*packet_spurious_results\.json/i);
  });
});

test.concurrent("isCanonicalResultFilename separates canonical results from stray files", () => {
  // Canonical per-task result name: <stem>_<12-hex digest>.json (artifactNameForId).
  expect(isCanonicalResultFilename("unit_foo_0123456789ab.json")).toBe(true);
  expect(isCanonicalResultFilename("lens_security_packet-1_a1b2c3d4e5f6.json")).toBe(true);
  // Stray files a subagent might leave — no _<12hex> suffix, so a prior round's
  // canonical results never inflate spurious_file_count while these still do.
  expect(isCanonicalResultFilename("packet-23-results.json")).toBe(false);
  expect(isCanonicalResultFilename("packet_spurious_results.json")).toBe(false);
  expect(isCanonicalResultFilename("tmp-packet-87-result.json")).toBe(false);
  expect(isCanonicalResultFilename("audit_result_packet1.json")).toBe(false);
});

test.concurrent("merge-and-ingest rejects swapped task result files", async () => {
  await withTempRepo(async (root) => {
    const dispatchStep = await startDispatchRun(root);
    const runId = dispatchStep.run_id;
    const artifactsDir = dispatchStep.artifacts_dir;

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

    const runDir = join(artifactsDir, "runs", runId);
    const tasks = JSON.parse(
      await readFile(join(runDir, "pending-audit-tasks.json"), "utf8"),
    );
    expect(tasks.length >= 2).toBeTruthy();
    const resultMap = JSON.parse(
      await readFile(join(runDir, "dispatch-result-map.json"), "utf8"),
    );
    const entryByTaskId = new Map<string, any>(
      resultMap.entries.map((entry: any) => [entry.task_id, entry]),
    );
    const [first, second] = tasks;

    await writeFile(
      entryByTaskId.get(first.task_id).result_path,
      JSON.stringify(validAuditResultForTask(second), null, 2) + "\n",
    );
    await writeFile(
      entryByTaskId.get(second.task_id).result_path,
      JSON.stringify(validAuditResultForTask(first), null, 2) + "\n",
    );

    await assert.rejects(
      runWrapper(
        ["merge-and-ingest", "--run-id", runId, "--artifacts-dir", artifactsDir],
        { cwd: root },
      ),
      /assigned to|blocked before ingestion/i,
    );
  });
});
