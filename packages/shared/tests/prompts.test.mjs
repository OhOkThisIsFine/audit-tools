import test from "node:test";
import assert from "node:assert/strict";

const { buildCacheablePrompt } = await import("../src/prompts.ts");

test("buildCacheablePrompt assembles shared prefix before per-agent payload", async (t) => {
  await t.test("result starts with the sharedPrefix string", () => {
    const result = buildCacheablePrompt({
      sharedPrefix: "SHARED CONTEXT",
      perAgentPayload: "agent task",
    });
    assert.ok(result.startsWith("SHARED CONTEXT"), `expected result to start with sharedPrefix, got: ${result}`);
  });

  await t.test("result ends with the perAgentPayload string", () => {
    const result = buildCacheablePrompt({
      sharedPrefix: "SHARED CONTEXT",
      perAgentPayload: "agent task",
    });
    assert.ok(result.endsWith("agent task"), `expected result to end with perAgentPayload, got: ${result}`);
  });

  await t.test("a double-newline separator appears between prefix and payload", () => {
    const result = buildCacheablePrompt({
      sharedPrefix: "SHARED CONTEXT",
      perAgentPayload: "agent task",
    });
    assert.strictEqual(result, "SHARED CONTEXT\n\nagent task");
  });

  await t.test("empty sharedPrefix returns only perAgentPayload with no leading separator", () => {
    const result = buildCacheablePrompt({
      sharedPrefix: "",
      perAgentPayload: "only payload",
    });
    assert.strictEqual(result, "only payload");
  });
});

test("buildCacheablePrompt: identical sharedPrefix across multiple calls produces identical prefix bytes", async (t) => {
  await t.test("two calls with same sharedPrefix share an identical prefix substring", () => {
    const sharedPrefix = "Shared design spec and repo context";
    const result1 = buildCacheablePrompt({ sharedPrefix, perAgentPayload: "task for agent A" });
    const result2 = buildCacheablePrompt({ sharedPrefix, perAgentPayload: "task for agent B" });

    // Both results should start with the identical sharedPrefix
    assert.ok(result1.startsWith(sharedPrefix));
    assert.ok(result2.startsWith(sharedPrefix));

    // The shared prefix bytes are identical
    const prefix1 = result1.slice(0, sharedPrefix.length);
    const prefix2 = result2.slice(0, sharedPrefix.length);
    assert.strictEqual(prefix1, prefix2);
  });

  await t.test("the per-agent payload sections differ between the two results", () => {
    const sharedPrefix = "Shared design spec and repo context";
    const result1 = buildCacheablePrompt({ sharedPrefix, perAgentPayload: "task for agent A" });
    const result2 = buildCacheablePrompt({ sharedPrefix, perAgentPayload: "task for agent B" });

    // Trailing payloads differ
    assert.notStrictEqual(result1, result2);
    assert.ok(result1.endsWith("task for agent A"));
    assert.ok(result2.endsWith("task for agent B"));
  });
});
