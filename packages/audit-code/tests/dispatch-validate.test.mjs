import test from "node:test";
import assert from "node:assert/strict";

const { validateResult } = await import("../dispatch/validate.mjs");

test("validateResult uses live source — rejects a result that fails source-level validation", () => {
  const { valid, errors } = validateResult({}, null);
  assert.equal(valid, false);
  assert.ok(errors.length > 0, "expected at least one error for an empty object");
});

test("validateResult returns valid:true for a well-formed audit result", () => {
  const result = {
    task_id: "task-001",
    unit_id: "unit-001",
    pass_id: "pass:security",
    lens: "security",
    file_coverage: [{ path: "src/api/auth.ts", total_lines: 3 }],
    findings: [],
  };
  const { valid, errors } = validateResult(result, null);
  assert.equal(valid, true);
  assert.deepEqual(errors, []);
});
