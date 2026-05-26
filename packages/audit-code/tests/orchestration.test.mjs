import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { decideNextStep } = await import("../dist/orchestrator/nextStep.js");
const { advanceAudit } = await import("../dist/orchestrator/advance.js");
const {
  computeArtifactMetadata,
} = await import("../dist/orchestrator/artifactMetadata.js");
const {
  buildAuditReportModel,
  renderAuditReportMarkdown,
} = await import("../dist/reporting/synthesis.js");

const FIXTURE_LINE_INDEX = {
  "src/api/auth.ts": 4,
  "src/lib/session.ts": 8,
  "infra/deploy.yml": 5,
  "package.json": 4,
};

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
    repo_manifest: createRepoManifest(),
    file_disposition: { files: [] },
    auto_fixes_applied: { applied: [] },
    external_analyzer_results: { tool: "eslint", results: [] },
    syntax_resolution_status: {
      tool: "syntax_resolution_executor",
      completed_at: "2026-04-22T00:00:00Z",
    },
    unit_manifest: createUnitManifest(),
    surface_manifest: { surfaces: [] },
    graph_bundle: { graphs: { imports: [], calls: [] } },
    critical_flows: { flows: [], fallback_required: false },
    risk_register: { entries: [] },
    design_assessment: { generated_at: "2026-04-22T00:00:00Z", findings: [], review_findings: [], reviewed: true },
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

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "auditor-lambda-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeFixtureRepo(root) {
  await mkdir(join(root, "src", "api"), { recursive: true });
  await mkdir(join(root, "src", "lib"), { recursive: true });
  await mkdir(join(root, "infra"), { recursive: true });

  await writeFile(
    join(root, "package.json"),
    JSON.stringify(
      {
        name: "fixture-app",
        version: "0.0.0",
      },
      null,
      2,
    ) + "\n",
  );

  await writeFile(
    join(root, "src", "api", "auth.ts"),
    [
      "export function authenticate(token: string): boolean {",
      "  return token.trim().length > 0;",
      "}",
      "",
    ].join("\n"),
  );

  await writeFile(
    join(root, "src", "lib", "session.ts"),
    [
      "export interface Session {",
      "  id: string;",
      "}",
      "",
      "export function createSession(id: string): Session {",
      "  return { id };",
      "}",
      "",
    ].join("\n"),
  );

  await writeFile(
    join(root, "infra", "deploy.yml"),
    [
      "name: deploy",
      "on: [push]",
      "jobs:",
      "  release:",
      "    runs-on: ubuntu-latest",
      "",
    ].join("\n"),
  );
}

function findObligation(state, id) {
  return state.obligations.find((item) => item.id === id);
}

async function buildSyntheticResults(tasks, lineIndex) {
  return tasks.map((task, index) => ({
    task_id: task.task_id,
    unit_id: task.unit_id,
    pass_id: task.pass_id,
    lens: task.lens,
    agent_role: "fixture-reviewer",
    file_coverage: task.file_paths.map((path) => ({
      path,
      total_lines: lineIndex[path],
    })),
    findings:
      index === 0
        ? [
            {
              id: "finding-auth-1",
              title: "Auth path lacks structured rejection telemetry",
              category: "security",
              severity: "medium",
              confidence: "medium",
              lens: task.lens,
              summary:
                "Authentication failures are not recorded with enough context.",
              affected_files: [
                { path: task.file_paths[0], line_start: 1, line_end: 3 },
              ],
              evidence: [`${task.file_paths[0]}:1 - no structured failure event`],
            },
          ]
        : [],
    notes: ["fixture ingestion"],
    requires_followup: false,
  }));
}

async function advanceFixtureToPlanning(root) {
  const intake = await advanceAudit({}, { root });
  const preparedBundle = {
    ...intake.updated_bundle,
    auto_fixes_applied: {
      executed_tools: [],
      timestamp: "2026-04-22T00:00:00Z",
    },
    external_analyzer_results: {
      tool: "syntax_resolution_executor",
      results: [],
    },
    syntax_resolution_status: {
      tool: "syntax_resolution_executor",
      completed_at: "2026-04-22T00:00:00Z",
    },
  };

  const structure = await advanceAudit(preparedBundle);

  const designAssessment = await advanceAudit(structure.updated_bundle);
  const designReview = await advanceAudit(designAssessment.updated_bundle);

  const planning = await advanceAudit(designReview.updated_bundle, {
    root,
    lineIndex: FIXTURE_LINE_INDEX,
  });

  return { planning, lineIndex: FIXTURE_LINE_INDEX };
}

test("decideNextStep covers representative priority states", () => {
  const intakeDecision = decideNextStep({
    repo_manifest: createRepoManifest(),
  });
  assert.equal(intakeDecision.selected_obligation, "file_disposition");
  assert.equal(intakeDecision.selected_executor, "intake_executor");

  const structureDecision = decideNextStep({
    repo_manifest: createRepoManifest(),
    file_disposition: { files: [] },
    auto_fixes_applied: { applied: [] },
    external_analyzer_results: { tool: "eslint", results: [] },
    syntax_resolution_status: {
      tool: "syntax_resolution_executor",
      completed_at: "2026-04-22T00:00:00Z",
    },
  });
  assert.equal(structureDecision.selected_obligation, "structure_artifacts");
  assert.equal(structureDecision.selected_executor, "structure_executor");

  const agentDecision = decideNextStep(
    withArtifactMetadata(createDecisionBundle()),
  );
  assert.equal(agentDecision.selected_obligation, "audit_tasks_completed");
  assert.equal(agentDecision.selected_executor, "agent");

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
  assert.equal(synthesisDecision.selected_obligation, "synthesis_current");
  assert.equal(synthesisDecision.selected_executor, "synthesis_executor");
});

test("advanceAudit planning stage builds tasks without requiring runtime validation", async () => {
  await withTempDir(async (root) => {
    await writeFixtureRepo(root);

    const { planning } = await advanceFixtureToPlanning(root);

    assert.equal(planning.selected_executor, "planning_executor");
    assert.ok(planning.updated_bundle.audit_tasks.length > 0);
    assert.equal(
      findObligation(planning.audit_state, "runtime_validation_current")?.state,
      "satisfied",
    );
    assert.equal(planning.next_likely_step, "audit_tasks_completed");
  });
});

test("advanceAudit pauses on agent handoff after planning artifacts exist", async () => {
  await withTempDir(async (root) => {
    await writeFixtureRepo(root);

    const { planning } = await advanceFixtureToPlanning(root);
    const handoff = await advanceAudit(planning.updated_bundle);

    assert.equal(handoff.selected_executor, "agent");
    assert.equal(handoff.selected_obligation, "audit_tasks_completed");
    assert.equal(handoff.progress_made, false);
    assert.equal(handoff.next_likely_step, "audit_tasks_completed");
    assert.match(handoff.progress_summary, /not yet dispatched through advance-audit/i);
  });
});

test("advanceAudit ingests explicit audit results and advances toward synthesis", async () => {
  await withTempDir(async (root) => {
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

    assert.equal(ingest.selected_executor, "result_ingestion_executor");
    assert.equal(ingest.selected_obligation, "forced:result_ingestion_executor");
    assert.equal(
      findObligation(ingest.audit_state, "audit_tasks_completed")?.state,
      "satisfied",
    );
    assert.equal(ingest.updated_bundle.audit_results.length, results.length);
    assert.equal(ingest.next_likely_step, "synthesis_current");
  });
});

test("advanceAudit renders a final audit report after synthesis", async () => {
  await withTempDir(async (root) => {
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

    assert.equal(synthesis.selected_executor, "synthesis_executor");
    assert.equal(synthesis.selected_obligation, "forced:synthesis_executor");
    assert.match(synthesis.updated_bundle.audit_report, /# Audit Report/);
    assert.match(
      synthesis.updated_bundle.audit_report,
      /finding-auth-1 .* Auth path lacks structured rejection telemetry/,
    );
    assert.equal(
      findObligation(synthesis.audit_state, "synthesis_current")?.state,
      "satisfied",
    );
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
      assert.match(
        error.message,
        /advanceAudit result_ingestion_executor failed while resolving forced:result_ingestion_executor/i,
      );
      assert.match(error.message, /Cannot ingest results without coverage_matrix/i);
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
    externalAnalyzerResults: {
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
    },
  });

  assert.equal(report.findings.length, 0);
  assert.equal(report.work_blocks.length, 0);
  assert.equal(report.summary.finding_count, 0);
  assert.equal(report.summary.work_block_count, 0);
  assert.equal(report.summary.audited_file_count, 1);
  assert.equal(report.summary.excluded_file_count, 1);
  assert.equal(report.summary.runtime_validation_status_breakdown.confirmed, 1);

  const markdown = renderAuditReportMarkdown(report);
  assert.match(markdown, /No remediation work blocks were generated\./);
  assert.match(markdown, /No findings were recorded\./);
});

test("buildAuditReportModel keeps location-distinct findings separate while merging exact duplicates", () => {
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
            id: "finding-session-distinct",
            title: "Missing audit trail",
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
    externalAnalyzerResults: {
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
    },
  });

  assert.equal(report.findings.length, 2);
  assert.equal(report.summary.finding_count, 2);

  const mergedFinding = report.findings[0];
  assert.equal(mergedFinding.severity, "high");
  assert.equal(mergedFinding.confidence, "high");
  assert.equal(
    mergedFinding.summary,
    "Authentication failures are not logged consistently across auth helpers.",
  );
  assert.deepEqual(
    mergedFinding.affected_files.map(
      (file) => `${file.path}:${file.line_start ?? ""}`,
    ),
    ["src/api/auth.ts:2", "src/lib/session.ts:10"],
  );
  assert.ok(
    mergedFinding.evidence.some(
      (entry) =>
        entry.includes("rv-orphan: confirmed") &&
        entry.includes("Detached runtime replay still corroborated the issue."),
    ),
  );
  assert.ok(
    mergedFinding.evidence.includes(
      "external:eslint:src/api/auth.ts:Static analysis corroborated the auth-path gap.",
    ),
  );
  assert.equal(
    mergedFinding.evidence.some((entry) => /pending runtime evidence/i.test(entry)),
    false,
  );

  const distinctFinding = report.findings[1];
  assert.equal(distinctFinding.id, "finding-session-distinct");
  assert.equal(distinctFinding.affected_files[0].path, "src/lib/session.ts");

  const markdown = renderAuditReportMarkdown(report);
  assert.match(markdown, /### finding-auth-low .* Missing audit trail/);
  assert.match(markdown, /### finding-session-distinct .* Missing audit trail/);
});
