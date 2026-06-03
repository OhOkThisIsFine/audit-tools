import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { runAutoFixExecutor } = await import(
  "../src/orchestrator/autoFixExecutor.ts"
);

test("runAutoFixExecutor requires file_disposition", async () => {
  await assert.rejects(() => runAutoFixExecutor({}, tmpdir()), /file_disposition/);
});

test("runAutoFixExecutor is a no-op and records an empty result when no formatter matches", async () => {
  const root = await mkdtemp(join(tmpdir(), "autofix-"));
  try {
    // .txt has no associated formatter, and the temp root has no prettier
    // config — so no formatter is even attempted (no subprocess spawned).
    const bundle = {
      file_disposition: { files: [{ path: "notes/readme.txt", status: "audit" }] },
    };
    const result = await runAutoFixExecutor(bundle, root);
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
    const result = await runAutoFixExecutor(bundle, root);
    assert.deepEqual(result.updated.auto_fixes_applied.executed_tools, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runAutoFixExecutor enters the formatter branch when a prettier config and a .ts file are present", async () => {
  const root = await mkdtemp(join(tmpdir(), "autofix-"));
  try {
    // A prettier config makes hasPrettierConfig() true, and a status:'audit'
    // .ts file puts 'ts' in the extension set, so the prettier branch fires.
    await writeFile(join(root, ".prettierrc"), "{}\n", "utf8");
    // Install a local, deterministic prettier stub: resolveNodeTool() resolves
    // node_modules/prettier/bin/prettier.cjs and runs it with the current node,
    // so it exits 0 and the prettier branch records as executed (no network /
    // global prettier required, works in CI).
    await mkdir(join(root, "node_modules", "prettier", "bin"), {
      recursive: true,
    });
    await writeFile(
      join(root, "node_modules", "prettier", "bin", "prettier.cjs"),
      "process.exit(0);\n",
      "utf8",
    );

    const bundle = {
      file_disposition: { files: [{ path: "src/index.ts", status: "audit" }] },
    };
    const result = await runAutoFixExecutor(bundle, root);

    // Distinct from the no-formatter no-op: prettier was actually executed.
    assert.ok(
      result.updated.auto_fixes_applied.executed_tools.includes("prettier"),
      "executed_tools should contain prettier",
    );
    const timing = result.updated.auto_fixes_applied.tool_timings.find(
      (entry) => entry.tool === "prettier",
    );
    assert.ok(timing, "tool_timings should have a prettier entry");
    assert.equal(typeof timing.duration_ms, "number");
    assert.match(result.progress_summary, /prettier/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
