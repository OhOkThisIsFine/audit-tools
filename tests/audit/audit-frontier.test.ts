import { projectQuestionForReport } from "../../src/audit/reporting/questionReport.js";
import { test, expect } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hashContent } from "audit-tools/shared";
import { runDeterministicForNextStep } from "../../src/audit/cli/nextStepHelpers.js";
import { updateRunConsentUnlocked } from "../../src/shared/analyzerRunConsent.js";
import { queryReviewerGraph } from "../../src/audit/cli/reviewGraphCommand.js";
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
    const observed = projectQuestionForReport(shared.question, resumed.answers, resumed.adjudications, new Map(),
      resumed.dependenciesByQuestion.get(shared.question.question_id));
    expect(observed.row.parts.map(part => part.state)).toEqual(["clean", "unreviewed"]);

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

test("one shared checkpoint offers using evidence without accepting audit intent", async () => {
  await withTempRepo(async root => {
    const artifactsDir = join(root, ".audit-tools", "audit");
    const bundle = await sourceFixture(root);
    const manifest = '{"name":"fixture"}\n';
    await writeFile(join(root, "package.json"), manifest);
    bundle.repo_manifest!.files.push({ path: "package.json", language: "json", size_bytes: Buffer.byteLength(manifest), hash: hashContent(manifest) });
    bundle.file_disposition!.files.push({ path: "package.json", status: "doc_only" });
    delete bundle.intent_checkpoint;
    await writeCoreArtifacts(artifactsDir, {
      ...bundle, auto_fixes_applied: {}, syntax_resolution_status: {},
      external_analyzer_acquisition: { enabled: true, tool_statuses: [
        { tool: "gitleaks", status: "success", resolved: true, exit_code: 0 },
        { tool: "semgrep", status: "findings", resolved: true, exit_code: 0, reported_coverage: { scanned: [MANUAL], skipped: [STORE, SCHEDULED] } },
      ] }, external_analyzer_results: [{ tool: "semgrep", results: [
        { id: "historical-scheduled", path: SCHEDULED, category: "correctness", severity: "low", summary: "Retain an earlier lead until this file is rescanned" },
      ] }],
      analyzer_capability: { coverage: "not_applicable", analyzers: [] },
      design_assessment: { generated_at: "2026-01-01T00:00:00Z", findings: [], contract_reviewed: true, conceptual_reviewed: true },
      docs_digest: { generated_at: "2026-01-01T00:00:00Z", docs: [] },
      structure_decomposition: {
        generated_at: "2026-01-01T00:00:00Z", target: "structure", node_universe_size: 1,
        source_ids: [], consensus: [], contested: [], findings: [],
      },
    });
    const argv = ["--root", root, "--artifacts-dir", artifactsDir];
    const current = async () => JSON.parse(await readFile(join(artifactsDir, "steps/current-step.json"), "utf8"));
    await cmdNextStep(argv);
    const preparation = await current();
    expect(preparation.step_kind).toBe("analyzer_calibration");
    const prompt = await readFile(preparation.prompt_path, "utf8");
    const fingerprint = /"input_sha256": "([a-f0-9]{64})"/u.exec(prompt)?.[1];
    expect(fingerprint).toEqual(expect.any(String));
    const healthy = { tool: "gitleaks", action: "accept", reason: "Already verified", coverage: "Secret scan covered the fixture" };
    await writeFile(preparation.artifact_paths.analyzer_calibration, JSON.stringify({
      input_sha256: fingerprint,
      decisions: [healthy, { tool: "semgrep", action: "retry", reason: "Corrected fixture rules", coverage: "Store and scheduled files were skipped" }],
      unresolved: [],
    }));
    await updateRunConsentUnlocked(root, artifactsDir, { semgrep: "granted" });
    const executions: string[][] = [];
    const retry = await runDeterministicForNextStep({
      root, artifactsDir, selfCliPath: "audit-code", timeoutMs: 15000,
      externalAcquisition: { enabled: true, hostSelection: true, run: async argv => {
        executions.push([...argv]);
        return { argv, status: 0, stderr: "", duration_ms: 1,
          stdout: JSON.stringify({ results: [
            { check_id: "new-manual", path: MANUAL, start: { line: 1 }, extra: { message: "new fixture lead", severity: "WARNING" } },
          ], paths: { scanned: [MANUAL, STORE], skipped: [{ path: SCHEDULED }] } }) };
      } },
    });
    expect(retry.kind).toBe("analyzer_calibration");
    if (retry.kind !== "analyzer_calibration") throw new Error("Missing retry assessment");
    expect(executions).toHaveLength(2);
    expect(executions[0]).toEqual(["pipx", "--version"]);
    expect(executions[1]).toContain("semgrep");
    expect(retry.request.input_sha256).not.toBe(fingerprint);
    expect(retry.request.tools.find(tool => tool.tool === "semgrep")?.admittedSkipped).toEqual([SCHEDULED]);
    expect(retry.request.tools.find(tool => tool.tool === "gitleaks")).toMatchObject({ status: "success", exit_code: 0 });
    expect(retry.bundle.external_analyzer_results?.find(row => row.tool === "semgrep")?.results)
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: "historical-scheduled" }),
        expect.objectContaining({ rule: "new-manual" })]));
    const staleAfterRetry = computeStaleArtifacts(retry.bundle, { emit: false });
    expect(staleAfterRetry).toContain("graph_bundle.json");
    expect(staleAfterRetry).not.toContain("external_analyzer_acquisition.json");
    await writeFile(preparation.artifact_paths.analyzer_calibration, JSON.stringify({
      input_sha256: retry.request.input_sha256,
      decisions: [healthy, { tool: "semgrep", action: "limited", reason: "Retry fixed store coverage only", coverage: "Scheduled file remains skipped" }],
      unresolved: [SCHEDULED + " still omitted by Semgrep"],
    }));
    await cmdNextStep(argv);
    let first = await current();
    if (first.step_kind === "critical_flow_fallback") {
      // The tiny fixture may have no classified entrypoint after regeneration.
      await writeFile(first.artifact_paths.critical_flow_fallback_results, JSON.stringify({ flows: [] }));
      await cmdNextStep(argv);
      first = await current();
    }
    if (first.step_kind === "analyzer_install") {
      // Inline graph enrichment is optional, separate from the scoped retry.
      await writeFile(first.artifact_paths.analyzer_decisions, JSON.stringify({ typescript: "skip" }));
      await cmdNextStep(argv);
      first = await current();
    }
    expect(first.step_kind).toBe("confirm_intent");
    expect(first.stop_condition).toMatch(/stop with the prepared evidence/);
    const checkpointPrompt = await readFile(first.prompt_path, "utf8");
    expect(checkpointPrompt).toMatch(/In one message, ask whether to stop here.*continue with the proposed scope, lenses, and design-review depth/u);
    expect(checkpointPrompt).toContain("A reply choosing to continue with no changes confirms the proposal");
    expect(checkpointPrompt).toContain("Unresolved analyzer coverage:");
    expect(checkpointPrompt).toContain(SCHEDULED + " still omitted by Semgrep");
    expect(first.artifact_paths.graph_index).toEqual(expect.any(String));
    const graphIndex = first.artifact_paths.graph_index;
    const graph = await readFile(graphIndex, "utf8");
    expect(await queryReviewerGraph(graphIndex, hashContent(graph), { path: MANUAL })).toMatchObject({ path: MANUAL });
    expect(first.artifact_paths.host_workload).toBeUndefined();
    const finalReceipt = await readFile(first.artifact_paths.analyzer_calibration, "utf8");
    expect(JSON.parse(finalReceipt).unresolved).toEqual([SCHEDULED + " still omitted by Semgrep"]);
    const scanned = await readFile(first.artifact_paths.analyzer_acquisition, "utf8");
    expect(scanned).toContain(STORE);
    expect(JSON.parse(scanned).calibration_retries).toEqual([expect.objectContaining({
      input_sha256: fingerprint, tools: [expect.objectContaining({ tool: "semgrep", reason: "Corrected fixture rules" })],
    })]);
    await expect(readFile(join(artifactsDir, "intent_checkpoint.json"), "utf8")).rejects.toMatchObject({code:"ENOENT"});
    const snapshot = await readFile(join(artifactsDir, "run-snapshot.json"), "utf8");
    await cmdNextStep(argv);
    const audit = await current();
    expect(audit.step_kind).toBe("confirm_intent");
    for (const key of ["frozen_source", "repo_manifest", "native_graph", "graph_index", "analyzer_acquisition", "analyzer_results", "analyzer_capability"]) {
      expect(audit.artifact_paths[key]).toEqual(first.artifact_paths[key]);
    }
    expect(await readFile(join(artifactsDir, "run-snapshot.json"), "utf8")).toBe(snapshot);
    expect(await readFile(audit.artifact_paths.analyzer_acquisition, "utf8")).toBe(scanned);
    expect(await readFile(audit.artifact_paths.analyzer_calibration, "utf8")).toBe(finalReceipt);
    await writeFile(audit.artifact_paths.intent_checkpoint, JSON.stringify({
      schema_version: "intent-checkpoint/v1", confirmed_at: "2026-01-01T00:00:00Z", confirmed_by: "host",
      scope_summary: "Fixture source", intent_summary: "Audit the fixture", lens_selection: { include: ["behavior"] },
    }));
    const continued = await runDeterministicForNextStep({
      root, artifactsDir, selfCliPath: "audit-code", timeoutMs: 15000,
      externalAcquisition: { enabled: true, hostSelection: true, run: async argv => {
        executions.push([...argv]);
        throw new Error("Continuing with valid evidence must not invoke an analyzer");
      } },
    });
    expect(continued.bundle.intent_checkpoint?.intent_summary).toBe("Audit the fixture");
    expect(continued.kind).not.toBe("confirm_intent");
    expect(continued.kind).not.toBe("analyzer_calibration");
    expect(executions).toHaveLength(2);
    expect(await readFile(join(artifactsDir, "run-snapshot.json"), "utf8")).toBe(snapshot);
  });
});

test("resuming with confirmed intent still requires calibration of current analyzer evidence", async () => {
  await withTempRepo(async root => {
    const artifactsDir = join(root, ".audit-tools", "audit");
    const bundle = await sourceFixture(root);
    await writeCoreArtifacts(artifactsDir, {
      ...bundle, auto_fixes_applied: {}, syntax_resolution_status: {},
      external_analyzer_acquisition: { enabled: true, tool_statuses: [
        { tool: "gitleaks", status: "success", resolved: true, exit_code: 0 },
      ] },
      analyzer_capability: { coverage: "not_applicable", analyzers: [] },
      design_assessment: { generated_at: "2026-01-01T00:00:00Z", findings: [], contract_reviewed: true, conceptual_reviewed: true },
      docs_digest: { generated_at: "2026-01-01T00:00:00Z", docs: [] },
      structure_decomposition: {
        generated_at: "2026-01-01T00:00:00Z", target: "structure", node_universe_size: 1,
        source_ids: [], consensus: [], contested: [], findings: [],
      },
    });
    const step = await runDeterministicForNextStep({
      root, artifactsDir, selfCliPath: "audit-code", timeoutMs: 15000,
      externalAcquisition: { enabled: true, hostSelection: true, run: async () => {
        throw new Error("No analyzer should be spawned before the calibration decision");
      } },
    });
    expect(step.bundle.intent_checkpoint).toBeDefined();
    expect(step.kind).toBe("analyzer_calibration");
  });
});

test("changing analyzer findings invalidates a previously built graph but not analyzer acquisition", async () => {
  await withTempRepo(async root => {
    const bundle = await sourceFixture(root);
    bundle.external_analyzer_acquisition = { enabled: true, tool_statuses: [] };
    bundle.external_analyzer_results = [{ tool: "synthetic", results: [] }];
    bundle.artifact_metadata = computeArtifactMetadata(bundle);
    const refreshed: ArtifactBundle = {
      ...bundle,
      external_analyzer_results: [{ tool: "synthetic", results: [],
        graph_edges: [{ from: MANUAL, to: SCHEDULED }] }],
    };
    refreshed.artifact_metadata = computeArtifactMetadata(
      refreshed, bundle.artifact_metadata, ["external_analyzer_results.json"],
    );
    const changed = computeStaleArtifacts(refreshed, { emit: false });
    expect(changed).toContain("graph_bundle.json");
    expect(changed).not.toContain("external_analyzer_acquisition.json");
  });
});
