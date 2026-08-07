/**
 * Tests for resolveAccountIdSafe and related QuotaSource helpers.
 *
 * TST-f2f7d4fa-2: Verify that resolveAccountIdSafe correctly handles both success
 * and error cases when a quota source attempts to resolve an account id, never
 * throwing or rejecting but instead returning null on failure.
 */

import { test, expect } from "vitest";
import { resolveAccountIdSafe } from "../../src/shared/quota/quotaSource.js";
import type { QuotaSource } from "../../src/shared/quota/quotaSource.js";

test("resolveAccountIdSafe: returns null when source has no resolveAccountId method", async () => {
  const source: QuotaSource = {
    name: "test",
    queryCurrentUsage: async () => null,
  };

  const result = await resolveAccountIdSafe(source, "test-key");
  expect(result).toBeNull();
});

test("resolveAccountIdSafe: returns account id when resolveAccountId succeeds", async () => {
  const source: QuotaSource = {
    name: "test",
    queryCurrentUsage: async () => null,
    resolveAccountId: async () => "account-123",
  };

  const result = await resolveAccountIdSafe(source, "test-key");
  expect(result).toBe("account-123");
});

test("resolveAccountIdSafe: returns null when resolveAccountId throws synchronously", async () => {
  const source: QuotaSource = {
    name: "test",
    queryCurrentUsage: async () => null,
    resolveAccountId: () => {
      throw new Error("sync error");
    },
  };

  const result = await resolveAccountIdSafe(source, "test-key");
  expect(result).toBeNull();
});

test("resolveAccountIdSafe: returns null when resolveAccountId rejects asynchronously", async () => {
  const source: QuotaSource = {
    name: "test",
    queryCurrentUsage: async () => null,
    resolveAccountId: async () => {
      throw new Error("async error");
    },
  };

  const result = await resolveAccountIdSafe(source, "test-key");
  expect(result).toBeNull();
});

test("resolveAccountIdSafe: passes through the providerModelKey to resolveAccountId", async () => {
  const keys: string[] = [];
  const source: QuotaSource = {
    name: "test",
    queryCurrentUsage: async () => null,
    resolveAccountId: async (key: string) => {
      keys.push(key);
      return "account-456";
    },
  };

  await resolveAccountIdSafe(source, "special-key");
  expect(keys).toContain("special-key");
});

test("resolveAccountIdSafe: returns null for other error types (not just Error)", async () => {
  const source: QuotaSource = {
    name: "test",
    queryCurrentUsage: async () => null,
    resolveAccountId: async () => {
      // Simulate a rejection with a non-Error value
      throw "random-rejection-string";
    },
  };

  const result = await resolveAccountIdSafe(source, "test-key");
  expect(result).toBeNull();
});
