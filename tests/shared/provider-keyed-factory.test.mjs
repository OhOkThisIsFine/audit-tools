import test from "node:test";
import assert from "node:assert/strict";

const { makeProviderKeyedFactory } = await import("../../src/shared/providers/providerKeyedFactory.ts");
const { collectClaudeCodeJsonLines } = await import("../../src/shared/quota/claudeCodeJsonLines.ts");

// ── makeProviderKeyedFactory (drift-plan E5) ────────────────────────────────

test("makeProviderKeyedFactory returns the record value for a known provider key", () => {
  const generic = { name: "generic" };
  const claude = { name: "claude-code" };
  const lookup = makeProviderKeyedFactory({ "claude-code": claude }, generic);
  assert.strictEqual(lookup("claude-code"), claude);
});

test("makeProviderKeyedFactory returns the generic fallback for an unknown provider key", () => {
  const generic = { name: "generic" };
  const claude = { name: "claude-code" };
  const lookup = makeProviderKeyedFactory({ "claude-code": claude }, generic);
  assert.strictEqual(lookup("opencode"), generic);
  assert.strictEqual(lookup("totally-unknown"), generic);
});

test("makeProviderKeyedFactory returns the same fallback instance for every unknown key (singleton fallback)", () => {
  const generic = { name: "generic" };
  const lookup = makeProviderKeyedFactory({}, generic);
  const a = lookup("x");
  const b = lookup("y");
  assert.strictEqual(a, b, "all unknown keys must resolve to the same fallback instance");
  assert.strictEqual(a, generic);
});

// ── collectClaudeCodeJsonLines (drift-plan E5) ──────────────────────────────

test("collectClaudeCodeJsonLines parses every JSON object line and skips noise", () => {
  const stderr = [
    "plain text noise",
    '{"level":"info","message":"started"}',
    "not json {oops",
    '{"status_code":429,"retry_after":30}',
  ].join("\n");
  const objects = collectClaudeCodeJsonLines(stderr);
  assert.equal(objects.length, 2);
  assert.equal(objects[0].message, "started");
  assert.equal(objects[1].status_code, 429);
});

test("collectClaudeCodeJsonLines skips non-object JSON (arrays, scalars)", () => {
  const stderr = ['[1,2,3]', '{"a":1}', '"bare string"', '42'].join("\n");
  const objects = collectClaudeCodeJsonLines(stderr);
  // Only the `{`-prefixed object line is collected; the array starts with `[`
  // (filtered before parse) and the scalars never start with `{`.
  assert.deepEqual(objects, [{ a: 1 }]);
});

test("collectClaudeCodeJsonLines returns an empty array for empty / noise-only input", () => {
  assert.deepEqual(collectClaudeCodeJsonLines(""), []);
  assert.deepEqual(collectClaudeCodeJsonLines("no json here\nstill none"), []);
});
