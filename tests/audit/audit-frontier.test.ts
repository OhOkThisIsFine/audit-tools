import { test, expect } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hashContent } from "audit-tools/shared";
import { cmdNextStep } from "../../src/audit/cli/nextStepCommand.js";
import { deriveQuestionCycleUnlocked } from "../../src/audit/cli/questionReviewCycle.js";
import { publishAuditQuestionWorkload, submitAuditQuestionResult } from "../../src/audit/cli/dispatch/hostHandoff.js";
import { projectQuestionReview, type AuditQuestionBinding } from "../../src/audit/cli/dispatch/questionReviewAcceptance.js";
import { questionWorkloadBindings } from "../../src/audit/cli/questionWorkloadBindings.js";
import { writeCoreArtifacts, type ArtifactBundle } from "../../src/audit/io/artifacts.js";
import { buildQuestionPlanArtifacts } from "../../src/audit/orchestrator/questionPlanExecutor.js";
import { computeArtifactMetadata } from "../../src/audit/orchestrator/artifactMetadata.js";
import { computeStaleArtifacts } from "../../src/audit/orchestrator/staleness.js";
import { runExternalAnalyzerImportExecutor } from "../../src/audit/orchestrator/ingestionExecutors.js";
import { hashAnalyzerSnippet } from "../../src/shared/analyzers/provenance.js";
import { fullAuditScope } from "../../src/audit/orchestrator/scope.js";
import { REVIEW_QUESTION_CONTRACT_VERSION, type ReviewSubmission } from "../../src/shared/types/reviewQuestion.js";
import { captureCompletedDesignReviews, persistDesignReviewSnapshots } from "./helpers/designReviewSnapshotFixture.js";
import { withTempRepo } from "./helpers/next-step-harness.js";

const VERSION = REVIEW_QUESTION_CONTRACT_VERSION;
const MANUAL = "src/manual.ts";
const SCHEDULED = "src/scheduled.ts";
const STORE = "src/resume-store.ts";
const RETRY = "src/retry.ts";
const DOC = "README.md";
const HIDDEN = "src/not-admitted.ts";

async function sourceFixture(root: string): Promise<ArtifactBundle> {
  const contents = [
    [MANUAL, "export const manual = () => 'continue';\n"],
    [SCHEDULED, "export const tick = () => 'continue';\n"],
    [STORE, "export const preserve = true;\n"],
    [HIDDEN, "export const cannotRead = true;\n"],
    [DOC, "# Fixture\nInterrupted work should remain available.\n"],
  ] as const;
  for (const [path, body] of contents) await writeFile(join(root, path), body, "utf8");
  return {
    repo_manifest: { repository: { name: "fixture" }, generated_at: "2026-01-01T00:00:00Z",
      files: contents.map(([path, body]) => ({ path, language: "text", size_bytes: Buffer.byteLength(body), hash: hashContent(body) })) },
    file_disposition: { files: contents.map(([path]) => ({
      path, status: path === DOC ? "doc_only" : path === HIDDEN ? "excluded" : "included",
    })) },
    unit_manifest: { units: contents.filter(([path]) => path !== DOC && path !== HIDDEN).map(([path]) => ({
      unit_id: path, name: path, files: [path], required_lenses: [],
    })) },
    surface_manifest: { surfaces: [
      { id: "manual", kind: "interface", entrypoint: MANUAL },
      { id: "scheduled", kind: "background", entrypoint: SCHEDULED },
    ] },
    critical_flows: { flows: [
      { id: "manual", name: "Manual resume", entrypoints: [MANUAL], paths: [MANUAL, STORE], concerns: [] },
      { id: "scheduled", name: "Scheduled resume", entrypoints: [SCHEDULED], paths: [SCHEDULED, STORE], concerns: [] },
      { id: "store", name: "Shared history", entrypoints: [STORE], paths: [STORE], concerns: [] },
    ], fallback_required: false },
    graph_bundle: { graphs: {} },
    risk_register: { items: [] },
    intent_checkpoint: {
      schema_version: "intent-checkpoint/v1", confirmed_at: "2026-01-01T00:00:00Z", confirmed_by: "host",
      scope_summary: "fixture operations", intent_summary: "review resumed work",
      lens_selection: { include: ["behavior"] },
    },
  };
}

function plan(bundle: ArtifactBundle): ArtifactBundle {
  return buildQuestionPlanArtifacts(bundle, fullAuditScope()).updated;
}

async function registerRetry(root: string, bundle: ArtifactBundle) {
  const body = "export const retry = () => 'continue';\n";
  await writeFile(join(root, RETRY), body, "utf8");
  bundle.repo_manifest!.files.push({ path: RETRY, language: "typescript", hash: hashContent(body), size_bytes: Buffer.byteLength(body) });
  bundle.file_disposition!.files.push({ path: RETRY, status: "included" });
  bundle.surface_manifest!.surfaces.push({ id: "retry", kind: "interface", entrypoint: RETRY });
  bundle.critical_flows!.flows.push({
    id: "retry", name: "Retry resume", entrypoints: [RETRY], paths: [RETRY, STORE], concerns: [],
  });
}

function manualOnly(binding: AuditQuestionBinding, id: string): ReviewSubmission {
  const { question_id, revision_id, snapshot_id, requested_parts } = binding.question;
  const part_id = requested_parts.find(({ part_id }) => part_id === "manual")?.part_id ?? requested_parts[0]!.part_id;
  const identity = { schema_version: VERSION, question_id, revision_id, snapshot_id } as const;
  const source = { path: MANUAL, start_line: 1 };
  return {
    ...identity, submission_id: id, assignment_id: binding.assignment.assignment_id,
    inspected_sources: [source], evidence_ids: [], limitations: ["Only the manual restart was examined."],
    answer: { outcome: "clean", findings: [],
      parts: [{ part_id, outcome: "clean", observation_ids: ["manual-read"] }],
      observations: [{ ...identity, observation_id: "manual-read", part_id, kind: "source_confirmed",
        statement: "The manual entry continues the stored operation.", source_refs: [source], evidence_refs: [] }] },
  };
}

test("blind charter extraction still pauses and grants only its own packets, never accepted question evidence", async () => {
  await withTempRepo(async (root) => {
    const artifactsDir = join(root, ".audit-tools", "audit");
    const fixture = await sourceFixture(root);
    fixture.intent_checkpoint!.design_review = { answered_at: "2026-01-01T00:00:00Z", ceiling: { rung: "deep" } };
    const bundle = captureCompletedDesignReviews({
      ...fixture, auto_fixes_applied: {}, syntax_resolution_status: {},
      external_analyzer_acquisition: { enabled: false, tool_statuses: [] }, external_analyzer_results: [],
      analyzer_capability: { coverage: "not_applicable", analyzers: [] },
      design_assessment: { generated_at: "2026-01-01T00:00:00Z", findings: [], contract_reviewed: true, conceptual_reviewed: true },
      docs_digest: { generated_at: "2026-01-01T00:00:00Z", docs: [] },
      structure_decomposition: {
        generated_at: "2026-01-01T00:00:00Z", target: "structure", node_universe_size: 1,
        source_ids: [], consensus: [], contested: [], findings: [],
      },
    });
    await writeCoreArtifacts(artifactsDir, bundle);
    await persistDesignReviewSnapshots(artifactsDir, bundle);
    await cmdNextStep(["--root", root, "--artifacts-dir", artifactsDir]);
    const step = JSON.parse(await readFile(join(artifactsDir, "steps/current-step.json"), "utf8"));
    expect(step.step_kind).toBe("charter_extraction");
    expect(step.status).toBe("ready");
    expect(step.stop_condition).toContain("one blind agent per kind");
    expect(step.artifact_paths.host_workload).toBeUndefined();
    const lanePrompts = Object.entries(step.artifact_paths)
      .filter(([key]) => key.startsWith("charter_extraction_") && key.endsWith("_prompt"));
    expect(lanePrompts).toHaveLength(3);
    for (const [, path] of lanePrompts) {
      const prompt = await readFile(path as string, "utf8");
      expect(prompt).not.toMatch(/host-workload|accepted-results|audit_results\.jsonl/u);
      if (step.artifact_paths.host_workload) expect(prompt).not.toContain(step.artifact_paths.host_workload);
    }
  });
});

test("a targeted Architecture review is grounded in real ownership crossings, not all audited files", async () => {
  await withTempRepo(async (root) => {
    const fixture = await sourceFixture(root);
    fixture.intent_checkpoint!.lens_selection = { include: ["architecture"] };
    const result = plan(fixture).review_plan!;
    expect(result.questions).toHaveLength(2);
    expect(result.questions.every(question => question.lens === "architecture")).toBe(true);
    for (const question of result.questions) {
      const paths = question.source_dependencies.filter(dep => dep.kind === "source").map(dep => dep.key);
      expect(paths).toContain(STORE);
      expect(paths).not.toContain(HIDDEN);
      expect(paths).toHaveLength(2);
      expect(paths.some(path => path === MANUAL || path === SCHEDULED)).toBe(true);
    }
  });
});

test("artifact planning is deterministic; discovering a new operation stales the plan and only its dependent revisions", async () => {
  await withTempRepo(async (root) => {
    const original = plan(await sourceFixture(root));
    original.artifact_metadata = computeArtifactMetadata(original);
    const planned = original.review_plan!;
    expect(planned.questions).toHaveLength(3);
    expect(plan(structuredClone(original)).review_plan).toEqual(planned);
    const edited = structuredClone(original);
    await registerRetry(root, edited);
    expect(computeStaleArtifacts(edited, { emit: false }).has("review_plan.json")).toBe(true);
    const revised = plan(edited);
    const addedPlan = revised.review_plan!;
    expect(addedPlan.snapshot_id).not.toBe(planned.snapshot_id);
    expect(addedPlan.questions).toHaveLength(4);
    const beforeShared = planned.questions.find(question => question.requested_parts.length > 1)!;
    const afterShared = addedPlan.questions.find(question => question.question_id === beforeShared.question_id)!;
    expect(afterShared.revision_id).not.toBe(beforeShared.revision_id);
    expect(afterShared.requested_parts.map(part => part.part_id)).toEqual(["manual", "retry", "scheduled"]);
    for (const prior of planned.questions.filter(question => question !== beforeShared)) {
      expect(addedPlan.questions.find(question => question.question_id === prior.question_id)?.revision_id).toBe(prior.revision_id);
    }
    revised.artifact_metadata = computeArtifactMetadata(revised);
    expect(computeStaleArtifacts(revised, { emit: false }).has("review_plan.json")).toBe(false);
  });
});

test("the host may examine admitted non-suggested files but an excluded file never enters the question source index", async () => {
  await withTempRepo(async (root) => {
    const bundle = plan(await sourceFixture(root));
    const bindings = await questionWorkloadBindings(bundle, root, []);
    const manual = bindings.find(item => item.assignment.suggested_sources.some(ref => ref.path === MANUAL) &&
      item.question.requested_parts.length === 1)!;
    expect(manual.assignment.suggested_sources.some(ref => ref.path === SCHEDULED)).toBe(false);
    expect(manual.sourceFiles.find(file => file.path === SCHEDULED)).toMatchObject({ line_count: 1, fingerprint: expect.any(String) });
    expect(manual.sourceFiles.some(file => file.path === HIDDEN)).toBe(false);
    const boundary = { root, sourceRoot: root, artifactsDir: join(root, ".audit-tools", "audit"), runId: "question-access" };
    await publishAuditQuestionWorkload({ ...boundary, bindings });
    const submitted = manualOnly(manual, "scope-witness");
    submitted.inspected_sources.push({ path: HIDDEN, start_line: 1 });
    await expect(submitAuditQuestionResult({ ...boundary, assignmentId: submitted.assignment_id,
      source: JSON.stringify(submitted) })).rejects.toThrow(/(?:outside|unbound|not admitted).*not-admitted|not-admitted.*(?:outside|unbound|not admitted)/iu);
  });
});

test("the published question frontier resumes from accepted answers, reuses unrelated work and rejects a late superseded assignment", async () => {
  await withTempRepo(async (root) => {
    const bundle = plan(await sourceFixture(root));
    const boundary = { root, sourceRoot: root, artifactsDir: join(root, ".audit-tools", "audit") };
    const first = await deriveQuestionCycleUnlocked({ ...boundary, bundle });
    expect(first.pending).toHaveLength(3);
    const shared = first.pending.find(binding => binding.question.requested_parts.length > 1)!;
    const manual = first.pending.find(binding => binding.question.requested_parts.length === 1 &&
      binding.assignment.suggested_sources.some(ref => ref.path === MANUAL))!;
    const oldAnswer = manualOnly(shared, "shared-answer");
    const accept = (answer: ReviewSubmission) => submitAuditQuestionResult({ ...boundary, runId: first.runId,
      assignmentId: answer.assignment_id, source: JSON.stringify(answer) });
    await publishAuditQuestionWorkload({ ...boundary, runId: first.runId, bindings: first.pending });
    expect((await accept(oldAnswer)).kind).toBe("accepted");
    expect((await accept(manualOnly(manual, "manual-answer"))).kind).toBe("accepted");
    expect((await accept(oldAnswer)).kind).toBe("replay");
    const resumed = await deriveQuestionCycleUnlocked({ ...boundary, bundle: structuredClone(bundle) });
    expect(resumed.runId).toBe(first.runId);
    expect(resumed.answers).toHaveLength(2);
    expect(resumed.pending).toHaveLength(1);
    const observed = projectQuestionReview(shared.question, resumed.answers,
      resumed.dependenciesByQuestion.get(shared.question.question_id));
    expect(observed.parts.map(part => part.state)).toEqual(["clean", "open"]);

    const edited = structuredClone(bundle);
    await registerRetry(root, edited);
    const changed = await deriveQuestionCycleUnlocked({ ...boundary, bundle: plan(edited) });
    expect(changed.pending).toHaveLength(3);
    const rebound = changed.pending.find(binding => binding.question.question_id === shared.question.question_id)!;
    expect(rebound.assignment.assignment_id).not.toBe(shared.assignment.assignment_id);
    expect(changed.pending.some(binding => binding.question.question_id === manual.question.question_id)).toBe(false);
    expect(projectQuestionReview(rebound.question, changed.answers,
      changed.dependenciesByQuestion.get(rebound.question.question_id)).stale).toHaveLength(1);
    await publishAuditQuestionWorkload({ ...boundary, runId: changed.runId, bindings: changed.pending });
    await expect(accept({ ...oldAnswer, submission_id: "late-new-result" })).rejects.toThrow(/not in the current issued workload/i);
  });
});

test("same-source analyzer refresh reissues only changed pending bindings and keeps valid accepted answers", async () => {
  await withTempRepo(async (root) => {
    const bundle = plan(await sourceFixture(root));
    const boundary = { root, sourceRoot: root, artifactsDir: join(root, ".audit-tools", "audit") };
    const initial = await deriveQuestionCycleUnlocked({ ...boundary, bundle });
    const published = { ...boundary, runId: initial.runId };
    const issue = (bindings: AuditQuestionBinding[]) => publishAuditQuestionWorkload({ ...published, bindings });
    const accept = (answer: ReviewSubmission) => submitAuditQuestionResult({ ...published,
      assignmentId: answer.assignment_id, source: JSON.stringify(answer) });
    const shared = initial.pending.find(item => item.question.requested_parts.length > 1)!;
    const manual = initial.pending.find(item => item !== shared &&
      item.assignment.suggested_sources.some(ref => ref.path === MANUAL))!;
    const scheduled = initial.pending.find(item => item !== shared && item !== manual)!;
    await issue(initial.pending);
    const existing = await accept(manualOnly(manual, "accepted-before-refresh"));
    expect(existing.kind).toBe("accepted");

    const source = await readFile(join(root, MANUAL), "utf8");
    const imported = runExternalAnalyzerImportExecutor(bundle, { tool: "fixture-static", results: [{
      id: "lead", category: "fixture", severity: "low", path: MANUAL, line_start: 1,
      summary: "Synthetic analyzer lead", provenance: {
        analyzer_id: "fixture-static", path: MANUAL, snippet_hash: hashAnalyzerSnippet(source, 1)!,
      },
    }] }).updated;
    const replanned = plan(imported);
    expect(replanned.review_plan?.snapshot_id).toBe(bundle.review_plan?.snapshot_id);
    const refreshed = await deriveQuestionCycleUnlocked({ ...boundary, bundle: replanned });
    expect(refreshed.answers).toEqual([existing.record]);
    expect(refreshed.pending).toHaveLength(2);
    expect(refreshed.pending.some(item => item.question.question_id === manual.question.question_id)).toBe(false);
    const reissued = refreshed.pending.find(item => item.question.question_id === shared.question.question_id)!;
    expect(reissued.question).toEqual(shared.question);
    expect(reissued.assignment.available_evidence_ids).toHaveLength(1);
    expect(refreshed.pending.find(item => item.question.question_id === scheduled.question.question_id)?.assignment.assignment_id)
      .toBe(scheduled.assignment.assignment_id);

    const second = await issue(refreshed.pending);
    expect(reissued.assignment.assignment_id).not.toBe(shared.assignment.assignment_id);
    const bytes = await readFile(second.workload_path, "utf8");
    const resumed = await deriveQuestionCycleUnlocked({ ...boundary, bundle: replanned });
    await issue(resumed.pending);
    expect(await readFile(second.workload_path, "utf8")).toBe(bytes);
    await expect(accept(manualOnly(shared, "late-before-refresh"))).rejects.toThrow(/not in the current issued workload/u);
    expect((await accept(manualOnly(reissued, "fresh-after-refresh"))).kind).toBe("accepted");
  });
});
