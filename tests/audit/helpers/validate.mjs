import { access } from "node:fs/promises";

export function fail(message) {
  throw new Error(message);
}

export function describeValue(value) {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

export function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
