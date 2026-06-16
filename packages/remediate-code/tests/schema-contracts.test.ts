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
  "agent_reflection.schema.json",
  "clarification_request.schema.json",
  "closing_result.schema.json",
  "closing_plan.schema.json",
  "dispatch_quota.schema.json",
  "dispatch_plan.schema.json",
  "finding.schema.json",
  "item_spec.schema.json",
  "remediation_block.schema.json",
  "remediation_outcomes.schema.json",
  "remediation_plan.schema.json",
  "remediation_report.schema.json",
  "shared.schema.json",
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

      it("has a type or $ref at the root, or is a pure $defs library schema", () => {
        const s = schema as Record<string, unknown>;
        const hasType = typeof s.type === "string";
        const hasRef = typeof s.$ref === "string";
        const hasOneOf = Array.isArray(s.oneOf);
        const hasAnyOf = Array.isArray(s.anyOf);
        // Schemas used only as definition libraries (e.g. shared.schema.json) have
        // only $defs at the root — that is valid JSON Schema 2020-12 usage.
        const isDefsLibrary = typeof s.$defs === "object" && s.$defs !== null &&
          !hasType && !hasRef && !hasOneOf && !hasAnyOf;
        expect(hasType || hasRef || hasOneOf || hasAnyOf || isDefsLibrary).toBe(true);
      });
    });
  }

  it("all expected schemas are present on disk", async () => {
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(SCHEMA_DIR);
    const schemaFiles = files.filter((f) => f.endsWith(".schema.json"));
    expect(schemaFiles.length).toBeGreaterThanOrEqual(EXPECTED_SCHEMAS.length);
  });

  it("no schema files exist on disk that are missing from EXPECTED_SCHEMAS (bidirectional coverage)", async () => {
    // A new schema file added to schemas/ must also be added to EXPECTED_SCHEMAS above —
    // otherwise it ships untested. This test auto-detects the gap.
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(SCHEMA_DIR);
    const schemaFiles = files.filter((f) => f.endsWith(".schema.json")).sort();
    const expectedSorted = [...EXPECTED_SCHEMAS].sort();
    const missing = schemaFiles.filter((f) => !expectedSorted.includes(f));
    expect(missing).toEqual([]);
  });
});

// S6 — the contract-pipeline artifact contracts are single-sourced in the TS
// validators (CONTRACT_PIPELINE_VALIDATORS, src/validation/contractPipeline.ts)
// and tested in validation.test.ts. The hand-maintained contract_pipeline.schema.json
// was DELETED: it was unused at runtime, had drifted from the validators (a stale
// DesignSpec def + ~6 missing modern artifacts), and a second hand-maintained
// source can only ever drift again — imperative validators cannot be auto-generated
// into a JSON schema, so there is no non-drifting way to keep both. This guard
// rejects silent re-introduction of a parallel source; if an external JSON schema
// is ever genuinely needed, generate it from the validators rather than hand-maintaining it.
describe("contract_pipeline contract is single-sourced in the TS validators", () => {
  it("has no hand-maintained contract_pipeline.schema.json (deleted in S6)", () => {
    expect(existsSync(join(SCHEMA_DIR, "contract_pipeline.schema.json"))).toBe(false);
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

  // (The JudgeRepairDirective target-enum invariant INV-remediate-infra-06 is now
  // enforced + tested on the TS validator itself — validation.test.ts exercises
  // validateJudgeReport accepting finalized_module_contracts / legacy design_spec
  // and rejecting an unknown target — not on the deleted JSON schema. See S6.)

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

  it("remediation_outcomes schema declares every top-level key runClosePhase writes (DAT-99284fb4)", async () => {
    // runClosePhase writes remediation-outcomes.json as the RemediationOutcomesReport
    // PLUS run-context keys. Because the schema is additionalProperties:false, every
    // such key must be declared or the on-disk file fails validation against its own
    // schema. Keep this list in lockstep with close.ts's `outcomesFile` literal.
    const schema = JSON.parse(
      await readFile(
        join(SCHEMA_DIR, "remediation_outcomes.schema.json"),
        "utf8",
      ),
    );
    expect(schema.additionalProperties).toBe(false);
    const writtenTopLevelKeys = [
      "contract_version",
      "total",
      "by_outcome",
      "by_lens",
      "outcomes",
      "started_at",
      "ended_at",
      "step_count",
      "combined_test_result",
      "e2e_result",
      "closing_result",
      "plan_coverage",
    ];
    for (const key of writtenTopLevelKeys) {
      expect(
        schema.properties,
        `schema must declare top-level key '${key}' that runClosePhase writes (additionalProperties:false)`,
      ).toHaveProperty(key);
    }
    // The nested run-context shapes mirror remediation_report.schema.json.
    expect(schema.properties.combined_test_result.properties).toMatchObject({
      passed: { type: "boolean" },
      failure_summary: { type: "string" },
    });
    expect(schema.properties.closing_result.required).toEqual(
      expect.arrayContaining(["action", "status"]),
    );
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
