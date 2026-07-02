import { test, describe, it, expect } from "vitest";

const { prefixValidationIssues } = await import("../../src/shared/validation/basic.ts");

describe("prefixValidationIssues idempotency guard — already-prefixed paths are not double-prefixed", () => {
  it("an issue whose path equals prefix exactly is returned with path unchanged", () => {
    const issues = [{ path: "foo", message: "msg", severity: "error" }];
    const result = prefixValidationIssues("foo", issues);
    expect(result[0].path).toBe("foo");
  });

  it("an issue whose path starts with prefix+'.' is returned with path unchanged", () => {
    const issues = [{ path: "foo.bar", message: "msg", severity: "error" }];
    const result = prefixValidationIssues("foo", issues);
    expect(result[0].path).toBe("foo.bar");
  });

  it("an issue with an empty path is returned with path set to prefix", () => {
    const issues = [{ path: "", message: "msg", severity: "error" }];
    const result = prefixValidationIssues("foo", issues);
    expect(result[0].path).toBe("foo");
  });

  it("an issue with an unrelated path has prefix+'.' prepended", () => {
    const issues = [{ path: "bar", message: "msg", severity: "error" }];
    const result = prefixValidationIssues("foo", issues);
    expect(result[0].path).toBe("foo.bar");
  });
});
