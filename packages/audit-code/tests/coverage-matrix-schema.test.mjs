import test from "node:test";
import assert from "node:assert/strict";
import {
  SCHEMA_REGISTRY,
  assertMatchesJsonSchema,
} from "./helpers/auditSchemaRegistry.mjs";

// ---------------------------------------------------------------------------
// TASK-003: coverage_matrix classification_status enum covers every value the
// TypeScript code writes (scope.ts writes out_of_scope_delta and
// out_of_scope_intent; trivialAudit.ts writes excluded_trivial).
// ---------------------------------------------------------------------------

const schema = SCHEMA_REGISTRY["coverage_matrix.schema.json"];

function coverageMatrixWith(classificationStatus) {
  return {
    files: [
      {
        path: "src/example.ts",
        unit_ids: ["unit-1"],
        classification_status: classificationStatus,
        audit_status: "pending",
        required_lenses: ["correctness"],
        completed_lenses: [],
      },
    ],
  };
}

test("coverage_matrix schema accepts all classification_status values written by code", async (t) => {
  await t.test("classification_status enum includes the statuses written by scope and trivial-audit code", () => {
    const enumValues =
      schema.properties.files.items.properties.classification_status.enum;
    assert.ok(Array.isArray(enumValues), "classification_status enum must be an array");
    for (const value of ["out_of_scope_delta", "excluded_trivial", "out_of_scope_intent"]) {
      assert.ok(
        enumValues.includes(value),
        `classification_status enum must include "${value}"`,
      );
    }
  });

  await t.test("a coverage_matrix document using out_of_scope_delta validates", () => {
    assert.doesNotThrow(() =>
      assertMatchesJsonSchema(
        schema,
        coverageMatrixWith("out_of_scope_delta"),
        "coverage_matrix",
      ),
    );
  });

  await t.test("a coverage_matrix document using excluded_trivial validates", () => {
    assert.doesNotThrow(() =>
      assertMatchesJsonSchema(
        schema,
        coverageMatrixWith("excluded_trivial"),
        "coverage_matrix",
      ),
    );
  });

  await t.test("a coverage_matrix document using out_of_scope_intent validates", () => {
    assert.doesNotThrow(() =>
      assertMatchesJsonSchema(
        schema,
        coverageMatrixWith("out_of_scope_intent"),
        "coverage_matrix",
      ),
    );
  });

  await t.test("an unknown classification_status value still fails validation", () => {
    assert.throws(
      () =>
        assertMatchesJsonSchema(
          schema,
          coverageMatrixWith("definitely_not_a_status"),
          "coverage_matrix",
        ),
      /classification_status must be one of/,
    );
  });

  await t.test("previously valid classification_status values continue to validate", () => {
    const preexisting = [
      "unclassified",
      "classified",
      "excluded",
      "generated",
      "vendor",
      "binary",
      "doc_only",
    ];
    for (const value of preexisting) {
      assert.doesNotThrow(
        () =>
          assertMatchesJsonSchema(
            schema,
            coverageMatrixWith(value),
            "coverage_matrix",
          ),
        `pre-existing classification_status "${value}" must remain valid`,
      );
    }
  });
});
