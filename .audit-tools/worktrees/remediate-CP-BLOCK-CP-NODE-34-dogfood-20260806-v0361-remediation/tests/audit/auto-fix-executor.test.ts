import { test, expect } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileDispositionStatus } from "audit-tools/shared";
import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";
import type { ExecutorRunResult } from "../../src/audit/orchestrator/executorResult.js";

const { runAutoFixExecutor: runAutoFixExecutorSource } = await import("../../src/audit/orchestrator/autoFixExecutor.js");

interface AutoFixesApplied {
  executed_tools: string[];
  failed_tools: string[];
  tool_timings: Array<{ tool: string; duration_ms: number }>;
  timestamp: string;
}

type AutoFixExecutorResult = ExecutorRunResult & {
  updated: ArtifactBundle & { auto_fixes_applied: AutoFixesApplied };
};

function isAutoFixesApplied(value: unknown): value is AutoFixesApplied {
  return (
    typeof value === "object" &&
    value !== null &&
    "executed_tools" in value &&
    Array.isArray(value.executed_tools) &&
    "failed_tools" in value &&
    Array.isArray(value.failed_tools) &&
    "tool_timings" in value &&
    Array.isArray(value.tool_timings) &&
    "timestamp" in value &&
    typeof value.timestamp === "string"
  );
}

async function runAutoFixExecutor(
  bundle: ArtifactBundle,
  root: string,
): Promise<AutoFixExecutorResult> {
  const result = await runAutoFixExecutorSource(bundle, root);
  const applied = result.updated.auto_fixes_applied;
  if (!isAutoFixesApplied(applied)) {
    throw new TypeError("auto_fixes_applied did not match the executor contract");
  }
  return {
    ...result,
    updated: { ...result.updated, auto_fixes_applied: applied },
  };
}

function bundleWithFile(
  path: string,
  status: FileDispositionStatus,
): ArtifactBundle {
  return { file_disposition: { files: [{ path, status }] } };
}

test("runAutoFixExecutor requires file_disposition", async () => {
  await assert.rejects(() => runAutoFixExecutor({}, tmpdir()), /file_disposition/);
});

test("runAutoFixExecutor is a no-op and records an empty result when no formatter matches", async () => {
  const root = await mkdtemp(join(tmpdir(), "autofix-"));
  try {
    // .txt has no associated formatter, and the temp root has no prettier
    // config — so no formatter is even attempted (no subprocess spawned).
    const bundle = bundleWithFile("notes/readme.txt", "included");
    const result = await runAutoFixExecutor(bundle, root);
    expect(result.artifacts_written).toEqual(["auto_fixes_applied.json"]);
    expect(result.updated.auto_fixes_applied.executed_tools).toEqual([]);
    expect(result.updated.auto_fixes_applied.tool_timings).toEqual([]);
    expect(result.updated.auto_fixes_applied.timestamp).toBeTruthy();
    expect(result.progress_summary).toMatch(/Formatters executed: None/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runAutoFixExecutor ignores audit-excluded files when collecting extensions", async () => {
  const root = await mkdtemp(join(tmpdir(), "autofix-"));
  try {
    // The only file is a .py that is excluded from the audit, so black must not
    // be attempted (extensions stays empty -> no formatter branch runs).
    const bundle = bundleWithFile("vendor/generated.py", "excluded");
    const result = await runAutoFixExecutor(bundle, root);
    const applied = result.updated.auto_fixes_applied;
    expect(applied.executed_tools).toEqual([]);
    expect(applied.tool_timings.length).toBe(applied.executed_tools.length);
    applied.tool_timings.forEach((entry, i) => {
      expect(entry.tool).toBe(applied.executed_tools[i]);
      expect(typeof entry.duration_ms).toBe("number");
      expect(entry.duration_ms >= 0).toBeTruthy();
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runAutoFixExecutor surfaces failed formatters in progress_summary", async () => {
  const root = await mkdtemp(join(tmpdir(), "autofix-failed-"));
  try {
    // Install a prettier config so the prettier branch is entered, but a stub
    // that exits non-zero so it lands in failed_tools rather than executed_tools.
    await writeFile(join(root, ".prettierrc"), "{}\n", "utf8");
    await mkdir(join(root, "node_modules", "prettier", "bin"), { recursive: true });
    await writeFile(
      join(root, "node_modules", "prettier", "bin", "prettier.cjs"),
      "process.exit(1);\n",
      "utf8",
    );

    const bundle = bundleWithFile("src/index.ts", "included");
    const result = await runAutoFixExecutor(bundle, root);
    const applied = result.updated.auto_fixes_applied;

    // Tool was attempted but failed — it must NOT appear in executed_tools.
    expect(!applied.executed_tools.includes("prettier"), "prettier must not appear in executed_tools when it exits non-zero").toBeTruthy();
    // It MUST appear in failed_tools.
    expect(Array.isArray(applied.failed_tools), "failed_tools must be an array").toBeTruthy();
    expect(applied.failed_tools.includes("prettier"), "prettier must appear in failed_tools when it exits non-zero").toBeTruthy();
    // progress_summary must distinguish this from the 'no formatter applicable' case.
    expect(result.progress_summary, "progress_summary must mention 'Formatters failed:' when a formatter exits non-zero").toMatch(/Formatters failed:/);
    expect(result.progress_summary, "progress_summary must name the failed formatter").toMatch(/prettier/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runAutoFixExecutor progress_summary shows 'Formatters executed: None' with a failed list when all applicable formatters fail", async () => {
  const root = await mkdtemp(join(tmpdir(), "autofix-allfailed-"));
  try {
    await writeFile(join(root, ".prettierrc"), "{}\n", "utf8");
    await mkdir(join(root, "node_modules", "prettier", "bin"), { recursive: true });
    await writeFile(
      join(root, "node_modules", "prettier", "bin", "prettier.cjs"),
      "process.exit(2);\n",
      "utf8",
    );

    const bundle = bundleWithFile("src/app.ts", "included");
    const result = await runAutoFixExecutor(bundle, root);
    const applied = result.updated.auto_fixes_applied;

    expect(applied.executed_tools, "executed_tools must be empty when all fail").toEqual([]);
    expect(applied.failed_tools.includes("prettier"), "failed_tools must contain prettier").toBeTruthy();
    expect(result.progress_summary).toMatch(/Formatters executed: None/);
    expect(result.progress_summary).toMatch(/Formatters failed:/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runAutoFixExecutor progress_summary shows 'Formatters executed: None' with no failed list when no formatter is applicable", async () => {
  const root = await mkdtemp(join(tmpdir(), "autofix-noapp-"));
  try {
    // .txt only — no formatter applicable, no subprocess spawned.
    const bundle = bundleWithFile("notes/readme.txt", "included");
    const result = await runAutoFixExecutor(bundle, root);
    const applied = result.updated.auto_fixes_applied;

    expect(applied.executed_tools).toEqual([]);
    expect(applied.failed_tools, "failed_tools must be empty when no formatter was applicable").toEqual([]);
    expect(result.progress_summary).toMatch(/Formatters executed: None/);
    expect(result.progress_summary, "progress_summary must NOT mention 'Formatters failed:' when no formatter was applicable").not.toMatch(/Formatters failed:/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("auto_fixes_applied artifact includes a failed_tools field", async () => {
  const root = await mkdtemp(join(tmpdir(), "autofix-artifact-"));
  try {
    // No prettier config — no formatter is attempted at all.
    const bundle = bundleWithFile("src/index.ts", "included");
    const result = await runAutoFixExecutor(bundle, root);
    const applied = result.updated.auto_fixes_applied;

    expect(Object.prototype.hasOwnProperty.call(applied, "failed_tools"), "auto_fixes_applied must always contain a failed_tools field").toBeTruthy();
    expect(Array.isArray(applied.failed_tools), "failed_tools must be an array").toBeTruthy();
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

    const bundle = bundleWithFile("src/index.ts", "included");
    const result = await runAutoFixExecutor(bundle, root);

    // Distinct from the no-formatter no-op: prettier was actually executed.
    expect(result.updated.auto_fixes_applied.executed_tools.includes("prettier"), "executed_tools should contain prettier").toBeTruthy();
    const timing = result.updated.auto_fixes_applied.tool_timings.find(
      (entry) => entry.tool === "prettier",
    );
    expect(timing, "tool_timings should have a prettier entry").toBeTruthy();
    if (!timing) {
      throw new TypeError("prettier timing was not recorded");
    }
    expect(typeof timing.duration_ms).toBe("number");
    expect(result.progress_summary).toMatch(/prettier/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
