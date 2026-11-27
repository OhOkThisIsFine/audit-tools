import { afterEach, expect, test } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";
import { createCoverageMatrix } from "../../src/audit/coverage.js";
import { runResultIngestionExecutor, runRuntimeValidationExecutor, runRuntimeValidationUpdateExecutor } from "../../src/audit/orchestrator/ingestionExecutors.js";
import { computeArtifactMetadata } from "../../src/audit/orchestrator/artifactMetadata.js";
import { deriveAuditState } from "../../src/audit/orchestrator/state.js";
import {
  buildRuntimeValidationTasks, discoverRuntimeValidationCommand, mergeCurrentRuntimeValidationReport, runtimeValidationSourceIsCurrent, runtimeValidationSourceKey,
} from "../../src/audit/orchestrator/runtimeValidation.js";
import { RuntimeValidationResultSchema } from "../../src/audit/types/runtimeValidation.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

// V2 question planning does not produce unit runtime checks. Exercise the
// runtime producer and its source-bound merge directly; legacy result ingestion
// remains a separate compatibility boundary below.
async function planRuntime(bundle: ArtifactBundle, root: string): Promise<ArtifactBundle> {
  const runtime_validation_tasks = buildRuntimeValidationTasks({
    unitManifest: bundle.unit_manifest!,
    command: await discoverRuntimeValidationCommand(root),
  });
  expect(runtime_validation_tasks.tasks).toHaveLength(1);
  return {
    ...bundle,
    runtime_validation_tasks,
    runtime_validation_report: mergeCurrentRuntimeValidationReport(runtime_validation_tasks, bundle),
  };
}

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
  base.coverage_matrix = createCoverageMatrix(base.repo_manifest!.files.map(file => file.path));
  const planned = await planRuntime(base, root);
  const result = {
    ...planned.runtime_validation_report!.results[0], status: "confirmed" as const, summary: "Old source passed",
    evidence: ["synthetic log reference"], verification: {
      source_key: runtimeValidationSourceKey(planned)!,
      observations: ["fixture case: auth unit behavior checked"],
    },
  };
  const bundle = runRuntimeValidationUpdateExecutor(planned, { results: [result] }).updated;
  bundle.artifact_metadata = computeArtifactMetadata(bundle);
  return { root, bundle, result: bundle.runtime_validation_report!.results[0] };
}

test("replanning changed source on identical task paths invalidates runtime completion", async () => {
  const { root, bundle } = await completedRuntime();
  bundle.repo_manifest!.files[0].hash = "b".repeat(64);
  const next = await planRuntime(bundle, root);
  expect(next.runtime_validation_report!.results[0].status).toBe("pending");
});

test("coverage-only replanning reuses the check on unchanged source", async () => {
  const { root, bundle, result } = await completedRuntime();
  bundle.coverage_matrix!.files[0].completed_lenses = ["security"];
  const next = await planRuntime(bundle, root);
  expect(next.runtime_validation_report!.results[0]).toBe(result);
});

test.each(["absent", "old", "hashless"])("replanning cannot reuse completion with %s source provenance", async (mode) => {
  const { root, bundle } = await completedRuntime();
  if (mode === "absent") bundle.artifact_metadata = undefined;
  if (mode === "old") bundle.artifact_metadata!.metadata_schema_version = 0;
  if (mode === "hashless") delete bundle.repo_manifest!.files[0].hash;
  const next = await planRuntime(bundle, root);
  expect(next.runtime_validation_report!.results[0].status).toBe("pending");
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
  expect(runtimeValidationSourceIsCurrent(bundle)).toBe(false);
  const next = await planRuntime(bundle, root);
  expect(next.runtime_validation_report!.results[0].status).toBe("pending");
});

test("the archival runtime helper runs the synthetic command again after source changes", async () => {
  const { root, bundle } = await completedRuntime();
  bundle.repo_manifest!.files[0].hash = "b".repeat(64);
  bundle.runtime_validation_tasks!.tasks[0].command = [process.execPath, "-e", "process.stdout.write('fresh runtime')"];
  const next = await runRuntimeValidationExecutor(bundle, root);
  expect(next.progress_summary).toContain("1 unique command(s) run");
  expect(next.updated.runtime_validation_report!.results[0].summary).not.toBe("Old source passed");
  expect(runtimeValidationSourceIsCurrent(next.updated)).toBe(true);
  expect(next.updated.runtime_validation_report!.results[0].status).toBe("inconclusive");
});

test("a partial runtime update after source changes leaves untouched checks pending", async () => {
  const { bundle } = await completedRuntime();
  const second = { ...bundle.runtime_validation_tasks!.tasks[0], id: "runtime:unit:second" };
  bundle.runtime_validation_tasks!.tasks.push(second);
  bundle.runtime_validation_report!.results.push({ task_id: second.id, status: "confirmed", summary: "Old second check" });
  bundle.repo_manifest!.files[0].hash = "b".repeat(64);
  const first = bundle.runtime_validation_tasks!.tasks[0];
  const next = runRuntimeValidationUpdateExecutor(bundle, { results: [{
    task_id: first.id, status: "confirmed", summary: "New first check",
    evidence: ["new synthetic log"], verification: {
      source_key: runtimeValidationSourceKey(bundle)!, observations: ["fixture case: first unit checked"],
    },
  }] });
  expect(next.updated.runtime_validation_report!.results.find((r) => r.task_id === second.id)!.status).toBe("pending");
  expect(next.updated.runtime_validation_report!.results.find((r) => r.task_id === first.id)?.status).toBe("confirmed");
});

test("an archival runtime confirmation does not satisfy active question review", async () => {
  const { bundle } = await completedRuntime();
  expect(runtimeValidationSourceIsCurrent(bundle)).toBe(true);
  expect(bundle.runtime_validation_report!.results[0].status).toBe("confirmed");
  const obligations = deriveAuditState(bundle).obligations;
  expect(obligations).not.toContainEqual(expect.objectContaining({ id: "runtime_validation_current" }));
  expect(obligations).toContainEqual(expect.objectContaining({ id: "audit_tasks_completed", state: "missing" }));
});

test("timestamp-only reintake preserves runtime completion", async () => {
  const { root, bundle, result } = await completedRuntime();
  bundle.repo_manifest!.generated_at = "2026-11-05T00:00:00Z";
  const next = await planRuntime(bundle, root);
  expect(next.runtime_validation_report!.results[0]).toBe(result);
});

test("metadata carry preserves an explicit runtime source-key clear", async () => {
  const { bundle } = await completedRuntime();
  const previousMetadata = bundle.artifact_metadata;
  const originalHash = bundle.repo_manifest!.files[0].hash;
  delete bundle.repo_manifest!.files[0].hash;
  const task = bundle.runtime_validation_tasks!.tasks[0];
  const updated = runRuntimeValidationUpdateExecutor(bundle, { results: [
    { task_id: task.id, status: "inconclusive", summary: "Unbound observation" },
  ] }).updated;
  updated.artifact_metadata = computeArtifactMetadata(updated, previousMetadata, ["runtime_validation_report.json"]);
  updated.repo_manifest!.files[0].hash = originalHash;
  expect(runtimeValidationSourceIsCurrent(updated)).toBe(false);
});

test("planned runtime results refuse empty or stale unit evidence", async () => {
  const { bundle, result } = await completedRuntime();
  expect(bundle.runtime_validation_tasks!.tasks[0].evidence_requirements?.join(" ")).toContain("Before execution");
  expect(() => runRuntimeValidationUpdateExecutor(bundle, { results: [{ ...result, evidence: [] }] }))
    .toThrow("observations and evidence bound to the current source");
  expect(() => runRuntimeValidationUpdateExecutor(bundle, { results: [{ ...result, verification: { ...result.verification!, observations: [" "] } }] }))
    .toThrow("observations and evidence bound to the current source");
  bundle.repo_manifest!.files[0].hash = "b".repeat(64);
  expect(() => runRuntimeValidationUpdateExecutor(bundle, { results: [result] }))
    .toThrow("observations and evidence bound to the current source");
});

test("runtime result verification is validated and retained on report merge", async () => {
  const { bundle, result } = await completedRuntime();
  const verification = { source_key: runtimeValidationSourceKey(bundle)!, observations: ["observed the fixture"] };
  const update = RuntimeValidationResultSchema.parse({ ...result, verification });
  expect(update.verification).toEqual(verification);
  expect(RuntimeValidationResultSchema.safeParse({ ...update, verification: { ...verification, source_key: "" } }).success).toBe(false);
  expect(RuntimeValidationResultSchema.safeParse({ ...update, verification: { ...verification, observations: [] } }).success).toBe(false);
  expect(RuntimeValidationResultSchema.safeParse({ ...update, verification: { ...verification, observations: [" "] } }).success).toBe(false);
  const merged = runRuntimeValidationUpdateExecutor(bundle, { results: [update] });
  expect(merged.updated.runtime_validation_report!.results[0].verification).toEqual(verification);
});

test("repairing prerequisites reopens only explicitly pending units on unchanged source", async () => {
  const { root, bundle, result } = await completedRuntime();
  const first = bundle.runtime_validation_tasks!.tasks[0];
  first.command = [process.execPath, "-e", "process.stdout.write('isolated runtime fixture')"];
  const sibling = { ...first, id: "runtime:unit:sibling" };
  bundle.runtime_validation_tasks!.tasks.push(sibling);
  bundle.runtime_validation_report!.results = [
    { ...result, status: "inconclusive", summary: "Not run: required fixture absent" },
    { ...result, task_id: sibling.id },
  ];
  const unchanged = await runRuntimeValidationExecutor(bundle, root);
  expect(unchanged.progress_summary).toContain("0 unique command(s) run");
  const reopened = runRuntimeValidationUpdateExecutor(unchanged.updated, { results: [{
    task_id: first.id, status: "pending", summary: "Isolated fixture restored",
  }] });
  const retry = await runRuntimeValidationExecutor(reopened.updated, root);
  expect(retry.progress_summary).toContain("1 unique command(s) run");
  expect(retry.updated.runtime_validation_report!.results).toEqual([
    expect.objectContaining({ task_id: first.id, status: "inconclusive", summary: expect.stringContaining("Shared command only") }),
    expect.objectContaining({ task_id: sibling.id, status: "confirmed" }),
  ]);
});

test.each(["confirmed", "inconclusive"] as const)("adding evidence instructions does not retry a legacy %s check", async (status) => {
  const { root, bundle, result } = await completedRuntime();
  delete bundle.runtime_validation_tasks!.tasks[0].evidence_requirements;
  bundle.runtime_validation_report!.results = [{
    task_id: result.task_id, status, summary: "Historical command record", evidence: ["historical output"],
  }];
  const replanned = await planRuntime(bundle, root);
  const observed = replanned.runtime_validation_report!.results[0];
  expect(observed).toMatchObject({ status: "inconclusive", evidence: ["historical output"] });
  const next = await runRuntimeValidationExecutor(replanned, root);
  expect(next.progress_summary).toContain("0 unique command(s) run");
});
