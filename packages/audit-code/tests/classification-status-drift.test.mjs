import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// ---------------------------------------------------------------------------
// TASK-004: drift guard between the runtime CLASSIFICATION_STATUSES constant
// (packages/audit-code/src/types.ts) and the classification_status enum in
// schemas/coverage_matrix.schema.json. Adding, removing, or renaming a value
// on either side without updating the other must fail this test.
// ---------------------------------------------------------------------------

const { CLASSIFICATION_STATUSES } = await import("../src/types.ts");

// Resolve the schema relative to this test file, not the process cwd.
const schemaPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "schemas",
  "coverage_matrix.schema.json",
);

test("classification_status schema enum matches exported TS union values", async (t) => {
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  const schemaEnum =
    schema?.properties?.files?.items?.properties?.classification_status?.enum;

  await t.test("schema declares a classification_status enum array", () => {
    assert.ok(
      Array.isArray(schemaEnum),
      "properties.files.items.properties.classification_status.enum must be an array in coverage_matrix.schema.json",
    );
  });

  await t.test("CLASSIFICATION_STATUSES is a non-empty array with no duplicates", () => {
    assert.ok(Array.isArray(CLASSIFICATION_STATUSES));
    assert.ok(CLASSIFICATION_STATUSES.length > 0, "CLASSIFICATION_STATUSES must be non-empty");
    assert.equal(
      new Set(CLASSIFICATION_STATUSES).size,
      CLASSIFICATION_STATUSES.length,
      "CLASSIFICATION_STATUSES must not contain duplicate members",
    );
  });

  await t.test("schema enum and TS constant are set-equal (both directions)", () => {
    assert.deepEqual(
      [...schemaEnum].sort(),
      [...CLASSIFICATION_STATUSES].sort(),
      "schema/TS classification_status drift: coverage_matrix.schema.json's " +
        "classification_status enum and CLASSIFICATION_STATUSES in src/types.ts " +
        "must list exactly the same values — update both sides together",
    );
  });
});
