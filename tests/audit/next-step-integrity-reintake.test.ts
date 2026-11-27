import { readFile, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { withTempRepo } from "./helpers/next-step-harness.js";
import { advanceToDispatchReady } from "./helpers/completion-harness.js";
import { readQuestionWorkload, submitQuestions } from "./helpers/question-completion-harness.js";
import { loadArtifactBundle } from "../../src/audit/io/artifacts.js";
import { runDeterministicForNextStep } from "../../src/audit/cli/nextStepCommand.js";
import { hashContent } from "audit-tools/shared";
import { MAX_DRAIN_STEPS } from "../../src/audit/orchestrator/advance.js";
import { runSnapshotPath } from "../../src/audit/io/runSnapshot.js";

// Keep the working native graph and omit only the optional workstation-specific index.
// Native index preparation has its own dedicated tests.
vi.mock("../../src/audit/cli/reviewerCodebaseMemory.js", async (original) => ({
  ...await original<typeof import("../../src/audit/cli/reviewerCodebaseMemory.js")>(),
  prepareReviewerCbm: async () => undefined,
}));

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

test("same-line-count issued source edit refreshes returned and persisted authority", async () => {
  await withTempRepo(async (root) => {
    const step = await advanceToDispatchReady(root);
    expect(step.step_kind).toBe("dispatch_review");
    const artifactsDir = join(root, ".audit-tools", "audit");
    const before = await loadArtifactBundle(artifactsDir);
    const issued = await readQuestionWorkload(step);
    expect(issued.work_items.some(({ binding }) => binding.assignment.suggested_sources
      .some(({ path }) => path === "src/api/auth.ts"))).toBe(true);
    expect(before.review_plan?.snapshot_id).toBeDefined();
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
    expect((await advanceToDispatchReady(root)).step_kind).toBe("dispatch_review");
    const artifactsDir = join(root, ".audit-tools", "audit");
    const before = await loadArtifactBundle(artifactsDir);
    expect(before.review_plan?.questions.some(q => q.source_dependencies.some(dep => dep.key === "src/api/auth.ts"))).toBe(true);
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

test.each([false, true])("bound question answer acceptance with changed frozen source = %s", async (changed) => {
  await withTempRepo(async (root) => {
    const issued = await readQuestionWorkload(await advanceToDispatchReady(root));
    const old = issued.work_items.find(({ binding }) => binding.assignment.suggested_sources
      .some(({ path }) => path === "src/api/auth.ts"));
    expect(old).toBeDefined();
    const [answer] = await submitQuestions(root, [old!]);
    const artifactsDir = join(root, ".audit-tools", "audit");
    const before = await loadArtifactBundle(artifactsDir);
    const source = join(await runSourceRoot(root), "src", "api", "auth.ts");
    if (changed) await writeFile(source, (await readFile(source, "utf8")).replace("length > 0", "length > 1"));
    await resume(root);
    const after = await loadArtifactBundle(artifactsDir);
    const currentHash = hashContent(await readFile(source));
    expect(after.repo_manifest?.files.find((file) => file.path === "src/api/auth.ts")?.hash).toBe(currentHash);
    const ledgerPath = join(artifactsDir, "runs", issued.run_id, "host-accepted-results-ledger.json");
    const readSavedQuestionAnswerLedgerForFixture = () => readFile(ledgerPath, "utf8").then(raw => JSON.parse(raw), (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return { answers: [] };
      throw error;
    });
    if (!changed) {
      expect((await readSavedQuestionAnswerLedgerForFixture()).answers).toEqual([expect.objectContaining({ submission: answer })]);
      return;
    }
    expect((await readSavedQuestionAnswerLedgerForFixture()).answers).toEqual([]);
    const current = await readQuestionWorkload(await advanceToDispatchReady(root));
    expect((await readSavedQuestionAnswerLedgerForFixture()).answers).toEqual([]);
    expect(current.work_items.some(({ binding }) => binding.assignment.assignment_id === old!.binding.assignment.assignment_id)).toBe(false);
    expect(current.work_items.some(({ binding }) => binding.question.source_dependencies.some(dep =>
      dep.kind === "source" && dep.key === "src/api/auth.ts" && dep.fingerprint === currentHash,
    ))).toBe(true);
    expect(before.repo_manifest).not.toEqual(after.repo_manifest);
  });
});

test("failed integrity intake commits its named failure without accepting queued work", async () => {
  await withTempRepo(async (root) => {
    const issued = await readQuestionWorkload(await advanceToDispatchReady(root));
    await submitQuestions(root, [issued.work_items[0]!]);
    await unlink(join(await runSourceRoot(root), "src", "api", "auth.ts"));
    await unlink(join(await runSourceRoot(root), "package.json"));
    await expect(resume(root)).rejects.toThrow("No auditable files found");
    const dir = join(root, ".audit-tools", "audit");
    const after = await loadArtifactBundle(dir);
    expect(after.audit_state?.last_executor).toBe("intake_executor");
    expect(after.audit_state?.last_obligation).toBe("forced:intake_executor");
    expect(after.audit_state?.status).not.toBe("complete");
    const ledger = join(dir, "runs", issued.run_id, "host-accepted-results-ledger.json");
    await expect(readFile(ledger, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
