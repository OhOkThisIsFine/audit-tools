import { test, describe, it, expect } from "vitest";

const { prefixValidationIssues } = await import("../../src/shared/validation/basic.ts");

test("prefixValidationIssues: empty path is replaced by the prefix", () => {
  const result = prefixValidationIssues("foo", [
    { path: "", message: "bad", severity: "error" },
  ]);
  expect(result).toEqual([{ path: "foo", message: "bad", severity: "error" }]);
});

test("prefixValidationIssues: path that exactly equals the prefix is left unchanged (de-dup guard)", () => {
  const result = prefixValidationIssues("foo", [
    { path: "foo", message: "bad", severity: "error" },
  ]);
  expect(result).toEqual([{ path: "foo", message: "bad", severity: "error" }]);
});

describe("prefixValidationIssues: path that starts with prefix + '.' is left unchanged (de-dup guard)", () => {
  it("one level deep", () => {
    const result = prefixValidationIssues("foo", [
      { path: "foo.bar", message: "bad", severity: "error" },
    ]);
    expect(result).toEqual([{ path: "foo.bar", message: "bad", severity: "error" }]);
  });

  it("two levels deep", () => {
    const result = prefixValidationIssues("foo", [
      { path: "foo.bar.baz", message: "bad", severity: "error" },
    ]);
    expect(result).toEqual([{ path: "foo.bar.baz", message: "bad", severity: "error" }]);
  });
});

test("prefixValidationIssues: path that shares a string prefix but is not dot-separated is still prefixed (no false de-dup)", () => {
  // 'foobar' starts with the string 'foo' but not 'foo.' — must be prefixed
  const result = prefixValidationIssues("foo", [
    { path: "foobar", message: "bad", severity: "error" },
  ]);
  expect(result).toEqual([{ path: "foo.foobar", message: "bad", severity: "error" }]);
});

test("prefixValidationIssues: normal non-empty path that does not start with prefix is prepended", () => {
  const result = prefixValidationIssues("root", [
    { path: "child", message: "bad", severity: "warning" },
  ]);
  expect(result).toEqual([{ path: "root.child", message: "bad", severity: "warning" }]);
});

test("prefixValidationIssues: mixed issues in a single call are all handled correctly", () => {
  const issues = [
    { path: "", message: "m1", severity: "error" },
    { path: "root", message: "m2", severity: "error" },
    { path: "root.nested", message: "m3", severity: "warning" },
    { path: "other", message: "m4", severity: "error" },
  ];
  const result = prefixValidationIssues("root", issues);
  expect(result).toEqual([
    { path: "root", message: "m1", severity: "error" },
    { path: "root", message: "m2", severity: "error" },
    { path: "root.nested", message: "m3", severity: "warning" },
    { path: "root.other", message: "m4", severity: "error" },
  ]);
});

test("prefixValidationIssues: returns a new array and does not mutate the input", () => {
  const issues = [{ path: "x", message: "bad", severity: "error" }];
  const original = issues[0];
  const result = prefixValidationIssues("pfx", issues);

  // Different array reference
  expect(result).not.toBe(issues);
  // Original issue object is unchanged
  expect(issues[0].path).toBe("x");
  expect(original.path).toBe("x");
  // The returned object is a new reference
  expect(result[0]).not.toBe(original);
  expect(result[0].path).toBe("pfx.x");
});
