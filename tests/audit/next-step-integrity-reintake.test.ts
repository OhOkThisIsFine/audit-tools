import { readFile, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { advancePastDesignReview, withTempRepo } from "./helpers/next-step-harness.js";
import { loadArtifactBundle, writeCoreArtifacts } from "../../src/audit/io/artifacts.js";
import { runDeterministicForNextStep } from "../../src/audit/cli/nextStepCommand.js";
import { buildPendingAuditTasks } from "../../src/audit/cli/dispatch/packetFilter.js";
import { hashContent } from "audit-tools/shared";
import { MAX_DRAIN_STEPS } from "../../src/audit/orchestrator/advance.js";
import { runWrapper } from "./helpers/run-wrapper.mjs";
import { countLines } from "../../src/audit/cli/args.js";
import { runSnapshotPath } from "../../src/audit/io/runSnapshot.js";

const observation = vi.hoisted(() => ({ intake: 0, holds: 0, failAfterIntake: false, engineBudget: 0 }));
vi.mock("../../src/audit/orchestrator/intakeExecutors.js", async (original) => {
  const actual = await original<typeof import("../../src/audit/orchestrator/intakeExecutors.js")>();
  return { ...actual, runIntakeExecutor: async (...args: Parameters<typeof actual.runIntakeExecutor>) => {
    observation.intake++;
    return actual.runIntakeExecutor(...args);
  } };
});
vi.mock("../../src/shared/io/fileLock.js", async (original) => {
  const actual = await original<typeof import("../../src/shared/io/fileLock.js")>();
  return { ...actual, withFileLock: ((...args: Parameters<typeof actual.withFileLock>) => {
    if (args[0].endsWith("artifact-tree.lock")) observation.holds++;
    return actual.withFileLock(...args);
  }) as typeof actual.withFileLock };
});
vi.mock("audit-tools/shared", async (original) => {
  const actual = await original<typeof import("audit-tools/shared")>();
  return { ...actual, advance: ((...args: Parameters<typeof actual.advance>) => {
    observation.engineBudget = args[3]?.maxExecutions ?? 0;
    if (observation.failAfterIntake && observation.intake > 0) throw new Error("injected post-intake failure");
    return actual.advance(...args);
  }) as typeof actual.advance };
});

/**
 * The run's frozen snapshot root. A live-tree edit no longer reaches a run
 * (tests/audit/frozen-snapshot.test.ts); what the integrity re-check still
 * guards is an edit to the tree the run READS — a host lane or the tool's own
 * auto-fix writing into the snapshot — so these cases edit the snapshot.
 */
async function runSourceRoot(root: string): Promise<string> {
  const record = JSON.parse(await readFile(runSnapshotPath(join(root, ".audit-tools", "audit")), "utf8")) as { source_root: string };
  return record.source_root;
}

function resume(root: string) {
  return runDeterministicForNextStep({ root, artifactsDir: join(root, ".audit-tools", "audit"),
    selfCliPath: "audit-code", timeoutMs: 30_000, narrativeEnabled: false, graphLlmEdgeReasoning: false,
    analyzers: { typescript: "skip", python: "skip", css: "skip", html: "skip", sql: "skip" } });
}

test("same-line-count pending source edit refreshes returned and persisted authority", async () => {
  await withTempRepo(async (root) => {
    const step = await advancePastDesignReview(root);
    expect(step.step_kind).toBe("dispatch_review");
    const artifactsDir = join(root, ".audit-tools", "audit");
    const before = await loadArtifactBundle(artifactsDir);
    const pending = buildPendingAuditTasks(before);
    expect(pending, JSON.stringify(before.audit_tasks)).not.toHaveLength(0);
    expect(pending.some((task) => task.file_paths.includes("src/api/auth.ts"))).toBe(true);
    // Exercise the existing enriched pending-task form that the integrity
    // preamble checks (ordinary planned tasks need not carry line counts).
    for (const task of before.audit_tasks ?? []) {
      task.file_line_counts = Object.fromEntries(task.file_paths.map((path) => [path, path === "src/api/auth.ts" ? 4 : 2]));
    }
    await writeCoreArtifacts(artifactsDir, before);
    observation.intake = 0;
    observation.holds = 0;
    const source = join(await runSourceRoot(root), "src", "api", "auth.ts");
    await writeFile(source, (await readFile(source, "utf8")).replace("length > 0", "length > 1"));
    const result = await runDeterministicForNextStep({ root, artifactsDir, selfCliPath: "audit-code", timeoutMs: 30_000,
      narrativeEnabled: false, graphLlmEdgeReasoning: false,
      analyzers: { typescript: "skip", python: "skip", css: "skip", html: "skip", sql: "skip" } });
    const after = await loadArtifactBundle(artifactsDir);
    const hash = hashContent(await readFile(source));
    expect(hash).not.toBe(before.repo_manifest?.files.find((file) => file.path === "src/api/auth.ts")?.hash);
    expect(after.repo_manifest?.files.find((file) => file.path === "src/api/auth.ts")?.hash).toBe(hash);
    expect(result.bundle.repo_manifest).toEqual(after.repo_manifest);
    expect(observation.intake).toBe(1);
    expect(observation.holds).toBe(1);
    expect(observation.engineBudget).toBeLessThanOrEqual(MAX_DRAIN_STEPS - 1);
    await resume(root);
    expect(observation.intake).toBe(1);
  });
});

test.each(["line-count edit", "deleted file", "post-intake failure"])("%s commits refreshed authority", async (scenario) => {
  await withTempRepo(async (root) => {
    // Deletion keeps a second auditable source, so intake remains valid.
    await writeFile(join(root, "src", "api", "other.ts"), "export const other = 1;\n");
    expect((await advancePastDesignReview(root)).step_kind).toBe("dispatch_review");
    const artifactsDir = join(root, ".audit-tools", "audit");
    const before = await loadArtifactBundle(artifactsDir);
    expect(buildPendingAuditTasks(before).some((task) => task.file_paths.includes("src/api/auth.ts"))).toBe(true);
    observation.intake = 0;
    const source = join(await runSourceRoot(root), "src", "api", "auth.ts");
    if (scenario === "deleted file") await unlink(source);
    else await writeFile(source, (await readFile(source, "utf8")) + "export const extra = 1;\n");
    observation.failAfterIntake = scenario === "post-intake failure";
    try {
      if (observation.failAfterIntake) await expect(resume(root)).rejects.toThrow("injected post-intake failure");
      else await resume(root);
      const after = await loadArtifactBundle(artifactsDir);
      if (scenario === "deleted file") expect(after.repo_manifest?.files.some((file) => file.path === "src/api/auth.ts")).toBe(false);
      else expect(after.repo_manifest?.files.find((file) => file.path === "src/api/auth.ts")?.hash).toBe(hashContent(await readFile(source)));
      expect(observation.intake).toBe(1);
    } finally { observation.failAfterIntake = false; }
  });
});

test.each([false, true])("bound old result acceptance with changed source = %s", async (changed) => {
  await withTempRepo(async (root) => {
    const step = await advancePastDesignReview(root);
    expect(step.step_kind).toBe("dispatch_review");
    const workload = JSON.parse(await readFile(step.artifact_paths.host_workload, "utf8"));
    const item = workload.work_items.find((entry: { scope: { files: string[] } }) => entry.scope.files.includes("src/api/auth.ts"));
    expect(item).toBeTruthy();
    const fileCoverage = await Promise.all(item.scope.files.map(async (path: string) => {
      const lines = await countLines(join(await runSourceRoot(root), path));
      return { path, reviewed_lines: lines, total_lines: lines };
    }));
    await writeFile(join(root, item.result_path), JSON.stringify({ contract_version: "audit-host-result/v1alpha1",
      result_id: `${item.id}-${item.prompt.sha256.slice(0, 12)}`, run_id: workload.run_id,
      work_item_id: item.id, prompt_sha256: item.prompt.sha256, file_coverage: fileCoverage, findings: [] }));
    const artifactsDir = join(root, ".audit-tools", "audit");
    const before = await loadArtifactBundle(artifactsDir);
    const source = join(await runSourceRoot(root), "src", "api", "auth.ts");
    if (changed) await writeFile(source, (await readFile(source, "utf8")).replace("length > 0", "length > 1"));
    await resume(root);
    const after = await loadArtifactBundle(artifactsDir);
    expect(after.repo_manifest?.files.find((file) => file.path === "src/api/auth.ts")?.hash).toBe(hashContent(await readFile(source)));
    if (!changed) {
      expect(after.audit_results?.length).toBeGreaterThan(0);
      return;
    }
    expect(after.audit_results ?? []).toHaveLength(0);
    const emitted = JSON.parse((await runWrapper(["next-step"], { cwd: root })).stdout);
    expect(emitted.step_kind).toBe("dispatch_review");
    {
      const current = JSON.parse(await readFile(emitted.artifact_paths.host_workload, "utf8"));
      const refreshedItems = current.work_items.filter((entry: { scope: { files: string[] } }) => entry.scope.files.includes("src/api/auth.ts"));
      expect(refreshedItems.length).toBeGreaterThan(0);
      for (const entry of refreshedItems) {
        expect(entry.prompt.text).toContain(hashContent(await readFile(source)));
        expect(entry.prompt.sha256).not.toBe(item.prompt.sha256);
      }
    }
    expect(before.repo_manifest).not.toEqual(after.repo_manifest);
  });
});

test("failed integrity intake commits its named failure without accepting old work", async () => {
  await withTempRepo(async (root) => {
    expect((await advancePastDesignReview(root)).step_kind).toBe("dispatch_review");
    await unlink(join(await runSourceRoot(root), "src", "api", "auth.ts"));
    await unlink(join(await runSourceRoot(root), "package.json"));
    await expect(resume(root)).rejects.toThrow("No auditable files found");
    const after = await loadArtifactBundle(join(root, ".audit-tools", "audit"));
    expect(after.audit_state?.last_executor).toBe("intake_executor");
    expect(after.audit_state?.last_obligation).toBe("forced:intake_executor");
    expect(after.audit_results ?? []).toHaveLength(0);
  });
});
