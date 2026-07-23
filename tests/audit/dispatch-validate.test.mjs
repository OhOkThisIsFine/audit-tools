import { test, expect } from "vitest";

const { validateResult } = await import("../../dispatch/validate.mjs");

/** The assigned task context a result must validate against (CP-NODE-2). */
function assignedTask() {
  return {
    task_id: "task-001",
    unit_id: "unit-001",
    pass_id: "pass:security",
    lens: "security",
    file_paths: ["src/api/auth.ts"],
  };
}

function wellFormedResult() {
  return {
    task_id: "task-001",
    unit_id: "unit-001",
    pass_id: "pass:security",
    lens: "security",
    file_coverage: [{ path: "src/api/auth.ts", total_lines: 3 }],
    findings: [],
  };
}

test("NEGATIVE: validateResult hard-fails a well-formed result when task context is null — never fail-open (CP-NODE-2 task-identity gate)", () => {
  const { valid, errors } = validateResult(wellFormedResult(), null);
  expect(valid).toBe(false);
  expect(
    errors.some((e) => /task context|assigned task/i.test(e)),
    `expected a missing-task-context error, got: ${JSON.stringify(errors)}`,
  ).toBeTruthy();
});

test("NEGATIVE: validateResult hard-fails when task context is undefined", () => {
  const { valid } = validateResult(wellFormedResult(), undefined);
  expect(valid).toBe(false);
});

test("NEGATIVE: validateResult uses live source — rejects a result that fails source-level validation", () => {
  const { valid, errors } = validateResult({}, assignedTask());
  expect(valid).toBe(false);
  expect(errors.length > 0, "expected at least one error for an empty object").toBeTruthy();
});

test("POSITIVE: validateResult accepts a well-formed result in its assigned task's context", () => {
  const { valid, errors } = validateResult(wellFormedResult(), assignedTask());
  expect(errors).toEqual([]);
  expect(valid).toBe(true);
});

test("NEGATIVE: validateResult rejects an identity mismatch against the assigned task (lens)", () => {
  const result = wellFormedResult();
  result.lens = "correctness";
  const { valid } = validateResult(result, assignedTask());
  expect(valid).toBe(false);
});
