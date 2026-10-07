import { afterEach, expect, test } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashContent } from "audit-tools/shared";
import { runPlanningExecutor } from "../../src/audit/orchestrator/planningExecutors.js";
import { runResultIngestionExecutor } from "../../src/audit/orchestrator/ingestionExecutors.js";
import { ingestAuditHostResults, readPublishedAuditTaskIds, type AuditHostWorkItem } from "../../src/audit/cli/dispatch/hostHandoff.js";
import { prepareSemanticReviewWorkload } from "../../src/audit/cli/semanticReviewStep.js";
import { advanceAudit } from "../../src/audit/orchestrator/advance.js";
import { materializeReviewRun, writeHandoffOnly } from "../../src/audit/cli/reviewRun.js";
import { deriveAuditState } from "../../src/audit/orchestrator/state.js";
import { runDeterministicForNextStep } from "../../src/audit/cli/nextStepHelpers.js";
import { loadArtifactBundle, writeCoreArtifacts, type ArtifactBundle } from "../../src/audit/io/artifacts.js";
import { computeArtifactMetadata } from "../../src/audit/orchestrator/artifactMetadata.js";
import { buildAdvancedBundle } from "./helpers/advancedBundle.mjs";
import { runIntentEquivalenceResolve } from "../../src/audit/orchestrator/intentEquivalenceExecutor.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function persistFixture(artifactsDir: string, bundle: ArtifactBundle) {
  await writeCoreArtifacts(artifactsDir, bundle);
  // Stamp the schema-normalized persisted shape, including schema defaults.
  const persisted = await loadArtifactBundle(artifactsDir);
  persisted.artifact_metadata = computeArtifactMetadata(persisted);
  await writeCoreArtifacts(artifactsDir, persisted);
  expect(deriveAuditState(await loadArtifactBundle(artifactsDir), { emitStaleness: false }).obligations.find(obligation => obligation.id === "planning_artifacts")!.state).toBe("satisfied");
}

async function fixture(options: { customArtifacts?: boolean; lens?: "correctness" | "maintainability" } = {}) {
  const lens = options.lens ?? "correctness";
  const root = await mkdtemp(join(tmpdir(), "audit-inflight-plan-")); roots.push(root);
  await mkdir(join(root, "src"));
  const lineIndex = { "src/a.ts": 1500, "src/b.ts": 2000, "src/c.ts": 1000, "src/d.ts": 1500 };
  const files = await Promise.all(Object.entries(lineIndex).map(async ([path, lines]) => {
    const content = Array.from({ length: lines }, (_, i) => `export const value${i} = ${i};`).join("\n") + "\n";
    await writeFile(join(root, path), content);
    return { path, language: "ts", size_bytes: Buffer.byteLength(content), hash: hashContent(content) };
  }));
  let bundle: ArtifactBundle = {
    ...await buildAdvancedBundle(root, "audit_tasks_completed"),
    repo_manifest: { repository: { name: "inflight-plan" }, generated_at: "2026-10-05T00:00:00.000Z", files },
    file_disposition: { files: files.map(file => ({ path: file.path, status: "included" })) },
    unit_manifest: { units: [{ unit_id: "unit-all", name: "all", files: files.map(file => file.path), risk_score: 5, required_lenses: [lens] }] },
    surface_manifest: { surfaces: [] }, critical_flows: { flows: [] }, risk_register: { items: [] },
  };
  bundle = runIntentEquivalenceResolve({ ...bundle, artifact_metadata: computeArtifactMetadata(bundle) }).updated;
  const artifactsDir = join(root, ".audit-tools", options.customArtifacts ? "custom-audit" : "audit");
  const planned = (await runPlanningExecutor(bundle, root, lineIndex)).updated;
  const tasks = planned.audit_tasks!.filter(task => task.lens === lens);
  expect(tasks.map(task => task.file_paths).sort()).toEqual([["src/a.ts"], ["src/b.ts", "src/c.ts"], ["src/d.ts"]].sort());
  const reviewRun = await materializeReviewRun({ root, artifactsDir, bundle: planned, obligationId: "audit_tasks_completed", tasksOverride: tasks });
  await writeHandoffOnly({ root, artifactsDir, bundle: planned, audit_state: deriveAuditState(planned), progress_summary: "Published inspection fixture", activeReviewRun: reviewRun.activeReviewRun });
  const runId = reviewRun.activeReviewRun.run_id;
  // Publish through the production path: the pending-task manifest with
  // disk-measured line counts, then the semantic review workload built from it.
  const publish = async (current: ArtifactBundle) => {
    const run = await materializeReviewRun({ root, artifactsDir, bundle: current, obligationId: "audit_tasks_completed",
      tasksOverride: current.audit_tasks!.filter(task => task.lens === lens && task.status !== "complete") });
    expect(run.activeReviewRun.run_id).toBe(runId);
    return (await prepareSemanticReviewWorkload({ root, artifactsDir, activeReviewRun: run.activeReviewRun, bundle: current })).handoff;
  };
  const published = await publish(planned);
  const submit = async (item: AuditHostWorkItem) => {
    const path = join(root, item.result_path); await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, JSON.stringify({ contract_version: "audit-host-result/v1alpha1", result_id: `${item.id}-${item.prompt.sha256.slice(0, 12)}`, run_id: runId,
      work_item_id: item.id, prompt_sha256: item.prompt.sha256, findings: [], file_coverage: item.scope.files.map(path => ({ path, reviewed_lines: lineIndex[path as keyof typeof lineIndex], total_lines: lineIndex[path as keyof typeof lineIndex] })) }));
  };
  const middle = published.workload.work_items.find(item => item.scope.files.includes("src/b.ts"))!;
  const inflight = published.workload.work_items.find(item => item.scope.files.length === 1 && item.scope.files[0] === "src/d.ts")!;
  await submit(middle);
  const accepted = await ingestAuditHostResults({ pendingTaskIds: new Set(), root, artifactsDir, runId, auditTasks: planned.audit_tasks!, lineIndex });
  expect(accepted.accepted_count).toBe(1);
  const ingested = runResultIngestionExecutor(planned, [...accepted.accepted_results]).updated;
  expect(ingested.coverage_matrix!.files.find(file => file.path === "src/b.ts")!.completed_lenses).toContain(lens);
  return { root, artifactsDir, lineIndex, runId, ingested, inflight, submit, publish };
}

const replan = async (value: Awaited<ReturnType<typeof fixture>>) => (await advanceAudit(value.ingested,
  { root: value.root, artifactsDir: value.artifactsDir, preferredExecutor: "planning_executor", lineIndex: value.lineIndex })).updated_bundle;

test("publication preservation honors a custom artifacts directory", async () => {
  const value = await fixture({ customArtifacts: true });
  const replanned = await replan(value);
  expect(replanned.audit_tasks!.find(task => task.task_id === value.inflight.id)).toEqual(value.ingested.audit_tasks!.find(task => task.task_id === value.inflight.id));
  expect((await value.publish(replanned)).workload.work_items.find(item => item.id === value.inflight.id)).toEqual(value.inflight);
});

const signalOn = (path: string) => [{ tool: "semgrep", results: [{ id: "s1", category: "correctness", severity: "high", path, summary: "Analyzer lead" }] }];

test("an analyzer signal on another file of the block keeps the published task", async () => {
  // The all-pending assignment build puts src/b.ts and src/d.ts in one block, so
  // its chunk-level signal tag and priority differ from the published task's.
  const value = await fixture();
  value.ingested.external_analyzer_results = signalOn("src/b.ts");
  const replanned = await replan(value);
  expect(replanned.audit_tasks!.find(task => task.task_id === value.inflight.id)).toEqual(value.ingested.audit_tasks!.find(task => task.task_id === value.inflight.id));
  expect((await value.publish(replanned)).workload.work_items.find(item => item.id === value.inflight.id)).toEqual(value.inflight);
});

test("an analyzer signal on the task's own file rebuilds the published task with the lead", async () => {
  const value = await fixture();
  value.ingested.external_analyzer_results = signalOn("src/d.ts");
  const replanned = await replan(value);
  const tasks = replanned.audit_tasks!.filter(task => task.lens === "correctness" && task.file_paths.includes("src/d.ts"));
  expect(tasks).toHaveLength(1);
  expect(tasks[0]!.tags).toContain("external_analyzer_signal");
  expect((await value.publish(replanned)).workload.work_items.find(item => item.id === tasks[0]!.task_id)!.prompt.sha256).not.toBe(value.inflight.prompt.sha256);
});

test("a changed intent boost rebuilds a published task at its new priority", async () => {
  // Priority gates selective deepening, so a published task kept at a stale
  // priority would get different follow-up work than a rebuilt one.
  const value = await fixture();
  const original = value.ingested.audit_tasks!.find(task => task.task_id === value.inflight.id)!;
  expect(original.priority).toBe("low");
  value.ingested.intent_checkpoint!.free_form_intent = "focus on correctness";
  const replanned = await replan(value);
  const tasks = replanned.audit_tasks!.filter(task => task.lens === "correctness" && task.file_paths.includes("src/d.ts"));
  expect(tasks).toHaveLength(1);
  expect(tasks[0]!.priority).toBe("medium");
});

test("intent scope exclusion removes an unchanged published task", async () => {
  const value = await fixture();
  value.ingested.intent_checkpoint!.excluded_scope = [{ path: "src/d.ts", reason: "Host excluded this subject" }];
  const replanned = await replan(value);
  expect(replanned.audit_tasks!.some(task => task.file_paths.includes("src/d.ts"))).toBe(false);
  expect(replanned.coverage_matrix!.files.find(file => file.path === "src/d.ts")!.audit_status).toBe("excluded");
});

test("changed lens policy removes an unchanged published nonmandatory lens", async () => {
  const value = await fixture({ lens: "maintainability" });
  value.ingested.intent_checkpoint!.lens_selection = { exclude: ["maintainability"] };
  const replanned = await replan(value);
  expect(replanned.audit_tasks!.some(task => task.lens === "maintainability")).toBe(false);
});

test("new critical flow membership uses the current shared builder assignment", async () => {
  const value = await fixture();
  value.ingested.critical_flows = { flows: [{ id: "flow-new", name: "New flow", entrypoints: ["src/d.ts"], paths: ["src/d.ts"], concerns: ["correctness"] }] };
  const replanned = await replan(value);
  const tasks = replanned.audit_tasks!.filter(task => task.lens === "correctness" && task.file_paths.includes("src/d.ts"));
  expect(tasks).toHaveLength(1);
  expect(tasks[0]!.task_id).not.toBe(value.inflight.id);
  expect(tasks[0]!.unit_id).toBe("flow:flow-new");
});

test("changed unit membership invalidates the published subject even with unchanged bytes", async () => {
  const value = await fixture();
  value.ingested.unit_manifest!.units[0]!.unit_id = "unit-reassigned";
  const replanned = await replan(value);
  const tasks = replanned.audit_tasks!.filter(task => task.lens === "correctness" && task.file_paths.includes("src/d.ts"));
  expect(tasks).toHaveLength(1);
  expect(tasks[0]!.task_id).not.toBe(value.inflight.id);
  expect(tasks[0]!.unit_id).toBe("unit-reassigned");
});

test("missing source hash cannot preserve prior published authority from file size alone", async () => {
  const value = await fixture();
  delete value.ingested.repo_manifest!.files.find(file => file.path === "src/d.ts")!.hash;
  const replanned = await replan(value);
  const task = replanned.audit_tasks!.find(task => task.lens === "correctness" && task.file_paths.includes("src/d.ts"))!;
  expect(task.inputs?.["source:src/d.ts"]).toBe("unversioned");
  const published = await value.publish(replanned);
  expect(published.workload.work_items.find(item => item.id === task.task_id)!.prompt.sha256).not.toBe(value.inflight.prompt.sha256);
  await value.submit(value.inflight);
  const late = await ingestAuditHostResults({ pendingTaskIds: new Set(), root: value.root, artifactsDir: value.artifactsDir, runId: value.runId, auditTasks: replanned.audit_tasks!, lineIndex: value.lineIndex });
  expect(late.accepted_results.some(result => result.task_id === value.inflight.id)).toBe(false);
});

test("changed current review premise cannot preserve a historically valid prompt", async () => {
  const value = await fixture();
  value.ingested.audit_tasks!.find(task => task.task_id === value.inflight.id)!.rationale = "A different review requirement";
  const publishedIds = await readPublishedAuditTaskIds({ root: value.root, artifactsDir: value.artifactsDir, tasks: value.ingested.audit_tasks!, manifest: value.ingested.repo_manifest, lineIndex: value.lineIndex });
  expect(publishedIds.has(value.inflight.id)).toBe(false);
  const replanned = await replan(value);
  expect(replanned.audit_tasks!.find(task => task.task_id === value.inflight.id)!.rationale).not.toBe("A different review requirement");
});

test.each(["missing", "invalid"])("%s publication tuple falls back to rebuilding pending work", async mode => {
  const value = await fixture();
  const path = join(value.artifactsDir, "runs", value.runId, "host-task-bindings.json");
  if (mode === "missing") await rm(path); else await writeFile(path, "{}");
  const replanned = await replan(value);
  expect(replanned.audit_tasks!.some(task => task.task_id === value.inflight.id)).toBe(false);
  expect(replanned.audit_tasks!.some(task => task.lens === "correctness" && task.file_paths.includes("src/d.ts"))).toBe(true);
});

test("unsafe active review pointer is unusable publication rather than a path resolution error", async () => {
  const value = await fixture();
  const path = join(value.artifactsDir, "dispatch", "current-review-run.json");
  const pointer = JSON.parse(await readFile(path, "utf8"));
  pointer.run_id = "../outside";
  await writeFile(path, JSON.stringify(pointer));
  const replanned = await replan(value);
  expect(replanned.audit_tasks!.some(task => task.task_id === value.inflight.id)).toBe(false);
});

test("publication I/O failures remain visible rather than silently authorizing fallback", async () => {
  const value = await fixture();
  const path = join(value.artifactsDir, "runs", value.runId, "host-task-bindings.json");
  await rm(path); await mkdir(path);
  await expect(replan(value)).rejects.toThrow();
});

test("replanning retains published unchanged pending tasks and consumes their genuine late bound result", async () => {
  const value = await fixture();
  const replanned = await replan(value);
  const pendingOriginals = value.ingested.audit_tasks!.filter(task => task.lens === "correctness" && task.status !== "complete");
  for (const task of pendingOriginals) expect.soft(replanned.audit_tasks!.find(current => current.task_id === task.task_id)).toEqual(task);
  for (const path of ["src/a.ts", "src/d.ts"]) expect(replanned.audit_tasks!.filter(task => task.lens === "correctness" && task.file_paths.includes(path))).toHaveLength(1);
  const republished = await value.publish(replanned);
  expect(republished.workload.work_items.find(item => item.id === value.inflight.id)).toEqual(value.inflight);
  await value.submit(value.inflight);
  const late = await ingestAuditHostResults({ pendingTaskIds: new Set(), root: value.root, artifactsDir: value.artifactsDir, runId: value.runId, auditTasks: replanned.audit_tasks!, lineIndex: value.lineIndex });
  expect(late.accepted_results.some(result => result.task_id === value.inflight.id)).toBe(true);
  replanned.artifact_metadata = computeArtifactMetadata(replanned);
  expect(deriveAuditState(replanned, { emitStaleness: false }).obligations.find(obligation => obligation.id === "planning_artifacts")!.state).toBe("satisfied");
  await persistFixture(value.artifactsDir, replanned);
  await runDeterministicForNextStep({ root: value.root, artifactsDir: value.artifactsDir, selfCliPath: "audit-code.mjs", timeoutMs: 30_000,
    analyzers: { typescript: "skip", python: "skip", html: "skip", css: "skip", sql: "skip" } });
  const resumed = await loadArtifactBundle(value.artifactsDir);
  expect.soft(resumed.audit_results?.some(result => result.task_id === value.inflight.id)).toBe(true);
  expect(resumed.coverage_matrix!.files.find(file => file.path === "src/d.ts")!.completed_lenses).toContain("correctness");
});

test("changed reviewed source refreshes workload authority and cannot reuse the old bound result", async () => {
  const value = await fixture();
  const path = "src/d.ts";
  const changed = (await readFile(join(value.root, path), "utf8")).replace("value0 = 0", "value0 = 9");
  await writeFile(join(value.root, path), changed);
  const file = value.ingested.repo_manifest!.files.find(file => file.path === path)!;
  file.hash = hashContent(changed);
  const replanned = await replan(value);
  const currentTasks = replanned.audit_tasks!.filter(task => task.lens === "correctness" && task.file_paths.includes(path));
  expect(currentTasks.length).toBeGreaterThan(0);
  for (const task of currentTasks) expect(task.inputs?.[`source:${path}`]).toBe(file.hash);
  await value.publish(replanned);
  await value.submit(value.inflight);
  const late = await ingestAuditHostResults({ pendingTaskIds: new Set(), root: value.root, artifactsDir: value.artifactsDir, runId: value.runId, auditTasks: replanned.audit_tasks!, lineIndex: value.lineIndex });
  expect(late.accepted_results.some(result => result.task_id === value.inflight.id)).toBe(false);
  expect(replanned.coverage_matrix!.files.find(file => file.path === path)!.completed_lenses).not.toContain("correctness");
});

test("a genuine late result is consumed by the production fold while its published task remains active", async () => {
  const value = await fixture();
  value.ingested.artifact_metadata = computeArtifactMetadata(value.ingested);
  expect(deriveAuditState(value.ingested, { emitStaleness: false }).obligations.find(obligation => obligation.id === "planning_artifacts")!.state).toBe("satisfied");
  await persistFixture(value.artifactsDir, value.ingested);
  await value.submit(value.inflight);
  await runDeterministicForNextStep({ root: value.root, artifactsDir: value.artifactsDir, selfCliPath: "audit-code.mjs", timeoutMs: 30_000,
    analyzers: { typescript: "skip", python: "skip", html: "skip", css: "skip", sql: "skip" } });
  const resumed = await loadArtifactBundle(value.artifactsDir);
  expect(resumed.audit_results?.some(result => result.task_id === value.inflight.id)).toBe(true);
  expect(resumed.coverage_matrix!.files.find(file => file.path === "src/d.ts")!.completed_lenses).toContain("correctness");
});

test("an accepted entry that no longer validates is withdrawn by the production fold, not replayed into a throwing batch gate", async () => {
  // Dogfood 2026-10-05: one accepted result that no longer validates stopped
  // every fold (open-bugs: "One invalid accepted result stops the whole audit run").
  const value = await fixture();
  value.ingested.artifact_metadata = computeArtifactMetadata(value.ingested);
  await persistFixture(value.artifactsDir, value.ingested);
  await value.submit(value.inflight);
  const early = await ingestAuditHostResults({ pendingTaskIds: new Set(), root: value.root, artifactsDir: value.artifactsDir, runId: value.runId, auditTasks: value.ingested.audit_tasks!, lineIndex: value.lineIndex });
  expect(early.accepted_results.some(result => result.task_id === value.inflight.id)).toBe(true);
  // The entry no longer validates against the bundle it is replayed against
  // (a rule the earlier acceptance did not apply; here its lens is not the
  // task's). Before the fix the batch gate threw on this fold and on every
  // later one.
  const ledgerPath = join(value.artifactsDir, "runs", value.runId, "host-accepted-results-ledger.json");
  type LedgerEntry = { work_item_id: string; audit_result: { lens: string } };
  const poisoned = JSON.parse(await readFile(ledgerPath, "utf8")) as { entries: LedgerEntry[] };
  for (const entry of poisoned.entries.filter(entry => entry.work_item_id === value.inflight.id)) {
    entry.audit_result.lens = "security";
  }
  await writeFile(ledgerPath, JSON.stringify(poisoned));
  await runDeterministicForNextStep({ root: value.root, artifactsDir: value.artifactsDir, selfCliPath: "audit-code.mjs", timeoutMs: 30_000,
    analyzers: { typescript: "skip", python: "skip", html: "skip", css: "skip", sql: "skip" } });
  // The poisoned entry is withdrawn, and the same ingest re-reads the valid
  // file still at its bound path, accepts it again, and the fold consumes it.
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8")) as { entries: LedgerEntry[] };
  expect(ledger.entries.filter(entry => entry.work_item_id === value.inflight.id).map(entry => entry.audit_result.lens)).toEqual(["correctness"]);
  const resumed = await loadArtifactBundle(value.artifactsDir);
  expect(resumed.audit_results?.filter(result => result.task_id === value.inflight.id).map(result => result.lens)).toEqual(["correctness"]);
  expect(resumed.coverage_matrix!.files.find(file => file.path === "src/d.ts")!.completed_lenses).toContain("correctness");
});
