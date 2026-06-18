import test from "node:test";
import assert from "node:assert/strict";
import { CoverageMatrixSchema, ClassificationStatusSchema } from "../src/types.ts";

// ---------------------------------------------------------------------------
// TASK-003 (A6): coverage_matrix is validated against its zod single source
// (CoverageMatrixSchema). The classification_status enum is ClassificationStatus
// — the same source scope.ts / trivialAudit.ts write — so the enum can never
// drift from the values the code emits (the former TS↔schema drift guard is now
// structurally impossible and was removed).
// ---------------------------------------------------------------------------

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
    const enumValues = ClassificationStatusSchema.options;
    for (const value of ["out_of_scope_delta", "excluded_trivial", "out_of_scope_intent"]) {
      assert.ok(
        enumValues.includes(value),
        `classification_status enum must include "${value}"`,
      );
    }
  });

  await t.test("documents using the scope/trivial statuses validate", () => {
    for (const value of ["out_of_scope_delta", "excluded_trivial", "out_of_scope_intent"]) {
      assert.doesNotThrow(() => CoverageMatrixSchema.parse(coverageMatrixWith(value)));
    }
  });

  await t.test("an unknown classification_status value still fails validation", () => {
    assert.throws(() =>
      CoverageMatrixSchema.parse(coverageMatrixWith("definitely_not_a_status")),
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
        () => CoverageMatrixSchema.parse(coverageMatrixWith(value)),
        `pre-existing classification_status "${value}" must remain valid`,
      );
    }
  });
});
