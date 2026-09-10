import { access } from "node:fs/promises";
// `describeValue` and `isRecord` are IMPORTED, never re-declared. Both stood
// here as byte-identical copies of `src/shared/validation/basic.ts`. The copies
// is the defect, not their fidelity: a duplicated predicate stays correct only
// until someone edits one of them, and the failure mode is a test helper
// disagreeing with the validator it is helping to exercise.
// `tests/shared/test-mirrors-production.test.ts` is the invariant that keeps a
// third copy from appearing.
export { describeValue, isRecord } from "audit-tools/shared";

export function fail(message) {
  throw new Error(message);
}

export function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(`${label} must be a non-empty string, got ${describeValue(value)}.`);
  }
}

export function assertStringArray(value, label, options = {}) {
  if (!Array.isArray(value)) {
    fail(`${label} must be an array of strings.`);
  }
  if (!options.allowEmpty && value.length === 0) {
    fail(`${label} must not be empty.`);
  }
  value.forEach((entry, index) => {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      fail(`${label}[${index}] must be a non-empty string.`);
    }
  });
}

export function looksLikeCliFlag(value) {
  return typeof value === "string" && value.startsWith("--");
}

export async function assertAccessibleDirectory(path, label) {
  assertNonEmptyString(path, label);
  try {
    await access(path);
  } catch (error) {
    fail(`${label} does not exist or is not accessible: ${path}`);
  }
}
