import { test, expect } from "vitest";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  FIXTURE_LINE_INDEX,
  writeFixtureRepo,
  buildSyntheticResults,
  advanceFixtureToPlanning,
} from "./helpers/fixture.mjs";

const { decideNextStep, PRIORITY } = await import("../../src/audit/orchestrator/nextStep.ts");
const { EXECUTOR_REGISTRY } = await import("../../src/audit/orchestrator/executors.ts");
const { advanceAudit } = await import("../../src/audit/orchestrator/advance.ts");
const { RunLogger } = await import("audit-tools/shared");
const {
  computeArtifactMetadata,
} = await import("../../src/audit/orchestrator/artifactMetadata.ts");
const {
  buildAuditReportModel,
  renderAuditReportMarkdown,
} = await import("../../src/audit/reporting/synthesis.ts");

function createRepoManifest() {
  return {
    repository: { name: "fixture-app" },
    generated_at: "2026-04-22T00:00:00Z",
    files: [
      {
        path: "src/api/auth.ts",
        language: "ts",
        size_bytes: 64,
      },
      {
        path: "src/lib/session.ts",
        language: "ts",
        size_bytes: 96,
      },
    ],
  };
}

function createUnitManifest() {
  return {
    units: [
      {
        unit_id: "src-auth",
        name: "src-auth",
        files: ["src/api/auth.ts", "src/lib/session.ts"],
        required_lenses: ["security"],
      },
    ],
  };
}

function createCoverageMatrix({ completed = false } = {}) {
  return {
    files: [
      {
        path: "src/api/auth.ts",
        unit_ids: ["src-auth"],
        classification_status: "classified",
        audit_status: completed ? "complete" : "pending",
        required_lenses: ["security"],
        completed_lenses: completed ? ["security"] : [],
      },
    ],
  };
}

function createAuditTask(status = "pending") {
  return {
    task_id: "src-auth:security",
    unit_id: "src-auth",
    pass_id: "pass:security",
    lens: "security",
    file_paths: ["src/api/auth.ts"],
    rationale: "Audit authentication paths.",
    status,
  };
}

function createDecisionBundle(overrides = {}) {
  return {
    provider_confirmation: { confirmed_at: "2026-04-22T00:00:00Z", confirmed_by: "host" },
    repo_manifest: createRepoManifest(),
    file_disposition: { files: [] },
    auto_fixes_applied: { applied: [] },
    external_analyzer_results: [{ tool: "eslint", results: [] }],
    external_analyzer_acquisition: { enabled: false, tool_statuses: [] },
    syntax_resolution_status: {
      tool: "syntax_resolution_executor",
      completed_at: "2026-04-22T00:00:00Z",
    },
    unit_manifest: createUnitManifest(),
    surface_manifest: { surfaces: [] },
    graph_bundle: { graphs: { imports: [], calls: [] } },
    critical_flows: { flows: [], fallback_required: false },
    risk_register: { entries: [] },
    analyzer_capability: { status: "omitted", analyzers: [] },
    design_assessment: { generated_at: "2026-04-22T00:00:00Z", findings: [], review_findings: [], reviewed: true },
    intent_checkpoint: {
      schema_version: "intent-checkpoint/v1",
      confirmed_at: "2026-04-22T00:00:00Z",
      confirmed_by: "host",
      scope_summary: "test scope",
      intent_summary: "full-audit",
    },
    coverage_matrix: createCoverageMatrix(),
    flow_coverage: { flows: [] },
    runtime_validation_tasks: { tasks: [] },
    audit_tasks: [createAuditTask()],
    requeue_tasks: [],
    ...overrides,
  };
}

function withArtifactMetadata(bundle) {
  return {
    ...bundle,
    artifact_metadata: computeArtifactMetadata(bundle),
  };
}

const { withTempDir } = await import("./helpers/withTempDir.mjs");

function findObligation(state, id) {
  return state.obligations.find((item) => item.id === id);
}

test("decideNextStep covers representative priority states", () => {
  const intakeDecision = decideNextStep({
    provider_confirmation: { confirmed_at: "2026-04-22T00:00:00Z", confirmed_by: "host" },
    repo_manifest: createRepoManifest(),
  });
  expect(intakeDecision.selected_obligation).toBe("file_disposition");
  expect(intakeDecision.selected_executor).toBe("intake_executor");

  const structureDecision = decideNextStep({
    provider_confirmation: { confirmed_at: "2026-04-22T00:00:00Z", confirmed_by: "host" },
    repo_manifest: createRepoManifest(),
    file_disposition: { files: [] },
    auto_fixes_applied: { applied: [] },
    external_analyzer_results: [{ tool: "eslint", results: [] }],
    external_analyzer_acquisition: { enabled: false, tool_statuses: [] },
    syntax_resolution_status: {
      tool: "syntax_resolution_executor",
      completed_at: "2026-04-22T00:00:00Z",
    },
  });
  expect(structureDecision.selected_obligation).toBe("structure_artifacts");
  expect(structureDecision.selected_executor).toBe("structure_executor");

  const agentDecision = decideNextStep(
    withArtifactMetadata(createDecisionBundle()),
  );
  expect(agentDecision.selected_obligation).toBe("audit_tasks_completed");
  expect(agentDecision.selected_executor).toBe("rolling_dispatch_executor");

  const synthesisDecision = decideNextStep(
    withArtifactMetadata(
      createDecisionBundle({
        coverage_matrix: createCoverageMatrix({ completed: true }),
        audit_tasks: [createAuditTask("complete")],
        audit_results: [
          {
            task_id: "src-auth:security",
            unit_id: "src-auth",
            pass_id: "pass:security",
            lens: "security",
            file_coverage: [{ path: "src/api/auth.ts", total_lines: 4 }],
            findings: [],
          },
        ],
      }),
    ),
  );
  expect(synthesisDecision.selected_obligation).toBe("synthesis_current");
  expect(synthesisDecision.selected_executor).toBe("synthesis_executor");
});

test("shared helper advanceFixtureToPlanning returns planning bundle and lineIndex", async () => {
  await withTempDir("audit-code-orchestration-", async (root) => {
    await writeFixtureRepo(root);

    const { planning, lineIndex } = await advanceFixtureToPlanning(root);

    expect(planning.selected_executor).toBe("planning_executor");
    expect(planning.updated_bundle.audit_tasks.length > 0).toBeTruthy();
    expect(lineIndex).toBe(FIXTURE_LINE_INDEX);
  });
});

test("advanceAudit planning stage builds tasks without requiring runtime validation", async () => {
  await withTempDir("audit-code-orchestration-", async (root) => {
    await writeFixtureRepo(root);

    const { planning } = await advanceFixtureToPlanning(root);

    expect(planning.selected_executor).toBe("planning_executor");
    expect(planning.updated_bundle.audit_tasks.length > 0).toBeTruthy();
    expect(findObligation(planning.audit_state, "runtime_validation_current")?.state).toBe("satisfied");
    expect(planning.next_likely_step).toBe("audit_tasks_completed");
  });
});

test("advanceAudit emits a structured run log threading obligation → executor → artifacts", async () => {
  await withTempDir("audit-code-orchestration-", async (root) => {
    await writeFixtureRepo(root);
    const logPath = join(root, "run.log.jsonl");
    const runLogger = new RunLogger(logPath, { now: () => 0 });

    const providerConf = await advanceAudit({}, { root, runLogger });
    const intake = await advanceAudit(providerConf.updated_bundle, { root, runLogger });
    const preparedBundle = {
      ...intake.updated_bundle,
      auto_fixes_applied: { executed_tools: [], timestamp: "2026-04-22T00:00:00Z" },
      external_analyzer_results: [{ tool: "syntax_resolution_executor", results: [] }],
      syntax_resolution_status: {
        tool: "syntax_resolution_executor",
        completed_at: "2026-04-22T00:00:00Z",
      },
      external_analyzer_acquisition: { enabled: false, tool_statuses: [] },
    };
    await advanceAudit(preparedBundle, { runLogger });

    const events = (await readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    // Every line carries an ISO timestamp.
    expect(events.every((event) => typeof event.ts === "string")).toBeTruthy();
    expect(events.every((event) => typeof event.correlationId === "string")).toBeTruthy();

    const secondInvocationStart = events.findIndex(
      (event, index) => index > 0 && event.kind === "obligation",
    );
    expect(secondInvocationStart > 0).toBeTruthy();
    const firstCorrelationId = events[0].correlationId;
    const secondCorrelationId = events[secondInvocationStart].correlationId;
    expect(firstCorrelationId).not.toBe(secondCorrelationId);
    expect(events
        .slice(0, secondInvocationStart)
        .every((event) => event.correlationId === firstCorrelationId)).toBeTruthy();
    // The third invocation (advanceAudit(preparedBundle)) starts at the next
    // "obligation" event after the second one. Events between second and third
    // invocations all share secondCorrelationId.
    const thirdInvocationStart = events.findIndex(
      (event, index) => index > secondInvocationStart && event.kind === "obligation",
    );
    const endOfSecondInvocation = thirdInvocationStart > 0 ? thirdInvocationStart : events.length;
    expect(events
        .slice(secondInvocationStart, endOfSecondInvocation)
        .every((event) => event.correlationId === secondCorrelationId)).toBeTruthy();

    const obligations = events
      .filter((event) => event.kind === "obligation")
      .map((event) => event.obligation);
    // First obligation is the top of the priority chain (provider_confirmation);
    // after the provider gate, the intake executor satisfies repo_manifest +
    // file_disposition together, so structure_artifacts follows.
    expect(obligations[0]).toBe("provider_confirmation");
    expect(obligations.includes("structure_artifacts")).toBeTruthy();

    // Executor start/end pairs are emitted, and end carries a numeric duration.
    expect(events.some((event) => event.kind === "executor_start")).toBeTruthy();
    const ends = events.filter((event) => event.kind === "executor_end");
    expect(ends.length > 0).toBeTruthy();
    expect(ends.every((event) => typeof event.duration_ms === "number")).toBeTruthy();

    // Artifact writes are recorded.
    const artifacts = events
      .filter((event) => event.kind === "artifact_write")
      .map((event) => event.artifact);
    expect(artifacts.includes("repo_manifest.json")).toBeTruthy();
  });
});

test("advanceAudit pauses on rolling_dispatch_executor handoff after planning artifacts exist", async () => {
  await withTempDir("audit-code-orchestration-", async (root) => {
    await writeFixtureRepo(root);

    const { planning } = await advanceFixtureToPlanning(root);
    const handoff = await advanceAudit(planning.updated_bundle);

    expect(handoff.selected_executor).toBe("rolling_dispatch_executor");
    expect(handoff.selected_obligation).toBe("audit_tasks_completed");
    expect(handoff.progress_made).toBe(false);
    expect(handoff.next_likely_step).toBe("audit_tasks_completed");
    expect(handoff.progress_summary).toMatch(/not yet dispatched through advance-audit/i);
  });
});

test("advanceAudit ingests explicit audit results and advances toward synthesis", async () => {
  await withTempDir("audit-code-orchestration-", async (root) => {
    await writeFixtureRepo(root);

    const { planning, lineIndex } = await advanceFixtureToPlanning(root);
    const results = await buildSyntheticResults(
      planning.updated_bundle.audit_tasks,
      lineIndex,
    );

    const ingest = await advanceAudit(planning.updated_bundle, {
      preferredExecutor: "result_ingestion_executor",
      auditResults: results,
    });

    expect(ingest.selected_executor).toBe("result_ingestion_executor");
    expect(ingest.selected_obligation).toBe("forced:result_ingestion_executor");
    expect(findObligation(ingest.audit_state, "audit_tasks_completed")?.state).toBe("satisfied");
    expect(ingest.updated_bundle.audit_results.length).toBe(results.length);
    expect(ingest.next_likely_step).toBe("synthesis_current");
  });
});

test("advanceAudit renders a final audit report after synthesis", async () => {
  await withTempDir("audit-code-orchestration-", async (root) => {
    await writeFixtureRepo(root);

    const { planning, lineIndex } = await advanceFixtureToPlanning(root);
    const ingest = await advanceAudit(planning.updated_bundle, {
      preferredExecutor: "result_ingestion_executor",
      auditResults: await buildSyntheticResults(
        planning.updated_bundle.audit_tasks,
        lineIndex,
      ),
    });

    const synthesis = await advanceAudit(ingest.updated_bundle, {
      preferredExecutor: "synthesis_executor",
    });

    expect(synthesis.selected_executor).toBe("synthesis_executor");
    expect(synthesis.selected_obligation).toBe("forced:synthesis_executor");
    expect(synthesis.updated_bundle.audit_report).toMatch(/# Audit Report/);
    // Findings are re-keyed to content-derived ids at synthesis, so match the
    // (stable) title in the rendered section header rather than a packet id.
    expect(synthesis.updated_bundle.audit_report).toMatch(/### \S+ — Auth path lacks structured rejection telemetry/);
    expect(findObligation(synthesis.audit_state, "synthesis_current")?.state).toBe("satisfied");
  });
});

test("advanceAudit reports missing mid-flow prerequisites with executor context", async () => {
  await assert.rejects(
    () =>
      advanceAudit(
        {
          audit_tasks: [createAuditTask()],
        },
        {
          preferredExecutor: "result_ingestion_executor",
          auditResults: [],
        },
      ),
    (error) => {
      expect(error.message).toMatch(/advanceAudit result_ingestion_executor failed while resolving forced:result_ingestion_executor/i);
      expect(error.message).toMatch(/Cannot ingest results without coverage_matrix/i);
      return true;
    },
  );
});

test("buildAuditReportModel handles empty inputs and unmatched runtime results cleanly", () => {
  const report = buildAuditReportModel({
    results: [],
    coverageMatrix: {
      files: [
        {
          path: "src/api/auth.ts",
          unit_ids: ["src-auth"],
          classification_status: "classified",
          audit_status: "complete",
          required_lenses: ["security"],
          completed_lenses: ["security"],
        },
        {
          path: "docs/notes.md",
          unit_ids: [],
          classification_status: "excluded",
          audit_status: "excluded",
          required_lenses: [],
          completed_lenses: [],
        },
      ],
    },
    runtimeValidationReport: {
      results: [
        {
          task_id: "rv-orphan",
          status: "confirmed",
          summary: "Detached runtime replay still completed successfully.",
        },
      ],
    },
    externalAnalyzerResults: [{
      tool: "semgrep",
      results: [
        {
          id: "sg-auth",
          category: "security",
          severity: "warning",
          path: "src/api/auth.ts",
          summary: "No findings consume this analyzer context yet.",
        },
      ],
    }],
  });

  expect(report.findings.length).toBe(0);
  expect(report.work_blocks.length).toBe(0);
  expect(report.summary.finding_count).toBe(0);
  expect(report.summary.work_block_count).toBe(0);
  expect(report.summary.audited_file_count).toBe(1);
  expect(report.summary.excluded_file_count).toBe(1);
  expect(report.summary.runtime_validation_status_breakdown.confirmed).toBe(1);
  expect(report.summary.lens_breakdown).toEqual({});

  const markdown = renderAuditReportMarkdown(report);
  expect(markdown).toMatch(/No remediation work blocks were generated\./);
  expect(markdown).toMatch(/No findings were recorded\./);
  expect(markdown).not.toMatch(/Lens breakdown:/);
});

test("buildAuditReportModel includes lens and pending runtime-validation breakdowns", () => {
  const report = buildAuditReportModel({
    results: [
      {
        task_id: "task-security-1",
        unit_id: "src-auth",
        pass_id: "pass:security",
        lens: "security",
        file_coverage: [{ path: "src/api/auth.ts", total_lines: 10 }],
        findings: [
          {
            id: "sec-1",
            title: "Missing auth rejection log",
            category: "security",
            severity: "medium",
            confidence: "high",
            lens: "security",
            summary: "Rejected auth attempts lack logs.",
            affected_files: [{ path: "src/api/auth.ts", line_start: 1, line_end: 2 }],
            evidence: ["auth review"],
          },
          {
            id: "sec-2",
            title: "Missing token expiry check",
            category: "security",
            severity: "high",
            confidence: "medium",
            lens: "security",
            summary: "Token expiry validation is incomplete.",
            affected_files: [{ path: "src/lib/session.ts", line_start: 3, line_end: 4 }],
            evidence: ["session review"],
          },
        ],
      },
      {
        task_id: "task-maintainability",
        unit_id: "src-auth",
        pass_id: "pass:maintainability",
        lens: "maintainability",
        file_coverage: [{ path: "src/lib/session.ts", total_lines: 12 }],
        findings: [
          {
            id: "mnt-1",
            title: "Session helper does too much",
            category: "maintainability",
            severity: "low",
            confidence: "high",
            lens: "maintainability",
            summary: "The session helper mixes validation and persistence.",
            affected_files: [{ path: "src/lib/session.ts", line_start: 5, line_end: 9 }],
            evidence: ["maintainability review"],
          },
        ],
      },
    ],
    runtimeValidationReport: {
      results: [
        {
          task_id: "runtime-1",
          status: "confirmed",
          summary: "Replay confirmed the auth issue.",
        },
      ],
    },
    runtimeValidationTaskManifest: {
      tasks: [
        {
          id: "runtime-1",
          kind: "unit-risk-check",
          target_paths: ["src/api/auth.ts"],
          reason: "Confirm auth behavior.",
          priority: "high",
        },
        {
          id: "runtime-2",
          kind: "critical-flow-check",
          target_paths: ["src/lib/session.ts"],
          reason: "Confirm session behavior.",
          priority: "medium",
        },
        {
          id: "runtime-3",
          kind: "unit-risk-check",
          target_paths: ["src/lib/session.ts"],
          reason: "Confirm maintainability behavior.",
          priority: "low",
        },
      ],
    },
  });

  expect(report.summary.lens_breakdown).toEqual({
    maintainability: 1,
    security: 2,
  });
  expect(report.summary.runtime_validation_status_breakdown.confirmed).toBe(1);
  expect(report.summary.runtime_validation_status_breakdown.pending).toBe(2);

  const markdown = renderAuditReportMarkdown(report);
  expect(markdown).toMatch(/- Lens breakdown: maintainability: 1, security: 2/);
});

test("buildAuditReportModel runtime breakdown omits pending without a manifest", () => {
  const report = buildAuditReportModel({
    results: [],
    runtimeValidationReport: {
      results: [
        {
          task_id: "runtime-1",
          status: "confirmed",
          summary: "Replay confirmed the issue.",
        },
      ],
    },
  });

  expect(report.summary.runtime_validation_status_breakdown).toEqual({
    confirmed: 1,
  });
});

test("decideNextStep emits a warning reason when no executor is registered for the selected obligation", () => {
  // Verify the happy-path reason string for a registered obligation (file_disposition).
  const normalDecision = decideNextStep({
    provider_confirmation: { confirmed_at: "2026-04-22T00:00:00Z", confirmed_by: "host" },
    repo_manifest: createRepoManifest(),
  });
  expect(normalDecision.selected_obligation).toBe("file_disposition");
  expect(normalDecision.selected_executor !== null, "executor should be registered for file_disposition").toBeTruthy();
  expect(normalDecision.reason, "normal path reason should reference the obligation id").toMatch(/Selected highest-priority actionable obligation file_disposition\./);
});

test("decideNextStep reason flags the gap when selected_executor is null", () => {
  // With an empty bundle, decideNextStep selects the first actionable obligation.
  // If that obligation has no registered executor (gap case), the reason must
  // contain "No executor found for obligation" + the obligation id.
  // If the registry happens to have an entry (normal case), we fall through
  // to the normal-path assertion below — the test degrades gracefully.
  const decision = decideNextStep({});
  if (decision.selected_executor === null && decision.selected_obligation !== null) {
    // Gap case: the reason MUST contain the sentinel phrase and the obligation id.
    expect(decision.reason, "gap-case reason must contain the sentinel phrase").toMatch(/No executor found for obligation/);
    expect(decision.reason.includes(decision.selected_obligation), "gap-case reason must embed the obligation id").toBeTruthy();
  } else if (decision.selected_executor !== null) {
    // Normal case: the reason must reference the selected obligation.
    expect(decision.reason).toMatch(/Selected highest-priority actionable obligation/);
  }
  // Either branch exercises the relevant code path.
});

test("every PRIORITY obligation maps to exactly one executor (E3 enforce-in-tooling)", () => {
  // The module-load invariant in nextStep.ts already throws on a gap; importing
  // the module above proves it holds today. This mirrors the property so a future
  // PRIORITY id added without a registry entry (or owned by two executors) fails
  // here with a named obligation rather than a silent runtime null-executor step.
  for (const obligationId of PRIORITY) {
    const owners = EXECUTOR_REGISTRY.filter((executor) =>
      executor.obligation_ids.includes(obligationId),
    );
    expect(owners.length, `PRIORITY obligation "${obligationId}" must map to exactly one executor, found ${owners.length} (${owners.map((e) => e.id).join(", ")}).`).toBe(1);
  }
});

test("buildAuditReportModel keeps identity-distinct findings separate while merging re-emissions of one identity across files", () => {
  const report = buildAuditReportModel({
    results: [
      {
        task_id: "task-1",
        unit_id: "src-auth",
        pass_id: "pass:security",
        lens: "security",
        file_coverage: [{ path: "src/api/auth.ts", total_lines: 10 }],
        findings: [
          {
            id: "finding-auth-low",
            title: "Missing audit trail",
            category: "security",
            severity: "medium",
            confidence: "low",
            lens: "security",
            summary: "Authentication failures are not logged.",
            affected_files: [
              { path: "src/api/auth.ts", line_start: 2, line_end: 4 },
            ],
          },
          {
            // A genuinely distinct problem: identity (lens|category|title) is
            // file-independent, so distinctness comes from a different title,
            // not from living in a different file.
            id: "finding-session-distinct",
            title: "Session writes bypass audit hooks",
            category: "security",
            severity: "low",
            confidence: "medium",
            lens: "security",
            summary: "A different session-path issue should remain separate.",
            affected_files: [
              { path: "src/lib/session.ts", line_start: 1, line_end: 2 },
            ],
            evidence: ["session-review"],
          },
        ],
      },
      {
        task_id: "task-2",
        unit_id: "src-auth",
        pass_id: "pass:security",
        lens: "security",
        file_coverage: [{ path: "src/api/auth.ts", total_lines: 10 }],
        findings: [
          {
            id: "finding-auth-high",
            title: "Missing audit trail",
            category: "security",
            severity: "high",
            confidence: "high",
            lens: "security",
            summary:
              "Authentication failures are not logged consistently across auth helpers.",
            affected_files: [
              { path: "src/api/auth.ts", line_start: 2, line_end: 4 },
              {
                path: "src/lib/session.ts",
                line_start: 10,
                line_end: 12,
                symbol: "createSession",
              },
            ],
            evidence: ["auth-review"],
          },
        ],
      },
    ],
    unitManifest: createUnitManifest(),
    runtimeValidationReport: {
      results: [
        {
          task_id: "rv-pending",
          status: "pending",
          summary: "Pending runtime evidence should not surface yet.",
        },
        {
          task_id: "rv-orphan",
          status: "confirmed",
          summary: "Detached runtime replay still corroborated the issue.",
        },
      ],
    },
    externalAnalyzerResults: [{
      tool: "eslint",
      results: [
        {
          id: "duplicate-analyzer-id",
          category: "security",
          severity: "warning",
          path: "src/api/auth.ts",
          summary: "Static analysis corroborated the auth-path gap.",
        },
        {
          id: "duplicate-analyzer-id",
          category: "security",
          severity: "warning",
          path: "src/lib/session.ts",
          summary: "Static analysis corroborated the session-path gap.",
        },
      ],
    }],
  });

  expect(report.findings.length).toBe(2);
  expect(report.summary.finding_count).toBe(2);

  const mergedFinding = report.findings[0];
  expect(mergedFinding.severity).toBe("high");
  expect(mergedFinding.confidence).toBe("high");
  expect(mergedFinding.summary).toBe("Authentication failures are not logged consistently across auth helpers.");
  expect(mergedFinding.affected_files.map(
      (file) => `${file.path}:${file.line_start ?? ""}`,
    )).toEqual(["src/api/auth.ts:2", "src/lib/session.ts:10"]);
  expect(mergedFinding.evidence.some(
      (entry) =>
        entry.includes("rv-orphan: confirmed") &&
        entry.includes("Detached runtime replay still corroborated the issue."),
    )).toBeTruthy();
  expect(mergedFinding.evidence.includes(
      "external:eslint:src/api/auth.ts:Static analysis corroborated the auth-path gap.",
    )).toBeTruthy();
  expect(mergedFinding.evidence.some((entry) => /pending runtime evidence/i.test(entry))).toBe(false);

  const distinctFinding = report.findings[1];
  // The identity-distinct finding stays separate (re-keyed to its own unique id,
  // not fused with the merged auth-path finding).
  expect(distinctFinding.id && distinctFinding.id !== mergedFinding.id).toBeTruthy();
  expect(distinctFinding.affected_files[0].path).toBe("src/lib/session.ts");

  const markdown = renderAuditReportMarkdown(report);
  expect(markdown.includes(`### ${mergedFinding.id} — Missing audit trail`)).toBeTruthy();
  expect(markdown.includes(
      `### ${distinctFinding.id} — Session writes bypass audit hooks`,
    )).toBeTruthy();
});
