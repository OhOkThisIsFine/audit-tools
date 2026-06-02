import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { runAutoFixExecutor } = await import(
  "../dist/orchestrator/autoFixExecutor.js"
);

test("runAutoFixExecutor requires file_disposition", () => {
  assert.throws(() => runAutoFixExecutor({}, tmpdir()), /file_disposition/);
});

test("runAutoFixExecutor is a no-op and records an empty result when no formatter matches", async () => {
  const root = await mkdtemp(join(tmpdir(), "autofix-"));
  try {
    // .txt has no associated formatter, and the temp root has no prettier
    // config — so no formatter is even attempted (no subprocess spawned).
    const bundle = {
      file_disposition: { files: [{ path: "notes/readme.txt", status: "audit" }] },
    };
    const result = runAutoFixExecutor(bundle, root);
    assert.deepEqual(result.artifacts_written, ["auto_fixes_applied.json"]);
    assert.deepEqual(result.updated.auto_fixes_applied.executed_tools, []);
    assert.ok(result.updated.auto_fixes_applied.timestamp);
    assert.match(result.progress_summary, /Formatters executed: None/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runAutoFixExecutor ignores audit-excluded files when collecting extensions", async () => {
  const root = await mkdtemp(join(tmpdir(), "autofix-"));
  try {
    // The only file is a .py that is excluded from the audit, so black must not
    // be attempted (extensions stays empty -> no formatter branch runs).
    const bundle = {
      file_disposition: {
        files: [{ path: "vendor/generated.py", status: "excluded" }],
      },
    };
    const result = runAutoFixExecutor(bundle, root);
    assert.deepEqual(result.updated.auto_fixes_applied.executed_tools, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
