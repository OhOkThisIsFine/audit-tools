import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertMatchesJsonSchema as assertMatchesJsonSchemaRaw } from "./helpers/jsonSchemaAssert.mjs";
import { buildUnitManifest } from "../src/orchestrator/unitBuilder.ts";
import { buildRiskRegister } from "../src/extractors/risk.ts";
import { buildSurfaceManifest } from "../src/extractors/surfaces.ts";
import { buildGraphBundle } from "../src/extractors/graph.ts";
import { buildRuntimeValidationTasks } from "../src/orchestrator/runtimeValidation.ts";
import { buildAuditPlanMetrics, buildReviewPackets } from "../src/orchestrator/reviewPackets.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

async function loadSchema(name) {
  return JSON.parse(
    await readFile(join(repoRoot, "schemas", name), "utf8"),
  );
}

// Published schemas cross-reference sibling files (e.g. the shared
// lens.schema.json enum, pulled in via {"$ref":"lens.schema.json"}). The
// validator resolves external refs through a registry, so load every schema
// file once and inject it into all assertions below. Individual callers can
// still add or override registry entries.
async function loadAllSchemas() {
  const { readdir } = await import("node:fs/promises");
  const schemasDir = join(repoRoot, "schemas");
  const files = (await readdir(schemasDir)).filter((f) =>
    f.endsWith(".schema.json"),
  );
  const registry = {};
  for (const file of files) {
    registry[file] = JSON.parse(
      await readFile(join(schemasDir, file), "utf8"),
    );
  }
  return registry;
}

const SCHEMA_REGISTRY = await loadAllSchemas();

function assertMatchesJsonSchema(schema, value, rootName, options = {}) {
  return assertMatchesJsonSchemaRaw(schema, value, rootName, {
    ...options,
    schemaRegistry: { ...SCHEMA_REGISTRY, ...(options.schemaRegistry ?? {}) },
  });
}

test("jsonSchemaAssert rejects invalid enum via $ref resolution", async () => {
  const auditResultSchema = await loadSchema("audit_result.schema.json");
  const findingSchema = await loadSchema("finding.schema.json");
  const auditTaskSchema = await loadSchema("audit_task.schema.json");

  assert.throws(
    () =>
      assertMatchesJsonSchema(
        auditResultSchema,
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
              summary: "Should fail through $ref resolution.",
              affected_files: [{ path: "src/api/auth.ts" }],
              evidence: ["src/api/auth.ts:1 - detail"],
            },
          ],
        },
        "auditResult",
        {
          schemaRegistry: {
            "finding.schema.json": findingSchema,
            "audit_task.schema.json": auditTaskSchema,
          },
        },
      ),
    /auditResult\.findings\[0\]\.lens must be one of/i,
  );
});

test("jsonSchemaAssert accepts empty findings array", async () => {
  const auditResultSchema = await loadSchema("audit_result.schema.json");
  const findingSchema = await loadSchema("finding.schema.json");
  const auditTaskSchema = await loadSchema("audit_task.schema.json");

  assert.doesNotThrow(() =>
    assertMatchesJsonSchema(
      auditResultSchema,
      {
        task_id: "task-empty",
        unit_id: "unit-empty",
        pass_id: "pass:reliability",
        lens: "reliability",
        file_coverage: [{ path: "src/empty.ts", total_lines: 0 }],
        findings: [],
      },
      "auditResult",
      {
        schemaRegistry: {
          "finding.schema.json": findingSchema,
          "audit_task.schema.json": auditTaskSchema,
        },
      },
    ),
  );
});

test("jsonSchemaAssert accepts result with verification shape", async () => {
  const auditResultSchema = await loadSchema("audit_result.schema.json");
  const findingSchema = await loadSchema("finding.schema.json");
  const auditTaskSchema = await loadSchema("audit_task.schema.json");

  assert.doesNotThrow(() =>
    assertMatchesJsonSchema(
      auditResultSchema,
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
      "auditResultVerification",
      {
        schemaRegistry: {
          "finding.schema.json": findingSchema,
          "audit_task.schema.json": auditTaskSchema,
        },
      },
    ),
  );
});

test("jsonSchemaAssert accepts finding with category more specific than lens", async () => {
  const auditResultSchema = await loadSchema("audit_result.schema.json");
  const findingSchema = await loadSchema("finding.schema.json");
  const auditTaskSchema = await loadSchema("audit_task.schema.json");

  assert.doesNotThrow(() =>
    assertMatchesJsonSchema(
      auditResultSchema,
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
      "auditResultSpecificCategory",
      {
        schemaRegistry: {
          "finding.schema.json": findingSchema,
          "audit_task.schema.json": auditTaskSchema,
        },
      },
    ),
  );
});

test("jsonSchemaAssert enforces array type for auditResults and rejects plain object", async () => {
  const auditResultSchema = await loadSchema("audit_result.schema.json");
  const auditResultsSchema = await loadSchema("audit_results.schema.json");
  const findingSchema = await loadSchema("finding.schema.json");
  const auditTaskSchema = await loadSchema("audit_task.schema.json");

  assert.doesNotThrow(() =>
    assertMatchesJsonSchema(
      auditResultsSchema,
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
      "auditResults",
      {
        schemaRegistry: {
          "audit_result.schema.json": auditResultSchema,
          "finding.schema.json": findingSchema,
          "audit_task.schema.json": auditTaskSchema,
        },
      },
    ),
  );

  assert.throws(
    () =>
      assertMatchesJsonSchema(
        auditResultsSchema,
        {
          task_id: "task-object",
          unit_id: "unit-object",
          pass_id: "pass:correctness",
          lens: "correctness",
          file_coverage: [{ path: "src/index.ts", total_lines: 1 }],
          findings: [],
        },
        "auditResults",
        {
          schemaRegistry: {
            "audit_result.schema.json": auditResultSchema,
            "finding.schema.json": findingSchema,
            "audit_task.schema.json": auditTaskSchema,
          },
        },
      ),
    /auditResults must be of type array/i,
  );
});

test("jsonSchemaAssert enforces strict property constraints (pattern, bounds, additionalProperties)", () => {
  const strictSchema = {
    $id: "strict-test.schema.json",
    type: "object",
    required: ["id", "count", "tags", "extras"],
    properties: {
      id: {
        type: "string",
        pattern: "^[a-z]+$",
      },
      count: {
        type: "integer",
        minimum: 1,
        maximum: 2,
      },
      tags: {
        type: "array",
        minItems: 1,
        maxItems: 2,
        items: { type: "string" },
      },
      extras: {
        type: "object",
        additionalProperties: { type: "string" },
      },
    },
    additionalProperties: false,
  };

  assert.doesNotThrow(() =>
    assertMatchesJsonSchema(strictSchema, {
      id: "ok",
      count: 2,
      tags: ["one"],
      extras: { note: "allowed" },
    }),
  );

  assert.throws(
    () =>
      assertMatchesJsonSchema(strictSchema, {
        id: "BAD",
        count: 3,
        tags: [],
        extras: { note: 7 },
      }),
    /must match pattern|must be <= 2|must have at least 1 item|must be of type string/i,
  );
});

test("jsonSchemaAssert validates allOf and oneOf combinators", () => {
  const combinatorSchema = {
    type: "object",
    required: ["mode"],
    properties: {
      mode: { type: "string" },
      value: {},
    },
    allOf: [
      {
        properties: {
          mode: { const: "bounded" },
          value: { type: "integer", minimum: 1, maximum: 3 },
        },
      },
    ],
    oneOf: [
      {
        properties: {
          value: { const: 1 },
        },
      },
      {
        properties: {
          value: { const: 2 },
        },
      },
    ],
    additionalProperties: false,
  };

  assert.doesNotThrow(() =>
    assertMatchesJsonSchema(combinatorSchema, {
      mode: "bounded",
      value: 2,
    }),
  );
  assert.throws(
    () =>
      assertMatchesJsonSchema(combinatorSchema, {
        mode: "bounded",
        value: 3,
      }),
    /exactly one oneOf branch/i,
  );
});

test("jsonSchemaAssert preserves object and additionalProperties behavior after validator extraction", () => {
  const schema = {
    type: "object",
    required: ["id"],
    properties: {
      id: { type: "string" },
      metadata: {
        type: "object",
        additionalProperties: { type: "string" },
      },
    },
    additionalProperties: false,
  };

  assert.doesNotThrow(() =>
    assertMatchesJsonSchema(
      schema,
      { id: "worker-1", metadata: { note: "ok" } },
      "worker",
    ),
  );

  assert.throws(
    () => assertMatchesJsonSchema(schema, { metadata: {} }, "worker"),
    /worker\.id is required/i,
  );

  assert.throws(
    () =>
      assertMatchesJsonSchema(
        schema,
        { id: "worker-1", extra: true },
        "worker",
      ),
    /worker\.extra is not allowed by schema/i,
  );
});

test("jsonSchemaAssert preserves array, string, and number constraint behavior after validator extraction", () => {
  const schema = {
    type: "object",
    required: ["items", "name", "score"],
    properties: {
      items: {
        type: "array",
        minItems: 1,
        items: { type: "integer", minimum: 1 },
      },
      name: {
        type: "string",
        minLength: 2,
        maxLength: 4,
        pattern: "^[a-z]+$",
      },
      score: {
        type: "number",
        minimum: 1,
        maximum: 3,
      },
    },
    additionalProperties: false,
  };

  assert.doesNotThrow(() =>
    assertMatchesJsonSchema(
      schema,
      { items: [1, 2], name: "ok", score: 2 },
      "sample",
    ),
  );

  assert.throws(
    () =>
      assertMatchesJsonSchema(
        schema,
        { items: [0], name: "ok", score: 2 },
        "sample",
      ),
    /sample\.items\[0\] must be >= 1/i,
  );

  assert.throws(
    () =>
      assertMatchesJsonSchema(
        schema,
        { items: [1], name: "BAD", score: 2 },
        "sample",
      ),
    /sample\.name must match pattern/i,
  );

  assert.throws(
    () =>
      assertMatchesJsonSchema(
        schema,
        { items: [1], name: "ok", score: 4 },
        "sample",
      ),
    /sample\.score must be <= 3/i,
  );
});

test("jsonSchemaAssert preserves refs, combiners, const, and enum behavior after validator extraction", () => {
  const referencedSchema = {
    $id: "ref-target.schema.json",
    type: "object",
    required: ["kind", "mode", "value"],
    properties: {
      kind: { const: "target" },
      mode: { enum: ["one", "two"] },
      value: {},
    },
    allOf: [{ properties: { value: { type: "integer", minimum: 1 } } }],
    anyOf: [
      { properties: { value: { const: 1 } } },
      { properties: { mode: { const: "two" } } },
    ],
    oneOf: [
      { properties: { value: { const: 1 } } },
      { properties: { value: { const: 2 } } },
    ],
    additionalProperties: false,
  };
  const schema = { $ref: "ref-target.schema.json" };

  assert.doesNotThrow(() =>
    assertMatchesJsonSchema(
      schema,
      { kind: "target", mode: "one", value: 1 },
      "target",
      { schemaRegistry: { "ref-target.schema.json": referencedSchema } },
    ),
  );

  assert.throws(
    () =>
      assertMatchesJsonSchema(
        schema,
        { kind: "other", mode: "one", value: 1 },
        "target",
        { schemaRegistry: { "ref-target.schema.json": referencedSchema } },
      ),
    /target\.kind must equal "target"/i,
  );

  assert.throws(
    () =>
      assertMatchesJsonSchema(
        schema,
        { kind: "target", mode: "three", value: 1 },
        "target",
        { schemaRegistry: { "ref-target.schema.json": referencedSchema } },
      ),
    /target\.mode must be one of one, two/i,
  );

  assert.throws(
    () =>
      assertMatchesJsonSchema(
        schema,
        { kind: "target", mode: "one", value: 3 },
        "target",
        { schemaRegistry: { "ref-target.schema.json": referencedSchema } },
      ),
    /target must satisfy at least one anyOf branch/i,
  );
});

test("jsonSchemaAssert rejects invalid date-time strings", () => {
  const schema = { type: "string", format: "date-time" };

  assert.doesNotThrow(() =>
    assertMatchesJsonSchema(schema, "2026-05-20T16:45:30Z", "timestamp"),
  );

  assert.throws(
    () => assertMatchesJsonSchema(schema, "not a date", "timestamp"),
    /timestamp must match date-time format/i,
  );

  assert.throws(
    () => assertMatchesJsonSchema(schema, "2026-02-31T10:00:00Z", "timestamp"),
    /timestamp must match date-time format/i,
  );
});

test("jsonSchemaAssert intentionally skips unsupported string formats", () => {
  assert.doesNotThrow(() =>
    assertMatchesJsonSchema(
      { type: "string", format: "email" },
      "not an email",
      "email",
    ),
  );
});

test("dispatch quota schema enforces cooldown_until date-time format through helper", async () => {
  const dispatchQuotaSchema = await loadSchema("dispatch_quota.schema.json");
  const dispatchQuota = {
    contract_version: "audit-code-dispatch-quota/v1alpha1",
    run_id: "PLAN-1",
    model: "gpt-test",
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
    wave_size: 2,
    estimated_wave_tokens: 1000,
    cooldown_until: "2026-05-20T16:45:30Z",
  };

  assert.doesNotThrow(() =>
    assertMatchesJsonSchema(dispatchQuotaSchema, dispatchQuota, "dispatchQuota"),
  );

  assert.throws(
    () =>
      assertMatchesJsonSchema(
        dispatchQuotaSchema,
        { ...dispatchQuota, cooldown_until: "soon-ish" },
        "dispatchQuota",
      ),
    /dispatchQuota\.cooldown_until must match date-time format/i,
  );

  assert.doesNotThrow(() =>
    assertMatchesJsonSchema(
      dispatchQuotaSchema,
      { ...dispatchQuota, cooldown_until: null },
      "dispatchQuota",
    ),
  );
});

test("repo_manifest schema enforces date-time format on generated_at", async () => {
  const repoManifestSchema = await loadSchema("repo_manifest.schema.json");

  assert.equal(repoManifestSchema.properties.generated_at.format, "date-time");

  assert.doesNotThrow(() =>
    assertMatchesJsonSchema(
      repoManifestSchema,
      {
        repository: { name: "t" },
        generated_at: "2026-04-22T00:00:00.000Z",
        files: [],
      },
      "repoManifest",
    ),
  );

  assert.throws(
    () =>
      assertMatchesJsonSchema(
        repoManifestSchema,
        {
          repository: { name: "t" },
          generated_at: "not-a-timestamp",
          files: [],
        },
        "repoManifest",
      ),
    /repoManifest\.generated_at must match date-time format/i,
  );
});

test("strict schema contracts accept real builder output and reject unexpected fields", async () => {
  const unitManifestSchema = await loadSchema("unit_manifest.schema.json");
  const surfaceManifestSchema = await loadSchema("surface_manifest.schema.json");
  const graphBundleSchema = await loadSchema("graph_bundle.schema.json");
  const reviewPacketsSchema = await loadSchema("review_packets.schema.json");
  const auditPlanMetricsSchema = await loadSchema(
    "audit_plan_metrics.schema.json",
  );
  const runtimeValidationSchema = await loadSchema(
    "runtime_validation_tasks.schema.json",
  );
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
  assertMatchesJsonSchema(unitManifestSchema, unitManifest, "unitManifest");

  const surfaceManifest = buildSurfaceManifest(repoManifest, disposition);
  assertMatchesJsonSchema(
    surfaceManifestSchema,
    surfaceManifest,
    "surfaceManifest",
  );

  const graphBundle = buildGraphBundle(repoManifest, disposition, {
    fileContents: {
      "src/api/auth.ts": "const deploy = 'infra/deploy.yml';",
    },
  });
  assertMatchesJsonSchema(graphBundleSchema, graphBundle, "graphBundle");

  const runtimeValidationTasks = buildRuntimeValidationTasks({
    unitManifest,
    command: ["npm", "test"],
  });
  assertMatchesJsonSchema(
    runtimeValidationSchema,
    runtimeValidationTasks,
    "runtimeValidationTasks",
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
  const reviewPackets = JSON.parse(
    JSON.stringify(buildReviewPackets(auditTasks, { graphBundle })),
  );
  assertMatchesJsonSchema(reviewPacketsSchema, reviewPackets, "reviewPackets");

  const auditPlanMetrics = JSON.parse(
    JSON.stringify(
      buildAuditPlanMetrics(auditTasks, {
        graphBundle,
        generatedAt: new Date("2026-04-22T00:00:00Z"),
      }),
    ),
  );
  assertMatchesJsonSchema(
    auditPlanMetricsSchema,
    auditPlanMetrics,
    "auditPlanMetrics",
  );

  assert.throws(
    () =>
      assertMatchesJsonSchema(unitManifestSchema, {
        units: [
          {
            unit_id: "src-api-auth",
            name: "src-api-auth",
            files: ["src/api/auth.ts"],
            required_lenses: ["security"],
            unexpected: true,
          },
        ],
      }),
    /unexpected is not allowed by schema/i,
  );

  assert.throws(
    () =>
      assertMatchesJsonSchema(surfaceManifestSchema, {
        surfaces: [
          {
            id: "surface:src/api/auth.ts",
            kind: "interface",
            entrypoint: "src/api/auth.ts",
            exposure: "public",
          },
        ],
      }),
    /exposure must be one of network, local/i,
  );

  assert.throws(
    () =>
      assertMatchesJsonSchema(graphBundleSchema, {
        graphs: {
          imports: [
            {
              from: "src/api/auth.ts",
              to: "src/lib/session.ts",
              confidence: 2,
            },
          ],
        },
      }),
    /graphs\.imports\[0\]\.confidence must be <= 1/i,
  );

  assert.throws(
    () =>
      assertMatchesJsonSchema(runtimeValidationSchema, {
        tasks: [
          {
            id: "runtime:unit:src-api-auth",
            kind: "unit-risk-check",
            target_paths: [],
            reason: "Should fail",
            priority: "high",
          },
        ],
      }),
    /target_paths must have at least 1 item/i,
  );

  assert.throws(
    () =>
      assertMatchesJsonSchema(reviewPacketsSchema, [
        {
          ...reviewPackets[0],
          key_edges: [
            {
              from: "src/api/auth.ts",
              to: "infra/deploy.yml",
              confidence: 2,
            },
          ],
        },
      ]),
    /key_edges\[0\]\.confidence must be <= 1/i,
  );

  assert.throws(
    () =>
      assertMatchesJsonSchema(auditPlanMetricsSchema, {
        ...auditPlanMetrics,
        packet_quality: {
          ...auditPlanMetrics.packet_quality,
          average_cohesion_score: 2,
        },
      }),
    /packet_quality\.average_cohesion_score must be <= 1/i,
  );
});

test("planning artifact examples match published schemas", async () => {
  const reviewPacketsSchema = await loadSchema("review_packets.schema.json");
  const riskRegisterSchema = await loadSchema("risk_register.schema.json");
  const auditPlanMetricsSchema = await loadSchema(
    "audit_plan_metrics.schema.json",
  );
  const externalAnalyzerResultsSchema = await loadSchema(
    "external_analyzer_results.schema.json",
  );
  const reviewPacketsExample = JSON.parse(
    await readFile(
      join(repoRoot, "examples", "review_packets.example.json"),
      "utf8",
    ),
  );
  const riskRegisterExample = JSON.parse(
    await readFile(
      join(repoRoot, "examples", "risk_register.example.json"),
      "utf8",
    ),
  );
  const auditPlanMetricsExample = JSON.parse(
    await readFile(
      join(repoRoot, "examples", "audit_plan_metrics.example.json"),
      "utf8",
    ),
  );
  const externalAnalyzerResultsExample = JSON.parse(
    await readFile(
      join(repoRoot, "examples", "external_analyzer_results.example.json"),
      "utf8",
    ),
  );

  assertMatchesJsonSchema(
    reviewPacketsSchema,
    reviewPacketsExample,
    "reviewPacketsExample",
  );
  assertMatchesJsonSchema(
    riskRegisterSchema,
    riskRegisterExample,
    "riskRegisterExample",
  );
  assertMatchesJsonSchema(
    auditPlanMetricsSchema,
    auditPlanMetricsExample,
    "auditPlanMetricsExample",
  );
  assertMatchesJsonSchema(
    externalAnalyzerResultsSchema,
    externalAnalyzerResultsExample,
    "externalAnalyzerResultsExample",
  );
});

test("risk register schema accepts planner-scale scores and rejects out-of-scale values", async () => {
  const riskRegisterSchema = await loadSchema("risk_register.schema.json");
  const unitManifestSchema = await loadSchema("unit_manifest.schema.json");
  const plannerScaleRiskRegister = {
    items: [
      {
        unit_id: "api-auth",
        risk_score: 9,
        signals: ["security_relevant"],
      },
    ],
  };

  assert.doesNotThrow(() =>
    assertMatchesJsonSchema(
      riskRegisterSchema,
      plannerScaleRiskRegister,
      "riskRegister",
    ),
  );
  assert.doesNotThrow(() =>
    assertMatchesJsonSchema(
      riskRegisterSchema,
      {
        items: [
          {
            unit_id: "api-auth",
            risk_score: 10,
            signals: ["security_relevant"],
          },
        ],
      },
      "riskRegister",
    ),
  );
  assert.throws(
    () =>
      assertMatchesJsonSchema(
        riskRegisterSchema,
        {
          items: [
            {
              unit_id: "api-auth",
              risk_score: -1,
              signals: ["security_relevant"],
            },
          ],
        },
        "riskRegister",
      ),
    /riskRegister\.items\[0\]\.risk_score must be >= 0/i,
  );
  assert.throws(
    () =>
      assertMatchesJsonSchema(
        riskRegisterSchema,
        {
          items: [
            {
              unit_id: "api-auth",
              risk_score: 11,
              signals: ["security_relevant"],
            },
          ],
        },
        "riskRegister",
      ),
    /riskRegister\.items\[0\]\.risk_score must be <= 10/i,
  );
  assert.throws(
    () =>
      assertMatchesJsonSchema(
        riskRegisterSchema,
        {
          items: [
            {
              unit_id: "api-auth",
              risk_score: "9",
              signals: ["security_relevant"],
            },
          ],
        },
        "riskRegister",
      ),
    /riskRegister\.items\[0\]\.risk_score must be of type number/i,
  );
  assert.throws(
    () =>
      assertMatchesJsonSchema(
        unitManifestSchema,
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
        "unitManifest",
      ),
    /unitManifest\.units\[0\]\.risk_score must be <= 10/i,
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

test("audit task schema enforces lens, priority, tags, and strict additionalProperties", async () => {
  const auditTaskSchema = await loadSchema("audit_task.schema.json");

  assert.doesNotThrow(() =>
    assertMatchesJsonSchema(
      auditTaskSchema,
      {
        task_id: "task-1",
        unit_id: "unit-1",
        pass_id: "pass:security",
        lens: "security",
        file_paths: ["src/api/auth.ts"],
        file_line_counts: {
          "src/api/auth.ts": 12,
        },
        inputs: {
          unit_manifest_ref: "unit_manifest.json",
          custom_ref: "custom.json",
        },
        rationale: "Review the auth path.",
        priority: "high",
        tags: ["auth", "critical-flow"],
        status: "pending",
      },
      "auditTask",
    ),
  );

  assert.throws(
    () =>
      assertMatchesJsonSchema(
        auditTaskSchema,
        {
          task_id: "task-1",
          unit_id: "unit-1",
          pass_id: "pass:security",
          lens: "bogus",
          file_paths: ["src/api/auth.ts"],
          rationale: "Review the auth path.",
        },
        "auditTask",
      ),
    /auditTask\.lens must be one of/i,
  );

  assert.throws(
    () =>
      assertMatchesJsonSchema(
        auditTaskSchema,
        {
          task_id: "task-1",
          unit_id: "unit-1",
          pass_id: "pass:security",
          lens: "security",
          file_paths: ["src/api/auth.ts"],
          rationale: "Review the auth path.",
          priority: "urgent",
        },
        "auditTask",
      ),
    /auditTask\.priority must be one of/i,
  );

  assert.throws(
    () =>
      assertMatchesJsonSchema(
        auditTaskSchema,
        {
          task_id: "task-1",
          unit_id: "unit-1",
          pass_id: "pass:security",
          lens: "security",
          file_paths: ["src/api/auth.ts"],
          rationale: "Review the auth path.",
          tags: [],
        },
        "auditTask",
      ),
    /auditTask\.tags must have at least 1 item/i,
  );

  assert.throws(
    () =>
      assertMatchesJsonSchema(
        auditTaskSchema,
        {
          task_id: "task-1",
          unit_id: "unit-1",
          pass_id: "pass:security",
          lens: "security",
          file_paths: ["src/api/auth.ts"],
          inputs: {
            unit_manifest_ref: "unit_manifest.json",
            custom_ref: 7,
          },
          rationale: "Review the auth path.",
        },
        "auditTask",
      ),
    /auditTask\.inputs\.custom_ref must be of type string/i,
  );

  assert.throws(
    () =>
      assertMatchesJsonSchema(
        auditTaskSchema,
        {
          task_id: "task-1",
          unit_id: "unit-1",
          pass_id: "pass:security",
          lens: "security",
          file_paths: ["src/api/auth.ts"],
          rationale: "Review the auth path.",
          unexpected: true,
        },
        "auditTask",
      ),
    /auditTask\.unexpected is not allowed by schema/i,
  );
});

test("audit task schema rejects nonpositive line range bounds", async () => {
  const auditTaskSchema = await loadSchema("audit_task.schema.json");
  const validTask = {
    task_id: "task-1",
    unit_id: "unit-1",
    pass_id: "pass:security",
    lens: "security",
    file_paths: ["src/api/auth.ts"],
    line_ranges: [{ path: "src/api/auth.ts", start: 1, end: 1 }],
    rationale: "Review the auth path.",
  };

  assert.doesNotThrow(() =>
    assertMatchesJsonSchema(auditTaskSchema, validTask, "auditTask"),
  );
  for (const [field, value] of [
    ["start", 0],
    ["start", -1],
    ["end", 0],
    ["end", -1],
  ]) {
    assert.throws(
      () =>
        assertMatchesJsonSchema(
          auditTaskSchema,
          {
            ...validTask,
            line_ranges: [
              {
                path: "src/api/auth.ts",
                start: 1,
                end: 1,
                [field]: value,
              },
            ],
          },
          "auditTask",
        ),
      new RegExp(`auditTask\\.line_ranges\\[0\\]\\.${field} must be >= 1`, "i"),
    );
  }
});

// ---------------------------------------------------------------------------
// ARC-ebbd5420: step_contract schema progress sub-object must accept all
// StepProgress fields that the TypeScript interface defines.
// ---------------------------------------------------------------------------

test("step_contract schema validates progress with all StepProgress fields (ARC-ebbd5420)", async () => {
  const stepContractSchema = await loadSchema("step_contract.schema.json");

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

  assert.doesNotThrow(
    () =>
      assertMatchesJsonSchema(
        stepContractSchema,
        {
          ...baseStep,
          progress: {
            summary: "Dispatching canary packet",
            phase: "canary",
            canary_packet_id: "pkt-001",
          },
        },
        "stepCanary",
      ),
    "progress with phase=canary and canary_packet_id should pass schema",
  );

  assert.doesNotThrow(
    () =>
      assertMatchesJsonSchema(
        stepContractSchema,
        {
          ...baseStep,
          progress: {
            summary: "Fan-out in progress",
            phase: "fan_out",
            agent_count: 8,
            wave_count: 2,
            confirmation_recommended: false,
            dispatch_summary: "8 agents across 2 waves",
          },
        },
        "stepFanOut",
      ),
    "progress with phase=fan_out and all fan-out fields should pass schema",
  );

  assert.doesNotThrow(
    () =>
      assertMatchesJsonSchema(
        stepContractSchema,
        {
          ...baseStep,
          progress: { summary: "Pending" },
        },
        "stepMinimalProgress",
      ),
    "progress with only the required summary field should pass schema",
  );

  assert.throws(
    () =>
      assertMatchesJsonSchema(
        stepContractSchema,
        {
          ...baseStep,
          progress: {
            summary: "Bad progress",
            unrecognized_field: true,
          },
        },
        "stepBadProgress",
      ),
    /unrecognized_field is not allowed by schema/i,
    "unrecognized progress field should be rejected (additionalProperties: false)",
  );
});

// ---------------------------------------------------------------------------
// DAT-3fb8a01d: blind_spot_register schema must reject invalid lens names in
// suggested_lenses, accepting only the canonical 11-value set.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// DAT-db770721: lens enum must be defined only once, in lens.schema.json;
// no other schema file should contain an inline enum array with "correctness".
// ---------------------------------------------------------------------------

test("lens enum is defined only once across all schemas (DAT-db770721)", async () => {
  const { readdir } = await import("node:fs/promises");
  const schemasDir = join(repoRoot, "schemas");
  const schemaFiles = (await readdir(schemasDir)).filter((f) =>
    f.endsWith(".schema.json"),
  );

  const EXPECTED_LENSES = [
    "correctness",
    "architecture",
    "maintainability",
    "security",
    "reliability",
    "performance",
    "data_integrity",
    "tests",
    "operability",
    "config_deployment",
    "observability",
  ];

  // lens.schema.json must exist and hold the canonical 11-value enum
  const lensSchema = JSON.parse(
    await readFile(join(schemasDir, "lens.schema.json"), "utf8"),
  );
  assert.deepEqual(
    lensSchema.enum,
    EXPECTED_LENSES,
    "lens.schema.json must contain exactly the 11 canonical lens values",
  );

  // No other schema file may embed an inline enum containing "correctness"
  function containsInlineLensEnum(obj) {
    if (typeof obj !== "object" || obj === null) return false;
    if (
      Array.isArray(obj.enum) &&
      obj.enum.includes("correctness")
    ) {
      return true;
    }
    for (const value of Object.values(obj)) {
      if (containsInlineLensEnum(value)) return true;
    }
    return false;
  }

  for (const file of schemaFiles) {
    if (file === "lens.schema.json") continue;
    const parsed = JSON.parse(
      await readFile(join(schemasDir, file), "utf8"),
    );
    assert.ok(
      !containsInlineLensEnum(parsed),
      `${file} must not contain an inline lens enum array — use {"$ref":"lens.schema.json"} instead`,
    );
  }
});

test("blind_spot_register schema rejects invalid lens names in suggested_lenses (DAT-3fb8a01d)", async () => {
  const blindSpotSchema = await loadSchema("blind_spot_register.schema.json");

  const baseEntry = {
    id: "bs-1",
    title: "Unobserved queue flush",
    kind: "dynamic-behavior",
    summary: "Queue flush behavior is not observable under static analysis.",
    evidence: ["No metrics emitted on flush path."],
  };

  // All 11 canonical lens values pass
  assert.doesNotThrow(() =>
    assertMatchesJsonSchema(
      blindSpotSchema,
      {
        items: [
          {
            ...baseEntry,
            suggested_lenses: [
              "correctness",
              "architecture",
              "maintainability",
              "security",
              "reliability",
              "performance",
              "data_integrity",
              "tests",
              "operability",
              "config_deployment",
              "observability",
            ],
          },
        ],
      },
      "blindSpotRegister",
    ),
  );

  // Empty suggested_lenses array passes (field is optional; empty array is valid)
  assert.doesNotThrow(() =>
    assertMatchesJsonSchema(
      blindSpotSchema,
      {
        items: [{ ...baseEntry, suggested_lenses: [] }],
      },
      "blindSpotRegister",
    ),
  );

  // suggested_lenses omitted entirely passes (field is optional)
  assert.doesNotThrow(() =>
    assertMatchesJsonSchema(
      blindSpotSchema,
      { items: [{ ...baseEntry }] },
      "blindSpotRegister",
    ),
  );

  // Unrecognized lens name fails
  assert.throws(
    () =>
      assertMatchesJsonSchema(
        blindSpotSchema,
        {
          items: [
            {
              ...baseEntry,
              suggested_lenses: ["nonexistent_lens"],
            },
          ],
        },
        "blindSpotRegister",
      ),
    /blindSpotRegister\.items\[0\]\.suggested_lenses\[0\] must be one of/i,
  );
});
