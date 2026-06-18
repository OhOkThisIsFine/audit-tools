import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LensSchema,
  SurfaceManifestSchema,
  GraphBundleSchema,
  GraphEdgeSchema,
  RiskRegisterSchema,
} from "audit-tools/shared";
import { RepoManifestSchema, UnitManifestSchema } from "../../src/audit/types.ts";
import { AuditPlanMetricsSchema } from "../../src/audit/types/reviewPlanning.ts";
import { RuntimeValidationTaskManifestSchema } from "../../src/audit/types/runtimeValidation.ts";
import { ExternalAnalyzerResultsSchema } from "../../src/audit/types/externalAnalyzer.ts";
import {
  WorkerAuditResultSchema,
  WorkerAuditResultsSchema,
  WorkerAuditTaskSchema,
} from "../../src/audit/contracts/workerSchemas.ts";
import { DispatchQuotaSchema } from "../../src/audit/quota/index.ts";
import { StepArtifactSchema } from "../../src/audit/cli/steps.ts";
import { buildUnitManifest } from "../../src/audit/orchestrator/unitBuilder.ts";
import { buildRiskRegister } from "../../src/audit/extractors/risk.ts";
import { buildSurfaceManifest } from "../../src/audit/extractors/surfaces.ts";
import { buildGraphBundle } from "../../src/audit/extractors/graph.ts";
import { buildRuntimeValidationTasks } from "../../src/audit/orchestrator/runtimeValidation.ts";
import { buildAuditPlanMetrics } from "../../src/audit/orchestrator/reviewPackets.ts";

// A6: every artifact contract is single-sourced as a zod schema. These tests
// validate real builder output (and hand-crafted edge cases) against the zod
// schema directly via `.parse` / `.safeParse` — there is no separate JSON-schema
// document or hand-rolled validator any more. The 5 worker-facing JSON schemas
// are GENERATED from the same zod sources (see worker-schema-generation.test.mjs);
// the lens-vocabulary drift guard at the bottom covers those.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");

/** Assert `value` satisfies `schema`; surface the zod issues on failure. */
function accepts(schema, value, label) {
  const result = schema.safeParse(value);
  assert.ok(
    result.success,
    `${label} should satisfy schema but did not: ${
      result.success ? "" : JSON.stringify(result.error.issues)
    }`,
  );
}

/** Assert `value` is rejected by `schema`. */
function rejects(schema, value, label) {
  assert.equal(
    schema.safeParse(value).success,
    false,
    `${label} should have been rejected by schema`,
  );
}

// ---------------------------------------------------------------------------
// Worker-facing audit result / finding / task contracts.
// ---------------------------------------------------------------------------

test("worker audit result rejects a non-canonical finding lens", () => {
  rejects(
    WorkerAuditResultSchema,
    {
      task_id: "task-1",
      unit_id: "unit-1",
      pass_id: "pass:security",
      lens: "security",
      file_coverage: [{ path: "src/api/auth.ts", total_lines: 12 }],
      findings: [
        {
          id: "finding-1",
          title: "Bad finding",
          category: "security",
          severity: "high",
          confidence: "high",
          lens: "bogus",
          summary: "Should fail through the canonical lens enum.",
          affected_files: [{ path: "src/api/auth.ts" }],
          evidence: ["src/api/auth.ts:1 - detail"],
        },
      ],
    },
    "auditResult with bogus finding lens",
  );
});

test("worker audit result accepts an empty findings array", () => {
  accepts(
    WorkerAuditResultSchema,
    {
      task_id: "task-empty",
      unit_id: "unit-empty",
      pass_id: "pass:reliability",
      lens: "reliability",
      file_coverage: [{ path: "src/empty.ts", total_lines: 0 }],
      findings: [],
    },
    "auditResult with empty findings",
  );
});

test("worker audit result accepts a verification shape", () => {
  accepts(
    WorkerAuditResultSchema,
    {
      task_id: "deepening:steward:security",
      unit_id: "lens-steward:security",
      pass_id: "lens-steward:security",
      lens: "security",
      file_coverage: [{ path: "src/api/auth.ts", total_lines: 10 }],
      findings: [],
      verification: {
        verified: false,
        needs_followup: true,
        concerns: ["High-risk clean result needs a targeted re-check."],
        coverage_concerns: ["External analyzer signal was not clearly resolved."],
        confidence_concerns: ["Severity confidence varied across related packets."],
        followup_tasks: [
          {
            task_id: "suggested-auth-recheck",
            unit_id: "src-api-auth",
            pass_id: "deepening:security",
            lens: "security",
            file_paths: ["src/api/auth.ts"],
            rationale: "Re-check token boundary handling.",
            priority: "high",
            tags: ["suggested"],
          },
        ],
      },
    },
    "auditResult with verification",
  );
});

test("worker audit result accepts a category more specific than its lens", () => {
  accepts(
    WorkerAuditResultSchema,
    {
      task_id: "task-specific-category",
      unit_id: "unit-category",
      pass_id: "pass:security",
      lens: "security",
      file_coverage: [{ path: "src/api/auth.ts", total_lines: 10 }],
      findings: [
        {
          id: "finding-category",
          title: "Specific category is allowed",
          category: "command-execution",
          severity: "high",
          confidence: "high",
          lens: "security",
          summary: "The category field can be more specific than the lens.",
          affected_files: [{ path: "src/api/auth.ts", line_start: 1 }],
          evidence: ["src/api/auth.ts:1 - command boundary"],
        },
      ],
    },
    "auditResult with specific category",
  );
});

test("worker audit results require an array, not a single object", () => {
  accepts(
    WorkerAuditResultsSchema,
    [
      {
        task_id: "task-array",
        unit_id: "unit-array",
        pass_id: "pass:correctness",
        lens: "correctness",
        file_coverage: [{ path: "src/index.ts", total_lines: 1 }],
        findings: [],
      },
    ],
    "auditResults array",
  );

  rejects(
    WorkerAuditResultsSchema,
    {
      task_id: "task-object",
      unit_id: "unit-object",
      pass_id: "pass:correctness",
      lens: "correctness",
      file_coverage: [{ path: "src/index.ts", total_lines: 1 }],
      findings: [],
    },
    "auditResults as a plain object",
  );
});

test("worker audit task enforces lens, priority, tags, inputs, and strict keys", () => {
  accepts(
    WorkerAuditTaskSchema,
    {
      task_id: "task-1",
      unit_id: "unit-1",
      pass_id: "pass:security",
      lens: "security",
      file_paths: ["src/api/auth.ts"],
      file_line_counts: { "src/api/auth.ts": 12 },
      inputs: { unit_manifest_ref: "unit_manifest.json", custom_ref: "custom.json" },
      rationale: "Review the auth path.",
      priority: "high",
      tags: ["auth", "critical-flow"],
      status: "pending",
    },
    "valid audit task",
  );

  const base = {
    task_id: "task-1",
    unit_id: "unit-1",
    pass_id: "pass:security",
    lens: "security",
    file_paths: ["src/api/auth.ts"],
    rationale: "Review the auth path.",
  };

  rejects(WorkerAuditTaskSchema, { ...base, lens: "bogus" }, "bad lens");
  rejects(WorkerAuditTaskSchema, { ...base, priority: "urgent" }, "bad priority");
  rejects(WorkerAuditTaskSchema, { ...base, tags: [] }, "empty tags");
  rejects(
    WorkerAuditTaskSchema,
    { ...base, inputs: { unit_manifest_ref: "unit_manifest.json", custom_ref: 7 } },
    "non-string input ref",
  );
  rejects(WorkerAuditTaskSchema, { ...base, unexpected: true }, "extra key");
});

test("worker audit task rejects nonpositive line range bounds", () => {
  const validTask = {
    task_id: "task-1",
    unit_id: "unit-1",
    pass_id: "pass:security",
    lens: "security",
    file_paths: ["src/api/auth.ts"],
    line_ranges: [{ path: "src/api/auth.ts", start: 1, end: 1 }],
    rationale: "Review the auth path.",
  };
  accepts(WorkerAuditTaskSchema, validTask, "valid line ranges");
  for (const [field, value] of [
    ["start", 0],
    ["start", -1],
    ["end", 0],
    ["end", -1],
  ]) {
    rejects(
      WorkerAuditTaskSchema,
      {
        ...validTask,
        line_ranges: [{ path: "src/api/auth.ts", start: 1, end: 1, [field]: value }],
      },
      `line range ${field}=${value}`,
    );
  }
});

// ---------------------------------------------------------------------------
// dispatch_quota.
// ---------------------------------------------------------------------------

test("dispatch quota accepts a single-pool schedule", () => {
  accepts(
    DispatchQuotaSchema,
    {
      contract_version: "audit-code-dispatch-quota/v1alpha1",
      run_id: "PLAN-1",
      model: "test-model",
      resolved_limits: {
        context_tokens: 128000,
        output_tokens: 8192,
        requests_per_minute: null,
        input_tokens_per_minute: null,
        output_tokens_per_minute: null,
      },
      confidence: "medium",
      source: "default",
      host_concurrency_limit: null,
      max_concurrent_agents: 2,
      cooldown_until: "2026-05-20T16:45:30Z",
    },
    "single-pool dispatch quota",
  );
});

test("dispatch quota accepts a null cooldown and rejects a bad enum", () => {
  const base = {
    contract_version: "audit-code-dispatch-quota/v1alpha1",
    run_id: "PLAN-1",
    model: "test-model",
    resolved_limits: {
      context_tokens: 128000,
      output_tokens: 8192,
      requests_per_minute: null,
      input_tokens_per_minute: null,
      output_tokens_per_minute: null,
    },
    confidence: "medium",
    source: "default",
    host_concurrency_limit: null,
    max_concurrent_agents: 2,
    cooldown_until: null,
  };
  accepts(DispatchQuotaSchema, base, "null cooldown");
  rejects(DispatchQuotaSchema, { ...base, confidence: "very-high" }, "bad confidence enum");
  rejects(DispatchQuotaSchema, { ...base, max_concurrent_agents: 0 }, "zero concurrency");
});

test("dispatch quota accepts multi-pool capacity summaries", () => {
  accepts(
    DispatchQuotaSchema,
    {
      contract_version: "audit-code-dispatch-quota/v1alpha2",
      run_id: "PLAN-1",
      model: "primary-model",
      resolved_limits: {
        context_tokens: 128000,
        output_tokens: 8192,
        requests_per_minute: null,
        input_tokens_per_minute: null,
        output_tokens_per_minute: null,
      },
      confidence: "medium",
      source: "provider_default",
      host_concurrency_limit: null,
      max_concurrent_agents: 5,
      cooldown_until: null,
      binding_cap: "host_concurrency",
      capacity_pools: [
        {
          pool_id: "claude-code/*",
          slots: 2,
          model: null,
          confidence: "medium",
          source: "provider_default",
          resolved_limits: {
            context_tokens: 128000,
            output_tokens: 8192,
            requests_per_minute: null,
            input_tokens_per_minute: null,
            output_tokens_per_minute: null,
          },
          host_concurrency_limit: {
            active_subagents: 2,
            source: "host_reported",
            description: "test host limit",
          },
          cooldown_until: null,
          estimated_wave_tokens: 2000,
          binding_cap: "host_concurrency",
          quota_source_snapshot: null,
        },
        {
          pool_id: "codex/o4-mini",
          slots: 3,
          model: "o4-mini",
          confidence: "high",
          source: "explicit_config",
          resolved_limits: {
            context_tokens: 200000,
            output_tokens: 8192,
            requests_per_minute: 100,
            input_tokens_per_minute: 1000000,
            output_tokens_per_minute: null,
          },
          host_concurrency_limit: null,
          cooldown_until: null,
          estimated_wave_tokens: 3000,
          binding_cap: "none",
        },
      ],
    },
    "multi-pool dispatch quota",
  );
});

// ---------------------------------------------------------------------------
// repo_manifest + builder-output contracts.
// ---------------------------------------------------------------------------

test("repo_manifest accepts a minimal manifest", () => {
  accepts(
    RepoManifestSchema,
    { repository: { name: "t" }, generated_at: "2026-04-22T00:00:00.000Z", files: [] },
    "minimal repo manifest",
  );
});

test("strict schema contracts accept real builder output and reject unexpected fields", () => {
  const repoManifest = {
    repository: { name: "fixture" },
    generated_at: "2026-04-22T00:00:00Z",
    files: [
      { path: "src/api/auth.ts", language: "ts", size_bytes: 12 },
      { path: "infra/deploy.yml", language: "yaml", size_bytes: 10 },
    ],
  };
  const disposition = {
    files: [
      { path: "src/api/auth.ts", status: "included" },
      { path: "infra/deploy.yml", status: "included" },
    ],
  };

  const unitManifest = buildUnitManifest(repoManifest, disposition);
  accepts(UnitManifestSchema, unitManifest, "unitManifest builder output");

  const surfaceManifest = buildSurfaceManifest(repoManifest, disposition);
  accepts(SurfaceManifestSchema, surfaceManifest, "surfaceManifest builder output");

  const graphBundle = buildGraphBundle(repoManifest, disposition, {
    fileContents: { "src/api/auth.ts": "const deploy = 'infra/deploy.yml';" },
  });
  accepts(GraphBundleSchema, graphBundle, "graphBundle builder output");

  const runtimeValidationTasks = buildRuntimeValidationTasks({
    unitManifest,
    command: ["npm", "test"],
  });
  accepts(
    RuntimeValidationTaskManifestSchema,
    runtimeValidationTasks,
    "runtimeValidationTasks builder output",
  );

  const auditTasks = [
    {
      task_id: "src-auth:security",
      unit_id: "src-auth",
      pass_id: "pass:security",
      lens: "security",
      file_paths: ["src/api/auth.ts"],
      file_line_counts: { "src/api/auth.ts": 12 },
      rationale: "Review auth under security.",
      priority: "high",
    },
    {
      task_id: "infra-deploy:correctness",
      unit_id: "infra-deploy",
      pass_id: "pass:correctness",
      lens: "correctness",
      file_paths: ["infra/deploy.yml"],
      file_line_counts: { "infra/deploy.yml": 10 },
      rationale: "Review deployment wiring.",
      priority: "medium",
    },
  ];
  const auditPlanMetrics = JSON.parse(
    JSON.stringify(
      buildAuditPlanMetrics(auditTasks, {
        graphBundle,
        generatedAt: new Date("2026-04-22T00:00:00Z"),
      }),
    ),
  );
  accepts(AuditPlanMetricsSchema, auditPlanMetrics, "auditPlanMetrics builder output");

  // Strict object schemas reject unexpected keys / out-of-vocabulary values.
  rejects(
    UnitManifestSchema,
    {
      units: [
        {
          unit_id: "src-api-auth",
          name: "src-api-auth",
          files: ["src/api/auth.ts"],
          required_lenses: ["security"],
          unexpected: true,
        },
      ],
    },
    "unit with extra key",
  );
  rejects(
    SurfaceManifestSchema,
    {
      surfaces: [
        {
          id: "surface:src/api/auth.ts",
          kind: "interface",
          entrypoint: "src/api/auth.ts",
          exposure: "public",
        },
      ],
    },
    "surface with out-of-vocabulary exposure",
  );
  rejects(GraphEdgeSchema, { from: "a.ts", to: "b.ts", confidence: 2 }, "edge confidence > 1");
  accepts(GraphEdgeSchema, { from: "a.ts", to: "b.ts", confidence: 1 }, "edge confidence == 1");
  rejects(
    RuntimeValidationTaskManifestSchema,
    {
      tasks: [
        {
          id: "runtime:unit:src-api-auth",
          kind: "unit-risk-check",
          target_paths: [],
          reason: "Should fail",
          priority: "high",
        },
      ],
    },
    "runtime task with empty target_paths",
  );
  rejects(
    AuditPlanMetricsSchema,
    {
      ...auditPlanMetrics,
      packet_quality: { ...auditPlanMetrics.packet_quality, average_cohesion_score: 2 },
    },
    "plan metrics cohesion > 1",
  );
});

// ---------------------------------------------------------------------------
// Example fixtures + risk register bounds.
// ---------------------------------------------------------------------------

test("planning artifact example fixtures satisfy their schemas", async () => {
  const riskRegisterExample = JSON.parse(
    await readFile(join(repoRoot, "examples", "risk_register.example.json"), "utf8"),
  );
  const auditPlanMetricsExample = JSON.parse(
    await readFile(join(repoRoot, "examples", "audit_plan_metrics.example.json"), "utf8"),
  );
  const externalAnalyzerResultsExample = JSON.parse(
    await readFile(
      join(repoRoot, "examples", "external_analyzer_results.example.json"),
      "utf8",
    ),
  );
  accepts(RiskRegisterSchema, riskRegisterExample, "risk register example");
  accepts(AuditPlanMetricsSchema, auditPlanMetricsExample, "audit plan metrics example");
  accepts(
    ExternalAnalyzerResultsSchema,
    externalAnalyzerResultsExample,
    "external analyzer results example",
  );
});

test("risk_register example keys match live buildRiskRegister output shape", async () => {
  const riskRegisterExample = JSON.parse(
    await readFile(join(repoRoot, "examples", "risk_register.example.json"), "utf8"),
  );
  const liveOutput = buildRiskRegister(
    {
      units: [
        {
          unit_id: "api-auth",
          name: "api-auth",
          files: [],
          risk_score: 9,
          required_lenses: ["security"],
        },
      ],
    },
    undefined,
    undefined,
  );
  accepts(RiskRegisterSchema, liveOutput, "live risk register");
  assert.deepEqual(
    Object.keys(liveOutput).sort(),
    Object.keys(riskRegisterExample).sort(),
    "live buildRiskRegister top-level keys must match example file keys",
  );
  if (liveOutput.items.length > 0 && riskRegisterExample.items.length > 0) {
    assert.deepEqual(
      Object.keys(liveOutput.items[0]).sort(),
      Object.keys(riskRegisterExample.items[0]).sort(),
      "live buildRiskRegister item keys must match example file item keys",
    );
  }
});

test("risk register accepts planner-scale scores and rejects out-of-scale values", () => {
  accepts(
    RiskRegisterSchema,
    { items: [{ unit_id: "api-auth", risk_score: 9, signals: ["security_relevant"] }] },
    "risk score 9",
  );
  accepts(
    RiskRegisterSchema,
    { items: [{ unit_id: "api-auth", risk_score: 10, signals: ["security_relevant"] }] },
    "risk score 10",
  );
  rejects(
    RiskRegisterSchema,
    { items: [{ unit_id: "api-auth", risk_score: -1, signals: ["security_relevant"] }] },
    "risk score -1",
  );
  rejects(
    RiskRegisterSchema,
    { items: [{ unit_id: "api-auth", risk_score: 11, signals: ["security_relevant"] }] },
    "risk score 11",
  );
  rejects(
    RiskRegisterSchema,
    { items: [{ unit_id: "api-auth", risk_score: "9", signals: ["security_relevant"] }] },
    "risk score as string",
  );
  rejects(
    UnitManifestSchema,
    {
      units: [
        {
          unit_id: "api-auth",
          name: "api-auth",
          files: ["src/api/auth.ts"],
          risk_score: 11,
          required_lenses: ["security"],
        },
      ],
    },
    "unit risk score 11",
  );
});

test("risk register builder caps additive scores at the shared 0..10 scale", () => {
  const riskRegister = buildRiskRegister(
    {
      units: [
        {
          unit_id: "api-auth",
          name: "api-auth",
          files: ["src/api/auth.ts", "src/cache/write.ts"],
          risk_score: 10,
          required_lenses: ["security", "data_integrity"],
        },
      ],
    },
    {
      flows: [
        {
          id: "login-flow",
          name: "Login",
          entrypoints: ["src/api/auth.ts"],
          paths: ["src/api/auth.ts", "src/cache/write.ts"],
          required_lenses: ["security"],
        },
      ],
    },
    {
      tool: "eslint",
      generated_at: "2026-04-22T00:00:00Z",
      results: [
        {
          id: "eslint-auth",
          path: "src/api/auth.ts",
          severity: "high",
          message: "Auth issue.",
        },
      ],
    },
  );
  assert.equal(riskRegister.items[0].risk_score, 10);
});

// ---------------------------------------------------------------------------
// step_contract progress sub-object (ARC-ebbd5420).
// ---------------------------------------------------------------------------

test("step_contract validates progress with all StepProgress fields (ARC-ebbd5420)", () => {
  const baseStep = {
    contract_version: "audit-code-step/v1alpha1",
    step_kind: "dispatch_review",
    prompt_path: "steps/current-prompt.md",
    status: "ready",
    run_id: "run-1",
    allowed_commands: ["audit-code"],
    stop_condition: "Call audit-code next-step when done.",
    repo_root: "/repo",
    artifacts_dir: ".audit-tools/audit",
    artifact_paths: {},
  };

  accepts(
    StepArtifactSchema,
    {
      ...baseStep,
      progress: {
        summary: "Dispatch in progress",
        agent_count: 8,
        max_concurrent_agents: 4,
        confirmation_recommended: false,
        dispatch_summary: "8 agents, max 4 concurrent (rolling)",
      },
    },
    "step with all fan-out progress fields",
  );

  accepts(
    StepArtifactSchema,
    { ...baseStep, progress: { summary: "Pending" } },
    "step with minimal progress",
  );

  rejects(
    StepArtifactSchema,
    { ...baseStep, progress: { summary: "Bad progress", unrecognized_field: true } },
    "step with unrecognized progress field",
  );
});

// ---------------------------------------------------------------------------
// DAT-db770721 (A6): the lens vocabulary has ONE source — the `LensSchema` zod
// enum. The generated worker-facing JSON schemas inline it; every inline lens
// enum must EQUAL the source so a hand-copied / drifted lens list can't slip in.
// ---------------------------------------------------------------------------

test("every inline lens enum across generated schemas equals the LensSchema source (DAT-db770721)", async () => {
  const CANONICAL = LensSchema.options;
  const schemasDir = join(repoRoot, "schemas");
  const schemaFiles = (await readdir(schemasDir)).filter((f) =>
    f.endsWith(".schema.json"),
  );

  // lens.schema.json is generated from LensSchema; it must hold exactly the source.
  const lensSchema = JSON.parse(
    await readFile(join(schemasDir, "lens.schema.json"), "utf8"),
  );
  assert.deepEqual(
    lensSchema.enum,
    [...CANONICAL],
    "lens.schema.json must contain exactly the canonical lens values",
  );

  const offenders = [];
  function checkInlineLensEnums(obj, file) {
    if (typeof obj !== "object" || obj === null) return;
    if (Array.isArray(obj.enum) && obj.enum.includes("correctness")) {
      try {
        assert.deepEqual(obj.enum, [...CANONICAL]);
      } catch {
        offenders.push(file);
      }
    }
    for (const value of Object.values(obj)) checkInlineLensEnums(value, file);
  }

  for (const file of schemaFiles) {
    const parsed = JSON.parse(await readFile(join(schemasDir, file), "utf8"));
    checkInlineLensEnums(parsed, file);
  }
  assert.deepEqual(
    offenders,
    [],
    `these schemas contain a lens enum that drifted from LensSchema: ${offenders.join(", ")}`,
  );
});
