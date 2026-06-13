import { describe, it, expect, beforeAll } from "vitest";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SCHEMA_DIR = join(__dirname, "..", "schemas");

// ── schema source-path guard (TST-97e61b4d-2) ────────────────────────────
// Schemas ship from packages/remediate-code/schemas/ (source), not from dist/.
// If this test ever breaks, someone has accidentally pointed SCHEMA_DIR at the
// dist/ copy (which may be stale/absent), creating a stale-build blind spot.
describe("schema source-path invariant", () => {
  it("SCHEMA_DIR resolves to the source schemas/ directory, not dist/", () => {
    // Must not contain a path segment named "dist"
    const normalized = SCHEMA_DIR.replace(/\\/g, "/");
    expect(normalized).not.toMatch(/\/dist\//);
    expect(normalized).toMatch(/\/schemas$/);
  });

  it("source schemas/ directory exists at test time", () => {
    expect(existsSync(SCHEMA_DIR)).toBe(true);
  });

  it("dist/schemas/ does not shadow source schemas (no dist copy)", () => {
    // If dist/schemas/ existed, tests reading source schemas would silently
    // pass even against a stale build that ships incorrect schema content.
    // This guard ensures the source-schema path is the only schema location.
    const distSchemaDir = join(__dirname, "..", "dist", "schemas");
    expect(existsSync(distSchemaDir)).toBe(false);
  });
});

const EXPECTED_SCHEMAS = [
  "clarification_request.schema.json",
  "closing_result.schema.json",
  "closing_plan.schema.json",
  "contract_pipeline.schema.json",
  "dispatch_quota.schema.json",
  "dispatch_plan.schema.json",
  "finding.schema.json",
  "item_spec.schema.json",
  "remediation_block.schema.json",
  "remediation_outcomes.schema.json",
  "remediation_plan.schema.json",
  "remediation_report.schema.json",
  "test_spec.schema.json",
  "triage_batch.schema.json",
  "verification_result.schema.json",
  "step.schema.json",
  "worker_result.schema.json",
];

describe("JSON schema contracts", () => {
  for (const schemaFile of EXPECTED_SCHEMAS) {
    describe(schemaFile, () => {
      let content: string;
      let schema: unknown;

      beforeAll(async () => {
        content = await readFile(join(SCHEMA_DIR, schemaFile), "utf8");
        schema = JSON.parse(content);
      });

      it("exists and is valid JSON", () => {
        expect(() => JSON.parse(content)).not.toThrow();
      });

      it("declares a JSON Schema draft", () => {
        expect(typeof (schema as Record<string, unknown>).$schema).toBe("string");
        expect((schema as Record<string, unknown>).$schema).toMatch(/json-schema\.org/);
      });

      it("has a type or $ref at the root", () => {
        const s = schema as Record<string, unknown>;
        const hasType = typeof s.type === "string";
        const hasRef = typeof s.$ref === "string";
        const hasOneOf = Array.isArray(s.oneOf);
        const hasAnyOf = Array.isArray(s.anyOf);
        expect(hasType || hasRef || hasOneOf || hasAnyOf).toBe(true);
      });
    });
  }

  it("all expected schemas are present", async () => {
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(SCHEMA_DIR);
    const schemaFiles = files.filter((f) => f.endsWith(".schema.json"));
    expect(schemaFiles.length).toBeGreaterThanOrEqual(EXPECTED_SCHEMAS.length);
  });
});

describe("contract_pipeline schema", () => {
  const EXPECTED_ARTIFACT_DEFS = [
    "GoalSpec",
    "ContextBundle",
    "DesignSpec",
    "ConceptualDesignCritique",
    "ObligationLedger",
    "ContractAssessmentReport",
    "CounterexampleReport",
    "JudgeReport",
    "ImplementationDAG",
    "VerificationReport",
  ];

  let schema: Record<string, unknown>;

  beforeAll(async () => {
    const content = await readFile(join(SCHEMA_DIR, "contract_pipeline.schema.json"), "utf8");
    schema = JSON.parse(content) as Record<string, unknown>;
  });

  it("declares draft 2020-12 JSON Schema metadata", () => {
    expect(typeof schema.$schema).toBe("string");
    expect(schema.$schema).toContain("json-schema.org");
    expect(schema.$schema).toContain("2020-12");
  });

  it("defines all core artifact types", () => {
    const defs = schema.$defs as Record<string, unknown>;
    for (const defName of EXPECTED_ARTIFACT_DEFS) {
      expect(defs).toHaveProperty(defName);
    }
  });

  it("each artifact definition requires a stable contract_version", () => {
    const defs = schema.$defs as Record<string, Record<string, unknown>>;
    for (const defName of EXPECTED_ARTIFACT_DEFS) {
      const def = defs[defName] as Record<string, unknown>;
      expect(Array.isArray(def.required) && (def.required as string[]).includes("contract_version")).toBe(true);
    }
  });

  it("each artifact definition rejects unknown properties", () => {
    const defs = schema.$defs as Record<string, Record<string, unknown>>;
    for (const defName of EXPECTED_ARTIFACT_DEFS) {
      const def = defs[defName] as Record<string, unknown>;
      expect(def.additionalProperties).toBe(false);
    }
  });
});

describe("JSON schema field-level consistency", () => {
  it("verification_result uses 'passed' (not 'conforms')", async () => {
    const schema = JSON.parse(
      await readFile(
        join(SCHEMA_DIR, "verification_result.schema.json"),
        "utf8",
      ),
    );
    expect(schema.properties).toHaveProperty("passed");
    expect(schema.properties).not.toHaveProperty("conforms");
    expect(schema.required).toContain("passed");
    expect(schema.required).not.toContain("conforms");
  });

  it("verification_result uses 'reason' (not 'rationale')", async () => {
    const schema = JSON.parse(
      await readFile(
        join(SCHEMA_DIR, "verification_result.schema.json"),
        "utf8",
      ),
    );
    expect(schema.properties).toHaveProperty("reason");
    expect(schema.properties).not.toHaveProperty("rationale");
  });

  it("remediation_plan schema includes block_strategy property", async () => {
    const schema = JSON.parse(
      await readFile(join(SCHEMA_DIR, "remediation_plan.schema.json"), "utf8"),
    );
    expect(schema.properties).toHaveProperty("block_strategy");
  });

  it("remediation_plan schema includes e2e_command property", async () => {
    const schema = JSON.parse(
      await readFile(join(SCHEMA_DIR, "remediation_plan.schema.json"), "utf8"),
    );
    expect(schema.properties).toHaveProperty("e2e_command");
  });

  it("dispatch_quota schema exposes multi-pool capacity metadata", async () => {
    const schema = JSON.parse(
      await readFile(join(SCHEMA_DIR, "dispatch_quota.schema.json"), "utf8"),
    );
    expect(schema.properties).toHaveProperty("binding_cap");
    expect(schema.properties).toHaveProperty("capacity_pools");
    expect(schema.properties.source.enum).toContain("provider_default");
    expect(schema.properties.capacity_pools.items.properties).toHaveProperty(
      "resolved_limits",
    );
  });

  it("dispatch_quota schema required field is max_concurrent_agents not wave_size (INV-remediate-infra-01)", async () => {
    const schema = JSON.parse(
      await readFile(join(SCHEMA_DIR, "dispatch_quota.schema.json"), "utf8"),
    );
    // Runtime emits max_concurrent_agents; schema must match.
    expect(schema.required).toContain("max_concurrent_agents");
    expect(schema.required).not.toContain("wave_size");
    expect(schema.properties).toHaveProperty("max_concurrent_agents");
    expect(schema.properties).not.toHaveProperty("wave_size");
  });

  it("contract_pipeline schema JudgeRepairDirective target enum includes finalized_module_contracts (INV-remediate-infra-06)", async () => {
    const schema = JSON.parse(
      await readFile(join(SCHEMA_DIR, "contract_pipeline.schema.json"), "utf8"),
    );
    const judgeRepairDirective = (schema.$defs as Record<string, Record<string, unknown>>).JudgeRepairDirective;
    const targetEnum = (judgeRepairDirective.properties as Record<string, Record<string, unknown>>).target.enum as string[];
    expect(targetEnum).toContain("finalized_module_contracts");
    expect(targetEnum).toContain("obligation_ledger");
    expect(targetEnum).toContain("contract_assessment_report");
  });

  it("test_spec schema requires assertions", async () => {
    const schema = JSON.parse(
      await readFile(join(SCHEMA_DIR, "test_spec.schema.json"), "utf8"),
    );
    expect(schema.required).toContain("assertions");
    expect(schema.properties).toHaveProperty("assertions");
  });

  it("remediation_report result objects reject unknown fields", async () => {
    const schema = JSON.parse(
      await readFile(join(SCHEMA_DIR, "remediation_report.schema.json"), "utf8"),
    );
    expect(schema.properties.combined_test_result.additionalProperties).toBe(
      false,
    );
    expect(schema.properties.closing_result.additionalProperties).toBe(false);
  });

  it("remediation_report schema exposes structured evidence, test metadata, and run observability", async () => {
    const schema = JSON.parse(
      await readFile(join(SCHEMA_DIR, "remediation_report.schema.json"), "utf8"),
    );
    expect(schema.properties.started_at.type).toEqual(["string", "null"]);
    expect(schema.properties.ended_at.type).toBe("string");
    expect(schema.properties.step_count).toMatchObject({
      type: "integer",
      minimum: 0,
    });
    expect(
      schema.properties.resolved.items.properties.verification_evidence,
    ).toMatchObject({
      type: "array",
      items: { type: "string" },
    });
    expect(
      schema.properties.verified_no_change.items.properties.verification_evidence,
    ).toMatchObject({
      type: "array",
      items: { type: "string" },
    });
    expect(schema.properties.combined_test_result.properties).toMatchObject({
      suite_name: { type: "string" },
      duration_ms: { type: "integer", minimum: 0 },
      failure_summary: { type: "string" },
    });
    expect(schema.properties.combined_test_result.properties).not.toHaveProperty(
      "output",
    );
    expect(schema.properties.e2e_result.properties).toMatchObject({
      suite_name: { type: "string" },
      duration_ms: { type: "integer", minimum: 0 },
      failure_summary: { type: "string" },
    });
    expect(schema.properties.e2e_result.properties).not.toHaveProperty("output");
  });

  it("remediation_outcomes schema matches the RemediationOutcomesReport contract", async () => {
    const schema = JSON.parse(
      await readFile(
        join(SCHEMA_DIR, "remediation_outcomes.schema.json"),
        "utf8",
      ),
    );
    expect(schema.properties.contract_version.const).toBe(
      "remediate-code-outcomes/v1alpha1",
    );
    expect(schema.required).toEqual(
      expect.arrayContaining(["total", "by_outcome", "by_lens", "outcomes"]),
    );
    const outcome = schema.$defs.remediation_outcome;
    expect(outcome.required).toEqual(
      expect.arrayContaining([
        "finding_id",
        "lens",
        "file_exts",
        "outcome",
        "rework_count",
        "closing_status",
      ]),
    );
    expect(outcome.properties.outcome.enum).toEqual([
      "resolved",
      "verified_no_change",
      "inappropriate",
      "ignored",
      "blocked",
    ]);
    expect(outcome.properties).toMatchObject({
      closing_status_reason: { type: "string" },
      started_at: { type: "string" },
      completed_at: { type: "string" },
      duration_ms: { type: "number", minimum: 0 },
    });
    expect(schema.properties).toMatchObject({
      started_at: { type: "string" },
      completed_at: { type: "string" },
      duration_ms: { type: "number", minimum: 0 },
    });
  });

  it("finding schema requires 'lens' field", async () => {
    const schema = JSON.parse(
      await readFile(join(SCHEMA_DIR, "finding.schema.json"), "utf8"),
    );
    expect(schema.required).toContain("lens");
    expect(schema.properties).toHaveProperty("lens");
  });

  it("finding schema requires 'evidence' field with minItems", async () => {
    const schema = JSON.parse(
      await readFile(join(SCHEMA_DIR, "finding.schema.json"), "utf8"),
    );
    expect(schema.required).toContain("evidence");
    expect(schema.properties.evidence.minItems).toBeGreaterThanOrEqual(1);
  });

  it("remediation_report schema requires verified_no_change and blocked arrays (DAT-aee05de9)", async () => {
    const schema = JSON.parse(
      await readFile(join(SCHEMA_DIR, "remediation_report.schema.json"), "utf8"),
    );
    expect(schema.required).toContain("verified_no_change");
    expect(schema.required).toContain("blocked");
    expect(schema.properties).toHaveProperty("verified_no_change");
    expect(schema.properties).toHaveProperty("blocked");
  });
});
