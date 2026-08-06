import { describe, it, expect, vi, afterEach } from "vitest";
import { CompositeQuotaSource } from "audit-tools/shared";
import type { QuotaSource, QuotaUsageSnapshot } from "audit-tools/shared";

function mockSource(name: string, result: QuotaUsageSnapshot | null): QuotaSource {
  return {
    name,
    queryCurrentUsage: vi.fn().mockResolvedValue(result),
  };
}

function failingSource(name: string): QuotaSource {
  return {
    name,
    queryCurrentUsage: vi.fn().mockRejectedValue(new Error("fail")),
  };
}

const snapshot: QuotaUsageSnapshot = {
  remaining_pct: 0.5,
  reset_at: null,
  requests_remaining: 10,
  tokens_remaining: null,
  captured_at: new Date().toISOString(),
  source: "test",
};

describe("CompositeQuotaSource", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns first non-null result", async () => {
    const source = new CompositeQuotaSource([
      mockSource("a", null),
      mockSource("b", snapshot),
      mockSource("c", snapshot),
    ]);
    const result = await source.queryCurrentUsage("test/model");
    expect(result).toEqual(snapshot);
  });

  it("returns null when all sources return null", async () => {
    const source = new CompositeQuotaSource([
      mockSource("a", null),
      mockSource("b", null),
    ]);
    const result = await source.queryCurrentUsage("test/model");
    expect(result).toBeNull();
  });

  it("skips failing sources", async () => {
    const source = new CompositeQuotaSource([
      failingSource("broken"),
      mockSource("good", snapshot),
    ]);
    const result = await source.queryCurrentUsage("test/model");
    expect(result).toEqual(snapshot);
  });

  it("returns null when all sources fail", async () => {
    const source = new CompositeQuotaSource([
      failingSource("a"),
      failingSource("b"),
    ]);
    const result = await source.queryCurrentUsage("test/model");
    expect(result).toBeNull();
  });

  it("returns null with empty sources", async () => {
    const source = new CompositeQuotaSource([]);
    const result = await source.queryCurrentUsage("test/model");
    expect(result).toBeNull();
  });
});
