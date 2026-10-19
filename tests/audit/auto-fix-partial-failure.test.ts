import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { hashContent } from "audit-tools/shared";
import { git } from "./helpers/submoduleRepo.mjs";
import { ensureRunSnapshot, removeRunSnapshot } from "../../src/audit/io/runSnapshot.js";

const mocks = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("../../src/audit/orchestrator/localCommands.js", () => ({
  resolveNodeTool: () => [],
  runFirstAvailableCommand: mocks.run,
}));
const { runAutoFixExecutor } = await import("../../src/audit/orchestrator/autoFixExecutor.js");

test.each(["failed-only", "failure-first", "failure-last"])("partial formatter failure preserves snapshot bytes across restoration without live writeback (%s)", async (scenario) => {
  const mixedSuccess = scenario !== "failed-only";
  const failedTool = scenario === "failure-last" ? "gofmt" : "black";
  const pythonBytes = scenario === "failure-last" ? "formatted python\n" : "partial python\n";
  const goBytes = scenario === "failure-last" ? "partial go\n" : "formatted go\n";
  const base = await mkdtemp(join(tmpdir(), "auto-fix-partial-"));
  const root = join(base, "repo");
  const artifactsDir = join(root, ".audit-tools", "audit");
  await mkdir(artifactsDir, { recursive: true });
  try {
    await writeFile(join(root, ".gitignore"), ".audit-tools/\n");
    await writeFile(join(root, "a.py"), "original python\n");
    await writeFile(join(root, "b.go"), "original go\n");
    await git(root, ["init", "-q"]);
    // Pin restoration uses Git checkout filters; keep this LF fixture deterministic.
    await git(root, ["config", "--local", "core.autocrlf", "false"]);
    await git(root, ["add", "-A"]);
    await git(root, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "fixture"]);
    const snapshot = await ensureRunSnapshot(root, artifactsDir);
    mocks.run.mockImplementation(async (source: string, candidates: Array<{ command: string }>) => {
      const tool = candidates[0].command;
      const success = tool !== failedTool;
      await writeFile(join(source, tool === "gofmt" ? "b.go" : "a.py"), tool === "gofmt" ? goBytes : pythonBytes);
      return { exitCode: success ? 0 : 1 };
    });
    const paths = mixedSuccess ? ["a.py", "b.go"] : ["a.py"];
    const result = await runAutoFixExecutor({
      repo_manifest: {
        repository: { name: "fixture" }, generated_at: "2026-01-01T00:00:00.000Z",
        files: [
          { path: "a.py", language: "python", size_bytes: 16, hash: hashContent("original python\n") },
          { path: "b.go", language: "go", size_bytes: 12, hash: hashContent("original go\n") },
        ],
      }, file_disposition: { files: paths.map(path => ({ path, status: "included" as const })) } }, snapshot.source_root, {
      autoFix: { enabled: true }, repositoryRoot: root, artifactsDir,
    });
    expect(result.updated.auto_fixes_applied).toMatchObject({
      executed_tools: mixedSuccess ? [failedTool === "black" ? "gofmt" : "black"] : [], failed_tools: [failedTool],
      failure_reconciliation: { source_edits: "retained", live_writeback: "withheld" },
    });
    expect(result.progress_summary).toContain(`Formatters failed: ${failedTool}.`);
    expect(result.progress_summary).toContain("No formatter edits were written back to the live tree because a formatter failed.");
    expect(result.progress_summary).toContain("Partial formatter edits may remain in the audit snapshot and will be audited.");
    expect(result.progress_summary).not.toContain("Wrote ");
    expect(await readFile(join(root, "a.py"), "utf8")).toBe("original python\n");
    expect(await readFile(join(root, "b.go"), "utf8")).toBe("original go\n");
    expect(await readFile(join(snapshot.source_root, "a.py"), "utf8")).toBe(pythonBytes);
    // A lost checkout must restore the same partial bytes the run actually audited.
    await rm(snapshot.source_root, { recursive: true, force: true });
    const restored = await ensureRunSnapshot(root, artifactsDir);
    expect(await readFile(join(restored.source_root, "a.py"), "utf8")).toBe(pythonBytes);
    expect(await readFile(join(restored.source_root, "b.go"), "utf8")).toBe(mixedSuccess ? goBytes : "original go\n");
  } finally {
    mocks.run.mockReset();
    await removeRunSnapshot(artifactsDir, root);
    await rm(base, { recursive: true, force: true });
  }
});


test.each([false, true])("formatter failure reports retained edits for live or frozen sources (snapshot record: %s)", async (withSnapshot) => {
  const root = await mkdtemp(join(tmpdir(), "auto-fix-direct-"));
  const artifactsDir = join(root, ".audit-tools", "audit");
  await mkdir(artifactsDir, { recursive: true });
  try {
    await writeFile(join(root, "a.py"), "original\n");
    if (withSnapshot) {
      await writeFile(join(root, ".gitignore"), ".audit-tools/\n");
      await git(root, ["init", "-q"]);
      // Pin restoration uses Git checkout filters; keep this LF fixture deterministic.
      await git(root, ["config", "--local", "core.autocrlf", "false"]);
      await git(root, ["add", "-A"]);
      await git(root, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "fixture"]);
    }
    const source = withSnapshot ? (await ensureRunSnapshot(root, artifactsDir)).source_root : root;
    mocks.run.mockImplementation(async () => {
      await writeFile(join(source, "a.py"), "partial\n");
      return { exitCode: 1 };
    });
    const result = await runAutoFixExecutor({ file_disposition: { files: [{ path: "a.py", status: "included" }] } }, source, {
      autoFix: { enabled: true }, repositoryRoot: root, ...(withSnapshot ? { artifactsDir } : {}),
    });
    expect(result.updated.auto_fixes_applied).toMatchObject({
      executed_tools: [], failed_tools: ["black"],
      failure_reconciliation: { source_edits: "retained", live_writeback: withSnapshot ? "withheld" : "not_applicable" },
    });
    expect(result.progress_summary).toContain(withSnapshot
      ? "Partial formatter edits may remain in the audit snapshot and will be audited."
      : "Partial formatter edits may remain in the source tree and will be audited.");
    if (!withSnapshot) expect(result.progress_summary).not.toContain("No formatter edits were written back");
    expect(await readFile(join(source, "a.py"), "utf8")).toBe("partial\n");
    if (withSnapshot) {
      await rm(source, { recursive: true, force: true });
      const restored = await ensureRunSnapshot(root, artifactsDir);
      expect(await readFile(join(restored.source_root, "a.py"), "utf8")).toBe("partial\n");
      expect(await readFile(join(root, "a.py"), "utf8")).toBe("original\n");
    }
  } finally {
    mocks.run.mockReset();
    await removeRunSnapshot(artifactsDir, root);
    await rm(root, { recursive: true, force: true });
  }
});
