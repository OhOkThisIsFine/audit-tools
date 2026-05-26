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

  await t.test("preserves not combiner behavior — not keyword absent means no restriction", () => {
    const schema = { type: "string" };
    assert.doesNotThrow(() =>
      assertMatchesJsonSchema(schema, "anything", "val"),
    );
  });

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
  wave_size: 5,
  estimated_wave_tokens: 100000,
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
