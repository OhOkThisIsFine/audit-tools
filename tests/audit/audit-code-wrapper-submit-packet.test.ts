import { test, expect, vi } from "vitest";
import assert from "node:assert/strict";

// Heavy spawn suite: real tarball packs + real subprocess round-trips, and the
// cases are `concurrent`, so under a full-suite run they contend with siblings.
// Single-sourced ceiling — see tests/helpers/heavy-timeout.mjs for the rationale.
import { HEAVY_AUDIT_TEST_TIMEOUT_MS } from "../helpers/heavy-timeout.mjs";
vi.setConfig({ testTimeout: HEAVY_AUDIT_TEST_TIMEOUT_MS });
import {
  assertPacketResultFilesMissing,
  runWrapper,
  setupSubmitPacketFixture,
  validAuditResultForTask,
  withTempRepo,
} from "./helpers/wrapper-harness.js";

// submit-packet's assignment validation: a packet's submission must carry
// exactly the results for the tasks assigned to it — no duplicates, nothing from
// outside the packet, nothing missing. Every rejection must also leave NO result
// file behind, so a refused submission cannot be half-applied.

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
