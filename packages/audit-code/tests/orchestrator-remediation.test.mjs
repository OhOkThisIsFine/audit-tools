import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";

const { advanceAudit } = await import("../src/orchestrator/advance.ts");
const {
  runExternalAnalyzerImportExecutor,
  runResultIngestionExecutor,
  runRuntimeValidationUpdateExecutor,
} = await import("../src/orchestrator/ingestionExecutors.ts");
const { resolveRuntimeValidationSpawnCommand } = await import(
  "../src/orchestrator/runtimeCommand.ts"
);
const { deriveAuditState } = await import("../src/orchestrator/state.ts");
const { buildFlowCoverage } =
  await import("../src/orchestrator/flowCoverage.ts");
const { buildFlowRequeueTasks } =
  await import("../src/orchestrator/flowRequeue.ts");
const { buildRequeueTasks } = await import("../src/orchestrator/requeue.ts");
const { buildExternalSignalTasks } =
  await import("../src/orchestrator/taskBuilder.ts");
const { buildSelectiveDeepeningTasks } =
  await import("../src/orchestrator/selectiveDeepening.ts");
const { ingestAuditResults } =
  await import("../src/orchestrator/resultIngestion.ts");

function findObligation(state, id) {
  return state.obligations.find((item) => item.id === id);
}

test("advanceAudit preserves persisted complete state when no executor is selected", async () => {
  const completeState = {
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

  assert.equal(result.selected_executor, null);
  assert.equal(result.progress_made, false);
  assert.equal(result.audit_state.status, "complete");
  assert.equal(result.audit_state.last_executor, "synthesis_executor");
  assert.equal(result.audit_state.last_obligation, "synthesis_current");
});

test("advanceAudit wraps executor failures with executor and obligation context", async () => {
  const missingRoot = join(
    tmpdir(),
    `auditor-lambda-missing-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );

  await assert.rejects(
    () => advanceAudit({}, { root: missingRoot }),
    (error) => {
      assert.match(
        error.message,
        /advanceAudit intake_executor failed while resolving repo_manifest/i,
      );
      return true;
    },
  );
});

test("runtime validation runs package-manager shims through the Windows shell", () => {
  assert.deepEqual(
    resolveRuntimeValidationSpawnCommand(["npm", "test"], "win32", "cmd.exe"),
    { command: "cmd.exe", args: ["/d", "/s", "/c", "npm test"] },
  );
  assert.deepEqual(
    resolveRuntimeValidationSpawnCommand(
      ["npx", "vitest", "run", "--reporter=dot"],
      "win32",
      "cmd.exe",
    ),
    {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", "npx vitest run --reporter=dot"],
    },
  );
  assert.deepEqual(
    resolveRuntimeValidationSpawnCommand(["npm.cmd", "test"], "win32", "cmd.exe"),
    { command: "cmd.exe", args: ["/d", "/s", "/c", "npm.cmd test"] },
  );
  assert.deepEqual(
    resolveRuntimeValidationSpawnCommand(["python", "-m", "pytest"], "win32"),
    { command: "python", args: ["-m", "pytest"] },
  );
  assert.deepEqual(
    resolveRuntimeValidationSpawnCommand(["npm", "test"], "linux"),
    { command: "npm", args: ["test"] },
  );
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
      },
    ],
  });

  assert.equal(findObligation(state, "audit_tasks_completed")?.state, "satisfied");
  assert.equal(findObligation(state, "audit_results_ingested")?.state, "satisfied");
});

test("deriveAuditState requires syntax-resolution marker instead of imported analyzer results", () => {
  const importedOnly = deriveAuditState({
    repo_manifest: {
      repository: { name: "fixture" },
      generated_at: "2026-04-22T00:00:00Z",
      files: [{ path: "src/app.ts", language: "ts", size_bytes: 12 }],
    },
    external_analyzer_results: {
      tool: "semgrep",
      results: [],
    },
  });
  assert.equal(findObligation(importedOnly, "syntax_resolved")?.state, "missing");

  const withMarker = deriveAuditState({
    repo_manifest: {
      repository: { name: "fixture" },
      generated_at: "2026-04-22T00:00:00Z",
      files: [{ path: "src/app.ts", language: "ts", size_bytes: 12 }],
    },
    external_analyzer_results: {
      tool: "syntax_resolution_executor",
      results: [],
    },
    syntax_resolution_status: {
      tool: "syntax_resolution_executor",
      completed_at: "2026-04-22T00:00:00Z",
    },
  });
  assert.equal(findObligation(withMarker, "syntax_resolved")?.state, "satisfied");
});

test("external analyzer import clears planning-derived outputs in memory", () => {
  const run = runExternalAnalyzerImportExecutor(
    {
      coverage_matrix: { files: [] },
      flow_coverage: { flows: [] },
      audit_tasks: [],
      audit_plan_metrics: { task_count: 0, packet_count: 0, priority_counts: {} },
      review_packets: [],
      requeue_tasks: [],
      audit_report: "# stale\n",
    },
    {
      tool: "semgrep",
      results: [],
    },
  );

  assert.equal(run.updated.external_analyzer_results.tool, "semgrep");
  assert.equal(run.updated.coverage_matrix, undefined);
  assert.equal(run.updated.audit_tasks, undefined);
  assert.equal(run.updated.review_packets, undefined);
  assert.equal(run.updated.requeue_tasks, undefined);
  assert.equal(run.updated.audit_report, undefined);
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
      },
    ],
  });

  assert.equal(findObligation(state, "audit_tasks_completed")?.state, "missing");
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
        requires_followup: false,
      },
    ],
  );

  assert.deepEqual(updated.files[0].completed_lenses, []);
  assert.equal(updated.files[0].audit_status, "pending");
});

test("selective deepening creates bounded follow-up tasks for risky or ambiguous findings", () => {
  const sourceTask = {
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
  const result = {
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

  assert.equal(tasks.length, 1);
  assert.match(tasks[0].task_id, /^deepening:finding:/);
  assert.equal(tasks[0].priority, "high");
  assert.deepEqual(tasks[0].file_paths, ["src/api/auth.ts"]);
  assert.equal(tasks[0].file_line_counts["src/api/auth.ts"], 40);
  assert.ok(tasks[0].tags.includes("selective_deepening"));
  assert.ok(tasks[0].tags.includes("trigger:high_severity"));
  assert.ok(tasks[0].tags.includes("trigger:low_confidence"));

  assert.equal(
    buildSelectiveDeepeningTasks({
      existingTasks: [...tasks, sourceTask],
      results: [result],
    }).length,
    0,
  );
});

test("selective deepening adds a reconciliation task for conflicting findings", () => {
  const baseTask = {
    unit_id: "src-api-auth",
    pass_id: "pass:security",
    lens: "security",
    file_paths: ["src/api/auth.ts"],
    file_line_counts: { "src/api/auth.ts": 40 },
    rationale: "Audit auth",
    priority: "medium",
    status: "complete",
  };
  const finding = (id, severity, confidence) => ({
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
  const taskA = { ...baseTask, task_id: "src-api-auth:security:a" };
  const taskB = { ...baseTask, task_id: "src-api-auth:security:b" };
  const results = [
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

  assert.equal(tasks.length, 2);
  const conflict = tasks.find((task) =>
    task.tags.includes("trigger:conflicting_output"),
  );
  assert.ok(conflict);
  assert.match(conflict.task_id, /^deepening:conflict:/);
  assert.deepEqual(conflict.file_paths, ["src/api/auth.ts"]);
});

test("selective deepening samples high-risk no-finding results", () => {
  const sourceTask = {
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
  const result = {
    task_id: sourceTask.task_id,
    unit_id: sourceTask.unit_id,
    pass_id: sourceTask.pass_id,
    lens: sourceTask.lens,
    file_coverage: [{ path: "src/api/auth.ts", total_lines: 40 }],
    findings: [],
  };

  const tasks = buildSelectiveDeepeningTasks({
    existingTasks: [sourceTask],
    results: [result],
  });

  assert.equal(tasks.length, 1);
  assert.match(tasks[0].task_id, /^deepening:clean:/);
  assert.equal(tasks[0].priority, "high");
  assert.deepEqual(tasks[0].file_paths, ["src/api/auth.ts"]);
  assert.ok(tasks[0].tags.includes("trigger:high_risk_no_finding"));
});

test("selective deepening creates a lens steward for risky completed lens output", () => {
  const securityTasks = [
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
  const results = securityTasks.map((task) => ({
    task_id: task.task_id,
    unit_id: task.unit_id,
    pass_id: task.pass_id,
    lens: task.lens,
    file_coverage: task.file_paths.map((path) => ({
      path,
      total_lines: task.file_line_counts[path],
    })),
    findings: [],
  }));

  const tasks = buildSelectiveDeepeningTasks({
    existingTasks: securityTasks,
    results,
    externalAnalyzerResults: {
      tool: "semgrep",
      generated_at: "2026-04-30T00:00:00Z",
      results: [
        {
          id: "semgrep-1",
          path: "src/api/auth.ts",
          line: 12,
          category: "security",
          severity: "high",
          summary: "Token handling signal.",
        },
      ],
    },
  });

  const steward = tasks.find((task) =>
    task.tags.includes("lens_verification"),
  );
  assert.ok(steward);
  assert.match(steward.task_id, /^deepening:steward:/);
  assert.equal(steward.priority, "high");
  assert.equal(steward.lens, "security");
  assert.ok(steward.tags.includes("trigger:external_analyzer_signal"));
  assert.ok(steward.tags.includes("trigger:many_no_finding_results"));
  assert.ok(steward.rationale.includes("Do not write direct findings"));
  assert.ok(steward.file_paths.includes("src/api/auth.ts"));
});

test("lens steward verification suggestions become bounded follow-up tasks", () => {
  const stewardTask = {
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
  const verificationResult = {
    task_id: stewardTask.task_id,
    unit_id: stewardTask.unit_id,
    pass_id: stewardTask.pass_id,
    lens: stewardTask.lens,
    file_coverage: [
      { path: "src/api/auth.ts", total_lines: 40 },
      { path: "src/lib/session.ts", total_lines: 30 },
    ],
    findings: [],
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

  assert.equal(tasks.length, 1);
  assert.match(tasks[0].task_id, /^deepening:steward-followup:/);
  assert.equal(tasks[0].priority, "high");
  assert.deepEqual(tasks[0].file_paths, ["src/api/auth.ts"]);
  assert.equal(tasks[0].file_line_counts["src/api/auth.ts"], 40);
  assert.ok(tasks[0].tags.includes("lens_verification_followup"));
  assert.ok(tasks[0].tags.includes("trigger:lens_verification"));
});

test("selective deepening reconciles runtime validation disagreement", () => {
  const sourceTask = {
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
  const result = {
    task_id: sourceTask.task_id,
    unit_id: sourceTask.unit_id,
    pass_id: sourceTask.pass_id,
    lens: sourceTask.lens,
    file_coverage: [{ path: "src/api/auth.ts", total_lines: 40 }],
    findings: [],
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
    task.tags.includes("trigger:runtime_validation_disagreement"),
  );
  assert.ok(runtimeTask);
  assert.match(runtimeTask.task_id, /^deepening:runtime:/);
  assert.equal(runtimeTask.lens, "security");
  assert.equal(runtimeTask.priority, "high");
  assert.deepEqual(runtimeTask.file_paths, ["src/api/auth.ts"]);
});

test("result ingestion appends selective deepening tasks to the next review plan", () => {
  const result = {
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

  assert.equal(run.updated.audit_tasks.length, 2);
  assert.equal(run.updated.audit_tasks[0].status, "complete");
  assert.equal(run.updated.audit_tasks[1].status, "pending");
  assert.ok(run.updated.audit_tasks[1].tags.includes("selective_deepening"));
  assert.ok(run.artifacts_written.includes("review_packets.json"));
  assert.match(run.progress_summary, /selective deepening task/i);
});

test("runtime validation updates append disagreement follow-ups to the next review plan", () => {
  const sourceTask = {
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

  assert.equal(run.updated.audit_tasks.length, 2);
  const followup = run.updated.audit_tasks[1];
  assert.ok(followup.tags.includes("trigger:runtime_validation_disagreement"));
  assert.equal(followup.status, "pending");
  assert.ok(run.artifacts_written.includes("review_packets.json"));
  assert.match(run.progress_summary, /selective deepening task/i);
});

test("selectLensVerificationFiles truncates file list to MAX_LENS_VERIFICATION_FILES and emits stderr when sources exceed the limit", () => {
  // Build 13 security tasks each covering a distinct file so that
  // selectLensVerificationFiles sees 13 candidates and truncates to 12.
  const filePaths = Array.from({ length: 13 }, (_, i) => `src/module-${i}/index.ts`);

  const sourceTasks = filePaths.map((filePath, i) => ({
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

  const results = sourceTasks.map((task) => ({
    task_id: task.task_id,
    unit_id: task.unit_id,
    pass_id: task.pass_id,
    lens: task.lens,
    file_coverage: task.file_paths.map((path) => ({ path, total_lines: 40 })),
    findings: [],
    // Do NOT set requires_followup: false — that would mark all as closed-clean
  }));

  // Capture stderr output during buildSelectiveDeepeningTasks
  const stderrLines = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...args) => {
    stderrLines.push(typeof chunk === "string" ? chunk : chunk.toString());
    return originalWrite(chunk, ...args);
  };

  let tasks;
  try {
    tasks = buildSelectiveDeepeningTasks({
      existingTasks: sourceTasks,
      results,
    });
  } finally {
    process.stderr.write = originalWrite;
  }

  const steward = tasks.find((task) => task.tags.includes("lens_verification"));
  assert.ok(steward, "expected a lens steward task to be created");
  assert.equal(
    steward.file_paths.length,
    12,
    "steward file_paths should be capped at MAX_LENS_VERIFICATION_FILES (12), not 13",
  );

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
  assert.ok(
    truncationLog,
    `expected a truncated_verification_file_list log line but got: ${JSON.stringify(stderrLines)}`,
  );
  assert.equal(truncationLog.kept, 12, "kept should be MAX_LENS_VERIFICATION_FILES (12)");
  assert.equal(truncationLog.total, 13, "total should reflect the 13 candidate files");
});

test("buildFlowCoverage tolerates malformed flow paths and concerns", () => {
  const coverage = buildFlowCoverage(
    {
      flows: [
        {
          id: "auth-flow",
          name: "Auth Flow",
          paths: null,
          entrypoints: ["src/api/auth.ts"],
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

  assert.deepEqual(coverage.flows[0].paths, []);
  assert.deepEqual(coverage.flows[0].required_lenses, []);
  // null concerns → no required lenses → vacuously complete (required.every(...)
  // over an empty set is true), matching the "no concerns" vacuous-truth case.
  assert.equal(coverage.flows[0].status, "complete");
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
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].lens, "security");
  assert.ok(tasks.every((task) => task.lens !== "mystery"));
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
    {
      tool: "semgrep",
      results: [null, { path: 42 }, { path: "src/api/auth.ts" }],
    },
  );

  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].priority, "high");
  assert.ok(tasks[0].tags.includes("external_analyzer_signal"));
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

  assert.equal(coverage.flows[0].status, "complete");
  assert.deepEqual(coverage.flows[0].required_lenses, []);
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

  assert.equal(coverage.flows[0].status, "complete");
  assert.deepEqual(coverage.flows[0].required_lenses, []);
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

  assert.equal(coverage.flows[0].status, "complete");
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

  assert.equal(coverage.flows[0].status, "partial");
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

  assert.equal(coverage.flows[0].status, "pending");
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
    {
      tool: "semgrep",
      results: [undefined, { path: 99 }, { path: "src/api/auth.ts" }],
    },
  );

  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].priority, "high");
  assert.ok(tasks[0].tags.includes("external_analyzer_signal"));
});

test("lens steward trigger large_lens_surface when 3 or more source results", () => {
  // 3 security tasks/results, each covering 1 file with <700 lines
  // sources.length >= 3 triggers large_lens_surface
  const tasks = [
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
  const results = tasks.map((task) => ({
    task_id: task.task_id,
    unit_id: task.unit_id,
    pass_id: task.pass_id,
    lens: task.lens,
    file_coverage: task.file_paths.map((path) => ({
      path,
      total_lines: task.file_line_counts[path],
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
    task.tags.includes("lens_verification"),
  );
  assert.ok(steward, "should produce a lens steward task");
  assert.ok(steward.tags.includes("trigger:large_lens_surface"));
  assert.ok(!steward.tags.includes("trigger:many_no_finding_results"));
});

test("lens steward trigger large_lens_surface when 4 or more unique files across sources", () => {
  // 2 tasks each covering 2 distinct files = 4 unique files total
  // filePaths.length >= 4 triggers large_lens_surface
  const tasks = [
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
  const results = tasks.map((task) => ({
    task_id: task.task_id,
    unit_id: task.unit_id,
    pass_id: task.pass_id,
    lens: task.lens,
    file_coverage: task.file_paths.map((path) => ({
      path,
      total_lines: task.file_line_counts[path],
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
    task.tags.includes("lens_verification"),
  );
  assert.ok(steward, "should produce a lens steward task");
  assert.ok(steward.tags.includes("trigger:large_lens_surface"));
});

test("lens steward trigger large_file_reviewed when a source task has large_file tag", () => {
  // 2 security tasks where one task has tags: ['large_file']
  const tasks = [
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
  const results = tasks.map((task) => ({
    task_id: task.task_id,
    unit_id: task.unit_id,
    pass_id: task.pass_id,
    lens: task.lens,
    file_coverage: task.file_paths.map((path) => ({
      path,
      total_lines: task.file_line_counts[path],
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
    task.tags.includes("lens_verification"),
  );
  assert.ok(steward, "should produce a lens steward task");
  assert.ok(steward.tags.includes("trigger:large_file_reviewed"));
});

test("lens steward trigger unresolved_external_signal when external path has no matching finding", () => {
  // 2 security results covering src/api/auth.ts; externalAnalyzerResults lists src/api/auth.ts;
  // but result findings affected_files use a different path — so src/api/auth.ts remains unresolved.
  const tasks = [
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
  const results = tasks.map((task) => ({
    task_id: task.task_id,
    unit_id: task.unit_id,
    pass_id: task.pass_id,
    lens: task.lens,
    file_coverage: task.file_paths.map((path) => ({
      path,
      total_lines: task.file_line_counts[path],
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
    externalAnalyzerResults: {
      tool: "semgrep",
      generated_at: "2026-04-30T00:00:00Z",
      results: [
        {
          id: "semgrep-1",
          path: "src/api/auth.ts",
          line: 12,
          category: "security",
          severity: "high",
          summary: "Potential injection.",
        },
      ],
    },
  });

  const steward = deepeningTasks.find((task) =>
    task.tags.includes("lens_verification"),
  );
  assert.ok(steward, "should produce a lens steward task");
  assert.ok(steward.tags.includes("trigger:unresolved_external_signal"));
  assert.ok(steward.tags.includes("trigger:external_analyzer_signal"));
});

test("lens steward trigger critical_flow when a source task has critical_flow tag", () => {
  // 2 security tasks where one has tags: ['critical_flow']
  const tasks = [
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
  const results = tasks.map((task) => ({
    task_id: task.task_id,
    unit_id: task.unit_id,
    pass_id: task.pass_id,
    lens: task.lens,
    file_coverage: task.file_paths.map((path) => ({
      path,
      total_lines: task.file_line_counts[path],
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
    task.tags.includes("lens_verification"),
  );
  assert.ok(steward, "should produce a lens steward task");
  assert.ok(steward.tags.includes("trigger:critical_flow"));
});

test("lensVerificationTriggers totalLines uses path-owner map: large_lens_surface fires when totalLines >= 2000", () => {
  // Two tasks covering the same file (shared path). Only the first owner's
  // line count should be used for that path — matching the previous find-based
  // semantics.  2 distinct tasks × 1 shared file means sources.length < 3 and
  // filePaths.length < 4, so the only way large_lens_surface fires is via
  // totalLines >= 2000.
  const tasks = [
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
  const results = tasks.map((task) => ({
    task_id: task.task_id,
    unit_id: task.unit_id,
    pass_id: task.pass_id,
    lens: task.lens,
    file_coverage: task.file_paths.map((path) => ({
      path,
      total_lines: task.file_line_counts[path],
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
    task.tags.includes("lens_verification"),
  );
  assert.ok(steward, "should produce a lens steward task");
  // large_lens_surface fires: handler.ts (1800) + router.ts (250) = 2050 >= 2000
  assert.ok(
    steward.tags.includes("trigger:large_lens_surface"),
    "large_lens_surface should fire when totalLines >= 2000",
  );
});

test("lensVerificationTriggers totalLines: first-owner semantics — second source's lines for shared path are not double-counted", () => {
  // sources.length < 3, filePaths.length < 4, so large_lens_surface can only be
  // driven by totalLines here. The shared file has 1200 lines in source-1 and
  // 1200 in source-2. If double-counted it would be 2400 (fires); first-owner
  // gives 1200 + 700 = 1900 (does not fire). An external_analyzer_signal tag on
  // source-1 supplies an independent trigger so the steward is still built (the
  // surface triggers alone would not), letting us assert large_lens_surface is
  // absent — which proves the first-owner (non-double-counted) line total.
  const tasks = [
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
  const results = tasks.map((task) => ({
    task_id: task.task_id,
    unit_id: task.unit_id,
    pass_id: task.pass_id,
    lens: task.lens,
    file_coverage: task.file_paths.map((path) => ({
      path,
      total_lines: task.file_line_counts[path],
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
    task.tags.includes("lens_verification"),
  );
  assert.ok(steward, "should produce a lens steward task (sources.length=2)");
  // With first-owner semantics: src/big.ts=1200 (owned by src-big-a) +
  // src/other.ts=700 = 1900 < 2000 → large_lens_surface must NOT fire.
  assert.ok(
    !steward.tags.includes("trigger:large_lens_surface"),
    "large_lens_surface must NOT fire when first-owner totalLines < 2000",
  );
});

test("buildExternalSignalTasks skips malformed analyzer results and keeps valid ones", () => {
  const tasks = buildExternalSignalTasks(
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
    {},
    {
      tool: "semgrep",
      results: [
        null,
        { id: "bad", path: "src/api/auth.ts", category: 7, summary: "oops" },
        {
          id: "valid",
          path: "src/api/auth.ts",
          category: "security",
          severity: "error",
          summary: "Hard-coded credential path needs review",
          rule: "generic.secrets",
        },
      ],
    },
  );

  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].task_id, "analyzer:semgrep:security:src/api/auth.ts:valid");
  assert.equal(tasks[0].priority, "high");
});

test("conflictGroups suppresses group when both severitySpread and confidenceSpread are below 2", () => {
  // severity: medium/medium → spread = 0; confidence: high/medium → spread = 1
  // Both spreads < 2 → combined-spread guard triggers → no conflict task emitted
  const baseTask = {
    unit_id: "src-api-auth",
    pass_id: "pass:security",
    lens: "security",
    file_paths: ["src/api/auth.ts"],
    file_line_counts: { "src/api/auth.ts": 40 },
    rationale: "Audit auth",
    priority: "medium",
    status: "complete",
  };
  const taskA = { ...baseTask, task_id: "src-api-auth:security:a" };
  const taskB = { ...baseTask, task_id: "src-api-auth:security:b" };
  const makeFinding = (id, severity, confidence) => ({
    id,
    title: "Token validation",
    category: "auth",
    severity,
    confidence,
    lens: "security",
    summary: "Token validation issue.",
    affected_files: [{ path: "src/api/auth.ts", line_start: 12 }],
    evidence: ["src/api/auth.ts:12 - token check"],
  });
  const results = [
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
    task.tags.includes("trigger:conflicting_output"),
  );
  assert.equal(
    conflictTasks.length,
    0,
    `expected no conflict tasks when both spreads < 2, got: ${JSON.stringify(conflictTasks.map((t) => t.task_id))}`,
  );
});

test("conflictGroups keeps group when severitySpread >= 2 even if confidenceSpread < 2", () => {
  // severity: high(4) vs low(2) → spread = 2; confidence: high/high → spread = 0
  // severitySpread >= 2 → NOT (severitySpread < 2 && confidenceSpread < 2) → group kept
  const baseTask = {
    unit_id: "src-api-auth",
    pass_id: "pass:security",
    lens: "security",
    file_paths: ["src/api/auth.ts"],
    file_line_counts: { "src/api/auth.ts": 40 },
    rationale: "Audit auth",
    priority: "medium",
    status: "complete",
  };
  const taskA = { ...baseTask, task_id: "src-api-auth:security:c" };
  const taskB = { ...baseTask, task_id: "src-api-auth:security:d" };
  const makeFinding = (id, severity, confidence) => ({
    id,
    title: "Token validation",
    category: "auth",
    severity,
    confidence,
    lens: "security",
    summary: "Token validation issue.",
    affected_files: [{ path: "src/api/auth.ts", line_start: 12 }],
    evidence: ["src/api/auth.ts:12 - token check"],
  });
  const results = [
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
    task.tags.includes("trigger:conflicting_output"),
  );
  assert.ok(
    conflict,
    "expected a conflict task when severitySpread >= 2, even if confidenceSpread < 2",
  );
  assert.match(conflict.task_id, /^deepening:conflict:/);
});

test("conflictGroups keeps group when confidenceSpread >= 2 even if severitySpread < 2", () => {
  // severity: medium/medium → spread = 0; confidence: high(3) vs low(1) → spread = 2
  // confidenceSpread >= 2 → NOT (severitySpread < 2 && confidenceSpread < 2) → group kept
  const baseTask = {
    unit_id: "src-api-auth",
    pass_id: "pass:security",
    lens: "security",
    file_paths: ["src/api/auth.ts"],
    file_line_counts: { "src/api/auth.ts": 40 },
    rationale: "Audit auth",
    priority: "medium",
    status: "complete",
  };
  const taskA = { ...baseTask, task_id: "src-api-auth:security:e" };
  const taskB = { ...baseTask, task_id: "src-api-auth:security:f" };
  const makeFinding = (id, severity, confidence) => ({
    id,
    title: "Token validation",
    category: "auth",
    severity,
    confidence,
    lens: "security",
    summary: "Token validation issue.",
    affected_files: [{ path: "src/api/auth.ts", line_start: 12 }],
    evidence: ["src/api/auth.ts:12 - token check"],
  });
  const results = [
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
    task.tags.includes("trigger:conflicting_output"),
  );
  assert.ok(
    conflict,
    "expected a conflict task when confidenceSpread >= 2, even if severitySpread < 2",
  );
  assert.match(conflict.task_id, /^deepening:conflict:/);
});

// ── requeue folding ────────────────────────────────────────────────────────

const { runPlanningExecutor } = await import(
  "../src/orchestrator/planningExecutors.ts"
);

test("planning executor folds pending requeue tasks into review_packets", async () => {
  const tmpRoot = await mkdtemp(join(tmpdir(), "planning-requeue-"));
  try {
    const bundle = {
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

    // review_packets must be present and non-empty
    assert.ok(Array.isArray(result.updated.review_packets));
    assert.ok(
      result.updated.review_packets.length > 0,
      "expected at least one review packet",
    );

    // The requeue payload is built before folding; any pending requeue task
    // file paths must appear in review_packets
    const packetFilePaths = new Set(
      result.updated.review_packets.flatMap((p) => p.file_paths),
    );
    for (const requeueTask of (result.updated.requeue_tasks ?? []).filter(
      (t) => t.status === "pending",
    )) {
      for (const path of requeueTask.file_paths) {
        assert.ok(
          packetFilePaths.has(path),
          `requeue task path "${path}" must appear in at least one review packet`,
        );
      }
    }
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
});

test("ingestion executor folds pending requeue tasks for uncovered files into review_packets", () => {
  // Scenario: auth.ts is ingested (coverage complete), utils.ts has no task
  // and remains uncovered → buildRequeuePayload generates a pending task for
  // it → that task must appear in review_packets.
  const authTask = {
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
  const result = {
    task_id: authTask.task_id,
    unit_id: authTask.unit_id,
    pass_id: authTask.pass_id,
    lens: authTask.lens,
    file_coverage: [{ path: "src/api/auth.ts", total_lines: 30 }],
    findings: [],
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
  assert.ok(requeueTask, "expected a pending requeue task for src/lib/utils.ts");
  assert.equal(requeueTask.status, "pending");

  // The requeue task must appear in a review packet so dispatch actually covers it
  const packetFilePaths = new Set(
    (run.updated.review_packets ?? []).flatMap((p) => p.file_paths),
  );
  assert.ok(
    packetFilePaths.has("src/lib/utils.ts"),
    "src/lib/utils.ts from requeue task must appear in review_packets",
  );
  assert.ok(run.artifacts_written.includes("review_packets.json"));
});

test("ingestion executor deduplicates requeue tasks already present in audit_tasks", () => {
  // Scenario: utils.ts is already tracked as a "complete" task in audit_tasks.
  // After ingestion, buildRequeuePayload still generates a pending requeue task
  // for it (coverage is still marked pending), but the dedup guard must prevent
  // it from being added a second time via the requeue folding path.
  const authTask = {
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
  const utilsRequeueTask = {
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

  // review_packets must contain at most one entry for utils.ts (no duplicate packet)
  const utilsPackets = (run.updated.review_packets ?? []).filter((p) =>
    p.file_paths.includes("src/lib/utils.ts"),
  );
  const utilsTaskIds = utilsPackets.flatMap((p) => p.task_ids);
  const duplicates = utilsTaskIds.filter(
    (id) => utilsTaskIds.indexOf(id) !== utilsTaskIds.lastIndexOf(id),
  );
  assert.deepEqual(duplicates, [], "requeue task must not appear twice in review_packets");
});
