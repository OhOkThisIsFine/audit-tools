import { test, expect } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";

const { runAutoFixExecutor } = await import("../../src/audit/orchestrator/autoFixExecutor.js");

interface AutoFixesAppliedTimings {
  executed_tools: string[];
  tool_timings: Array<{ tool: string; duration_ms: number }>;
}

function isAutoFixesAppliedTimings(value: unknown): value is AutoFixesAppliedTimings {
  return (
    typeof value === "object" &&
    value !== null &&
    "executed_tools" in value &&
    Array.isArray(value.executed_tools) &&
    "tool_timings" in value &&
    Array.isArray(value.tool_timings)
  );
}

test("records an empty tool_timings array when no formatter runs", async () => {
  const root = await mkdtemp(join(tmpdir(), "autofix-timings-empty-"));
  try {
    // .txt has no associated formatter — no subprocess spawned, both arrays empty.
    const bundle: ArtifactBundle = {
      file_disposition: { files: [{ path: "notes/readme.txt", status: "included" }] },
    };
    const result = await runAutoFixExecutor(bundle, root);
    const applied = result.updated.auto_fixes_applied;
    if (!isAutoFixesAppliedTimings(applied)) {
      throw new TypeError("auto_fixes_applied did not match the executor contract");
    }
    expect(applied.executed_tools).toEqual([]);
    expect(applied.tool_timings).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keeps tool_timings aligned with executed_tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "autofix-timings-aligned-"));
  try {
    // A prettier config makes hasPrettierConfig() true, and a status:'included'
    // .js file puts 'js' in the extension set so the prettier branch fires.
    await writeFile(join(root, ".prettierrc"), "{}\n", "utf8");
    // Install a local, deterministic prettier stub that exits 0 so prettier
    // is recorded in executed_tools (no global prettier required, works in CI).
    await mkdir(join(root, "node_modules", "prettier", "bin"), { recursive: true });
    await writeFile(
      join(root, "node_modules", "prettier", "bin", "prettier.cjs"),
      "process.exit(0);\n",
      "utf8",
    );
    // A status:'included' .js file so the executor picks up the extension.
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "index.js"), "const x=1\n", "utf8");

    const bundle: ArtifactBundle = {
      file_disposition: { files: [{ path: "src/index.js", status: "included" }] },
    };
    const result = await runAutoFixExecutor(bundle, root);
    const applied = result.updated.auto_fixes_applied;
    if (!isAutoFixesAppliedTimings(applied)) {
      throw new TypeError("auto_fixes_applied did not match the executor contract");
    }

    // At least one formatter must have executed — the forEach body is live code.
    expect(applied.executed_tools.length > 0, "expected at least one formatter to execute; tool_timings forEach would be dead code if empty").toBeTruthy();
    expect(applied.tool_timings.length, "tool_timings and executed_tools must be the same length").toBe(applied.executed_tools.length);
    applied.tool_timings.forEach((entry, i) => {
      expect(entry.tool).toBe(applied.executed_tools[i]);
      expect(typeof entry.duration_ms).toBe("number");
      expect(entry.duration_ms >= 0).toBeTruthy();
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
