import { test, describe, it, expect } from "vitest";

const { buildCacheablePrompt } = await import("../../src/shared/prompts.ts");

describe("buildCacheablePrompt assembles shared prefix before per-agent payload", () => {
  it("result starts with the sharedPrefix string", () => {
    const result = buildCacheablePrompt({
      sharedPrefix: "SHARED CONTEXT",
      perAgentPayload: "agent task",
    });
    expect(result.startsWith("SHARED CONTEXT"), `expected result to start with sharedPrefix, got: ${result}`).toBeTruthy();
  });

  it("result ends with the perAgentPayload string", () => {
    const result = buildCacheablePrompt({
      sharedPrefix: "SHARED CONTEXT",
      perAgentPayload: "agent task",
    });
    expect(result.endsWith("agent task"), `expected result to end with perAgentPayload, got: ${result}`).toBeTruthy();
  });

  it("a double-newline separator appears between prefix and payload", () => {
    const result = buildCacheablePrompt({
      sharedPrefix: "SHARED CONTEXT",
      perAgentPayload: "agent task",
    });
    expect(result).toBe("SHARED CONTEXT\n\nagent task");
  });

  it("empty sharedPrefix returns only perAgentPayload with no leading separator", () => {
    const result = buildCacheablePrompt({
      sharedPrefix: "",
      perAgentPayload: "only payload",
    });
    expect(result).toBe("only payload");
  });
});

describe("buildCacheablePrompt: identical sharedPrefix across multiple calls produces identical prefix bytes", () => {
  it("two calls with same sharedPrefix share an identical prefix substring", () => {
    const sharedPrefix = "Shared design spec and repo context";
    const result1 = buildCacheablePrompt({ sharedPrefix, perAgentPayload: "task for agent A" });
    const result2 = buildCacheablePrompt({ sharedPrefix, perAgentPayload: "task for agent B" });

    // Both results should start with the identical sharedPrefix
    expect(result1.startsWith(sharedPrefix)).toBeTruthy();
    expect(result2.startsWith(sharedPrefix)).toBeTruthy();

    // The shared prefix bytes are identical
    const prefix1 = result1.slice(0, sharedPrefix.length);
    const prefix2 = result2.slice(0, sharedPrefix.length);
    expect(prefix1).toBe(prefix2);
  });

  it("the per-agent payload sections differ between the two results", () => {
    const sharedPrefix = "Shared design spec and repo context";
    const result1 = buildCacheablePrompt({ sharedPrefix, perAgentPayload: "task for agent A" });
    const result2 = buildCacheablePrompt({ sharedPrefix, perAgentPayload: "task for agent B" });

    // Trailing payloads differ
    expect(result1).not.toBe(result2);
    expect(result1.endsWith("task for agent A")).toBeTruthy();
    expect(result2.endsWith("task for agent B")).toBeTruthy();
  });
});
