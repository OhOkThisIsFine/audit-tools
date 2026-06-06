import test from "node:test";
import assert from "node:assert/strict";

const { prefixValidationIssues } = await import("../src/validation/basic.ts");

test("prefixValidationIssues idempotency guard — already-prefixed paths are not double-prefixed", async (t) => {
  await t.test("an issue whose path equals prefix exactly is returned with path unchanged", () => {
    const issues = [{ path: "foo", message: "msg", severity: "error" }];
    const result = prefixValidationIssues("foo", issues);
    assert.equal(result[0].path, "foo");
  });

  await t.test("an issue whose path starts with prefix+'.' is returned with path unchanged", () => {
    const issues = [{ path: "foo.bar", message: "msg", severity: "error" }];
    const result = prefixValidationIssues("foo", issues);
    assert.equal(result[0].path, "foo.bar");
  });

  await t.test("an issue with an empty path is returned with path set to prefix", () => {
    const issues = [{ path: "", message: "msg", severity: "error" }];
    const result = prefixValidationIssues("foo", issues);
    assert.equal(result[0].path, "foo");
  });

  await t.test("an issue with an unrelated path has prefix+'.' prepended", () => {
    const issues = [{ path: "bar", message: "msg", severity: "error" }];
    const result = prefixValidationIssues("foo", issues);
    assert.equal(result[0].path, "foo.bar");
  });
});
