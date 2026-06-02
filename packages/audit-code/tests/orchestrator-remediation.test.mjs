import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { advanceAudit } = await import("../dist/orchestrator/advance.js");
const {
  runExternalAnalyzerImportExecutor,
  runResultIngestionExecutor,
  runRuntimeValidationUpdateExecutor,
} = await import("../dist/orchestrator/internalExecutors.js");
const { resolveRuntimeValidationSpawnCommand } = await import(
  "../dist/orchestrator/runtimeCommand.js"
);
const { deriveAuditState } = await import("../dist/orchestrator/state.js");
const { buildFlowCoverage } =
  await import("../dist/orchestrator/flowCoverage.js");
const { buildFlowRequeueTasks } =
  await import("../dist/orchestrator/flowRequeue.js");
const { buildRequeueTasks } = await import("../dist/orchestrator/requeue.js");
const { buildExternalSignalTasks } =
  await import("../dist/orchestrator/taskBuilder.js");
const { buildSelectiveDeepeningTasks } =
  await import("../dist/orchestrator/selectiveDeepening.js");
const { ingestAuditResults } =
  await import("../dist/orchestrator/resultIngestion.js");

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
  assert.equal(coverage.flows[0].status, "pending");
});

test("buildFlowRequeueTasks rejects unsupported flow lenses loudly", () => {
  assert.throws(
    () =>
      buildFlowRequeueTasks(
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
              required_lenses: ["mystery"],
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
      ),
    /unsupported lens "mystery"/i,
  );
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
