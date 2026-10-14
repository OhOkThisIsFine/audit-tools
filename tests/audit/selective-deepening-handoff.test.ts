import { afterEach, expect, test } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashContent } from "audit-tools/shared";
import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";
import type { AuditResult, AuditTask } from "../../src/audit/types.js";
import { ingestAuditHostResults, type AuditHostWorkItem } from "../../src/audit/cli/dispatch/hostHandoff.js";
import { materializeReviewRun, writeHandoffOnly } from "../../src/audit/cli/reviewRun.js";
import { prepareSemanticReviewWorkload } from "../../src/audit/cli/semanticReviewStep.js";
import { runResultIngestionExecutor } from "../../src/audit/orchestrator/ingestionExecutors.js";
import { runPlanningExecutor } from "../../src/audit/orchestrator/planningExecutors.js";
import { derivePendingTaskPartition } from "../../src/audit/orchestrator/pendingTasks.js";
import { deriveAuditState } from "../../src/audit/orchestrator/state.js";
import { advanceAudit } from "../../src/audit/orchestrator/advance.js";
import { taskIdFor } from "../../src/audit/orchestrator/selectiveDeepening/shared.js";
import { buildAdvancedBundle } from "./helpers/advancedBundle.mjs";

const roots: string[] = [];
const paths = ["src/a.ts", "src/b.ts", "src/c.ts"];
const lineIndex = Object.fromEntries(paths.map(path => [path, 40]));
const isConflict = (task: AuditTask) => task.tags?.includes("trigger:conflicting_output");
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

// Pin the persisted pre-coalescing contract instead of constructing "legacy"
// tasks with the new builder. Every old bucket already carried the full scope.
function legacyConflicts(): AuditTask[] {
  return paths.map(path => {
    const key = `correctness:invariant:${path}`;
    return {
      task_id: taskIdFor("conflict", [key, "source-a", "source-b", "finding-a", "finding-b"]),
      unit_id: "unit-all", pass_id: "deepening:pass-a", lens: "correctness",
      file_paths: [...paths], file_line_counts: { ...lineIndex },
      rationale: `Reconcile conflicting audit output for ${key}. Compare source tasks source-a, source-b and decide the correct severity, confidence, and evidence-backed conclusion.`,
      priority: "medium", status: "pending",
      tags: ["selective_deepening", "trigger:conflicting_output", "source_task:source-a", "source_task:source-b"],
    };
  });
}

async function fixture(includeLegacy = false) {
  const root = await mkdtemp(join(tmpdir(), "audit-conflict-handoff-")); roots.push(root);
  await mkdir(join(root, "src"));
  const content = Array.from({ length: 40 }, (_, i) => `export const value${i} = ${i};`).join("\n");
  const files = await Promise.all(paths.map(async path => {
    await writeFile(join(root, path), content);
    return { path, language: "ts", size_bytes: Buffer.byteLength(content), hash: hashContent(content) };
  }));
  const bundle: ArtifactBundle = {
    ...await buildAdvancedBundle(root, "audit_tasks_completed"),
    repo_manifest: { repository: { name: "conflict-handoff" }, generated_at: "2026-10-14T00:00:00.000Z", files },
    file_disposition: { files: paths.map(path => ({ path, status: "included" })) },
    unit_manifest: { units: [{ unit_id: "unit-all", name: "all", files: paths, risk_score: 5, required_lenses: ["correctness"] }] },
    surface_manifest: { surfaces: [] }, critical_flows: { flows: [] }, risk_register: { items: [] },
    audit_tasks: includeLegacy ? legacyConflicts() : [], audit_results: [],
  };
  // Normal planning freezes source hashes/estimates before the historical
  // contract is published, just as an old run that has already replanned does.
  const planned = (await runPlanningExecutor(bundle, root, lineIndex)).updated;
  const sources: AuditTask[] = ["a", "b"].map(id => ({
    task_id: `source-${id}`, unit_id: "unit-all", pass_id: `pass-${id}`, lens: "correctness",
    file_paths: [...paths], file_line_counts: { ...lineIndex }, rationale: "Review the shared invariant", priority: "low", status: "pending",
  }));
  planned.audit_tasks = [...planned.audit_tasks!, ...sources];
  const results: AuditResult[] = sources.map((task, index) => ({
    task_id: task.task_id, unit_id: task.unit_id, pass_id: task.pass_id, lens: task.lens,
    file_coverage: paths.map(path => ({ path, total_lines: lineIndex[path]! })),
    findings: [{ id: `finding-${index === 0 ? "a" : "b"}`, title: "Shared invariant", category: "invariant", lens: "correctness",
      severity: index === 0 ? "medium" : "info", confidence: "high", summary: "Review the shared invariant",
      affected_files: paths.map(path => ({ path })), evidence: ["Observed shared invariant"] }],
  }));
  const artifactsDir = join(root, ".audit-tools", "audit");
  let runId: string | undefined;
  const publish = async (current: ArtifactBundle) => {
    const run = await materializeReviewRun({ root, sourceRoot: root, artifactsDir, bundle: current, obligationId: "audit_tasks_completed" });
    if (runId) expect(run.activeReviewRun.run_id).toBe(runId);
    runId = run.activeReviewRun.run_id;
    await writeHandoffOnly({ root, artifactsDir, bundle: current, audit_state: deriveAuditState(current), progress_summary: "Conflict handoff fixture", activeReviewRun: run.activeReviewRun });
    return (await prepareSemanticReviewWorkload({ root, sourceRoot: root, artifactsDir, activeReviewRun: run.activeReviewRun, bundle: current })).handoff;
  };
  const submit = async (item: AuditHostWorkItem) => {
    const path = join(root, item.result_path); await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, JSON.stringify({ contract_version: "audit-host-result/v1alpha1",
      result_id: `${item.id}-${item.prompt.sha256.slice(0, 12)}`, run_id: runId,
      work_item_id: item.id, prompt_sha256: item.prompt.sha256, findings: [],
      file_coverage: item.scope.files.map(path => ({ path, reviewed_lines: lineIndex[path], total_lines: lineIndex[path] })) }));
  };
  const ingest = (current: ArtifactBundle) => ingestAuditHostResults({ root, sourceRoot: root, artifactsDir, runId: runId!,
    auditTasks: current.audit_tasks!, pendingTaskIds: new Set(derivePendingTaskPartition(current).pendingTasks.map(task => task.task_id)), lineIndex });
  const replan = async (current: ArtifactBundle) => (await advanceAudit(current,
    { root, artifactsDir, preferredExecutor: "planning_executor", lineIndex })).updated_bundle;
  const entries = async (filename: string): Promise<Array<Record<string, unknown>>> => {
    const value = JSON.parse(await readFile(join(artifactsDir, "runs", runId!, filename), "utf8")) as { entries: Array<Record<string, unknown>> };
    return value.entries;
  };
  return { planned, results, publish, submit, ingest, replan, entries };
}

test("fresh three-file conflicts publish one complete pending conflict work item", async () => {
  const value = await fixture();
  const ingested = runResultIngestionExecutor(value.planned, value.results).updated;
  const conflicts = derivePendingTaskPartition(ingested).pendingTasks.filter(isConflict);
  expect(conflicts).toHaveLength(1);
  const published = await value.publish(ingested);
  const conflictIds = new Set(ingested.audit_tasks!.filter(isConflict).map(task => task.task_id));
  const work = published.workload.work_items.filter(item => conflictIds.has(item.id));
  expect(work).toHaveLength(1);
  expect(work[0]!.scope.files).toEqual(paths);
  expect(work[0]!.id).toBe(legacyConflicts()[0]!.task_id);
});

test("legacy conflicts retain their published contracts, late results, and accepted records through ingestion and replan", async () => {
  const value = await fixture(true);
  const legacy = structuredClone(value.planned.audit_tasks!.filter(isConflict));
  expect(legacy).toHaveLength(3);
  const original = await value.publish(value.planned);
  const originalBindings = await value.entries("host-task-bindings.json");
  const items = legacy.map(task => original.workload.work_items.find(item => item.id === task.task_id)!);
  expect(items.every(Boolean)).toBe(true);

  let current = runResultIngestionExecutor(value.planned, value.results).updated;
  expect(current.audit_tasks!.filter(isConflict)).toEqual(legacy);
  expect(derivePendingTaskPartition(current).pendingTasks.filter(isConflict)).toEqual(legacy);
  current = await value.replan(current);
  expect(current.audit_tasks!.filter(isConflict)).toEqual(legacy);
  expect(derivePendingTaskPartition(current).pendingTasks.filter(isConflict)).toEqual(legacy);
  const republished = await value.publish(current);
  const bindings = await value.entries("host-task-bindings.json");
  for (const item of items) {
    expect(republished.workload.work_items.find(work => work.id === item.id)).toEqual(item);
    expect(bindings.find(entry => entry.work_item_id === item.id)).toEqual(originalBindings.find(entry => entry.work_item_id === item.id));
  }

  // Accept one ORIGINAL prompt-bound legacy result, then retain its complete
  // ledger entry while the other redundant obligations remain in flight.
  await value.submit(items[0]!);
  const first = await value.ingest(current);
  expect(first.accepted_count).toBe(1);
  expect(first.accepted_results.map(result => result.task_id)).toContain(items[0]!.id);
  const acceptedBefore = (await value.entries("host-accepted-results-ledger.json")).find(entry => entry.work_item_id === items[0]!.id);
  expect(acceptedBefore).toBeDefined();
  current = runResultIngestionExecutor(current, [...first.accepted_results]).updated;
  current = await value.replan(current);
  expect(derivePendingTaskPartition(current).pendingTasks.filter(isConflict).map(task => task.task_id).sort()).toEqual(items.slice(1).map(item => item.id).sort());
  const pending = await value.publish(current);
  for (const item of items.slice(1)) {
    expect(pending.workload.work_items.find(work => work.id === item.id)).toEqual(item);
    await value.submit(item);
  }
  const late = await value.ingest(current);
  expect(late.accepted_count).toBe(2);
  for (const item of items) expect(late.accepted_results.map(result => result.task_id)).toContain(item.id);
  expect((await value.entries("host-accepted-results-ledger.json")).find(entry => entry.work_item_id === items[0]!.id)).toEqual(acceptedBefore);
  current = runResultIngestionExecutor(current, [...late.accepted_results]).updated;
  expect(derivePendingTaskPartition(current).pendingTasks.filter(isConflict)).toEqual([]);
  expect(current.audit_tasks!.filter(isConflict).map(task => task.task_id).sort()).toEqual(legacy.map(task => task.task_id).sort());
});
