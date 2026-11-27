import { afterEach, expect, test } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";
import { createCoverageMatrix } from "../../src/audit/coverage.js";
import { computeArtifactMetadata } from "../../src/audit/orchestrator/artifactMetadata.js";
import { deriveAuditState } from "../../src/audit/orchestrator/state.js";
import {
  buildRuntimeValidationTasks, discoverRuntimeValidationCommand, mergeCurrentRuntimeValidationReport, runtimeValidationSourceIsCurrent, runtimeValidationSourceKey, withRuntimeValidationSourceKey,
} from "../../src/audit/orchestrator/runtimeValidation.js";
import { RuntimeValidationResultSchema } from "../../src/audit/types/runtimeValidation.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

// V2 question planning does not produce unit runtime checks. Exercise the
// archived runtime records and their source-bound merge directly.
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
  const bundle = { ...planned, runtime_validation_report: { results: [result] }, artifact_metadata: withRuntimeValidationSourceKey(planned.artifact_metadata, runtimeValidationSourceKey(planned)) };
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

test.each([undefined, 0])("generic metadata migration cannot authorize legacy runtime completion (%s)", async (version) => {
  const { root, bundle } = await completedRuntime();
  bundle.artifact_metadata!.metadata_schema_version = version;
  bundle.repo_manifest!.files[0].hash = "b".repeat(64);
  bundle.artifact_metadata = computeArtifactMetadata(bundle, bundle.artifact_metadata);
  expect(runtimeValidationSourceIsCurrent(bundle)).toBe(false);
  const next = await planRuntime(bundle, root);
  expect(next.runtime_validation_report!.results[0].status).toBe("pending");
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
  const updated = { ...bundle, runtime_validation_report: { results: [{ task_id: task.id, status: "inconclusive" as const, summary: "Unbound observation" }] }, artifact_metadata: withRuntimeValidationSourceKey(bundle.artifact_metadata, undefined) };
  updated.artifact_metadata = computeArtifactMetadata(updated, previousMetadata, ["runtime_validation_report.json"]);
  updated.repo_manifest!.files[0].hash = originalHash;
  expect(runtimeValidationSourceIsCurrent(updated)).toBe(false);
});

test("runtime result verification survives the archive schema parser", async () => {
  const { bundle, result } = await completedRuntime();
  const verification = { source_key: runtimeValidationSourceKey(bundle)!, observations: ["observed the fixture"] };
  const update = RuntimeValidationResultSchema.parse({ ...result, verification });
  expect(update.verification).toEqual(verification);
  expect(RuntimeValidationResultSchema.safeParse({ ...update, verification: { ...verification, source_key: "" } }).success).toBe(false);
  expect(RuntimeValidationResultSchema.safeParse({ ...update, verification: { ...verification, observations: [] } }).success).toBe(false);
  expect(RuntimeValidationResultSchema.safeParse({ ...update, verification: { ...verification, observations: [" "] } }).success).toBe(false);
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
});
