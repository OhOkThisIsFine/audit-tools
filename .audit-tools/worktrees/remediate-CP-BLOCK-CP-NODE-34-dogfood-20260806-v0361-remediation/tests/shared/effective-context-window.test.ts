/**
 * Regression: an unknown source window must stay unknown and fail closed.
 *
 * The 2026-07-17 host-only-collapse root cause: `buildSourcePool` stamped
 * `contextCapTokens: null` whenever a source carried no `quota.context_tokens`
 * (a proxy pool whose registry entry exposed no context field). A null cap means
 * "unknown ⇒ always fits", which silently no-op'd every context-fit gate, so
 * oversized packets were dispatched and 413'd instead of being skipped. The fix
 * resolves an effective window from declared or models.dev data. When neither is
 * available, null is preserved and the fit gates must treat it as unadmittable.
 *
 * RED before the fix (contextCapTokens === null for the no-quota source); GREEN after.
 */

import { test, expect } from "vitest";
import { buildSourcePool, resolveSourceContextWindowTokens } from "../../src/shared/quota/apiPool.js";
import type { QuotaSource } from "../../src/shared/quota/quotaSource.js";
import type { DispatchableSource } from "../../src/shared/types/sessionConfig.js";

const STUB_QUOTA: QuotaSource = { name: "stub", async queryCurrentUsage() { return null; } };

test("buildSourcePool: an undiscoverable source window remains explicitly unknown", async () => {
  // A claude-worker proxy source whose registry entry exposed no context field —
  // exactly the run that collapsed to host-only.
  const source: DispatchableSource = {
    transport: "claude-worker",
    service: "groq",
    model: "some-unlisted-model-xyz",
    endpoint: "http://127.0.0.1:8791",
  };
  const pool = await buildSourcePool({ source, quotaSource: STUB_QUOTA, quotaEntries: {}, capabilityRanks: null });
  expect(pool.contextCapTokens).toBeNull();
});

test("resolveSourceContextWindowTokens: declared quota.context_tokens wins the fallback chain", () => {
  const window = resolveSourceContextWindowTokens({
    transport: "openai-compatible",
    model: "m1",
    quota: { context_tokens: 128_000 },
  });
  expect(window).toBe(128_000);
});

test("resolveSourceContextWindowTokens: a non-positive declaration remains unknown", () => {
  const window = resolveSourceContextWindowTokens({
    transport: "openai-compatible",
    model: "unlisted-model-xyz",
    quota: { context_tokens: 0 },
  });
  expect(window).toBeNull();
});

test("resolveSourceContextWindowTokens: an unknown model with no declaration remains unknown", () => {
  const window = resolveSourceContextWindowTokens({
    transport: "claude-worker",
    service: "groq",
    model: "definitely-not-a-real-model-id-000",
  });
  expect(window).toBeNull();
});

test("resolveSourceContextWindowTokens: a known models.dev model resolves to its real window", () => {
  // gpt-4o carries a 128k window in the vendored snapshot; no declared quota, so this
  // exercises models.dev rather than a declared window.
  const window = resolveSourceContextWindowTokens({
    transport: "openai-compatible",
    model: "gpt-4o",
  });
  expect(window).toBe(128_000);
});
