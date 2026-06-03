import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { runAutoFixExecutor } = await import(
  "../src/orchestrator/autoFixExecutor.ts"
);

test("runAutoFixExecutor records an empty tool_timings array when no formatter runs", async () => {
  const root = await mkdtemp(join(tmpdir(), "autofix-timings-"));
  try {
    // .txt has no formatter and the temp root has no prettier config, so nothing
    // is attempted — tool_timings must mirror executed_tools as an empty array.
    const bundle = {
      file_disposition: { files: [{ path: "notes/readme.txt", status: "audit" }] },
    };
    const result = await runAutoFixExecutor(bundle, root);
    const applied = result.updated.auto_fixes_applied;
    assert.deepEqual(applied.executed_tools, []);
    assert.deepEqual(applied.tool_timings, []);
    assert.ok(applied.timestamp);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runAutoFixExecutor keeps tool_timings aligned with executed_tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "autofix-timings-"));
  try {
    // Excluded file -> no extension collected -> no formatter branch runs.
    const bundle = {
      file_disposition: {
        files: [{ path: "vendor/generated.py", status: "excluded" }],
      },
    };
    const result = await runAutoFixExecutor(bundle, root);
    const applied = result.updated.auto_fixes_applied;
    // Same length and same order: each timing entry corresponds to an executed
    // tool, and every duration is a non-negative number.
    assert.equal(applied.tool_timings.length, applied.executed_tools.length);
    applied.tool_timings.forEach((entry, i) => {
      assert.equal(entry.tool, applied.executed_tools[i]);
      assert.equal(typeof entry.duration_ms, "number");
      assert.ok(entry.duration_ms >= 0);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
