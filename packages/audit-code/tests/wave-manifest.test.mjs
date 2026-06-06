import test from "node:test";
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
} = await import("../src/cli/waveManifest.ts");

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

  assert.equal(entry.run_id, slot.runId);
  assert.equal(entry.task_path, slot.paths.taskPath);
  assert.equal(entry.prompt_path, slot.paths.promptPath);
  assert.equal(entry.result_path, slot.paths.resultPath);
  assert.equal(entry.stdout_path, slot.paths.stdoutPath);
  assert.equal(entry.stderr_path, slot.paths.stderrPath);
  assert.equal(entry.status_path, slot.paths.statusPath);
  assert.equal(entry.audit_results_path, slot.auditResultsPath);
  assert.equal(entry.pending_tasks_path, slot.pendingTasksPath);
  assert.deepEqual(entry.task_ids, ["T-1", "T-2"]);
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
  assert.deepEqual(entry.task_ids, []);
});

// ── readWaveManifest ──────────────────────────────────────────────────────────

await test("readWaveManifest returns null when the manifest file does not exist", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "wave-manifest-read-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const result = await readWaveManifest(dir);
  assert.equal(result, null);
});

await test("readWaveManifest rethrows errors that are not a missing-file error", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "wave-manifest-bad-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

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
      assert.ok(err instanceof Error, `expected an Error, got ${err?.constructor?.name}`);
      assert.match(err.message, /Invalid JSON/i);
      assert.equal(err.code, undefined, "a parse error must not be reported as ENOENT");
      return true;
    },
  );
});

// ── writeWaveManifest + round-trip ────────────────────────────────────────────

await test("writeWaveManifest stamps contract_version and persists all manifest fields", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "wave-manifest-write-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

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
  const { readJsonFile } = await import("@audit-tools/shared");
  const written = await readJsonFile(waveManifestPath(dir));
  assert.equal(written.contract_version, "audit-code-wave/v1alpha1");
  assert.equal(written.obligation_id, manifest.obligation_id);
  assert.equal(written.started_at, manifest.started_at);
  assert.equal(written.pid, manifest.pid);
  assert.deepEqual(written.slots, manifest.slots);

  // Verify round-trip via readWaveManifest.
  const roundTripped = await readWaveManifest(dir);
  assert.ok(roundTripped !== null);
  assert.equal(roundTripped.contract_version, "audit-code-wave/v1alpha1");
  assert.equal(roundTripped.obligation_id, manifest.obligation_id);
  assert.equal(roundTripped.pid, manifest.pid);
  assert.deepEqual(roundTripped.slots, manifest.slots);
});

// ── removeWaveManifest ────────────────────────────────────────────────────────

await test("removeWaveManifest does not throw when the manifest file is absent", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "wave-manifest-remove-absent-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  // Should resolve without error even though no manifest exists.
  await assert.doesNotReject(() => removeWaveManifest(dir));
});

await test("removeWaveManifest removes an existing manifest file", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "wave-manifest-remove-exists-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const manifest = {
    obligation_id: "audit_tasks_completed",
    started_at: "2026-01-01T00:00:00.000Z",
    pid: 99,
    slots: [],
  };

  await writeWaveManifest(dir, manifest);

  // Verify it exists first.
  const before = await readWaveManifest(dir);
  assert.ok(before !== null, "manifest should exist after write");

  await removeWaveManifest(dir);

  // After removal, readWaveManifest should return null.
  const after = await readWaveManifest(dir);
  assert.equal(after, null, "manifest should be null after removal");
});
