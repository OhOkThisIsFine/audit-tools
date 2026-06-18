import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

const { withinRoot } = await import("../../src/audit/cli/dispatch.ts");

const ROOT = process.platform === "win32" ? "C:\\repo" : "/repo";

test("withinRoot resolves paths that stay inside the root", () => {
  assert.equal(withinRoot(ROOT, "src/file.ts"), join(ROOT, "src", "file.ts"));
  assert.equal(withinRoot(ROOT, "./a/b/c.txt"), join(ROOT, "a", "b", "c.txt"));
  // An absolute path that is genuinely inside the root is allowed.
  assert.equal(withinRoot(ROOT, join(ROOT, "x")), join(ROOT, "x"));
});

test("withinRoot rejects paths that escape the root", () => {
  assert.throws(() => withinRoot(ROOT, "../secret"), /escapes repository root/);
  assert.throws(() => withinRoot(ROOT, "../../etc/passwd"), /escapes repository root/);
  // A traversal that nets outside the root, even with an inside-looking prefix.
  assert.throws(() => withinRoot(ROOT, "a/../../b"), /escapes repository root/);
});

test("withinRoot rejects an absolute path outside the root", () => {
  const outside = process.platform === "win32" ? "D:\\other\\x" : "/other/x";
  assert.throws(() => withinRoot(ROOT, outside), /escapes repository root/);
});
