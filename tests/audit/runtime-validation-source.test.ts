import { afterEach, expect, test } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";
import { runPlanningExecutor } from "../../src/audit/orchestrator/planningExecutors.js";
import { runResultIngestionExecutor, runRuntimeValidationExecutor, runRuntimeValidationUpdateExecutor } from "../../src/audit/orchestrator/ingestionExecutors.js";
import { computeArtifactMetadata } from "../../src/audit/orchestrator/artifactMetadata.js";
import { deriveAuditState } from "../../src/audit/orchestrator/state.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function completedRuntime() {
  const root = await mkdtemp(join(tmpdir(), "runtime-source-"));
  roots.push(root);
  await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "node -e \"process.exit(0)\"" } }));
  await writeFile(join(root, "auth.ts"), "export const auth = true;\n");
  const base: ArtifactBundle = {
    repo_manifest: { repository: { name: "fixture" }, generated_at: "2026-11-04T00:00:00Z", files: [
      { path: "auth.ts", language: "typescript", size_bytes: 26, hash: "a".repeat(64) },
    ] },
    file_disposition: { files: [{ path: "auth.ts", status: "included" }] },
    unit_manifest: { units: [{ unit_id: "auth", name: "auth", files: ["auth.ts"], required_lenses: ["security"], risk_score: 7 }] },
    surface_manifest: { surfaces: [] }, critical_flows: { flows: [], fallback_required: false }, risk_register: { items: [] },
  };
  const planned = (await runPlanningExecutor(base, root, { "auth.ts": 1 })).updated;
  const result = { ...planned.runtime_validation_report!.results[0], status: "confirmed" as const, summary: "Old source passed" };
  const bundle = runRuntimeValidationUpdateExecutor(planned, { results: [result] }).updated;
  bundle.artifact_metadata = computeArtifactMetadata(bundle);
  return { root, bundle, result: bundle.runtime_validation_report!.results[0] };
}

test("replanning changed source on identical task paths invalidates runtime completion", async () => {
  const { root, bundle } = await completedRuntime();
  bundle.repo_manifest!.files[0].hash = "b".repeat(64);
  const next = await runPlanningExecutor(bundle, root, { "auth.ts": 1 });
  expect(next.updated.runtime_validation_report!.results[0].status).toBe("pending");
});

test("coverage-only replanning reuses the check on unchanged source", async () => {
  const { root, bundle, result } = await completedRuntime();
  bundle.coverage_matrix!.files[0].completed_lenses = ["security"];
  const next = await runPlanningExecutor(bundle, root, { "auth.ts": 1 });
  expect(next.updated.runtime_validation_report!.results[0]).toBe(result);
});

test.each(["absent", "old", "hashless"])("replanning cannot reuse completion with %s source provenance", async (mode) => {
  const { root, bundle } = await completedRuntime();
  if (mode === "absent") bundle.artifact_metadata = undefined;
  if (mode === "old") bundle.artifact_metadata!.metadata_schema_version = 0;
  if (mode === "hashless") delete bundle.repo_manifest!.files[0].hash;
  const next = await runPlanningExecutor(bundle, root, { "auth.ts": 1 });
  expect(next.updated.runtime_validation_report!.results[0].status).toBe("pending");
});

test("result ingestion cannot restamp old runtime completion onto changed source", async () => {
  const { bundle } = await completedRuntime();
  bundle.repo_manifest!.files[0].hash = "b".repeat(64);
  const next = runResultIngestionExecutor(bundle, []);
  expect(next.updated.runtime_validation_report!.results[0].status).toBe("pending");
});

test.each([undefined, 0])("generic metadata migration cannot authorize legacy runtime completion (%s)", async (version) => {
  const { root, bundle } = await completedRuntime();
  bundle.artifact_metadata!.metadata_schema_version = version;
  bundle.repo_manifest!.files[0].hash = "b".repeat(64);
  bundle.artifact_metadata = computeArtifactMetadata(bundle, bundle.artifact_metadata);
  expect(deriveAuditState(bundle).obligations.find((o) => o.id === "runtime_validation_current")!.state).toBe("stale");
  const next = await runPlanningExecutor(bundle, root, { "auth.ts": 1 });
  expect(next.updated.runtime_validation_report!.results[0].status).toBe("pending");
});

test("a direct runtime executor runs checks again after source changes", async () => {
  const { root, bundle } = await completedRuntime();
  bundle.repo_manifest!.files[0].hash = "b".repeat(64);
  bundle.runtime_validation_tasks!.tasks[0].command = [process.execPath, "-e", "process.stdout.write('fresh runtime')"];
  const next = await runRuntimeValidationExecutor(bundle, root);
  expect(next.progress_summary).toContain("1 unique command(s) run");
  expect(next.updated.runtime_validation_report!.results[0].summary).not.toBe("Old source passed");
  expect(deriveAuditState(next.updated).obligations.find((o) => o.id === "runtime_validation_current")!.state).toBe("satisfied");
});

test("a partial runtime update after source changes leaves untouched checks pending", async () => {
  const { bundle } = await completedRuntime();
  const second = { ...bundle.runtime_validation_tasks!.tasks[0], id: "runtime:unit:second" };
  bundle.runtime_validation_tasks!.tasks.push(second);
  bundle.runtime_validation_report!.results.push({ task_id: second.id, status: "confirmed", summary: "Old second check" });
  bundle.repo_manifest!.files[0].hash = "b".repeat(64);
  const first = bundle.runtime_validation_tasks!.tasks[0];
  const next = runRuntimeValidationUpdateExecutor(bundle, { results: [{task_id: first.id, status: "confirmed", summary: "New first check"}] });
  expect(next.updated.runtime_validation_report!.results.find((r) => r.task_id === second.id)!.status).toBe("pending");
  expect(deriveAuditState(next.updated).obligations.find((o) => o.id === "runtime_validation_current")!.state).toBe("stale");
});

test("timestamp-only reintake preserves runtime completion", async () => {
  const { root, bundle, result } = await completedRuntime();
  bundle.repo_manifest!.generated_at = "2026-11-05T00:00:00Z";
  const next = await runPlanningExecutor(bundle, root, { "auth.ts": 1 });
  expect(next.updated.runtime_validation_report!.results[0]).toBe(result);
});

test("metadata carry preserves an explicit runtime source-key clear", async () => {
  const { bundle } = await completedRuntime();
  const previousMetadata = bundle.artifact_metadata;
  const originalHash = bundle.repo_manifest!.files[0].hash;
  delete bundle.repo_manifest!.files[0].hash;
  const task = bundle.runtime_validation_tasks!.tasks[0];
  const updated = runRuntimeValidationUpdateExecutor(bundle, { results: [
    { task_id: task.id, status: "confirmed", summary: "Unbound observation" },
  ] }).updated;
  updated.artifact_metadata = computeArtifactMetadata(updated, previousMetadata, ["runtime_validation_report.json"]);
  updated.repo_manifest!.files[0].hash = originalHash;
  expect(deriveAuditState(updated).obligations.find((o) => o.id === "runtime_validation_current")!.state).toBe("stale");
});
