import { acceptQuestionReview, projectQuestionReview } from "../../src/audit/cli/dispatch/questionReviewAcceptance.js";
import { buildReviewQuestionPlan } from "../../src/audit/orchestrator/questionPlanning.js";
import { test, expect } from "vitest";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { deriveCurrentQuestionBindings, deriveQuestionCycleUnlocked } from "../../src/audit/cli/questionReviewCycle.js";
import { hashAnalyzerSnippet } from "../../src/shared/analyzers/provenance.js";
import { hashContent } from "audit-tools/shared";

import { buildQuestionPlanArtifacts } from "../../src/audit/orchestrator/questionPlanExecutor.js";
import { computeArtifactMetadata } from "../../src/audit/orchestrator/artifactMetadata.js";
import { computeStaleArtifacts } from "../../src/audit/orchestrator/staleness.js";
import { fullAuditScope } from "../../src/audit/orchestrator/scope.js";
import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";
import type {
  AuditResult,
  AuditTask,
  Finding,
} from "../../src/audit/types.js";
import type {
  AuditObligation,
  AuditState,
} from "../../src/audit/types/auditState.js";

const { advanceAudit } = await import("../../src/audit/orchestrator/advance.js");
const {
  runExternalAnalyzerImportExecutor,
} = await import("../../src/audit/orchestrator/ingestionExecutors.js");
const { resolveRuntimeValidationSpawnCommand } = await import("../../src/audit/orchestrator/runtimeCommand.js");
const { deriveAuditState } = await import("../../src/audit/orchestrator/state.js");
const { buildFlowCoverage } =
  await import("../../src/audit/orchestrator/flowCoverage.js");
const { buildFlowRequeueTasks } =
  await import("../../src/audit/orchestrator/flowRequeue.js");
const { buildRequeueTasks } = await import("../../src/audit/orchestrator/requeue.js");
const { buildSelectiveDeepeningTasks } =
  await import("../../src/audit/orchestrator/selectiveDeepening/index.js");
const { ingestAuditResults } =
  await import("../../src/audit/orchestrator/resultIngestion.js");

function findObligation(
  state: AuditState,
  id: string,
): AuditObligation | undefined {
  return state.obligations.find((item) => item.id === id);
}

test("advanceAudit preserves persisted complete state when no executor is selected", async () => {
  const completeState: AuditState = {
    status: "complete",
    last_executor: "synthesis_executor",
    last_obligation: "synthesis_current",
    blockers: [],
    obligations: [{ id: "synthesis_current", state: "satisfied" }],
  };

  const result = await advanceAudit({
    audit_state: completeState,
    audit_report: "# Audit Report\n",
  });

  expect(result.selected_executor).toBe(null);
  expect(result.progress_made).toBe(false);
  expect(result.audit_state.status).toBe("complete");
  expect(result.audit_state.last_executor).toBe("synthesis_executor");
  expect(result.audit_state.last_obligation).toBe("synthesis_current");
});

test("advanceAudit wraps executor failures with executor and obligation context", async () => {
  const missingRoot = join(
    tmpdir(),
    `auditor-lambda-missing-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );

  // repo_manifest is the first obligation, so intake_executor is selected and fails.
  await assert.rejects(
    () => advanceAudit(
      {},
      { root: missingRoot },
    ),
    (error: Error) => {
      expect(error.message).toMatch(/advanceAudit intake_executor failed while resolving repo_manifest/i);
      return true;
    },
  );
});

test("runtime validation runs package-manager shims through the Windows shell", () => {
  expect(resolveRuntimeValidationSpawnCommand(["npm", "test"], "win32", "cmd.exe")).toEqual({ command: "cmd.exe", args: ["/d", "/s", "/c", "npm test"] });
  expect(resolveRuntimeValidationSpawnCommand(
      ["npx", "vitest", "run", "--reporter=dot"],
      "win32",
      "cmd.exe",
    )).toEqual({
      command: "cmd.exe",
      args: ["/d", "/s", "/c", "npx vitest run --reporter=dot"],
    });
  expect(resolveRuntimeValidationSpawnCommand(["npm.cmd", "test"], "win32", "cmd.exe")).toEqual({ command: "cmd.exe", args: ["/d", "/s", "/c", "npm.cmd test"] });
  expect(resolveRuntimeValidationSpawnCommand(["python", "-m", "pytest"], "win32")).toEqual({ command: "python", args: ["-m", "pytest"] });
  expect(resolveRuntimeValidationSpawnCommand(["npm", "test"], "linux")).toEqual({ command: "npm", args: ["test"] });
});

test("deriveAuditState requires syntax-resolution marker instead of imported analyzer results", () => {
  const importedOnly = deriveAuditState({
    repo_manifest: {
      repository: { name: "fixture" },
      generated_at: "2026-04-22T00:00:00Z",
      files: [{ path: "src/app.ts", language: "ts", size_bytes: 12 }],
    },
    external_analyzer_results: [{
      tool: "semgrep",
      results: [],
    }],
  });
  expect(findObligation(importedOnly, "syntax_resolved")?.state).toBe("missing");

  const withMarker = deriveAuditState({
    repo_manifest: {
      repository: { name: "fixture" },
      generated_at: "2026-04-22T00:00:00Z",
      files: [{ path: "src/app.ts", language: "ts", size_bytes: 12 }],
    },
    external_analyzer_results: [{
      tool: "syntax_resolution_executor",
      results: [],
    }],
    syntax_resolution_status: {
      tool: "syntax_resolution_executor",
      completed_at: "2026-04-22T00:00:00Z",
    },
  });
  expect(findObligation(withMarker, "syntax_resolved")?.state).toBe("satisfied");
});

test("external analyzer import invalidates current plan inputs without erasing the existing plan", () => {
  const path = "src/api/auth.ts";
  const bundle = buildQuestionPlanArtifacts({
    repo_manifest: { repository: { name: "fixture" }, generated_at: "2026-04-22T00:00:00Z",
      files: [{ path, language: "typescript", size_bytes: 12, hash: hashContent("source body\n") }] },
    file_disposition: { files: [{ path, status: "included" }] },
    surface_manifest: { surfaces: [{ id: "auth", kind: "interface", entrypoint: path }] },
    external_analyzer_results: [],
    audit_report: "# stale\n",
  }, fullAuditScope()).updated;
  expect(bundle.review_plan?.questions.length).toBeGreaterThan(0);
  bundle.artifact_metadata = computeArtifactMetadata(bundle);
  expect(computeStaleArtifacts(bundle, { emit: false }).has("review_plan.json")).toBe(false);

  const run = runExternalAnalyzerImportExecutor(bundle, { tool: "semgrep", results: [] });
  expect(run.updated.external_analyzer_results).toEqual([{ tool: "semgrep", results: [] }]);
  expect(run.updated.review_plan).toBe(bundle.review_plan);
  expect(computeStaleArtifacts(run.updated, { emit: false }).has("review_plan.json")).toBe(true);
  expect(run.updated.audit_report).toBeUndefined();
});

test("partial analyzer recovery is additive and replay leaves native receipts and reports untouched", () => {
  const path = "src/workflow.ts";
  const original = { id: "A", category: "behavior", severity: "low", summary: "Original", path,
    provenance: { analyzer_id: "fixture", path, snippet_hash: "a", comparison_fingerprint: "native-a" } };
  const newItem = { ...original, id: "B", summary: "New", provenance: { ...original.provenance, snippet_hash: "b" } };
  const old = { tool: "fixture", generated_at: "original timestamp", results: [original] };
  const bundle = { external_analyzer_results: [old], audit_report: "# previous" };
  const marker = { tool: "fixture", resolved: true, status: "success" as const, exit_code: 0, comparison_fingerprint: "untrusted" };
  const replay = runExternalAnalyzerImportExecutor(bundle, { tool: "fixture", generated_at: "different timestamp", results: [original] });
  expect(replay.artifacts_written).toEqual([]);
  expect(replay.updated).toBe(bundle);

  const recovered = runExternalAnalyzerImportExecutor(bundle, { tool: "fixture", results: [newItem, newItem], tool_statuses: [marker] });
  expect(recovered.updated.external_analyzer_results?.[0]?.results).toEqual([
    original, { ...newItem, provenance: { analyzer_id: "fixture", path, snippet_hash: "b" } },
  ]);
  expect(recovered.updated.external_analyzer_results?.[0]?.tool_statuses).toBeUndefined();
  expect(recovered.updated.audit_report).toBeUndefined();
  const empty = runExternalAnalyzerImportExecutor(recovered.updated, { tool: "fixture", results: [] });
  expect(empty.updated).toBe(recovered.updated);
});

test("question binding withholds a stamped native receipt once its acquisition is stale", async () => {
  const root = await mkdtemp(join(tmpdir(), "audit-stale-receipt-"));
  const path = "src/workflow.ts";
  const body = "const text = 'review this';\n";
  try {
    await mkdir(join(root, "src"));
    await writeFile(join(root, path), body);
    const provenance = { analyzer_id: "fixture", path, snippet_hash: hashAnalyzerSnippet(body, 1)!,
      comparison_fingerprint: "measured" };
    const bundle = buildQuestionPlanArtifacts({
      repo_manifest: { repository: { name: "fixture" }, generated_at: "2026-11-27T00:00:00Z",
        files: [{ path, language: "typescript", size_bytes: body.length, hash: hashContent(body) }] },
      file_disposition: { files: [{ path, status: "included" }] },
      surface_manifest: { surfaces: [{ id: "workflow", kind: "interface", entrypoint: path }] },
      external_analyzer_results: [{ tool: "fixture", results: [{ id: "lead", category: "behavior",
        severity: "low", path, line_start: 1, summary: "Approximate candidate", provenance }] }],
      external_analyzer_acquisition: { enabled: true, tool_statuses: [{ tool: "fixture", resolved: true,
        status: "findings", exit_code: 0, comparison_fingerprint: "measured" }] },
    }, fullAuditScope()).updated;
    bundle.artifact_metadata = computeArtifactMetadata(bundle);
    const fresh = await deriveCurrentQuestionBindings(bundle, root);
    expect(fresh.evidence).toHaveLength(1);
    expect(fresh.evidence[0]?.analyzer_provenance).toEqual(provenance);
    const staleBundle: ArtifactBundle = { ...bundle, file_disposition: { files: [
      { path, status: "included" }, { path: "unrelated.txt", status: "excluded" },
    ] } };
    // A plan refresh does not certify the analyzer marker: the two
    // artifacts have independent revision stamps.
    staleBundle.artifact_metadata = computeArtifactMetadata(staleBundle, bundle.artifact_metadata, ["surface_manifest.json", "review_plan.json"]);
    const stale = computeStaleArtifacts(staleBundle, { emit: false });
    expect(stale.has("review_plan.json")).toBe(false);
    expect(stale.has("external_analyzer_acquisition.json")).toBe(true);
    const verifyAdvisoryOnly = async (target: ArtifactBundle, knownStale?: typeof stale) => {
      const review = await deriveCurrentQuestionBindings(target, root, undefined, [], knownStale);
      expect(review.evidence).toHaveLength(1);
      expect(review.evidence[0]?.evidence_id).toBe(fresh.evidence[0]?.evidence_id);
      expect(review.evidence[0]?.analyzer_provenance).toBeUndefined();
    };
    const readOnly = await deriveQuestionCycleUnlocked({ root, sourceRoot: root, artifactsDir: join(root, "audit"),
      bundle: staleBundle, readOnlyRunId: "fixture-run" });
    expect(readOnly.evidence).toHaveLength(1);
    expect(readOnly.evidence[0]?.analyzer_provenance).toBeUndefined();
    await verifyAdvisoryOnly(staleBundle); // shared fallback used by dispatch and standalone synthesis
    await verifyAdvisoryOnly(staleBundle, stale); // submission passes its existing staleness result
    await verifyAdvisoryOnly({ ...bundle, artifact_metadata: undefined });
    const marker = bundle.external_analyzer_acquisition!;
    await verifyAdvisoryOnly({ ...bundle, external_analyzer_acquisition: {
      ...marker, tool_statuses: marker.tool_statuses.map(status => ({ ...status, version: "unrecorded" })),
    } });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("deriveAuditState keeps explicit pending follow-up tasks actionable after coverage is complete", () => {
  const state = deriveAuditState({
    repo_manifest: {
      repository: { name: "fixture" },
      generated_at: "2026-04-22T00:00:00Z",
      files: [{ path: "src/api/auth.ts", language: "ts", size_bytes: 12 }],
    },
    coverage_matrix: {
      files: [
        {
          path: "src/api/auth.ts",
          unit_ids: ["src-api-auth"],
          classification_status: "classified",
          audit_status: "complete",
          required_lenses: ["security"],
          completed_lenses: ["security"],
        },
      ],
    },
    audit_tasks: [
      {
        task_id: "src-api-auth:security",
        unit_id: "src-api-auth",
        pass_id: "pass:security",
        lens: "security",
        file_paths: ["src/api/auth.ts"],
        rationale: "Audit auth",
        priority: "high",
        status: "complete",
      },
      {
        task_id: "deepening:finding:abc123",
        unit_id: "src-api-auth",
        pass_id: "deepening:pass:security",
        lens: "security",
        file_paths: ["src/api/auth.ts"],
        rationale: "Follow up",
        priority: "high",
        tags: ["selective_deepening"],
        status: "pending",
      },
    ],
    audit_results: [
      {
        task_id: "src-api-auth:security",
        unit_id: "src-api-auth",
        pass_id: "pass:security",
        lens: "security",
        file_coverage: [{ path: "src/api/auth.ts", total_lines: 12 }],
        findings: [],
        reviewed_clean: true,
      },
    ],
  });

  expect(findObligation(state, "audit_tasks_completed")?.state).toBe("missing");
});

test("deepening results do not add non-required lenses to coverage completion", () => {
  const updated = ingestAuditResults(
    {
      files: [
        {
          path: "src/types/sessionConfig.ts",
          unit_ids: ["src-types"],
          classification_status: "classified",
          audit_status: "pending",
          required_lenses: ["correctness"],
          completed_lenses: [],
        },
      ],
    },
    [
      {
        task_id: "deepening:runtime:abc123",
        unit_id: "src-types",
        pass_id: "deepening:runtime:runtime-unit-src-types",
        lens: "security",
        file_coverage: [
          { path: "src/types/sessionConfig.ts", total_lines: 56 },
        ],
        findings: [],
        reviewed_clean: true,
        requires_followup: false,
      },
    ],
  );

  expect(updated.files[0].completed_lenses).toEqual([]);
  expect(updated.files[0].audit_status).toBe("pending");
});

test("selective deepening creates bounded follow-up tasks for risky or ambiguous findings", () => {
  const sourceTask: AuditTask = {
    task_id: "src-api-auth:security",
    unit_id: "src-api-auth",
    pass_id: "pass:security",
    lens: "security",
    file_paths: ["src/api/auth.ts"],
    file_line_counts: { "src/api/auth.ts": 40 },
    rationale: "Audit auth",
    priority: "high",
    status: "complete",
  };
  const result: AuditResult = {
    task_id: sourceTask.task_id,
    unit_id: sourceTask.unit_id,
    pass_id: sourceTask.pass_id,
    lens: sourceTask.lens,
    file_coverage: [{ path: "src/api/auth.ts", total_lines: 40 }],
    findings: [
      {
        id: "SEC-001",
        title: "Token bypass",
        category: "auth",
        severity: "high",
        confidence: "low",
        lens: "security",
        summary: "Potential token bypass needs verification.",
        affected_files: [{ path: "src/api/auth.ts", line_start: 12 }],
        evidence: ["src/api/auth.ts:12 - accepts empty token"],
      },
    ],
  };

  const tasks = buildSelectiveDeepeningTasks({
    existingTasks: [sourceTask],
    results: [result],
  });

  expect(tasks.length).toBe(1);
  expect(tasks[0].task_id).toMatch(/^deepening:finding:/);
  expect(tasks[0].priority).toBe("high");
  expect(tasks[0].file_paths).toEqual(["src/api/auth.ts"]);
  expect(tasks[0].file_line_counts!["src/api/auth.ts"]).toBe(40);
  expect(tasks[0].tags!.includes("selective_deepening")).toBeTruthy();
  expect(tasks[0].tags!.includes("trigger:high_severity")).toBeTruthy();
  expect(tasks[0].tags!.includes("trigger:low_confidence")).toBeTruthy();

  expect(buildSelectiveDeepeningTasks({
      existingTasks: [...tasks, sourceTask],
      results: [result],
    }).length).toBe(0);
});

test("selective deepening adds a reconciliation task for conflicting findings", () => {
  const baseTask: Omit<AuditTask, "task_id"> = {
    unit_id: "src-api-auth",
    pass_id: "pass:security",
    lens: "security",
    file_paths: ["src/api/auth.ts"],
    file_line_counts: { "src/api/auth.ts": 40 },
    rationale: "Audit auth",
    priority: "medium",
    status: "complete",
  };
  const finding = (
    id: string,
    severity: Finding["severity"],
    confidence: Finding["confidence"],
  ): Finding => ({
    id,
    title: "Token validation",
    category: "auth",
    severity,
    confidence,
    lens: "security",
    summary: "Token validation conclusion.",
    affected_files: [{ path: "src/api/auth.ts", line_start: 12 }],
    evidence: ["src/api/auth.ts:12 - token handling"],
  });
  const taskA: AuditTask = { ...baseTask, task_id: "src-api-auth:security:a" };
  const taskB: AuditTask = { ...baseTask, task_id: "src-api-auth:security:b" };
  const results: AuditResult[] = [
    {
      task_id: taskA.task_id,
      unit_id: taskA.unit_id,
      pass_id: taskA.pass_id,
      lens: taskA.lens,
      file_coverage: [{ path: "src/api/auth.ts", total_lines: 40 }],
      findings: [finding("SEC-001", "medium", "high")],
    },
    {
      task_id: taskB.task_id,
      unit_id: taskB.unit_id,
      pass_id: taskB.pass_id,
      lens: taskB.lens,
      file_coverage: [{ path: "src/api/auth.ts", total_lines: 40 }],
      findings: [finding("SEC-002", "info", "low")],
    },
  ];

  const tasks = buildSelectiveDeepeningTasks({
    existingTasks: [taskA, taskB],
    results,
  });

  expect(tasks.length).toBe(2);
  const conflict = tasks.find((task) =>
    task.tags!.includes("trigger:conflicting_output"),
  );
  expect(conflict).toBeTruthy();
  expect(conflict!.task_id).toMatch(/^deepening:conflict:/);
  expect(conflict!.file_paths).toEqual(["src/api/auth.ts"]);
});

test("selective deepening samples high-risk no-finding results", () => {
  const sourceTask: AuditTask = {
    task_id: "src-api-auth:security",
    unit_id: "src-api-auth",
    pass_id: "pass:security",
    lens: "security",
    file_paths: ["src/api/auth.ts"],
    file_line_counts: { "src/api/auth.ts": 40 },
    rationale: "Audit auth",
    priority: "high",
    status: "complete",
  };
  const result: AuditResult = {
    task_id: sourceTask.task_id,
    unit_id: sourceTask.unit_id,
    pass_id: sourceTask.pass_id,
    lens: sourceTask.lens,
    file_coverage: [{ path: "src/api/auth.ts", total_lines: 40 }],
    findings: [],
    reviewed_clean: true,
  };

  const tasks = buildSelectiveDeepeningTasks({
    existingTasks: [sourceTask],
    results: [result],
  });

  expect(tasks.length).toBe(1);
  expect(tasks[0].task_id).toMatch(/^deepening:clean:/);
  expect(tasks[0].priority).toBe("high");
  expect(tasks[0].file_paths).toEqual(["src/api/auth.ts"]);
  expect(tasks[0].tags!.includes("trigger:high_risk_no_finding")).toBeTruthy();
});

test("selective deepening creates a lens steward for risky completed lens output", () => {
  const securityTasks: AuditTask[] = [
    {
      task_id: "src-api-auth:security",
      unit_id: "src-api-auth",
      pass_id: "pass:security",
      lens: "security",
      file_paths: ["src/api/auth.ts"],
      file_line_counts: { "src/api/auth.ts": 40 },
      rationale: "Audit auth",
      priority: "high",
      tags: ["external_analyzer_signal"],
      status: "complete",
    },
    {
      task_id: "src-lib-session:security",
      unit_id: "src-lib-session",
      pass_id: "pass:security",
      lens: "security",
      file_paths: ["src/lib/session.ts"],
      file_line_counts: { "src/lib/session.ts": 30 },
      rationale: "Audit session",
      priority: "medium",
      status: "complete",
    },
  ];
  const results: AuditResult[] = securityTasks.map((task) => ({
    task_id: task.task_id,
    unit_id: task.unit_id,
    pass_id: task.pass_id,
    lens: task.lens,
    file_coverage: task.file_paths.map((path) => ({
      path,
      total_lines: task.file_line_counts![path],
    })),
    findings: [],
    reviewed_clean: true,
  }));

  const tasks = buildSelectiveDeepeningTasks({
    existingTasks: securityTasks,
    results,
    externalAnalyzerResults: [{
      tool: "semgrep",
      generated_at: "2026-04-30T00:00:00Z",
      results: [
        {
          id: "semgrep-1",
          path: "src/api/auth.ts",
          // `line_start` is the contract's field name (the pre-conversion
          // fixture said `line`, which no consumer reads — only `path` is).
          line_start: 12,
          category: "security",
          severity: "high",
          summary: "Token handling signal.",
        },
      ],
    }],
  });

  const steward = tasks.find((task) =>
    task.tags!.includes("lens_verification"),
  );
  expect(steward).toBeTruthy();
  expect(steward!.task_id).toMatch(/^deepening:steward:/);
  expect(steward!.priority).toBe("high");
  expect(steward!.lens).toBe("security");
  expect(steward!.tags!.includes("trigger:external_analyzer_signal")).toBeTruthy();
  expect(steward!.tags!.includes("trigger:many_no_finding_results")).toBeTruthy();
  expect(steward!.rationale.includes("Do not write direct findings")).toBeTruthy();
  expect(steward!.file_paths.includes("src/api/auth.ts")).toBeTruthy();
});

test("lens steward verification suggestions become bounded follow-up tasks", () => {
  const stewardTask: AuditTask = {
    task_id: "deepening:steward:abc123",
    unit_id: "lens-steward:security",
    pass_id: "lens-steward:security",
    lens: "security",
    file_paths: ["src/api/auth.ts", "src/lib/session.ts"],
    file_line_counts: {
      "src/api/auth.ts": 40,
      "src/lib/session.ts": 30,
    },
    rationale: "Lens steward verification.",
    priority: "high",
    tags: ["selective_deepening", "lens_verification"],
    status: "complete",
  };
  const verificationResult: AuditResult = {
    task_id: stewardTask.task_id,
    unit_id: stewardTask.unit_id,
    pass_id: stewardTask.pass_id,
    lens: stewardTask.lens,
    file_coverage: [
      { path: "src/api/auth.ts", total_lines: 40 },
      { path: "src/lib/session.ts", total_lines: 30 },
    ],
    findings: [],
    reviewed_clean: true,
    verification: {
      verified: false,
      needs_followup: true,
      concerns: ["External signal was not resolved convincingly."],
      followup_tasks: [
        {
          task_id: "suggested-auth-session",
          unit_id: "src-api-auth",
          pass_id: "deepening:security",
          lens: "security",
          file_paths: ["src/api/auth.ts"],
          rationale: "Trace token validation into session refresh.",
          priority: "high",
        },
      ],
    },
  };

  const tasks = buildSelectiveDeepeningTasks({
    existingTasks: [stewardTask],
    results: [verificationResult],
  });

  expect(tasks.length).toBe(1);
  expect(tasks[0].task_id).toMatch(/^deepening:steward-followup:/);
  expect(tasks[0].priority).toBe("high");
  expect(tasks[0].file_paths).toEqual(["src/api/auth.ts"]);
  expect(tasks[0].file_line_counts!["src/api/auth.ts"]).toBe(40);
  expect(tasks[0].tags!.includes("lens_verification_followup")).toBeTruthy();
  expect(tasks[0].tags!.includes("trigger:lens_verification")).toBeTruthy();
});

test("selective deepening reconciles runtime validation disagreement", () => {
  const sourceTask: AuditTask = {
    task_id: "src-api-auth:security",
    unit_id: "src-api-auth",
    pass_id: "pass:security",
    lens: "security",
    file_paths: ["src/api/auth.ts"],
    file_line_counts: { "src/api/auth.ts": 40 },
    rationale: "Audit auth",
    priority: "high",
    status: "complete",
  };
  const result: AuditResult = {
    task_id: sourceTask.task_id,
    unit_id: sourceTask.unit_id,
    pass_id: sourceTask.pass_id,
    lens: sourceTask.lens,
    file_coverage: [{ path: "src/api/auth.ts", total_lines: 40 }],
    findings: [],
    reviewed_clean: true,
  };

  const tasks = buildSelectiveDeepeningTasks({
    existingTasks: [sourceTask],
    results: [result],
    runtimeValidationTasks: {
      tasks: [
        {
          id: "runtime:unit:src-api-auth",
          kind: "unit-risk-check",
          target_paths: ["src/api/auth.ts"],
          reason: "Auth unit is high risk.",
          priority: "high",
          command: ["npm", "test"],
        },
      ],
    },
    runtimeValidationReport: {
      results: [
        {
          task_id: "runtime:unit:src-api-auth",
          status: "not_confirmed",
          summary: "npm test failed",
        },
      ],
    },
  });

  const runtimeTask = tasks.find((task) =>
    task.tags!.includes("trigger:runtime_validation_disagreement"),
  );
  expect(runtimeTask).toBeTruthy();
  expect(runtimeTask!.task_id).toMatch(/^deepening:runtime:/);
  expect(runtimeTask!.lens).toBe("security");
  expect(runtimeTask!.priority).toBe("high");
  expect(runtimeTask!.file_paths).toEqual(["src/api/auth.ts"]);
});

test("a lens steward is granted its whole surface through buildSelectiveDeepeningTasks, with metrics and the selective policy", () => {
  // 13 security tasks, each covering a distinct file. This count is the OLD
  // cap plus one: the file list used to be sorted by signal score and sliced to
  // 12, and this test used to assert that slice. A file COUNT measures no cost
  // the tool cares about (13 ten-line files against one 100,000-line file), so
  // the caps are gone and the steward now receives the whole surface and
  // chooses what to open — see docs/reviews/lens-steward-redesign-2026-09-17.md.
  const filePaths = Array.from({ length: 13 }, (_, i) => `src/module-${i}/index.ts`);

  const sourceTasks: AuditTask[] = filePaths.map((filePath, i) => ({
    task_id: `mod-${i}:security`,
    unit_id: `mod-${i}`,
    pass_id: `pass:security`,
    lens: "security",
    file_paths: [filePath],
    file_line_counts: { [filePath]: 40 },
    rationale: `Audit module ${i}`,
    // Tag the first task with external_analyzer_signal so the steward trigger fires
    tags: i === 0 ? ["external_analyzer_signal"] : [],
    priority: "medium",
    status: "complete",
  }));

  const results: AuditResult[] = sourceTasks.map((task) => ({
    task_id: task.task_id,
    unit_id: task.unit_id,
    pass_id: task.pass_id,
    lens: task.lens,
    file_coverage: task.file_paths.map((path) => ({ path, total_lines: 40 })),
    findings: [],
    reviewed_clean: true,
    // Do NOT set requires_followup: false — that would mark all as closed-clean
  }));

  // Capture stderr so the ABSENCE of a truncation trace is asserted, not assumed.
  const stderrLines: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  const captureWrite = (...args: Parameters<typeof originalWrite>): boolean => {
    const chunk = args[0];
    stderrLines.push(typeof chunk === "string" ? chunk : chunk.toString());
    return originalWrite(...args);
  };
  process.stderr.write = captureWrite as typeof process.stderr.write;

  let tasks: AuditTask[];
  try {
    tasks = buildSelectiveDeepeningTasks({
      existingTasks: sourceTasks,
      results,
    });
  } finally {
    process.stderr.write = originalWrite;
  }

  const steward = tasks.find((task) => task.tags!.includes("lens_verification"));
  expect(steward, "expected a lens steward task to be created").toBeTruthy();
  expect(
    steward!.file_paths,
    "the steward holds every file its lens was applied to, path-sorted",
  ).toEqual([...filePaths].sort());
  expect(
    steward!.coverage_policy,
    "a steward chooses what to open, so its coverage is selective",
  ).toBe("selective");
  expect(
    steward!.file_line_counts,
    "every surface file states its line count, so the steward can size its own work",
  ).toEqual(Object.fromEntries(filePaths.map((path) => [path, 40])));

  // The metrics are what the steward chooses BY: one entry per surface file,
  // each carrying the signals behind its score. They replace the slice — the
  // score orders the list instead of truncating it.
  const metrics = steward!.file_metrics ?? [];
  expect(metrics.map((metric) => metric.path).sort()).toEqual([...filePaths].sort());
  expect(metrics.every((metric) => metric.total_lines === 40)).toBeTruthy();
  expect(
    metrics.find((metric) => metric.path === filePaths[0])?.signals,
    "the externally flagged file states the signal that flagged it",
  ).toContain("external_analyzer_signal");
  expect(
    metrics.every((metric, index) =>
      index === 0 ? true : metrics[index - 1].score >= metric.score,
    ),
    "metrics are ordered strongest signal first",
  ).toBeTruthy();

  // No cap means no truncation trace. The two stderr events that used to fire
  // here (`truncated_verification_file_list`, `truncated_result_summary_list`)
  // no longer exist, and their absence is the assertion.
  const truncationLog = stderrLines
    .map((line) => {
      try {
        return JSON.parse(line.trim()) as { event?: string };
      } catch {
        return null;
      }
    })
    .find(
      (obj) =>
        obj?.event === "truncated_verification_file_list" ||
        obj?.event === "truncated_result_summary_list",
    );
  expect(
    truncationLog,
    `expected no truncation log line, got: ${JSON.stringify(stderrLines)}`,
  ).toBeUndefined();
});

test("buildFlowCoverage tolerates malformed flow paths and concerns", () => {
  const coverage = buildFlowCoverage(
    {
      flows: [
        {
          id: "auth-flow",
          name: "Auth Flow",
          // @ts-expect-error — deliberate contract-violation probe: a non-TS
          // producer emitting `null` for `paths` must degrade to [] at runtime
          // rather than throw.
          paths: null,
          entrypoints: ["src/api/auth.ts"],
          // @ts-expect-error — same deliberate probe for `concerns`: `null` must
          // degrade to an empty required-lens set rather than throw.
          concerns: null,
        },
      ],
    },
    {
      files: [
        {
          path: "src/api/auth.ts",
          unit_ids: ["src-api-auth"],
          classification_status: "classified",
          audit_status: "pending",
          required_lenses: ["security"],
          completed_lenses: [],
        },
      ],
    },
  );

  expect(coverage.flows[0].paths).toEqual([]);
  expect(coverage.flows[0].required_lenses).toEqual([]);
  // null concerns → no required lenses → vacuously complete (required.every(...)
  // over an empty set is true), matching the "no concerns" vacuous-truth case.
  expect(coverage.flows[0].status).toBe("complete");
});

test("buildFlowRequeueTasks skips unsupported flow lenses instead of throwing", () => {
  const tasks = buildFlowRequeueTasks(
    {
      flows: [
        {
          id: "auth-flow",
          name: "Auth Flow",
          paths: ["src/api/auth.ts"],
          entrypoints: ["src/api/auth.ts"],
          concerns: ["security"],
        },
      ],
    },
    {
      flows: [
        {
          flow_id: "auth-flow",
          paths: ["src/api/auth.ts"],
          // One canonical lens (still missing) and one bogus lens; only the
          // canonical one should yield a requeue task — the bogus one is
          // filtered out rather than aborting the whole requeue.
          required_lenses: ["mystery", "security"],
          completed_lenses: [],
          status: "pending",
        },
      ],
    },
    {
      files: [
        {
          path: "src/api/auth.ts",
          unit_ids: ["src-api-auth"],
          classification_status: "classified",
          audit_status: "pending",
          required_lenses: ["security"],
          completed_lenses: [],
        },
      ],
    },
  );
  expect(tasks.length).toBe(1);
  expect(tasks[0].lens).toBe("security");
  expect(tasks.every((task) => task.lens !== "mystery")).toBeTruthy();
});

test("buildFlowRequeueTasks ignores malformed analyzer entries but still prioritizes real signals", () => {
  const tasks = buildFlowRequeueTasks(
    {
      flows: [
        {
          id: "auth-flow",
          name: "Auth Flow",
          paths: ["src/api/auth.ts"],
          entrypoints: ["src/api/auth.ts"],
          concerns: ["security"],
        },
      ],
    },
    {
      flows: [
        {
          flow_id: "auth-flow",
          paths: ["src/api/auth.ts"],
          required_lenses: ["security"],
          completed_lenses: [],
          status: "pending",
        },
      ],
    },
    {
      files: [
        {
          path: "src/api/auth.ts",
          unit_ids: ["src-api-auth"],
          classification_status: "classified",
          audit_status: "pending",
          required_lenses: ["security"],
          completed_lenses: [],
        },
      ],
    },
    [
      {
        tool: "semgrep",
        // @ts-expect-error — deliberate contract-violation probe: a non-TS
        // analyzer adapter emitting a null entry, a wrong-typed `path`, and a
        // field-incomplete entry must all be skipped by the runtime guards while
        // the one real path still raises priority.
        results: [null, { path: 42 }, { path: "src/api/auth.ts" }],
      },
    ],
  );

  expect(tasks.length).toBe(1);
  expect(tasks[0].priority).toBe("high");
  expect(tasks[0].tags!.includes("external_analyzer_signal")).toBeTruthy();
});

test("buildFlowCoverage: flow with no concerns gets status complete (vacuous truth)", () => {
  const coverage = buildFlowCoverage(
    {
      flows: [
        {
          id: "empty-concerns-flow",
          name: "Empty Concerns Flow",
          paths: ["src/api/auth.ts"],
          entrypoints: [],
          concerns: [],
        },
      ],
    },
    {
      files: [
        {
          path: "src/api/auth.ts",
          unit_ids: ["src-api-auth"],
          classification_status: "classified",
          audit_status: "pending",
          required_lenses: [],
          completed_lenses: [],
        },
      ],
    },
  );

  expect(coverage.flows[0].status).toBe("complete");
  expect(coverage.flows[0].required_lenses).toEqual([]);
});

test("buildFlowCoverage: flow with only unknown concerns gets status complete (required is empty after filter)", () => {
  const coverage = buildFlowCoverage(
    {
      flows: [
        {
          id: "unknown-lens-flow",
          name: "Unknown Lens Flow",
          paths: ["src/api/auth.ts"],
          entrypoints: [],
          concerns: ["unknown_lens", "not_a_real_concern"],
        },
      ],
    },
    {
      files: [
        {
          path: "src/api/auth.ts",
          unit_ids: ["src-api-auth"],
          classification_status: "classified",
          audit_status: "pending",
          required_lenses: [],
          completed_lenses: [],
        },
      ],
    },
  );

  expect(coverage.flows[0].status).toBe("complete");
  expect(coverage.flows[0].required_lenses).toEqual([]);
});

test("buildFlowCoverage: flow with one required lens that is covered returns complete", () => {
  const coverage = buildFlowCoverage(
    {
      flows: [
        {
          id: "single-covered-flow",
          name: "Single Covered Flow",
          paths: ["src/api/auth.ts"],
          entrypoints: [],
          concerns: ["security"],
        },
      ],
    },
    {
      files: [
        {
          path: "src/api/auth.ts",
          unit_ids: ["src-api-auth"],
          classification_status: "classified",
          audit_status: "complete",
          required_lenses: ["security"],
          completed_lenses: ["security"],
        },
      ],
    },
  );

  expect(coverage.flows[0].status).toBe("complete");
});

test("buildFlowCoverage: flow with required lenses where some but not all are covered returns partial", () => {
  const coverage = buildFlowCoverage(
    {
      flows: [
        {
          id: "partial-flow",
          name: "Partial Flow",
          paths: ["src/api/auth.ts"],
          entrypoints: [],
          concerns: ["security", "reliability"],
        },
      ],
    },
    {
      files: [
        {
          path: "src/api/auth.ts",
          unit_ids: ["src-api-auth"],
          classification_status: "classified",
          audit_status: "partial",
          required_lenses: ["security", "reliability"],
          completed_lenses: ["security"],
        },
      ],
    },
  );

  expect(coverage.flows[0].status).toBe("partial");
});

test("buildFlowCoverage: flow with required lenses where none are covered returns pending", () => {
  const coverage = buildFlowCoverage(
    {
      flows: [
        {
          id: "pending-flow",
          name: "Pending Flow",
          paths: ["src/api/auth.ts"],
          entrypoints: [],
          concerns: ["security"],
        },
      ],
    },
    {
      files: [
        {
          path: "src/api/auth.ts",
          unit_ids: ["src-api-auth"],
          classification_status: "classified",
          audit_status: "pending",
          required_lenses: ["security"],
          completed_lenses: [],
        },
      ],
    },
  );

  expect(coverage.flows[0].status).toBe("pending");
});

test("buildRequeueTasks ignores malformed analyzer entries but still prioritizes real signals", () => {
  const tasks = buildRequeueTasks(
    {
      files: [
        {
          path: "src/api/auth.ts",
          unit_ids: ["src-api-auth"],
          classification_status: "classified",
          audit_status: "partial",
          required_lenses: ["security"],
          completed_lenses: [],
        },
      ],
    },
    [
      {
        tool: "semgrep",
        // @ts-expect-error — deliberate contract-violation probe: an undefined
        // entry, a wrong-typed `path`, and a field-incomplete entry must all be
        // skipped by the runtime guards while the one real path still raises
        // priority.
        results: [undefined, { path: 99 }, { path: "src/api/auth.ts" }],
      },
    ],
  );

  expect(tasks.length).toBe(1);
  expect(tasks[0].priority).toBe("high");
  expect(tasks[0].tags!.includes("external_analyzer_signal")).toBeTruthy();
});

test("lens steward trigger large_lens_surface when 3 or more source results", () => {
  // 3 security tasks/results, each covering 1 file with <700 lines
  // sources.length >= 3 triggers large_lens_surface
  const tasks: AuditTask[] = [
    {
      task_id: "src-api-auth:security",
      unit_id: "src-api-auth",
      pass_id: "pass:security",
      lens: "security",
      file_paths: ["src/api/auth.ts"],
      file_line_counts: { "src/api/auth.ts": 40 },
      rationale: "Audit auth",
      priority: "high",
      status: "complete",
    },
    {
      task_id: "src-lib-session:security",
      unit_id: "src-lib-session",
      pass_id: "pass:security",
      lens: "security",
      file_paths: ["src/lib/session.ts"],
      file_line_counts: { "src/lib/session.ts": 30 },
      rationale: "Audit session",
      priority: "medium",
      status: "complete",
    },
    {
      task_id: "src-lib-token:security",
      unit_id: "src-lib-token",
      pass_id: "pass:security",
      lens: "security",
      file_paths: ["src/lib/token.ts"],
      file_line_counts: { "src/lib/token.ts": 25 },
      rationale: "Audit token",
      priority: "medium",
      status: "complete",
    },
  ];
  const results: AuditResult[] = tasks.map((task) => ({
    task_id: task.task_id,
    unit_id: task.unit_id,
    pass_id: task.pass_id,
    lens: task.lens,
    file_coverage: task.file_paths.map((path) => ({
      path,
      total_lines: task.file_line_counts![path],
    })),
    findings: [
      {
        id: `${task.task_id}-f1`,
        title: "Issue",
        category: "auth",
        severity: "low",
        confidence: "high",
        lens: "security",
        summary: "Minor issue.",
        affected_files: [{ path: task.file_paths[0] }],
        evidence: [],
      },
    ],
  }));

  const deepeningTasks = buildSelectiveDeepeningTasks({
    existingTasks: tasks,
    results,
  });

  const steward = deepeningTasks.find((task) =>
    task.tags!.includes("lens_verification"),
  );
  expect(steward, "should produce a lens steward task").toBeTruthy();
  expect(steward!.tags!.includes("trigger:large_lens_surface")).toBeTruthy();
  expect(!steward!.tags!.includes("trigger:many_no_finding_results")).toBeTruthy();
});

test("lens steward trigger large_lens_surface when 4 or more unique files across sources", () => {
  // 2 tasks each covering 2 distinct files = 4 unique files total
  // filePaths.length >= 4 triggers large_lens_surface
  const tasks: AuditTask[] = [
    {
      task_id: "src-api:security",
      unit_id: "src-api",
      pass_id: "pass:security",
      lens: "security",
      file_paths: ["src/api/auth.ts", "src/api/token.ts"],
      file_line_counts: { "src/api/auth.ts": 40, "src/api/token.ts": 30 },
      rationale: "Audit api",
      priority: "high",
      status: "complete",
    },
    {
      task_id: "src-lib:security",
      unit_id: "src-lib",
      pass_id: "pass:security",
      lens: "security",
      file_paths: ["src/lib/session.ts", "src/lib/crypto.ts"],
      file_line_counts: { "src/lib/session.ts": 25, "src/lib/crypto.ts": 20 },
      rationale: "Audit lib",
      priority: "medium",
      status: "complete",
    },
  ];
  const results: AuditResult[] = tasks.map((task) => ({
    task_id: task.task_id,
    unit_id: task.unit_id,
    pass_id: task.pass_id,
    lens: task.lens,
    file_coverage: task.file_paths.map((path) => ({
      path,
      total_lines: task.file_line_counts![path],
    })),
    findings: [
      {
        id: `${task.task_id}-f1`,
        title: "Issue",
        category: "auth",
        severity: "low",
        confidence: "high",
        lens: "security",
        summary: "Minor issue.",
        affected_files: [{ path: task.file_paths[0] }],
        evidence: [],
      },
    ],
  }));

  const deepeningTasks = buildSelectiveDeepeningTasks({
    existingTasks: tasks,
    results,
  });

  const steward = deepeningTasks.find((task) =>
    task.tags!.includes("lens_verification"),
  );
  expect(steward, "should produce a lens steward task").toBeTruthy();
  expect(steward!.tags!.includes("trigger:large_lens_surface")).toBeTruthy();
});

test("lens steward trigger large_file_reviewed when a source task has large_file tag", () => {
  // 2 security tasks where one task has tags: ['large_file']
  const tasks: AuditTask[] = [
    {
      task_id: "src-api-auth:security",
      unit_id: "src-api-auth",
      pass_id: "pass:security",
      lens: "security",
      file_paths: ["src/api/auth.ts"],
      file_line_counts: { "src/api/auth.ts": 40 },
      rationale: "Audit auth",
      priority: "high",
      tags: ["large_file"],
      status: "complete",
    },
    {
      task_id: "src-lib-session:security",
      unit_id: "src-lib-session",
      pass_id: "pass:security",
      lens: "security",
      file_paths: ["src/lib/session.ts"],
      file_line_counts: { "src/lib/session.ts": 30 },
      rationale: "Audit session",
      priority: "medium",
      status: "complete",
    },
  ];
  const results: AuditResult[] = tasks.map((task) => ({
    task_id: task.task_id,
    unit_id: task.unit_id,
    pass_id: task.pass_id,
    lens: task.lens,
    file_coverage: task.file_paths.map((path) => ({
      path,
      total_lines: task.file_line_counts![path],
    })),
    findings: [
      {
        id: `${task.task_id}-f1`,
        title: "Issue",
        category: "auth",
        severity: "low",
        confidence: "high",
        lens: "security",
        summary: "Minor issue.",
        affected_files: [{ path: task.file_paths[0] }],
        evidence: [],
      },
    ],
  }));

  const deepeningTasks = buildSelectiveDeepeningTasks({
    existingTasks: tasks,
    results,
  });

  const steward = deepeningTasks.find((task) =>
    task.tags!.includes("lens_verification"),
  );
  expect(steward, "should produce a lens steward task").toBeTruthy();
  expect(steward!.tags!.includes("trigger:large_file_reviewed")).toBeTruthy();
});

test("lens steward trigger unresolved_external_signal when external path has no matching finding", () => {
  // 2 security results covering src/api/auth.ts; externalAnalyzerResults lists src/api/auth.ts;
  // but result findings affected_files use a different path — so src/api/auth.ts remains unresolved.
  const tasks: AuditTask[] = [
    {
      task_id: "src-api-auth:security",
      unit_id: "src-api-auth",
      pass_id: "pass:security",
      lens: "security",
      file_paths: ["src/api/auth.ts"],
      file_line_counts: { "src/api/auth.ts": 40 },
      rationale: "Audit auth",
      priority: "high",
      status: "complete",
    },
    {
      task_id: "src-lib-session:security",
      unit_id: "src-lib-session",
      pass_id: "pass:security",
      lens: "security",
      file_paths: ["src/lib/session.ts"],
      file_line_counts: { "src/lib/session.ts": 30 },
      rationale: "Audit session",
      priority: "medium",
      status: "complete",
    },
  ];
  const results: AuditResult[] = tasks.map((task) => ({
    task_id: task.task_id,
    unit_id: task.unit_id,
    pass_id: task.pass_id,
    lens: task.lens,
    file_coverage: task.file_paths.map((path) => ({
      path,
      total_lines: task.file_line_counts![path],
    })),
    findings: [
      {
        id: `${task.task_id}-f1`,
        title: "Other issue",
        category: "auth",
        severity: "low",
        confidence: "high",
        lens: "security",
        summary: "Found something elsewhere.",
        // Intentionally NOT src/api/auth.ts — so that path remains unresolved
        affected_files: [{ path: "src/lib/utils.ts" }],
        evidence: [],
      },
    ],
  }));

  const deepeningTasks = buildSelectiveDeepeningTasks({
    existingTasks: tasks,
    results,
    externalAnalyzerResults: [{
      tool: "semgrep",
      generated_at: "2026-04-30T00:00:00Z",
      results: [
        {
          id: "semgrep-1",
          path: "src/api/auth.ts",
          // `line_start` is the contract's field name (see the note on the
          // steward fixture above); only `path` is ever read.
          line_start: 12,
          category: "security",
          severity: "high",
          summary: "Potential injection.",
        },
      ],
    }],
  });

  const steward = deepeningTasks.find((task) =>
    task.tags!.includes("lens_verification"),
  );
  expect(steward, "should produce a lens steward task").toBeTruthy();
  expect(steward!.tags!.includes("trigger:unresolved_external_signal")).toBeTruthy();
  expect(steward!.tags!.includes("trigger:external_analyzer_signal")).toBeTruthy();
});

test("lens steward trigger critical_flow when a source task has critical_flow tag", () => {
  // 2 security tasks where one has tags: ['critical_flow']
  const tasks: AuditTask[] = [
    {
      task_id: "src-api-auth:security",
      unit_id: "src-api-auth",
      pass_id: "pass:security",
      lens: "security",
      file_paths: ["src/api/auth.ts"],
      file_line_counts: { "src/api/auth.ts": 40 },
      rationale: "Audit auth",
      priority: "high",
      tags: ["critical_flow"],
      status: "complete",
    },
    {
      task_id: "src-lib-session:security",
      unit_id: "src-lib-session",
      pass_id: "pass:security",
      lens: "security",
      file_paths: ["src/lib/session.ts"],
      file_line_counts: { "src/lib/session.ts": 30 },
      rationale: "Audit session",
      priority: "medium",
      status: "complete",
    },
  ];
  const results: AuditResult[] = tasks.map((task) => ({
    task_id: task.task_id,
    unit_id: task.unit_id,
    pass_id: task.pass_id,
    lens: task.lens,
    file_coverage: task.file_paths.map((path) => ({
      path,
      total_lines: task.file_line_counts![path],
    })),
    findings: [
      {
        id: `${task.task_id}-f1`,
        title: "Issue",
        category: "auth",
        severity: "low",
        confidence: "high",
        lens: "security",
        summary: "Minor issue.",
        affected_files: [{ path: task.file_paths[0] }],
        evidence: [],
      },
    ],
  }));

  const deepeningTasks = buildSelectiveDeepeningTasks({
    existingTasks: tasks,
    results,
  });

  const steward = deepeningTasks.find((task) =>
    task.tags!.includes("lens_verification"),
  );
  expect(steward, "should produce a lens steward task").toBeTruthy();
  expect(steward!.tags!.includes("trigger:critical_flow")).toBeTruthy();
});

test("lensVerificationTriggers totalLines uses path-owner map: large_lens_surface fires when totalLines >= 2000", () => {
  // Two tasks covering the same file (shared path). Only the first owner's
  // line count should be used for that path — matching the previous find-based
  // semantics.  2 distinct tasks × 1 shared file means sources.length < 3 and
  // filePaths.length < 4, so the only way large_lens_surface fires is via
  // totalLines >= 2000.
  const tasks: AuditTask[] = [
    {
      task_id: "src-api-handler:security",
      unit_id: "src-api-handler",
      pass_id: "pass:security",
      lens: "security",
      file_paths: ["src/api/handler.ts"],
      file_line_counts: { "src/api/handler.ts": 1800 },
      rationale: "Audit handler",
      priority: "high",
      status: "complete",
    },
    {
      task_id: "src-api-handler-extra:security",
      unit_id: "src-api-handler-extra",
      pass_id: "pass:security",
      lens: "security",
      // Same file path — second owner. Its 9999-line claim must NOT be added
      // (first-owner semantics: only the first source's count is used).
      file_paths: ["src/api/handler.ts"],
      file_line_counts: { "src/api/handler.ts": 9999 },
      rationale: "Extra audit handler",
      priority: "medium",
      status: "complete",
    },
    {
      task_id: "src-api-router:security",
      unit_id: "src-api-router",
      pass_id: "pass:security",
      lens: "security",
      file_paths: ["src/api/router.ts"],
      file_line_counts: { "src/api/router.ts": 250 },
      rationale: "Audit router",
      priority: "medium",
      status: "complete",
    },
  ];
  const results: AuditResult[] = tasks.map((task) => ({
    task_id: task.task_id,
    unit_id: task.unit_id,
    pass_id: task.pass_id,
    lens: task.lens,
    file_coverage: task.file_paths.map((path) => ({
      path,
      total_lines: task.file_line_counts![path],
    })),
    findings: [
      {
        id: `${task.task_id}-f1`,
        title: "Issue",
        category: "auth",
        severity: "low",
        confidence: "high",
        lens: "security",
        summary: "Minor issue.",
        affected_files: [{ path: task.file_paths[0] }],
        evidence: [],
      },
    ],
  }));

  const deepeningTasks = buildSelectiveDeepeningTasks({
    existingTasks: tasks,
    results,
  });

  const steward = deepeningTasks.find((task) =>
    task.tags!.includes("lens_verification"),
  );
  expect(steward, "should produce a lens steward task").toBeTruthy();
  // large_lens_surface fires: handler.ts (1800) + router.ts (250) = 2050 >= 2000
  expect(steward!.tags!.includes("trigger:large_lens_surface"), "large_lens_surface should fire when totalLines >= 2000").toBeTruthy();
});

test("lensVerificationTriggers totalLines: first-owner semantics — second source's lines for shared path are not double-counted", () => {
  // sources.length < 3, filePaths.length < 4, so large_lens_surface can only be
  // driven by totalLines here. The shared file has 1200 lines in source-1 and
  // 1200 in source-2. If double-counted it would be 2400 (fires); first-owner
  // gives 1200 + 700 = 1900 (does not fire). An external_analyzer_signal tag on
  // source-1 supplies an independent trigger so the steward is still built (the
  // surface triggers alone would not), letting us assert large_lens_surface is
  // absent — which proves the first-owner (non-double-counted) line total.
  const tasks: AuditTask[] = [
    {
      task_id: "src-big-a:security",
      unit_id: "src-big-a",
      pass_id: "pass:security",
      lens: "security",
      file_paths: ["src/big.ts"],
      file_line_counts: { "src/big.ts": 1200 },
      rationale: "Audit big A",
      priority: "medium",
      status: "complete",
      tags: ["external_analyzer_signal"],
    },
    {
      task_id: "src-big-b:security",
      unit_id: "src-big-b",
      pass_id: "pass:security",
      lens: "security",
      file_paths: ["src/big.ts", "src/other.ts"],
      file_line_counts: { "src/big.ts": 1200, "src/other.ts": 700 },
      rationale: "Audit big B",
      priority: "medium",
      status: "complete",
    },
  ];
  const results: AuditResult[] = tasks.map((task) => ({
    task_id: task.task_id,
    unit_id: task.unit_id,
    pass_id: task.pass_id,
    lens: task.lens,
    file_coverage: task.file_paths.map((path) => ({
      path,
      total_lines: task.file_line_counts![path],
    })),
    findings: [
      {
        id: `${task.task_id}-f1`,
        title: "Issue",
        category: "auth",
        severity: "low",
        confidence: "high",
        lens: "security",
        summary: "Minor issue.",
        affected_files: [{ path: task.file_paths[0] }],
        evidence: [],
      },
    ],
  }));

  const deepeningTasks = buildSelectiveDeepeningTasks({
    existingTasks: tasks,
    results,
  });

  const steward = deepeningTasks.find((task) =>
    task.tags!.includes("lens_verification"),
  );
  expect(steward, "should produce a lens steward task (sources.length=2)").toBeTruthy();
  // With first-owner semantics: src/big.ts=1200 (owned by src-big-a) +
  // src/other.ts=700 = 1900 < 2000 → large_lens_surface must NOT fire.
  expect(!steward!.tags!.includes("trigger:large_lens_surface"), "large_lens_surface must NOT fire when first-owner totalLines < 2000").toBeTruthy();
});

// ── conflictGroups spread-guard tests ────────────────────────────────────────
// Shared fixture for the three spread-guard test cases below.
// Only task_id suffix varies per call site; all other fields are identical.
const conflictBaseTask: Omit<AuditTask, "task_id"> = {
  unit_id: "src-api-auth",
  pass_id: "pass:security",
  lens: "security",
  file_paths: ["src/api/auth.ts"],
  file_line_counts: { "src/api/auth.ts": 40 },
  rationale: "Audit auth",
  priority: "medium",
  status: "complete",
};

function makeConflictFinding(
  id: string,
  severity: Finding["severity"],
  confidence: Finding["confidence"],
): Finding {
  return {
    id,
    title: "Token validation",
    category: "auth",
    severity,
    confidence,
    lens: "security",
    summary: "Token validation issue.",
    affected_files: [{ path: "src/api/auth.ts", line_start: 12 }],
    evidence: ["src/api/auth.ts:12 - token check"],
  };
}

test("conflictGroups suppresses group when both severitySpread and confidenceSpread are below 2", () => {
  // severity: medium/medium → spread = 0; confidence: high/medium → spread = 1
  // Both spreads < 2 → combined-spread guard triggers → no conflict task emitted
  const taskA: AuditTask = { ...conflictBaseTask, task_id: "src-api-auth:security:a" };
  const taskB: AuditTask = { ...conflictBaseTask, task_id: "src-api-auth:security:b" };
  const makeFinding = makeConflictFinding;
  const results: AuditResult[] = [
    {
      task_id: taskA.task_id,
      unit_id: taskA.unit_id,
      pass_id: taskA.pass_id,
      lens: taskA.lens,
      file_coverage: [{ path: "src/api/auth.ts", total_lines: 40 }],
      findings: [makeFinding("SEC-001", "medium", "high")],
    },
    {
      task_id: taskB.task_id,
      unit_id: taskB.unit_id,
      pass_id: taskB.pass_id,
      lens: taskB.lens,
      file_coverage: [{ path: "src/api/auth.ts", total_lines: 40 }],
      findings: [makeFinding("SEC-002", "medium", "medium")],
    },
  ];

  const tasks = buildSelectiveDeepeningTasks({
    existingTasks: [taskA, taskB],
    results,
  });

  const conflictTasks = tasks.filter((task) =>
    task.tags!.includes("trigger:conflicting_output"),
  );
  expect(conflictTasks.length, `expected no conflict tasks when both spreads < 2, got: ${JSON.stringify(conflictTasks.map((t) => t.task_id))}`).toBe(0);
});

test("conflictGroups keeps group when severitySpread >= 2 even if confidenceSpread < 2", () => {
  // severity: high(4) vs low(2) → spread = 2; confidence: high/high → spread = 0
  // severitySpread >= 2 → NOT (severitySpread < 2 && confidenceSpread < 2) → group kept
  const taskA: AuditTask = { ...conflictBaseTask, task_id: "src-api-auth:security:c" };
  const taskB: AuditTask = { ...conflictBaseTask, task_id: "src-api-auth:security:d" };
  const makeFinding = makeConflictFinding;
  const results: AuditResult[] = [
    {
      task_id: taskA.task_id,
      unit_id: taskA.unit_id,
      pass_id: taskA.pass_id,
      lens: taskA.lens,
      file_coverage: [{ path: "src/api/auth.ts", total_lines: 40 }],
      findings: [makeFinding("SEC-003", "high", "high")],
    },
    {
      task_id: taskB.task_id,
      unit_id: taskB.unit_id,
      pass_id: taskB.pass_id,
      lens: taskB.lens,
      file_coverage: [{ path: "src/api/auth.ts", total_lines: 40 }],
      findings: [makeFinding("SEC-004", "low", "high")],
    },
  ];

  const tasks = buildSelectiveDeepeningTasks({
    existingTasks: [taskA, taskB],
    results,
  });

  const conflict = tasks.find((task) =>
    task.tags!.includes("trigger:conflicting_output"),
  );
  expect(conflict, "expected a conflict task when severitySpread >= 2, even if confidenceSpread < 2").toBeTruthy();
  expect(conflict!.task_id).toMatch(/^deepening:conflict:/);
});

test("conflictGroups keeps group when confidenceSpread >= 2 even if severitySpread < 2", () => {
  // severity: medium/medium → spread = 0; confidence: high(3) vs low(1) → spread = 2
  // confidenceSpread >= 2 → NOT (severitySpread < 2 && confidenceSpread < 2) → group kept
  const taskA: AuditTask = { ...conflictBaseTask, task_id: "src-api-auth:security:e" };
  const taskB: AuditTask = { ...conflictBaseTask, task_id: "src-api-auth:security:f" };
  const makeFinding = makeConflictFinding;
  const results: AuditResult[] = [
    {
      task_id: taskA.task_id,
      unit_id: taskA.unit_id,
      pass_id: taskA.pass_id,
      lens: taskA.lens,
      file_coverage: [{ path: "src/api/auth.ts", total_lines: 40 }],
      findings: [makeFinding("SEC-005", "medium", "high")],
    },
    {
      task_id: taskB.task_id,
      unit_id: taskB.unit_id,
      pass_id: taskB.pass_id,
      lens: taskB.lens,
      file_coverage: [{ path: "src/api/auth.ts", total_lines: 40 }],
      findings: [makeFinding("SEC-006", "medium", "low")],
    },
  ];

  const tasks = buildSelectiveDeepeningTasks({
    existingTasks: [taskA, taskB],
    results,
  });

  const conflict = tasks.find((task) =>
    task.tags!.includes("trigger:conflicting_output"),
  );
  expect(conflict, "expected a conflict task when confidenceSpread >= 2, even if severitySpread < 2").toBeTruthy();
  expect(conflict!.task_id).toMatch(/^deepening:conflict:/);
});

// ── requeue folding ────────────────────────────────────────────────────────

test("the active question plan uses frozen source without legacy line counts or requeue tasks", () => {
  const path = "src/api/auth.ts";
  const bundle: ArtifactBundle = {
    repo_manifest: {
      repository: { name: "test-repo" },
      generated_at: "2026-01-01T00:00:00Z",
      files: [{ path, language: "ts", size_bytes: 11, hash: hashContent("synthetic!") }],
    },
    file_disposition: { files: [{ path, status: "included" }] },
    surface_manifest: { surfaces: [{ id: "fixture-entry", kind: "interface", entrypoint: path }] },
    intent_checkpoint: {
      schema_version: "intent-checkpoint/v1", confirmed_at: "2026-01-01T00:00:00Z",
      confirmed_by: "host", scope_summary: "Fixture source", intent_summary: "Review behavior",
      lens_selection: { include: ["behavior"] },
    },
  };
  const scope = fullAuditScope();
  const planned = buildQuestionPlanArtifacts(bundle, scope).updated.review_plan!;
  const questions = planned.questions.filter(row => row.source_dependencies.some(dep => dep.key === path));
  expect(questions.length).toBeGreaterThan(0);
  expect([...new Set(questions.map(row => row.lens))]).toEqual(["behavior"]);

  // Historical file/lens requeue work cannot change the admitted question cohort.
  const requeueTask: AuditTask = {
    task_id: `requeue:security:${path}`, unit_id: `requeue:${path}`,
    pass_id: "requeue:security", lens: "security", file_paths: [path],
    rationale: "Legacy pending work", priority: "medium", status: "pending",
  };
  const resumed = buildQuestionPlanArtifacts({ ...bundle, requeue_tasks: [requeueTask] }, scope);
  expect(resumed.updated.review_plan).toEqual(planned);
  expect(resumed.updated.requeue_tasks).toEqual([requeueTask]);
  expect(resumed.artifacts_written).toEqual(["scope.json", "review_plan.json"]);
});

test("scopes frozen project rule excerpts to the question's source folders and lens", async () => {
  const root = await mkdtemp(join(tmpdir(), "audit-project-rules-"));
  try {
    const contents: Record<string, string> = {
      "AGENTS.md": "# Behavior\n- State changes must retain recovery data unless the operator resets.\n"
        + "# Performance\n- Throughput budgets must be measured.\n"
        + ' `'.trim().repeat(3) + "\n- State must run an example command.\n" + ' `'.trim().repeat(3) + "\n",
      "src/local/CLAUDE.md": "# Behavior\n- Retry must retain accepted answers unless the local cache is disposable.\n",
      "src/local/AGENTS.md": "# Behavior\n- Retry must always retain accepted answers.\n",
      "src/peer/AGENTS.md": "# Behavior\n- State should not be confused with the local package.\n",
      "src/local/task.ts": "export const localTask = 1;\n",
      "src/peer/task.ts": "export const peerTask = 2;\n",
    };
    for (const [path, content] of Object.entries(contents)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), content);
    }
    const declaredQuestions = ["local", "peer", "cross"].map(id => ({
      key: id, lens: "behavior" as const, kind: "invariant" as const, title: id,
      source_refs: (id === "cross" ? ["local", "peer"] : [id]).map(directory => ({ path: "src/" + directory + "/task.ts" })),
      expectation: "Check this operation.",
    }));
    const artifacts = (localHash = hashContent(contents["src/local/CLAUDE.md"]!)): ArtifactBundle => ({
      repo_manifest: { repository: {name: "rules"}, generated_at: "2026-11-27T00:00:00Z",
        files: Object.entries(contents).map(([path, content]) => ({ path, language: path.endsWith(".md") ? "markdown" : "typescript", size_bytes: Buffer.byteLength(content),
          hash: path === "src/local/CLAUDE.md" ? localHash : hashContent(content) })) },
      file_disposition: { files: Object.keys(contents).map(path => ({
        path, status: path.endsWith(".md") ? "doc_only" : "included",
      })) },
    });
    const bundle = artifacts();
    const options = { snapshotId: "frozen", declaredQuestions };
    const planned = buildReviewQuestionPlan(bundle, options);
    const changed = buildReviewQuestionPlan(artifacts("revised-local"), options);
    const { bindings } = await deriveCurrentQuestionBindings({ ...bundle, review_plan: planned }, root);
    const local = bindings.find(item => item.question.expected_outcome.startsWith("Review local."))!;
    const peer = bindings.find(item => item.question.expected_outcome.startsWith("Review peer."))!;
    expect(local.assignment.suggested_sources.map(ref => ref.path)).toEqual(expect.arrayContaining(["AGENTS.md", "src/local/CLAUDE.md"]));
    expect(local.assignment.suggested_sources.map(ref => ref.path)).not.toContain("src/peer/AGENTS.md");
    expect(local.evidence.map(row => row.description)).toEqual(expect.arrayContaining([
      expect.stringContaining("Candidate project rule exception"),
      expect.stringContaining("Retry must retain accepted answers unless the local cache is disposable."),
    ]));
    expect(local.evidence.map(row => row.description).join(" ")).not.toMatch(/Throughput|example command|peer/);
    const cross = bindings.find(item => item.question.expected_outcome.startsWith("Review cross."))!;
    const crossText = cross.evidence.map(row => row.description);
    expect(crossText).toEqual(expect.arrayContaining([
      expect.stringContaining("disposable. Applies to src/local/ (that subtree only)"),
      expect.stringContaining("Applies to repository root (all in-scope paths)"),
      expect.stringContaining("State should not be confused with the local package. Applies to src/peer/"),
      expect.stringContaining("always retain accepted answers. Applies to src/local/"),
    ]));
    expect(crossText.every(description => description.includes("report the conflict rather than assume an override"))).toBe(true);
    expect(changed.questions.find(row => row.question_id === local.question.question_id)?.revision_id).not.toBe(local.question.revision_id);
    expect(changed.questions.find(row => row.question_id === peer.question.question_id)?.revision_id).toBe(peer.question.revision_id);
    const { schema_version, question_id, revision_id, snapshot_id, assignment_id } = peer.assignment;
    const identity = { schema_version, question_id, revision_id, snapshot_id };
    const part_id = peer.question.requested_parts[0]!.part_id;
    const ref = { path: "src/peer/task.ts", start_line: 1 };
    const accepted = acceptQuestionReview([], peer, {
      ...identity, assignment_id, submission_id: "peer-answer", inspected_sources: [ref],
      evidence_ids: [], limitations: [],
      answer: { outcome: "clean", parts: [{ part_id, outcome: "clean", observation_ids: ["checked"] }],
        observations: [{ ...identity, observation_id: "checked", part_id, kind: "source_confirmed",
          statement: "Peer output is unchanged.", source_refs: [ref], evidence_refs: [] }], findings: [] },
    }, "2026-11-27T00:00:00Z").record;
    const updated = "src/local/CLAUDE.md";
    contents[updated] = "# Behavior\n- Retry must retain unfinished work.\n";
    await writeFile(join(root, updated), contents[updated]!);
    const revised = artifacts();
    const { bindings: afterUpdate } = await deriveCurrentQuestionBindings({
      ...revised, review_plan: buildReviewQuestionPlan(revised, options),
    }, root);
    const peerAfter = afterUpdate.find(item => item.question.question_id === question_id)!;
    expect(projectQuestionReview(peerAfter.question, [accepted], peerAfter.dependencies).current).toEqual([accepted]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
