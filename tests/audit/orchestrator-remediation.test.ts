import { test, expect } from "vitest";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";

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
import type { AuditPlanMetrics } from "../../src/audit/types/reviewPlanning.js";

const { advanceAudit } = await import("../../src/audit/orchestrator/advance.js");
const {
  runExternalAnalyzerImportExecutor,
  runResultIngestionExecutor,
  runRuntimeValidationUpdateExecutor,
} = await import("../../src/audit/orchestrator/ingestionExecutors.js");
const { resolveRuntimeValidationSpawnCommand } = await import("../../src/audit/orchestrator/runtimeCommand.js");
const { deriveAuditState } = await import("../../src/audit/orchestrator/state.js");
const { buildFlowCoverage } =
  await import("../../src/audit/orchestrator/flowCoverage.js");
const { buildFlowRequeueTasks } =
  await import("../../src/audit/orchestrator/flowRequeue.js");
const { buildRequeueTasks } = await import("../../src/audit/orchestrator/requeue.js");
const { buildSelectiveDeepeningTasks } =
  await import("../../src/audit/orchestrator/selectiveDeepening.js");
const { ingestAuditResults } =
  await import("../../src/audit/orchestrator/resultIngestion.js");

/**
 * A contract-complete, all-zero `AuditPlanMetrics`. Only its PRESENCE matters to
 * the import-executor test below (which asserts planning-derived outputs are
 * cleared), so every numeric field is 0 and every collection empty.
 */
const ZERO_PLAN_METRICS: AuditPlanMetrics = {
  generated_at: "2026-04-22T00:00:00Z",
  task_count: 0,
  packet_count: 0,
  estimated_agent_reduction: 0,
  estimated_agent_reduction_ratio: 0,
  unique_file_count: 0,
  task_file_reference_count: 0,
  repeated_file_reference_count: 0,
  total_task_lines: 0,
  total_packet_lines: 0,
  repeated_line_reference_count: 0,
  min_task_lines: 0,
  max_task_lines: 0,
  average_task_lines: 0,
  lens_task_counts: {},
  priority_task_counts: {},
  packet_quality: {
    average_cohesion_score: 0,
    boundary_crossing_count: 0,
    merge_edge_kind_counts: {},
    boundary_edge_kind_counts: {},
    orphan_task_count: 0,
    high_fan_in_file_count: 0,
    high_fan_out_file_count: 0,
    weakly_explained_gap_counts: {},
    weakly_explained_file_extension_counts: {},
    weakly_explained_packet_count: 0,
    weakly_explained_packet_ids: [],
    weakly_explained_packet_samples: [],
    largest_unexplained_packet_files: 0,
  },
  packet_size: {
    single_task_packets: 0,
    multi_task_packets: 0,
    max_tasks_per_packet: 0,
    max_files_per_packet: 0,
  },
};

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

test("deriveAuditState marks audit tasks complete when every task has a result", () => {
  const state = deriveAuditState({
    repo_manifest: {
      repository: { name: "fixture" },
      generated_at: "2026-04-22T00:00:00Z",
      files: [{ path: "src/api/auth.ts", language: "ts", size_bytes: 12 }],
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

  expect(findObligation(state, "audit_tasks_completed")?.state).toBe("satisfied");
  expect(findObligation(state, "audit_results_ingested")?.state).toBe("satisfied");
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

test("external analyzer import clears planning-derived outputs in memory", () => {
  const run = runExternalAnalyzerImportExecutor(
    {
      coverage_matrix: { files: [] },
      flow_coverage: { flows: [] },
      audit_tasks: [],
      audit_plan_metrics: ZERO_PLAN_METRICS,
      requeue_tasks: [],
      audit_report: "# stale\n",
    },
    {
      tool: "semgrep",
      results: [],
    },
  );

  expect(run.updated.external_analyzer_results![0].tool).toBe("semgrep");
  expect(run.updated.coverage_matrix).toBe(undefined);
  expect(run.updated.audit_tasks).toBe(undefined);
  expect(run.updated.requeue_tasks).toBe(undefined);
  expect(run.updated.audit_report).toBe(undefined);
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

test("result ingestion appends selective deepening tasks to the next review plan", () => {
  const result: AuditResult = {
    task_id: "src-api-auth:security",
    unit_id: "src-api-auth",
    pass_id: "pass:security",
    lens: "security",
    file_coverage: [{ path: "src/api/auth.ts", total_lines: 40 }],
    findings: [
      {
        id: "SEC-001",
        title: "Token bypass",
        category: "auth",
        severity: "high",
        confidence: "medium",
        lens: "security",
        summary: "Potential token bypass needs verification.",
        affected_files: [{ path: "src/api/auth.ts", line_start: 12 }],
        evidence: ["src/api/auth.ts:12 - accepts empty token"],
      },
    ],
  };

  const run = runResultIngestionExecutor(
    {
      coverage_matrix: {
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
      audit_tasks: [
        {
          task_id: result.task_id,
          unit_id: result.unit_id,
          pass_id: result.pass_id,
          lens: result.lens,
          file_paths: ["src/api/auth.ts"],
          file_line_counts: { "src/api/auth.ts": 40 },
          rationale: "Audit auth",
          priority: "high",
          status: "pending",
        },
      ],
    },
    [result],
  );

  expect(run.updated.audit_tasks!.length).toBe(2);
  expect(
    run.updated.audit_tasks!.find((task) => task.task_id === result.task_id)
      ?.status,
  ).toBe("complete");
  const followup = run.updated.audit_tasks!.find((task) =>
    task.tags?.includes("selective_deepening"),
  );
  expect(followup?.status).toBe("pending");
  expect(run.artifacts_written.includes("audit_plan_metrics.json")).toBeTruthy();
  expect(run.progress_summary).toMatch(/selective deepening task/i);
});

test("runtime validation updates append disagreement follow-ups to the next review plan", () => {
  const sourceTask: AuditTask = {
    task_id: "src-api-auth:correctness",
    unit_id: "src-api-auth",
    pass_id: "pass:correctness",
    lens: "correctness",
    file_paths: ["src/api/auth.ts"],
    file_line_counts: { "src/api/auth.ts": 40 },
    rationale: "Audit auth",
    priority: "low",
    status: "complete",
  };
  const run = runRuntimeValidationUpdateExecutor(
    {
      audit_tasks: [sourceTask],
      audit_results: [
        {
          task_id: sourceTask.task_id,
          unit_id: sourceTask.unit_id,
          pass_id: sourceTask.pass_id,
          lens: sourceTask.lens,
          file_coverage: [{ path: "src/api/auth.ts", total_lines: 40 }],
          findings: [],
          reviewed_clean: true,
        },
      ],
      runtime_validation_tasks: {
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
      runtime_validation_report: {
        results: [
          {
            task_id: "runtime:unit:src-api-auth",
            status: "pending",
            summary: "Pending",
          },
        ],
      },
    },
    {
      results: [
        {
          task_id: "runtime:unit:src-api-auth",
          status: "not_confirmed",
          summary: "npm test failed",
        },
      ],
    },
  );

  expect(run.updated.audit_tasks!.length).toBe(2);
  const followup = run.updated.audit_tasks!.find((task) =>
    task.tags?.includes("trigger:runtime_validation_disagreement"),
  );
  expect(followup).toBeDefined();
  expect(
    followup?.tags?.includes("trigger:runtime_validation_disagreement"),
  ).toBeTruthy();
  expect(followup?.status).toBe("pending");
  expect(run.artifacts_written.includes("audit_plan_metrics.json")).toBeTruthy();
  expect(run.progress_summary).toMatch(/selective deepening task/i);
});

test("selectLensVerificationFiles truncates file list to MAX_LENS_VERIFICATION_FILES and emits stderr when sources exceed the limit", () => {
  // Build 13 security tasks each covering a distinct file so that
  // selectLensVerificationFiles sees 13 candidates and truncates to 12.
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

  // Capture stderr output during buildSelectiveDeepeningTasks
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
  expect(steward!.file_paths.length, "steward file_paths should be capped at MAX_LENS_VERIFICATION_FILES (12), not 13").toBe(12);

  // The truncation trace is a structured JSON log line (see lensVerification.ts
  // and the dedicated observability-signals test), not a human-readable string.
  const truncationLog = stderrLines
    .map((line) => {
      try {
        return JSON.parse(line.trim());
      } catch {
        return null;
      }
    })
    .find((obj) => obj && obj.event === "truncated_verification_file_list");
  expect(truncationLog, `expected a truncated_verification_file_list log line but got: ${JSON.stringify(stderrLines)}`).toBeTruthy();
  expect(truncationLog.kept, "kept should be MAX_LENS_VERIFICATION_FILES (12)").toBe(12);
  expect(truncationLog.total, "total should reflect the 13 candidate files").toBe(13);
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

const { runPlanningExecutor } = await import("../../src/audit/orchestrator/planningExecutors.js");

// TST-c7bdc07c: runPlanningExecutor with an empty lineIndex — exercises the
// path-resolution branch where no file has a known line count.
test("planning executor completes with an empty lineIndex (no line counts available)", async () => {
  const tmpRoot = await mkdtemp(join(tmpdir(), "planning-empty-lineindex-"));
  try {
    const bundle: ArtifactBundle = {
      repo_manifest: {
        repository: { name: "test-repo" },
        generated_at: "2026-01-01T00:00:00Z",
        files: [{ path: "src/api/auth.ts", language: "ts", size_bytes: 100 }],
      },
      file_disposition: { files: [] },
      unit_manifest: {
        units: [
          {
            unit_id: "src-api-auth",
            name: "Auth",
            files: ["src/api/auth.ts"],
            required_lenses: ["security"],
          },
        ],
      },
      surface_manifest: { surfaces: [] },
      critical_flows: { flows: [] },
      risk_register: { items: [] },
    };

    // Empty lineIndex — no file has a known line count.
    const result = await runPlanningExecutor(bundle, tmpRoot, {});

    expect(result, "executor must return a result").toBeTruthy();
    expect(Array.isArray(result.updated.task_affinity_graph?.nodes), "must produce a task-affinity graph").toBeTruthy();
    // With zero line counts the task is still planned (may have 0-line estimate)
    // but must NOT throw.
    expect(typeof result.updated === "object", "updated bundle must be an object").toBeTruthy();
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
});

test("planning executor folds pending requeue tasks into the dispatch surface", async () => {
  const tmpRoot = await mkdtemp(join(tmpdir(), "planning-requeue-"));
  try {
    const bundle: ArtifactBundle = {
      repo_manifest: {
        repository: { name: "test-repo" },
        generated_at: "2026-01-01T00:00:00Z",
        files: [{ path: "src/api/auth.ts", language: "ts", size_bytes: 100 }],
      },
      file_disposition: { files: [] },
      unit_manifest: {
        units: [
          {
            unit_id: "src-api-auth",
            name: "Auth",
            files: ["src/api/auth.ts"],
            required_lenses: ["security"],
          },
        ],
      },
      surface_manifest: { surfaces: [] },
      critical_flows: { flows: [] },
      risk_register: { items: [] },
    };

    const lineIndex = { "src/api/auth.ts": 50 };
    const result = await runPlanningExecutor(bundle, tmpRoot, lineIndex);

    // Packets are partitioned just-in-time at dispatch (never persisted); the
    // planning-time dispatch surface is the task-affinity graph.
    expect(Array.isArray(result.updated.task_affinity_graph?.nodes)).toBeTruthy();
    expect(result.updated.task_affinity_graph!.nodes.length > 0, "expected at least one task-affinity node").toBeTruthy();

    // The requeue payload is built before folding; any pending requeue task
    // file paths must appear in the dispatch surface
    const dispatchFilePaths = new Set(
      result.updated.task_affinity_graph!.nodes.flatMap((n) => n.file_paths),
    );
    for (const requeueTask of (result.updated.requeue_tasks ?? []).filter(
      (t) => t.status === "pending",
    )) {
      for (const path of requeueTask.file_paths) {
        expect(dispatchFilePaths.has(path), `requeue task path "${path}" must appear in the task-affinity graph`).toBeTruthy();
      }
    }
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
});

test("ingestion executor folds pending requeue tasks for uncovered files into the dispatch surface", () => {
  // Scenario: auth.ts is ingested (coverage complete), utils.ts has no task
  // and remains uncovered → buildRequeuePayload generates a pending task for
  // it → that task must count toward the refreshed plan metrics (packets
  // themselves are partitioned just-in-time at dispatch).
  const authTask: AuditTask = {
    task_id: "src-api-auth:security",
    unit_id: "src-api-auth",
    pass_id: "pass:security",
    lens: "security",
    file_paths: ["src/api/auth.ts"],
    file_line_counts: { "src/api/auth.ts": 30 },
    rationale: "Audit auth",
    priority: "high",
    status: "pending",
  };
  const result: AuditResult = {
    task_id: authTask.task_id,
    unit_id: authTask.unit_id,
    pass_id: authTask.pass_id,
    lens: authTask.lens,
    file_coverage: [{ path: "src/api/auth.ts", total_lines: 30 }],
    findings: [],
    reviewed_clean: true,
  };

  const run = runResultIngestionExecutor(
    {
      coverage_matrix: {
        files: [
          {
            path: "src/api/auth.ts",
            unit_ids: ["src-api-auth"],
            classification_status: "classified",
            audit_status: "pending",
            required_lenses: ["security"],
            completed_lenses: [],
          },
          {
            path: "src/lib/utils.ts",
            unit_ids: ["src-lib-utils"],
            classification_status: "classified",
            audit_status: "pending",
            required_lenses: ["security"],
            completed_lenses: [],
          },
        ],
      },
      audit_tasks: [authTask],
    },
    [result],
  );

  // utils.ts has no planned task and is still uncovered → requeue task exists
  const requeueTask = run.updated.requeue_tasks?.find(
    (t) => t.task_id === "requeue:security:src/lib/utils.ts",
  );
  expect(requeueTask, "expected a pending requeue task for src/lib/utils.ts").toBeTruthy();
  expect(requeueTask!.status).toBe("pending");

  // The requeue task must be folded into the persisted dispatch surface so JIT
  // packetization, the affinity graph, and metrics all describe one task set.
  const foldedRequeue = run.updated.audit_tasks!.find(
    (task) => task.task_id === requeueTask!.task_id,
  );
  expect(
    foldedRequeue?.file_paths.includes("src/lib/utils.ts"),
    "utils requeue task must be part of the folded dispatch surface",
  ).toBeTruthy();
  expect(run.updated.audit_plan_metrics!.task_count).toBe(
    run.updated.audit_tasks!.length,
  );
  expect(run.artifacts_written.includes("audit_plan_metrics.json")).toBeTruthy();
});

test("ingestion executor deduplicates requeue tasks already present in audit_tasks", () => {
  // Scenario: utils.ts is already tracked as a "complete" task in audit_tasks.
  // After ingestion, buildRequeuePayload still generates a pending requeue task
  // for it (coverage is still marked pending), but the dedup guard must prevent
  // it from being added a second time via the requeue folding path.
  const authTask: AuditTask = {
    task_id: "src-api-auth:security",
    unit_id: "src-api-auth",
    pass_id: "pass:security",
    lens: "security",
    file_paths: ["src/api/auth.ts"],
    file_line_counts: { "src/api/auth.ts": 30 },
    rationale: "Audit auth",
    priority: "high",
    status: "complete",
  };
  const utilsRequeueTask: AuditTask = {
    task_id: "requeue:security:src/lib/utils.ts",
    unit_id: "requeue:src/lib/utils.ts",
    pass_id: "requeue:security",
    lens: "security",
    file_paths: ["src/lib/utils.ts"],
    file_line_counts: {},
    rationale: "Already tracked",
    priority: "medium",
    tags: [],
    status: "complete",
  };

  const run = runResultIngestionExecutor(
    {
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
          {
            path: "src/lib/utils.ts",
            unit_ids: ["src-lib-utils"],
            classification_status: "classified",
            audit_status: "pending",
            required_lenses: ["security"],
            completed_lenses: [],
          },
        ],
      },
      audit_tasks: [authTask, utilsRequeueTask],
    },
    [],
  );

  // The dispatch surface must count utils.ts once (no duplicate task): the
  // already-tracked utils requeue task must not be re-added via the requeue
  // folding path, so metrics never exceed tracked tasks + genuinely-new
  // pending requeue tasks.
  const trackedIds = new Set(run.updated.audit_tasks!.map((t) => t.task_id));
  const foldedRequeue = (run.updated.requeue_tasks ?? []).filter(
    (t) => t.status === "pending" && !trackedIds.has(t.task_id),
  );
  expect(run.updated.audit_plan_metrics!.task_count, "requeue task must not be folded into the dispatch surface twice").toBe(run.updated.audit_tasks!.length + foldedRequeue.length);
});

test("ingestion executor refuses a requeue task a PLAIN plan task already covers under the same lens", () => {
  // The gap both fixtures above miss. `requeue:<lens>:<path>` and a plan task's
  // `<unit>:<lens>` are two different id grammars, so a task_id-only dedupe can
  // never match: the file is covered by a still-pending PLAIN plan task, which is
  // exactly the shape the whole coverage set takes on a fresh plan. Coverage-based
  // dedupe (`selectUncoveredRequeueTasks`, the planning draw's mechanism) is the
  // only thing that sees it.
  const authTask: AuditTask = {
    task_id: "src-api-auth:security",
    unit_id: "src-api-auth",
    pass_id: "pass:security",
    lens: "security",
    file_paths: ["src/api/auth.ts"],
    file_line_counts: { "src/api/auth.ts": 30 },
    rationale: "Audit auth",
    priority: "high",
    status: "pending",
  };
  const utilsTask: AuditTask = {
    task_id: "src-lib-utils:security",
    unit_id: "src-lib-utils",
    pass_id: "pass:security",
    lens: "security",
    file_paths: ["src/lib/utils.ts"],
    file_line_counts: { "src/lib/utils.ts": 20 },
    rationale: "Audit utils",
    priority: "medium",
    status: "pending",
  };
  const result: AuditResult = {
    task_id: authTask.task_id,
    unit_id: authTask.unit_id,
    pass_id: authTask.pass_id,
    lens: authTask.lens,
    file_coverage: [{ path: "src/api/auth.ts", total_lines: 30 }],
    findings: [],
    reviewed_clean: true,
  };

  const run = runResultIngestionExecutor(
    {
      coverage_matrix: {
        files: [
          {
            path: "src/api/auth.ts",
            unit_ids: ["src-api-auth"],
            classification_status: "classified",
            audit_status: "pending",
            required_lenses: ["security"],
            completed_lenses: [],
          },
          {
            path: "src/lib/utils.ts",
            unit_ids: ["src-lib-utils"],
            classification_status: "classified",
            audit_status: "pending",
            required_lenses: ["security"],
            completed_lenses: [],
          },
        ],
      },
      audit_tasks: [authTask, utilsTask],
    },
    [result],
  );

  // The payload still names the gap — the fold, not the payload, is under test.
  expect(
    (run.updated.requeue_tasks ?? []).some(
      (t) => t.task_id === "requeue:security:src/lib/utils.ts" && t.status === "pending",
    ),
    "the requeue payload must still emit the pending coverage cell",
  ).toBe(true);

  expect(
    run.updated.audit_tasks!.filter((t) => t.task_id.startsWith("requeue:")),
    "no requeue task may be folded when a pending plan task already covers the file under that lens",
  ).toEqual([]);
  expect(run.updated.audit_plan_metrics!.task_count).toBe(
    run.updated.audit_tasks!.length,
  );
});

test("ingestion executor applies the operator lens gate to the requeue fold", () => {
  // `intent_checkpoint.lens_selection.exclude` is the operator's word on what may
  // be dispatched. The planning draw gates the fold on it; ingestion must resolve
  // the SAME effective lens set, or an excluded lens re-enters dispatch through
  // requeue on the first ingest.
  const authTask: AuditTask = {
    task_id: "src-api-auth:security",
    unit_id: "src-api-auth",
    pass_id: "pass:security",
    lens: "security",
    file_paths: ["src/api/auth.ts"],
    file_line_counts: { "src/api/auth.ts": 30 },
    rationale: "Audit auth",
    priority: "high",
    status: "pending",
  };

  const run = runResultIngestionExecutor(
    {
      coverage_matrix: {
        files: [
          {
            path: "src/api/auth.ts",
            unit_ids: ["src-api-auth"],
            classification_status: "classified",
            audit_status: "pending",
            required_lenses: ["security", "performance"],
            completed_lenses: [],
          },
        ],
      },
      audit_tasks: [authTask],
      intent_checkpoint: {
        schema_version: "intent-checkpoint/v1",
        confirmed_at: "2026-01-01T00:00:00.000Z",
        confirmed_by: "host",
        scope_summary: "test",
        intent_summary: "test",
        lens_selection: { exclude: ["performance"] },
      },
    },
    [],
  );

  expect(
    (run.updated.requeue_tasks ?? []).some(
      (t) => t.task_id === "requeue:performance:src/api/auth.ts" && t.status === "pending",
    ),
    "the requeue payload still names the excluded-lens gap; the fold is what must refuse it",
  ).toBe(true);
  expect(
    run.updated.audit_tasks!.map((t) => t.task_id).filter((id) => id.includes("performance")),
    "an operator-excluded lens must never re-enter dispatch through the requeue fold",
  ).toEqual([]);
});
