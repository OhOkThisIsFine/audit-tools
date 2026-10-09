import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { expect, test } from "vitest";
import { hashContent } from "audit-tools/shared";
import { advancePastDesignReview, withTempRepo } from "./helpers/next-step-harness.js";
import { git } from "./helpers/submoduleRepo.mjs";
import { loadArtifactBundle } from "../../src/audit/io/artifacts.js";
import { runDeterministicForNextStep } from "../../src/audit/cli/nextStepCommand.js";
import { countLines } from "../../src/audit/cli/args.js";
import { runSnapshotPath } from "../../src/audit/io/runSnapshot.js";
import { cmdValidateResults } from "../../src/audit/cli/validateResultsCommand.js";
import { cleanupStaleArtifactsDir } from "../../src/audit/cli/cleanup.js";
import { buildSyntheticResults } from "./helpers/fixture.mjs";
import { captureConsole } from "./helpers/captureConsole.mjs";
import { existsSync } from "node:fs";

// The frozen-snapshot property (docs/backlog/forward-tracks.md): no edit to the
// live tree during a run changes that run's inputs. A git root is pinned at run
// start; a non-git root is frozen by a copy — both must hold.
test.each(["git", "non-git"])("a live edit during a run leaves the run's inputs unchanged (%s root)", async (kind) => {
  await withTempRepo(async (root) => {
    if (kind === "git") {
      await git(root, ["init", "-q"]);
      await git(root, ["add", "-A"]);
      await git(root, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "fixture"]);
    }
    expect((await advancePastDesignReview(root)).step_kind).toBe("dispatch_review");
    const artifactsDir = join(root, ".audit-tools", "audit");
    const source = join(root, "src", "api", "auth.ts");
    const atStart = hashContent(await readFile(source));
    const before = await loadArtifactBundle(artifactsDir);
    expect(before.repo_manifest?.files.find((file) => file.path === "src/api/auth.ts")?.hash).toBe(atStart);
    // Identity stays on the live root: the manifest is named after it, never after the snapshot dir.
    expect(before.repo_manifest?.repository.name).toBe(basename(root));

    await writeFile(source, (await readFile(source, "utf8")).replace("length > 0", "length > 1"));
    await runDeterministicForNextStep({ root, artifactsDir, selfCliPath: "audit-code", timeoutMs: 30_000,
      narrativeEnabled: false, graphLlmEdgeReasoning: false,
      analyzers: { typescript: "skip", python: "skip", css: "skip", html: "skip", sql: "skip" } });

    const after = await loadArtifactBundle(artifactsDir);
    expect(after.repo_manifest?.files.find((file) => file.path === "src/api/auth.ts")?.hash).toBe(atStart);
    expect(after.repo_manifest).toEqual(before.repo_manifest);
  });
}, 120_000);

// The host side of the same property: a work item names the snapshot, and its
// result is judged (line counts, cited text) against the snapshot — so a live
// edit after run start neither misdirects the lane nor refuses its honest result.
test("a host result measured against the snapshot is accepted after the live file changed", async () => {
  await withTempRepo(async (root) => {
    const step = await advancePastDesignReview(root);
    expect(step.step_kind).toBe("dispatch_review");
    const artifactsDir = join(root, ".audit-tools", "audit");
    const { source_root: sourceRoot } = JSON.parse(await readFile(runSnapshotPath(artifactsDir), "utf8")) as { source_root: string };
    const workload = JSON.parse(await readFile(step.artifact_paths.host_workload, "utf8"));
    const item = workload.work_items.find((entry: { scope: { files: string[] } }) => entry.scope.files.includes("src/api/auth.ts"));
    expect(item.prompt.text).toContain(sourceRoot.replace(/\\/g, "/"));
    const fileCoverage = await Promise.all(item.scope.files.map(async (path: string) => {
      const lines = await countLines(join(sourceRoot, path));
      return { path, reviewed_lines: lines, total_lines: lines };
    }));
    // The live file gains ten lines AFTER the snapshot — a material divergence, so a
    // live-root line count would refuse the result.
    const live = join(root, "src", "api", "auth.ts");
    await writeFile(live, (await readFile(live, "utf8")) + "export const extra = 1;\n".repeat(10));
    await writeFile(join(root, item.result_path), JSON.stringify({ contract_version: "audit-host-result/v1alpha1",
      result_id: `${item.id}-${item.prompt.sha256.slice(0, 12)}`, run_id: workload.run_id,
      work_item_id: item.id, prompt_sha256: item.prompt.sha256, file_coverage: fileCoverage, findings: [] }));
    await runDeterministicForNextStep({ root, artifactsDir, selfCliPath: "audit-code", timeoutMs: 30_000,
      narrativeEnabled: false, graphLlmEdgeReasoning: false,
      analyzers: { typescript: "skip", python: "skip", css: "skip", html: "skip", sql: "skip" } });
    expect((await loadArtifactBundle(artifactsDir)).audit_results?.length).toBeGreaterThan(0);
  });
}, 120_000);

// The standalone validator judges a result by the same frozen tree: a live edit
// after run start does not turn an honest snapshot-measured result into an error.
test("validate-results measures line counts against the run's snapshot", async () => {
  await withTempRepo(async (root) => {
    await advancePastDesignReview(root);
    const artifactsDir = join(root, ".audit-tools", "audit");
    const { source_root: sourceRoot } = JSON.parse(await readFile(runSnapshotPath(artifactsDir), "utf8")) as { source_root: string };
    const tasks = (await loadArtifactBundle(artifactsDir)).audit_tasks ?? [];
    expect(tasks.length).toBeGreaterThan(0);
    const lineIndex: Record<string, number> = {};
    for (const path of new Set(tasks.flatMap((task) => task.file_paths))) lineIndex[path] = await countLines(join(sourceRoot, path));
    const live = join(root, "src", "api", "auth.ts");
    await writeFile(live, (await readFile(live, "utf8")) + "export const extra = 1;\n".repeat(10));
    const resultsPath = join(root, "results.json");
    await writeFile(resultsPath, JSON.stringify(buildSyntheticResults(tasks, lineIndex)));
    const { stdout } = await captureConsole(() => cmdValidateResults(["--root", root, "--results", resultsPath]));
    const report = JSON.parse(stdout) as { issues: Array<{ severity: string; message: string }> };
    expect(report.issues.filter((issue) => /line/i.test(issue.message))).toEqual([]);
  });
}, 120_000);

test("cleanup removes the run's snapshot with its artifacts dir", async () => {
  await withTempRepo(async (root) => {
    await advancePastDesignReview(root);
    const artifactsDir = join(root, ".audit-tools", "audit");
    const { source_root: sourceRoot } = JSON.parse(await readFile(runSnapshotPath(artifactsDir), "utf8")) as { source_root: string };
    expect(existsSync(sourceRoot)).toBe(true);
    expect((await cleanupStaleArtifactsDir(artifactsDir, { force: true })).action).toBe("deleted");
    expect(existsSync(sourceRoot)).toBe(false);
  });
}, 120_000);
