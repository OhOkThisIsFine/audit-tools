import { test, onTestFinished, expect } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const {
  buildWaveSlotEntry,
  readWaveManifest,
  writeWaveManifest,
  removeWaveManifest,
  waveManifestPath,
} = await import("../../src/audit/cli/waveManifest.ts");

// ── buildWaveSlotEntry ────────────────────────────────────────────────────────

await test("buildWaveSlotEntry maps all slot fields and projects task_ids", () => {
  const slot = {
    runId: "run-abc",
    paths: {
      taskPath: "/tmp/task.json",
      promptPath: "/tmp/prompt.md",
      resultPath: "/tmp/result.json",
      stdoutPath: "/tmp/stdout.txt",
      stderrPath: "/tmp/stderr.txt",
      statusPath: "/tmp/status.json",
    },
    auditResultsPath: "/tmp/audit-results.jsonl",
    pendingTasksPath: "/tmp/pending.json",
    group: [
      { task_id: "T-1", unit_id: "U-1", pass_id: "P-1", lens: "correctness", file_paths: [], rationale: "r" },
      { task_id: "T-2", unit_id: "U-1", pass_id: "P-1", lens: "security", file_paths: [], rationale: "r" },
    ],
  };

  const entry = buildWaveSlotEntry(slot);

  expect(entry.run_id).toBe(slot.runId);
  expect(entry.task_path).toBe(slot.paths.taskPath);
  expect(entry.prompt_path).toBe(slot.paths.promptPath);
  expect(entry.result_path).toBe(slot.paths.resultPath);
  expect(entry.stdout_path).toBe(slot.paths.stdoutPath);
  expect(entry.stderr_path).toBe(slot.paths.stderrPath);
  expect(entry.status_path).toBe(slot.paths.statusPath);
  expect(entry.audit_results_path).toBe(slot.auditResultsPath);
  expect(entry.pending_tasks_path).toBe(slot.pendingTasksPath);
  expect(entry.task_ids).toEqual(["T-1", "T-2"]);
});

await test("buildWaveSlotEntry with an empty group yields an empty task_ids array", () => {
  const slot = {
    runId: "run-empty",
    paths: {
      taskPath: "/tmp/task.json",
      promptPath: "/tmp/prompt.md",
      resultPath: "/tmp/result.json",
      stdoutPath: "/tmp/stdout.txt",
      stderrPath: "/tmp/stderr.txt",
      statusPath: "/tmp/status.json",
    },
    auditResultsPath: "/tmp/audit-results.jsonl",
    pendingTasksPath: "/tmp/pending.json",
    group: [],
  };

  const entry = buildWaveSlotEntry(slot);
  expect(entry.task_ids).toEqual([]);
});

// ── readWaveManifest ──────────────────────────────────────────────────────────

await test("readWaveManifest returns null when the manifest file does not exist", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "wave-manifest-read-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));

  const result = await readWaveManifest(dir);
  expect(result).toBe(null);
});

await test("readWaveManifest rethrows errors that are not a missing-file error", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "wave-manifest-bad-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));

  // Write invalid JSON to the manifest path so we get a parse error.
  const manifestFile = waveManifestPath(dir);
  // Ensure the dispatch subdirectory exists.
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(dir, "dispatch"), { recursive: true });
  await writeFile(manifestFile, "not valid json", "utf8");

  await assert.rejects(
    () => readWaveManifest(dir),
    (err) => {
      // readJsonFile wraps the underlying JSON.parse SyntaxError in a generic
      // Error that names the path ("Invalid JSON in <path>: ..."). The contract
      // readWaveManifest must honor is: rethrow a parse error (NOT swallow it as
      // a missing-file null), so assert on the message rather than the subclass.
      expect(err instanceof Error, `expected an Error, got ${err?.constructor?.name}`).toBeTruthy();
      expect(err.message).toMatch(/Invalid JSON/i);
      expect(err.code, "a parse error must not be reported as ENOENT").toBe(undefined);
      return true;
    },
  );
});

// ── writeWaveManifest + round-trip ────────────────────────────────────────────

await test("writeWaveManifest stamps contract_version and persists all manifest fields", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "wave-manifest-write-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));

  const manifest = {
    obligation_id: "audit_tasks_completed",
    started_at: "2026-01-01T00:00:00.000Z",
    pid: 12345,
    slots: [
      {
        run_id: "run-1",
        task_path: "/tmp/task.json",
        prompt_path: "/tmp/prompt.md",
        result_path: "/tmp/result.json",
        stdout_path: "/tmp/stdout.txt",
        stderr_path: "/tmp/stderr.txt",
        status_path: "/tmp/status.json",
        audit_results_path: "/tmp/audit-results.jsonl",
        pending_tasks_path: "/tmp/pending.json",
        task_ids: ["T-1"],
      },
    ],
  };

  await writeWaveManifest(dir, manifest);

  // Read back and verify contract_version is stamped.
  const { readJsonFile } = await import("audit-tools/shared");
  const written = await readJsonFile(waveManifestPath(dir));
  expect(written.contract_version).toBe("audit-code-wave/v1alpha1");
  expect(written.obligation_id).toBe(manifest.obligation_id);
  expect(written.started_at).toBe(manifest.started_at);
  expect(written.pid).toBe(manifest.pid);
  expect(written.slots).toEqual(manifest.slots);

  // Verify round-trip via readWaveManifest.
  const roundTripped = await readWaveManifest(dir);
  expect(roundTripped !== null).toBeTruthy();
  expect(roundTripped.contract_version).toBe("audit-code-wave/v1alpha1");
  expect(roundTripped.obligation_id).toBe(manifest.obligation_id);
  expect(roundTripped.pid).toBe(manifest.pid);
  expect(roundTripped.slots).toEqual(manifest.slots);
});

// ── removeWaveManifest ────────────────────────────────────────────────────────

await test("removeWaveManifest does not throw when the manifest file is absent", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "wave-manifest-remove-absent-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));

  // Should resolve without error even though no manifest exists.
  await assert.doesNotReject(() => removeWaveManifest(dir));
});

await test("removeWaveManifest removes an existing manifest file", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "wave-manifest-remove-exists-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));

  const manifest = {
    obligation_id: "audit_tasks_completed",
    started_at: "2026-01-01T00:00:00.000Z",
    pid: 99,
    slots: [],
  };

  await writeWaveManifest(dir, manifest);

  // Verify it exists first.
  const before = await readWaveManifest(dir);
  expect(before !== null, "manifest should exist after write").toBeTruthy();

  await removeWaveManifest(dir);

  // After removal, readWaveManifest should return null.
  const after = await readWaveManifest(dir);
  expect(after, "manifest should be null after removal").toBe(null);
});
