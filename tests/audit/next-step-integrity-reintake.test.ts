import { readFile, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { withTempRepo } from "./helpers/next-step-harness.js";
import { advanceToDispatchReady } from "./helpers/completion-harness.js";
import { readQuestionWorkload, submitQuestions } from "./helpers/question-completion-harness.js";
import { loadArtifactBundle } from "../../src/audit/io/artifacts.js";
import { runDeterministicForNextStep } from "../../src/audit/cli/nextStepCommand.js";
import { EXTERNAL_ANALYZER_CANDIDATES, hashContent } from "audit-tools/shared";
import { persistAnalyzerSettings } from "../../src/shared/analyzerPolicy.js";
import { runSnapshotPath } from "../../src/audit/io/runSnapshot.js";

// Keep the working native graph and omit only the optional workstation-specific index.
// Native index preparation has its own dedicated tests.
vi.mock("../../src/audit/cli/reviewerCodebaseMemory.js", async (original) => ({
  ...await original<typeof import("../../src/audit/cli/reviewerCodebaseMemory.js")>(),
  prepareReviewerCbm: async () => undefined,
}));

const observation = vi.hoisted(() => ({ intake: 0, holds: 0 }));
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

/** Source integrity needs real review bindings, not acquisition of optional analyzers. */
async function prepareIntegrityDispatch(root: string) {
  await persistAnalyzerSettings(root, Object.fromEntries([
    "typescript", "python", "css", "html", "sql",
    ...EXTERNAL_ANALYZER_CANDIDATES.map(candidate => candidate.id),
  ].map(tool => [tool, "skip" as const])));
  return advanceToDispatchReady(root);
}

test("a same-line-count source edit re-intakes once and refuses the queued stale answer", async () => {
  await withTempRepo(async (root) => {
    const issued = await readQuestionWorkload(await prepareIntegrityDispatch(root));
    const old = issued.work_items.find(({ binding }) => binding.assignment.suggested_sources
      .some(({ path }) => path === "src/api/auth.ts"));
    expect(old).toBeDefined();
    await submitQuestions(root, [old!]);
    const artifactsDir = join(root, ".audit-tools", "audit");
    const before = await loadArtifactBundle(artifactsDir);
    const source = join(await runSourceRoot(root), "src", "api", "auth.ts");
    observation.intake = 0;
    observation.holds = 0;
    await writeFile(source, (await readFile(source, "utf8")).replace("length > 0", "length > 1"));
    const refreshed = await resume(root);
    expect(observation.intake).toBe(1);
    expect(observation.holds).toBe(1);
    const after = await loadArtifactBundle(artifactsDir);
    const currentHash = hashContent(await readFile(source));
    expect(refreshed.bundle.repo_manifest).toEqual(after.repo_manifest);
    expect(after.repo_manifest?.files.find((file) => file.path === "src/api/auth.ts")?.hash).toBe(currentHash);
    const ledgerPath = join(artifactsDir, "runs", issued.run_id, "host-accepted-results-ledger.json");
    const readSavedQuestionAnswerLedgerForFixture = () => readFile(ledgerPath, "utf8").then(raw => JSON.parse(raw), (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return { answers: [] };
      throw error;
    });
    expect((await readSavedQuestionAnswerLedgerForFixture()).answers).toEqual([]);
    const current = await readQuestionWorkload(await prepareIntegrityDispatch(root));
    expect((await readSavedQuestionAnswerLedgerForFixture()).answers).toEqual([]);
    expect(current.work_items.some(({ binding }) => binding.assignment.assignment_id === old!.binding.assignment.assignment_id)).toBe(false);
    expect(current.work_items.some(({ binding }) => binding.question.source_dependencies.some(dep =>
      dep.kind === "source" && dep.key === "src/api/auth.ts" && dep.fingerprint === currentHash,
    ))).toBe(true);
    expect(before.repo_manifest).not.toEqual(after.repo_manifest);
    expect(observation.intake).toBe(1);
  });
});

test("failed integrity intake commits its named failure without accepting queued work", async () => {
  await withTempRepo(async (root) => {
    const issued = await readQuestionWorkload(await prepareIntegrityDispatch(root));
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
