import { test, expect } from "vitest";

const { makeProviderKeyedFactory } = await import("../../src/shared/providers/providerKeyedFactory.ts");
const { collectClaudeCodeJsonLines } = await import("../../src/shared/quota/claudeCodeJsonLines.ts");

// ── makeProviderKeyedFactory (drift-plan E5) ────────────────────────────────

test("makeProviderKeyedFactory returns the record value for a known provider key", () => {
  const generic = { name: "generic" };
  const claude = { name: "claude-code" };
  const lookup = makeProviderKeyedFactory({ "claude-code": claude }, generic);
  expect(lookup("claude-code")).toBe(claude);
});

test("makeProviderKeyedFactory returns the generic fallback for an unknown provider key", () => {
  const generic = { name: "generic" };
  const claude = { name: "claude-code" };
  const lookup = makeProviderKeyedFactory({ "claude-code": claude }, generic);
  expect(lookup("opencode")).toBe(generic);
  expect(lookup("totally-unknown")).toBe(generic);
});

test("makeProviderKeyedFactory returns the same fallback instance for every unknown key (singleton fallback)", () => {
  const generic = { name: "generic" };
  const lookup = makeProviderKeyedFactory({}, generic);
  const a = lookup("x");
  const b = lookup("y");
  expect(a, "all unknown keys must resolve to the same fallback instance").toBe(b);
  expect(a).toBe(generic);
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
  expect(objects.length).toBe(2);
  expect(objects[0].message).toBe("started");
  expect(objects[1].status_code).toBe(429);
});

test("collectClaudeCodeJsonLines skips non-object JSON (arrays, scalars)", () => {
  const stderr = ['[1,2,3]', '{"a":1}', '"bare string"', '42'].join("\n");
  const objects = collectClaudeCodeJsonLines(stderr);
  // Only the `{`-prefixed object line is collected; the array starts with `[`
  // (filtered before parse) and the scalars never start with `{`.
  expect(objects).toEqual([{ a: 1 }]);
});

test("collectClaudeCodeJsonLines returns an empty array for empty / noise-only input", () => {
  expect(collectClaudeCodeJsonLines("")).toEqual([]);
  expect(collectClaudeCodeJsonLines("no json here\nstill none")).toEqual([]);
});
