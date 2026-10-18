import { afterEach, expect, test, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeAndRecord } from "../../src/audit/cli/nextStepHelpers.js";
import { runSingleAdvanceStep } from "../../src/audit/orchestrator/advance.js";
import { EXECUTOR_RUNNERS, preservesSourceIndexes } from "../../src/audit/orchestrator/executorRunners.js";
import * as selection from "../../src/audit/orchestrator/nextStep.js";
import * as lineIndexes from "../../src/audit/cli/lineIndex.js";
import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";

afterEach(() => vi.restoreAllMocks());

async function fixture(run: (root: string, bundle: ArtifactBundle) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "manifest-cache-"));
  try {
    await mkdir(join(root, "artifacts", "steps"), { recursive: true });
    await writeFile(join(root, "a.ts"), "one\n");
    await run(root, { repo_manifest: {
      repository: { name: "fixture" }, generated_at: "2026-01-01T00:00:00Z",
      scope_index_key: "stable", files: [{ path: "a.ts", language: "typescript", size_bytes: 4 }],
    } });
  } finally { await rm(root, { recursive: true, force: true }); }
}

async function exercise(root: string, initial: ArtifactBundle) {
  let bundle = initial;
  const cache = new WeakMap<object, { lineIndex?: Record<string, number>; sizeIndex?: Record<string, number> }>();
  const ctx = { manifestIndexCache: cache, failureRef: { value: null } };
  const params = { autoFix: { enabled: false }, root, sourceRoot: root, artifactsDir: join(root, "artifacts"),
    scopeIndexMemo: { key: `${root}\0a.ts`, value: "stable" } };
  const reads = vi.spyOn(lineIndexes, "buildLineIndex");
  const counts: number[] = [];
  vi.spyOn(EXECUTOR_RUNNERS, "design_assessment_executor").mockImplementation(async (current, { options }) => {
    counts.push(options.lineIndex?.["a.ts"] ?? -1);
    return { updated: current, artifacts_written: [], progress_summary: "read" };
  });
  async function dispatch(executor: string) {
    const decision: ReturnType<typeof selection.decideNextStep> = {
      state: { status: "active", obligations: [] }, selected_executor: executor,
      selected_obligation: "repo_manifest", reason: "test sequence",
    };
    vi.spyOn(selection, "decideNextStep").mockReturnValue(decision);
    const result = await executeAndRecord(params, undefined, decision, 0, "", bundle, ctx);
    bundle = result.updated_bundle;
    return result;
  }
  return { dispatch, reads, counts, cache, params, getBundle: () => bundle };
}

test("multiple unchanged dispatches share one line scan and changed manifest identity rebuilds", async () => {
  await fixture(async (root, bundle) => {
    const run = await exercise(root, bundle);
    for (let i = 0; i < 5; i++) await run.dispatch("design_assessment_executor");
    expect(run.counts).toEqual([1, 1, 1, 1, 1]);
    expect(run.reads).toHaveBeenCalledTimes(1);
    run.getBundle().repo_manifest = { ...run.getBundle().repo_manifest! };
    await run.dispatch("design_assessment_executor");
    expect(run.reads).toHaveBeenCalledTimes(2);
  });
});

for (const executor of ["auto_fix_executor", "syntax_resolution_executor", "runtime_validation_executor", "external_analyzer_acquisition_executor", "graph_enrichment_executor"]) {
  for (const throws of [false, true]) {
    test(`${executor} invalidates cached lines after a ${throws ? "partial failure" : "write"}`, async () => {
      await fixture(async (root, bundle) => {
        const run = await exercise(root, bundle);
        await run.dispatch("design_assessment_executor");
        const before = run.getBundle().repo_manifest!;
        vi.spyOn(EXECUTOR_RUNNERS, executor).mockImplementation(async (current) => {
          await writeFile(join(root, "a.ts"), "one\ntwo\nthree\n");
          if (throws) throw new Error("partial write");
          return { updated: current, artifacts_written: [], progress_summary: "wrote" };
        });
        if (throws) await expect(run.dispatch(executor)).rejects.toThrow("partial write");
        else await run.dispatch(executor);
        expect(run.cache.has(before)).toBe(false);
        await run.dispatch("design_assessment_executor");
        expect(run.counts).toEqual([1, 3]);
      });
    });
  }
}

test("forced graph submission outside executeAndRecord drops manifest identity", async () => {
  await fixture(async (root, bundle) => {
    const run = await exercise(root, bundle);
    await run.dispatch("design_assessment_executor");
    vi.spyOn(EXECUTOR_RUNNERS, "graph_enrichment_executor").mockImplementation(async (current) => {
      await writeFile(join(root, "a.ts"), "one\ntwo\nthree\n");
      return { updated: current, artifacts_written: [], progress_summary: "wrote" };
    });
    const before = run.getBundle();
    const result = await runSingleAdvanceStep(before, { ...run.params, preferredExecutor: "graph_enrichment_executor" });
    expect(result.updated_bundle.repo_manifest).not.toBe(before.repo_manifest);
    // The same fold cache survives a forced submission, so the changed identity
    // must cause the next deterministic dispatch to read the rewritten bytes.
    Object.assign(before, result.updated_bundle);
    await run.dispatch("design_assessment_executor");
    expect(run.counts).toEqual([1, 3]);
  });
});

for (const exitCode of [0, 1]) {
  test(`real auto-fix formatter exit ${exitCode} refreshes downstream planning line hints`, async () => {
    await fixture(async (root, bundle) => {
      const { runStructureExecutor } = await import("../../src/audit/orchestrator/structureExecutors.js");
      bundle.file_disposition = { files: [{ path: "a.ts", status: "included" }] };
      const structured = await runStructureExecutor(bundle);
      const run = await exercise(root, structured.updated);
      run.params.autoFix = { enabled: true };
      await run.dispatch("design_assessment_executor");
      await mkdir(join(root, "node_modules", "prettier", "bin"), { recursive: true });
      await writeFile(join(root, ".prettierrc"), "{}");
      // Real local-tool resolution and subprocess, no installed formatter or
      // network dependency. Failure deliberately occurs AFTER rewriting bytes.
      await writeFile(join(root, "node_modules", "prettier", "bin", "prettier.cjs"),
        `require('node:fs').writeFileSync('a.ts', 'one\\ntwo\\nthree\\n'); process.exit(${exitCode});`);
      await run.dispatch("auto_fix_executor");
      expect(run.getBundle().auto_fixes_applied).toMatchObject(exitCode === 0
        ? { executed_tools: ["prettier"], failed_tools: [] }
        : { executed_tools: [], failed_tools: ["prettier"] });
      const beforePlanning = run.getBundle();
      await run.dispatch("planning_executor");
      const { runPlanningExecutor } = await import("../../src/audit/orchestrator/planningExecutors.js");
      const fresh = await runPlanningExecutor(beforePlanning, root,
        await lineIndexes.buildLineIndex(root, beforePlanning.repo_manifest!));
      expect(run.getBundle().audit_tasks).toEqual(fresh.updated.audit_tasks);
      expect(run.getBundle().coverage_matrix).toEqual(fresh.updated.coverage_matrix);
      expect(run.getBundle().audit_plan_metrics?.total_packet_lines)
        .toBe(fresh.updated.audit_plan_metrics?.total_packet_lines);
      expect(run.getBundle().coverage_matrix?.files.find((file) => file.path === "a.ts")?.audit_status)
        .toBe("pending");
      const tasks = run.getBundle().audit_tasks ?? [];
      expect(tasks.length).toBeGreaterThan(0);
      expect(tasks.some((task) => task.file_paths.includes("a.ts"))).toBe(true);
      expect(run.getBundle().audit_plan_metrics?.total_packet_lines).toBeGreaterThanOrEqual(3);
    });
  });
}

test("actual read-only runner chain reuses one scan", async () => {
  await fixture(async (root, bundle) => {
    const { runStructureExecutor } = await import("../../src/audit/orchestrator/structureExecutors.js");
    bundle.file_disposition = { files: [{ path: "a.ts", status: "included" }] };
    const structured = await runStructureExecutor(bundle);
    const run = await exercise(root, structured.updated);
    vi.mocked(EXECUTOR_RUNNERS.design_assessment_executor).mockRestore();
    for (const executor of ["design_assessment_executor", "docs_digest_executor", "structure_decomposition_executor"]) {
      await run.dispatch(executor);
    }
    expect(run.reads).toHaveBeenCalledTimes(1);
    expect(run.getBundle().design_assessment).toBeDefined();
    expect(run.getBundle().docs_digest).toBeDefined();
    expect(run.getBundle().structure_decomposition).toBeDefined();
  });
});

test("potential writes replace identity even when the git probe is unavailable", async () => {
  await fixture(async (root, bundle) => {
    const run = await exercise(root, bundle);
    const before = run.getBundle().repo_manifest;
    vi.spyOn(EXECUTOR_RUNNERS, "auto_fix_executor").mockImplementation(async (current) => ({
      updated: current, artifacts_written: [], progress_summary: "noop",
    }));
    const result = await runSingleAdvanceStep(bundle, {
      root, preferredExecutor: "auto_fix_executor",
      scopeIndexMemo: { key: `${root}\0a.ts`, value: null },
    });
    expect(result.updated_bundle.repo_manifest).not.toBe(before);
  });
});


test("unknown and command-backed executors invalidate by default", () => {
  for (const executor of [null, "future_executor", "intake_executor", "structure_executor",
    "auto_fix_executor", "syntax_resolution_executor", "runtime_validation_executor",
    "external_analyzer_acquisition_executor", "graph_enrichment_executor"]) {
    expect(preservesSourceIndexes(executor)).toBe(false);
  }
});
