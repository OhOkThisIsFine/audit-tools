import test from "node:test";
import assert from "node:assert/strict";
import { assertMatchesJsonSchema } from "./helpers/jsonSchemaAssert.mjs";

// ---------------------------------------------------------------------------
// MNT-005: Verify refactored object keyword helper
// ---------------------------------------------------------------------------

test("jsonSchemaAssert preserves object and additionalProperties behavior after validator extraction", async (t) => {
  const schema = {
    type: "object",
    required: ["name", "age"],
    properties: {
      name: { type: "string" },
      age: { type: "integer" },
    },
    additionalProperties: false,
  };

  await t.test("validates required object properties through the object keyword helper", () => {
    assert.doesNotThrow(() =>
      assertMatchesJsonSchema(schema, { name: "Alice", age: 30 }, "obj"),
    );
  });

  await t.test("rejects missing required properties with path-aware assertion", () => {
    assert.throws(
      () => assertMatchesJsonSchema(schema, { name: "Alice" }, "obj"),
      /obj\.age is required/,
    );
  });

  await t.test("rejects disallowed additionalProperties through the object keyword helper", () => {
    assert.throws(
      () =>
        assertMatchesJsonSchema(
          schema,
          { name: "Alice", age: 30, extra: true },
          "obj",
        ),
      /obj\.extra is not allowed by schema/,
    );
  });
});

// ---------------------------------------------------------------------------
// MNT-005: Verify refactored array, string, and number keyword helpers
// ---------------------------------------------------------------------------

test("jsonSchemaAssert preserves array, string, and number constraint behavior after validator extraction", async (t) => {
  const arraySchema = {
    type: "array",
    items: { type: "string" },
    minItems: 1,
    maxItems: 3,
  };

  await t.test("validates array item schemas recursively through the array keyword helper", () => {
    assert.doesNotThrow(() =>
      assertMatchesJsonSchema(arraySchema, ["a", "b"], "arr"),
    );
  });

  await t.test("rejects array item that violates its item schema", () => {
    assert.throws(
      () => assertMatchesJsonSchema(arraySchema, ["a", 42], "arr"),
      /arr\[1\].*type.*string/i,
    );
  });

  await t.test("rejects string values that violate minLength with unchanged assertion semantics", () => {
    const strSchema = { type: "string", minLength: 5 };
    assert.throws(
      () => assertMatchesJsonSchema(strSchema, "hi", "str"),
      /str must have length >= 5/,
    );
  });

  await t.test("rejects string values that violate maxLength with unchanged assertion semantics", () => {
    const strSchema = { type: "string", maxLength: 3 };
    assert.throws(
      () => assertMatchesJsonSchema(strSchema, "toolong", "str"),
      /str must have length <= 3/,
    );
  });

  await t.test("rejects numeric values that violate minimum constraint with unchanged assertion semantics", () => {
    const numSchema = { type: "number", minimum: 10 };
    assert.throws(
      () => assertMatchesJsonSchema(numSchema, 5, "num"),
      /num must be >= 10/,
    );
  });

  await t.test("rejects numeric values that violate maximum constraint with unchanged assertion semantics", () => {
    const numSchema = { type: "number", maximum: 100 };
    assert.throws(
      () => assertMatchesJsonSchema(numSchema, 200, "num"),
      /num must be <= 100/,
    );
  });
});

// ---------------------------------------------------------------------------
// MNT-005: Verify refactored $ref, combiners, const, and enum behavior
// ---------------------------------------------------------------------------

test("jsonSchemaAssert preserves refs, combiners, const, and enum behavior after validator extraction", async (t) => {
  await t.test("resolves $ref before delegating keyword validation", () => {
    const schema = {
      $id: "root",
      properties: {
        status: { $ref: "#/definitions/Status" },
      },
      definitions: {
        Status: { type: "string", enum: ["active", "inactive"] },
      },
    };
    assert.doesNotThrow(() =>
      assertMatchesJsonSchema(schema, { status: "active" }, "obj"),
    );
    assert.throws(
      () => assertMatchesJsonSchema(schema, { status: "deleted" }, "obj"),
      /obj\.status must be one of/,
    );
  });

  await t.test("preserves allOf combiner behavior", () => {
    const schema = {
      allOf: [
        { type: "object", required: ["a"], properties: { a: { type: "string" } } },
        { type: "object", required: ["b"], properties: { b: { type: "number" } } },
      ],
    };
    assert.doesNotThrow(() =>
      assertMatchesJsonSchema(schema, { a: "hello", b: 42 }, "obj"),
    );
    assert.throws(
      () => assertMatchesJsonSchema(schema, { a: "hello" }, "obj"),
      /obj\.b is required/,
    );
  });

  await t.test("preserves anyOf combiner behavior", () => {
    const schema = {
      anyOf: [{ type: "string" }, { type: "number" }],
    };
    assert.doesNotThrow(() =>
      assertMatchesJsonSchema(schema, "text", "val"),
    );
    assert.doesNotThrow(() =>
      assertMatchesJsonSchema(schema, 42, "val"),
    );
    assert.throws(
      () => assertMatchesJsonSchema(schema, true, "val"),
      /val must satisfy at least one anyOf branch/,
    );
  });

  await t.test("preserves oneOf combiner behavior", () => {
    const schema = {
      oneOf: [{ type: "string" }, { type: "string", minLength: 5 }],
    };
    // "hi" matches first branch only (minLength 5 would fail)
    assert.doesNotThrow(() =>
      assertMatchesJsonSchema(schema, "hi", "val"),
    );
    // "hello world" matches both string branches -> fails oneOf
    assert.throws(
      () => assertMatchesJsonSchema(schema, "hello world", "val"),
      /val must satisfy exactly one oneOf branch/,
    );
  });

  await t.test(
    "silently ignores not keyword — helper does not implement not, so value matching the not-schema still passes",
    () => {
      // The helper does not implement the `not` keyword — it is silently ignored.
      // A value that should be rejected by `not: { type: 'string' }` still passes.
      assert.doesNotThrow(
        () => assertMatchesJsonSchema({ not: { type: "string" } }, "a string value", "val"),
        "not constraint is silently ignored by the helper",
      );
      // Combining `not` with another keyword: the `not` portion is still silently ignored.
      assert.doesNotThrow(
        () =>
          assertMatchesJsonSchema(
            { type: "string", not: { minLength: 3 } },
            "hi",
            "val",
          ),
        "not constraint on minLength is silently ignored",
      );
    },
  );

  await t.test(
    "schema without not keyword validates normally (baseline — not keyword absence imposes no restriction)",
    () => {
      const schema = { type: "string" };
      assert.doesNotThrow(() =>
        assertMatchesJsonSchema(schema, "anything", "val"),
      );
    },
  );

  await t.test("preserves const acceptance behavior", () => {
    const schema = { const: "fixed-value" };
    assert.doesNotThrow(() =>
      assertMatchesJsonSchema(schema, "fixed-value", "val"),
    );
    assert.throws(
      () => assertMatchesJsonSchema(schema, "other", "val"),
      /val must equal "fixed-value"/,
    );
  });

  await t.test("preserves enum acceptance and rejection behavior", () => {
    const schema = { type: "string", enum: ["a", "b", "c"] };
    assert.doesNotThrow(() =>
      assertMatchesJsonSchema(schema, "b", "val"),
    );
    assert.throws(
      () => assertMatchesJsonSchema(schema, "d", "val"),
      /val must be one of/,
    );
  });
});

// ---------------------------------------------------------------------------
// TST-006: date-time format validation
// ---------------------------------------------------------------------------

test("jsonSchemaAssert rejects invalid date-time strings", async (t) => {
  const schema = { type: "string", format: "date-time" };

  await t.test("accepts a valid RFC 3339 date-time string", () => {
    assert.doesNotThrow(() =>
      assertMatchesJsonSchema(schema, "2024-03-15T10:30:00Z", "ts"),
    );
  });

  await t.test("accepts a valid RFC 3339 date-time string with offset", () => {
    assert.doesNotThrow(() =>
      assertMatchesJsonSchema(schema, "2024-03-15T10:30:00+05:30", "ts"),
    );
  });

  await t.test("accepts a valid RFC 3339 date-time string with fractional seconds", () => {
    assert.doesNotThrow(() =>
      assertMatchesJsonSchema(schema, "2024-03-15T10:30:00.123Z", "ts"),
    );
  });

  await t.test("rejects a clearly invalid date-time value (plain text)", () => {
    assert.throws(
      () => assertMatchesJsonSchema(schema, "not-a-date", "ts"),
      /ts must match date-time format/,
    );
  });

  await t.test("rejects a date-only string (missing time component)", () => {
    assert.throws(
      () => assertMatchesJsonSchema(schema, "2024-03-15", "ts"),
      /ts must match date-time format/,
    );
  });

  await t.test("rejects a malformed timestamp-like value with out-of-range hour", () => {
    assert.throws(
      () => assertMatchesJsonSchema(schema, "2024-03-15T25:00:00Z", "ts"),
      /ts must match date-time format/,
    );
  });

  await t.test("rejects a malformed timestamp-like value with invalid month (00)", () => {
    assert.throws(
      () => assertMatchesJsonSchema(schema, "2024-00-15T10:30:00Z", "ts"),
      /ts must match date-time format/,
    );
  });

  await t.test("rejects a malformed timestamp-like value with invalid day (00)", () => {
    assert.throws(
      () => assertMatchesJsonSchema(schema, "2024-03-00T10:30:00Z", "ts"),
      /ts must match date-time format/,
    );
  });

  await t.test("rejects a malformed timestamp-like value with invalid month (13)", () => {
    assert.throws(
      () => assertMatchesJsonSchema(schema, "2024-13-01T10:30:00Z", "ts"),
      /ts must match date-time format/,
    );
  });

  await t.test("rejects a non-existent calendar date (Feb 30)", () => {
    assert.throws(
      () => assertMatchesJsonSchema(schema, "2024-02-30T10:30:00Z", "ts"),
      /ts must match date-time format/,
    );
  });

  await t.test("rejects a non-existent calendar date (Apr 31)", () => {
    assert.throws(
      () => assertMatchesJsonSchema(schema, "2024-04-31T10:30:00Z", "ts"),
      /ts must match date-time format/,
    );
  });
});

// ---------------------------------------------------------------------------
// TST-006: unsupported string formats are deliberately ignored
// ---------------------------------------------------------------------------

test("jsonSchemaAssert intentionally skips unsupported string formats", async (t) => {
  // The helper only validates format: "date-time"; other format values are
  // deliberately ignored so that schemas using "email", "uri", etc. do not
  // produce false failures.
  await t.test("does not throw for unsupported format keyword (email)", () => {
    const schema = { type: "string", format: "email" };
    // Any string passes — unsupported formats are intentionally not validated.
    assert.doesNotThrow(() =>
      assertMatchesJsonSchema(schema, "not-an-email-at-all", "val"),
      "Unsupported formats are deliberately ignored by the helper",
    );
  });

  await t.test("does not throw for unsupported format keyword (uri)", () => {
    const schema = { type: "string", format: "uri" };
    assert.doesNotThrow(() =>
      assertMatchesJsonSchema(schema, "definitely not a uri", "val"),
      "Unsupported formats are deliberately ignored by the helper",
    );
  });
});

// ---------------------------------------------------------------------------
// TST-006: dispatch quota schema enforces cooldown_until date-time via helper
// ---------------------------------------------------------------------------

const baseQuota = {
  contract_version: "audit-code-dispatch-quota/v1alpha1",
  run_id: "run-abc123",
  model: "claude-sonnet-4-6",
  resolved_limits: {
    context_tokens: 200000,
    output_tokens: 8192,
    requests_per_minute: null,
    input_tokens_per_minute: null,
    output_tokens_per_minute: null,
  },
  confidence: "high",
  source: "known_metadata",
  host_concurrency_limit: null,
  max_concurrent_agents: 5,
  cooldown_until: null,
};

test("dispatch quota schema enforces cooldown_until date-time format through helper", async (t) => {
  const { readFile } = await import("node:fs/promises");
  const { dirname, join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");

  const here = dirname(fileURLToPath(import.meta.url));
  const schemaPath = join(here, "..", "schemas", "dispatch_quota.schema.json");
  const schema = JSON.parse(await readFile(schemaPath, "utf8"));

  await t.test("a dispatch quota object with valid cooldown_until passes the schema helper", () => {
    const quota = { ...baseQuota, cooldown_until: "2024-06-01T12:00:00Z" };
    assert.doesNotThrow(() =>
      assertMatchesJsonSchema(schema, quota, "quota"),
    );
  });

  await t.test("a dispatch quota object with invalid cooldown_until string fails the schema helper", () => {
    const quota = { ...baseQuota, cooldown_until: "not-a-timestamp" };
    assert.throws(
      () => assertMatchesJsonSchema(schema, quota, "quota"),
      /quota\.cooldown_until must match date-time format/,
    );
  });

  await t.test("a dispatch quota object with cooldown_until set to null passes when other required fields are valid", () => {
    const quota = { ...baseQuota, cooldown_until: null };
    assert.doesNotThrow(() =>
      assertMatchesJsonSchema(schema, quota, "quota"),
    );
  });
});

// ---------------------------------------------------------------------------
// DAT-3a3fe3af: if/then/else keyword support in jsonSchemaAssert
// ---------------------------------------------------------------------------

const IF_THEN_SCHEMA = {
  type: "object",
  required: ["action"],
  properties: {
    action: { type: "string" },
    custom_command: { type: "string" },
    standard_arg: { type: "string" },
  },
  if: {
    properties: { action: { const: "custom" } },
    required: ["action"],
  },
  then: { required: ["custom_command"] },
};

const IF_THEN_ELSE_SCHEMA = {
  ...IF_THEN_SCHEMA,
  else: { required: ["standard_arg"] },
};

test("jsonSchemaAssert if/then: enforces then-branch when if condition is satisfied", async (t) => {
  await t.test("throws when action=custom but custom_command is absent", () => {
    assert.throws(
      () => assertMatchesJsonSchema(IF_THEN_SCHEMA, { action: "custom" }, "obj"),
      /obj\.custom_command is required/,
    );
  });

  await t.test("does not throw when action=custom and custom_command is present", () => {
    assert.doesNotThrow(() =>
      assertMatchesJsonSchema(
        IF_THEN_SCHEMA,
        { action: "custom", custom_command: "my-cmd" },
        "obj",
      ),
    );
  });
});

test("jsonSchemaAssert if/then: skips then-branch when if condition is not satisfied", async (t) => {
  await t.test("does not throw when action=run even though custom_command is absent", () => {
    assert.doesNotThrow(() =>
      assertMatchesJsonSchema(IF_THEN_SCHEMA, { action: "run" }, "obj"),
    );
  });
});

test("jsonSchemaAssert if/then/else: enforces else-branch when if condition is not satisfied", async (t) => {
  await t.test("throws when action=run but standard_arg is absent", () => {
    assert.throws(
      () => assertMatchesJsonSchema(IF_THEN_ELSE_SCHEMA, { action: "run" }, "obj"),
      /obj\.standard_arg is required/,
    );
  });

  await t.test("does not throw when action=run and standard_arg is present", () => {
    assert.doesNotThrow(() =>
      assertMatchesJsonSchema(
        IF_THEN_ELSE_SCHEMA,
        { action: "run", standard_arg: "myarg" },
        "obj",
      ),
    );
  });
});

test("jsonSchemaAssert if with no then and no else: no assertion for any value", async (t) => {
  const schema = {
    type: "object",
    properties: { action: { type: "string" } },
    if: { properties: { action: { const: "custom" } }, required: ["action"] },
  };

  await t.test("does not throw when if condition is satisfied", () => {
    assert.doesNotThrow(() =>
      assertMatchesJsonSchema(schema, { action: "custom" }, "obj"),
    );
  });

  await t.test("does not throw when if condition is not satisfied", () => {
    assert.doesNotThrow(() =>
      assertMatchesJsonSchema(schema, { action: "other" }, "obj"),
    );
  });
});

test("jsonSchemaAssert closing_plan if/then: custom_command required when action=custom", async (t) => {
  // Mirrors remediate-code's closing_plan.schema.json if/then contract, but with
  // the closing_action enum inlined. The real schema resolves the action enum via
  // `$ref: "shared.schema.json#/$defs/closing_action"`, a sibling of the schema
  // inside remediate-code; that cross-package reference is not resolvable from
  // audit-code's assertMatchesJsonSchema registry, so we inline the contract under
  // test here rather than load the file across packages.
  const closingPlanSchema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    required: ["action"],
    properties: {
      action: {
        type: "string",
        enum: ["commit", "push", "open-pr", "publish", "tag", "none", "custom"],
      },
      custom_command: {
        type: "array",
        items: { type: "string" },
      },
    },
    if: {
      properties: { action: { const: "custom" } },
    },
    then: {
      required: ["custom_command"],
    },
    additionalProperties: false,
  };

  await t.test("throws for { action: 'custom' } — custom_command is missing", () => {
    assert.throws(
      () =>
        assertMatchesJsonSchema(closingPlanSchema, { action: "custom" }, "plan"),
      /plan\.custom_command is required/,
    );
  });

  await t.test("does not throw for { action: 'custom', custom_command: [...] }", () => {
    assert.doesNotThrow(() =>
      assertMatchesJsonSchema(
        closingPlanSchema,
        { action: "custom", custom_command: ["my-cmd"] },
        "plan",
      ),
    );
  });

  await t.test("does not throw for non-custom action without custom_command", () => {
    assert.doesNotThrow(() =>
      assertMatchesJsonSchema(closingPlanSchema, { action: "commit" }, "plan"),
    );
  });
});
