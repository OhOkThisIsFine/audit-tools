import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const SCHEMA_DIR = join(__dirname, "..", "schemas");

const EXPECTED_SCHEMAS = [
  "clarification_request.schema.json",
  "closing_result.schema.json",
  "closing_plan.schema.json",
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
    it(`${schemaFile} exists and is valid JSON`, async () => {
      const content = await readFile(join(SCHEMA_DIR, schemaFile), "utf8");
      expect(() => JSON.parse(content)).not.toThrow();
    });

    it(`${schemaFile} declares a JSON Schema draft`, async () => {
      const schema = JSON.parse(
        await readFile(join(SCHEMA_DIR, schemaFile), "utf8"),
      );
      expect(typeof schema.$schema).toBe("string");
      expect(schema.$schema).toMatch(/json-schema\.org/);
    });

    it(`${schemaFile} has a type or $ref at the root`, async () => {
      const schema = JSON.parse(
        await readFile(join(SCHEMA_DIR, schemaFile), "utf8"),
      );
      const hasType = typeof schema.type === "string";
      const hasRef = typeof schema.$ref === "string";
      const hasOneOf = Array.isArray(schema.oneOf);
      const hasAnyOf = Array.isArray(schema.anyOf);
      expect(hasType || hasRef || hasOneOf || hasAnyOf).toBe(true);
    });
  }

  it("all expected schemas are present", async () => {
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(SCHEMA_DIR);
    const schemaFiles = files.filter((f) => f.endsWith(".schema.json"));
    expect(schemaFiles.length).toBeGreaterThanOrEqual(EXPECTED_SCHEMAS.length);
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
});
