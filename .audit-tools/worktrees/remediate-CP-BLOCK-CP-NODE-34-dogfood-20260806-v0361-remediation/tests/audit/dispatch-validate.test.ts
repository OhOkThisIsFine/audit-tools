import { test, expect } from "vitest";

const { validateResult } = await import("../../dispatch/validate.mjs");

// validateResult's JSDoc types `task` as `object | null` (its `if (!task)` guard
// treats null and undefined identically at runtime). This wrapper widens the
// call-site type to include `undefined` — matching the real accepted input —
// without touching dispatch/validate.mjs (outside this conversion's scope).
function callValidateResult(
  resultObj: object,
  task: object | null | undefined,
): { valid: boolean; errors: string[] } {
  return validateResult(resultObj, task ?? null);
}

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
    reviewed_clean: true,
  };
}

test("NEGATIVE: validateResult hard-fails a well-formed result when task context is null — never fail-open (CP-NODE-2 task-identity gate)", () => {
  const { valid, errors } = callValidateResult(wellFormedResult(), null);
  expect(valid).toBe(false);
  expect(
    errors.some((e) => /task context|assigned task/i.test(e)),
    `expected a missing-task-context error, got: ${JSON.stringify(errors)}`,
  ).toBeTruthy();
});

test("NEGATIVE: validateResult hard-fails when task context is undefined", () => {
  const { valid } = callValidateResult(wellFormedResult(), undefined);
  expect(valid).toBe(false);
});

test("NEGATIVE: validateResult uses live source — rejects a result that fails source-level validation", () => {
  const { valid, errors } = callValidateResult({}, assignedTask());
  expect(valid).toBe(false);
  expect(errors.length > 0, "expected at least one error for an empty object").toBeTruthy();
});

test("POSITIVE: validateResult accepts a well-formed result in its assigned task's context", () => {
  const { valid, errors } = callValidateResult(wellFormedResult(), assignedTask());
  expect(errors).toEqual([]);
  expect(valid).toBe(true);
});

test("NEGATIVE: validateResult rejects an identity mismatch against the assigned task (lens)", () => {
  const result = wellFormedResult();
  result.lens = "correctness";
  const { valid } = callValidateResult(result, assignedTask());
  expect(valid).toBe(false);
});
