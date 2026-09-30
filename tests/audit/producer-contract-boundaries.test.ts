import { initializeCoverageFromPlan } from "../../src/audit/orchestrator/planning.js";
import { test, expect } from "vitest";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeCoreArtifacts, loadArtifactBundle, type ArtifactBundle } from "../../src/audit/io/artifacts.js";
import { buildChunkedAuditTasks } from "../../src/audit/orchestrator/taskBuilder.js";
import { buildAuditReportModel, buildAuditFindingsReport } from "../../src/audit/reporting/synthesis.js";
import { writeReviewRunFiles } from "../../src/audit/io/runArtifacts.js";

function producedTasks() {
  return buildChunkedAuditTasks({ files: [{
    path: "src/a.ts", classification_status: "classified", audit_status: "pending",
    required_lenses: ["correctness"], completed_lenses: [], unit_ids: ["unit-1"],
  }] }, { "src/a.ts": 10 });
}

async function withRoot(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "producer-contract-"));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test("real planner and synthesis outputs survive the canonical persistence boundary", async () => {
  const tasks = producedTasks();
  expect(tasks.length).toBeGreaterThan(0);
  const report = buildAuditFindingsReport(buildAuditReportModel({ results: [] }), null);
  await withRoot(async (root) => {
    await writeCoreArtifacts(root, { audit_tasks: tasks, audit_findings: report });
    const loaded = await loadArtifactBundle(root);
    expect(loaded.audit_tasks).toEqual(tasks);
    expect(loaded.audit_findings).toEqual(JSON.parse(JSON.stringify(report)));
    await writeCoreArtifacts(root, { audit_tasks: [] });
  });
});

for (const kind of ["audit_tasks", "audit_results", "audit_findings"] as const) {
  test(`${kind} malformed producer output is refused before any artifact is persisted`, async () => {
    const task = { ...producedTasks()[0] } as Record<string, unknown>;
    delete task.rationale;
    const report = { ...buildAuditFindingsReport(buildAuditReportModel({ results: [] }), null) } as Record<string, unknown>;
    delete report.audit_read;
    const bad = kind === "audit_tasks" ? [task] : kind === "audit_results"
      ? [{ task_id: "task", unit_id: "unit", pass_id: "pass", lens: "correctness", findings: [] }]
      : report;
    await withRoot(async (root) => {
      const bundle = { repo_manifest: { repository: { name: "fixture" }, generated_at: "2026-01-01", files: [] }, [kind]: bad } as ArtifactBundle;
      await expect(writeCoreArtifacts(root, bundle)).rejects.toThrow();
      expect(await readdir(root)).toEqual([]);
    });
  });
}

test("review-run task producer refuses malformed output before writing run identity", async () => {
  const tasks = producedTasks();
  const task = { ...tasks[0] } as Record<string, unknown>;
  delete task.rationale;
  await withRoot(async (root) => {
    const run = { run_id: "run", review_run_path: join(root, "run.json"), pending_audit_tasks_path: join(root, "tasks.json") };
    await expect(writeReviewRunFiles(root, run as never, [task] as never)).rejects.toThrow();
    expect(await readdir(root)).toEqual([]);
  });
});


test("actual coverage producer is validated before a malformed coverage record replaces persisted output", async () => {
  const coverage = initializeCoverageFromPlan({
    repository: { name: "fixture" }, generated_at: "2026-01-01",
    files: [{ path: "src/a.ts", size_bytes: 10, language: "typescript", excluded: false }],
  }, { units: [] }, { files: [] });
  expect(coverage.files).toHaveLength(1);
  await withRoot(async (root) => {
    await writeCoreArtifacts(root, { coverage_matrix: coverage });
    const original = await readFile(join(root, "coverage_matrix.json"), "utf8");
    const malformed = JSON.parse(JSON.stringify(coverage));
    delete malformed.files[0].completed_lenses;
    await expect(writeCoreArtifacts(root, { coverage_matrix: malformed })).rejects.toThrow();
    expect(await readFile(join(root, "coverage_matrix.json"), "utf8")).toBe(original);
  });
});
