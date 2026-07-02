import { test, expect } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  writeWorkerTaskFiles,
  clearDispatchFiles,
  getRunPaths,
} = await import("../../src/audit/io/runArtifacts.ts");

// Minimal WorkerTask fixture
function makeTask(overrides = {}) {
  return {
    run_id: "test-run-001",
    worker_command: ["echo", "hi"],
    preferred_executor: "subprocess",
    audit_results_path: null,
    ...overrides,
  };
}

// OBS-226efbae: structured logging for dispatch I/O failures

// ── writeWorkerTaskFiles ─────────────────────────────────────────────────────

await test("OBS-226efbae: writeWorkerTaskFiles emits log event with run_id when mkdir fails", async () => {
  // A path inside a non-existent read-only parent triggers mkdir failure by
  // using a null byte in the path, which the OS rejects immediately.
  const badRunDir = join(tmpdir(), "audit-obs-226efbae-\x00-bad");
  const paths = {
    runDir: badRunDir,
    taskPath: join(badRunDir, "task.json"),
    promptPath: join(badRunDir, "prompt.md"),
    resultPath: join(badRunDir, "result.json"),
    stdoutPath: join(badRunDir, "stdout.log"),
    stderrPath: join(badRunDir, "stderr.log"),
    statusPath: join(badRunDir, "status.json"),
  };

  const events = [];
  const log = { event: (name, data) => events.push({ name, data }) };
  const task = makeTask();

  await assert.rejects(
    () => writeWorkerTaskFiles(task, "prompt text", paths, tmpdir(), undefined, {}, log),
  );

  expect(events.length, "exactly one log event emitted").toBe(1);
  expect(events[0].name).toBe("dispatch_io_error");
  expect(events[0].data.run_id).toBe(task.run_id);
  expect(events[0].data.function).toBe("writeWorkerTaskFiles");
  expect(typeof events[0].data.error === "string" && events[0].data.error.length > 0).toBeTruthy();
});

await test("OBS-226efbae: writeWorkerTaskFiles with no log parameter succeeds on valid paths", async () => {
  const artifactsDir = await mkdtemp(join(tmpdir(), "audit-obs-226efbae-ok-"));
  try {
    const task = makeTask({ run_id: "run-ok-001" });
    const paths = getRunPaths(artifactsDir, task.run_id);
    // Should resolve without error (backward compatibility: no log arg)
    await assert.doesNotReject(
      () => writeWorkerTaskFiles(task, "# prompt", paths, artifactsDir),
    );
  } finally {
    await rm(artifactsDir, { recursive: true, force: true });
  }
});

// ── clearDispatchFiles ───────────────────────────────────────────────────────

await test("OBS-226efbae: clearDispatchFiles emits log event with function name when rm fails", async () => {
  // rm with { force: true } does NOT throw on missing files, so to trigger
  // the catch we need a path that rm itself rejects — a null byte works.
  const badArtifactsDir = join(tmpdir(), "audit-obs-clear-\x00-bad");

  const events = [];
  const log = { event: (name, data) => events.push({ name, data }) };

  await assert.rejects(
    () => clearDispatchFiles(badArtifactsDir, log),
  );

  expect(events.length, "exactly one log event emitted").toBe(1);
  expect(events[0].name).toBe("dispatch_io_error");
  expect(events[0].data.function).toBe("clearDispatchFiles");
  expect(typeof events[0].data.error === "string" && events[0].data.error.length > 0).toBeTruthy();
});
