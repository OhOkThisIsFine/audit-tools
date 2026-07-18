/**
 * Regression: a dispatchable source pool's context window is NEVER null.
 *
 * The 2026-07-17 host-only-collapse root cause: `buildSourcePool` stamped
 * `contextCapTokens: null` whenever a source carried no `quota.context_tokens`
 * (a proxy pool whose registry entry exposed no context field). A null cap means
 * "unknown ⇒ always fits", which silently no-op'd every context-fit gate, so
 * oversized packets were dispatched and 413'd instead of being skipped. The fix
 * resolves an effective window from a fallback chain (declared → models.dev backend
 * window → DEFAULT_CONTEXT_TOKENS) so `null` is unreachable.
 *
 * RED before the fix (contextCapTokens === null for the no-quota source); GREEN after.
 */

import { test, expect } from "vitest";

const { buildSourcePool, resolveSourceContextWindowTokens } = await import(
  "../../src/shared/quota/apiPool.ts"
);
const { DEFAULT_CONTEXT_TOKENS } = await import("../../src/shared/tokens.ts");

const STUB_QUOTA = { name: "stub", async queryCurrentUsage() { return null; } };

test("buildSourcePool: a source with NO declared context_tokens still carries a non-null window (the no-op-fit-gate fix)", async () => {
  // A claude-worker proxy source whose registry entry exposed no context field —
  // exactly the run that collapsed to host-only.
  const source = {
    provider: "claude-worker",
    backend_provider: "groq",
    model: "some-unlisted-model-xyz",
    endpoint: "http://127.0.0.1:8791",
  };
  const pool = await buildSourcePool({ source, quotaSource: STUB_QUOTA, quotaEntries: {} });
  expect(pool.contextCapTokens).not.toBeNull();
  expect(typeof pool.contextCapTokens).toBe("number");
  expect(pool.contextCapTokens).toBeGreaterThan(0);
  // Unknown to models.dev ⇒ the conservative default floor, never null.
  expect(pool.contextCapTokens).toBe(DEFAULT_CONTEXT_TOKENS);
});

test("resolveSourceContextWindowTokens: declared quota.context_tokens wins the fallback chain", () => {
  const window = resolveSourceContextWindowTokens({
    provider: "openai-compatible",
    model: "m1",
    quota: { context_tokens: 128_000 },
  });
  expect(window).toBe(128_000);
});

test("resolveSourceContextWindowTokens: a non-positive declared value degrades to the default, not null", () => {
  const window = resolveSourceContextWindowTokens({
    provider: "openai-compatible",
    model: "unlisted-model-xyz",
    quota: { context_tokens: 0 }, // "0 = unknown" convention must not become an always-fits null
  });
  expect(window).toBe(DEFAULT_CONTEXT_TOKENS);
});

test("resolveSourceContextWindowTokens: an unknown model with no declaration falls to DEFAULT_CONTEXT_TOKENS", () => {
  const window = resolveSourceContextWindowTokens({
    provider: "claude-worker",
    backend_provider: "groq",
    model: "definitely-not-a-real-model-id-000",
  });
  expect(window).toBe(DEFAULT_CONTEXT_TOKENS);
});

test("resolveSourceContextWindowTokens: middle rung — a known models.dev model resolves to its REAL window, not the default", () => {
  // gpt-4o carries a 128k window in the vendored snapshot; no declared quota, so this
  // exercises fallback step 2 (models.dev) rather than the blind default. Locks the
  // middle rung so a regression that skipped straight to DEFAULT_CONTEXT_TOKENS is caught.
  const window = resolveSourceContextWindowTokens({
    provider: "openai-compatible",
    model: "gpt-4o",
  });
  expect(window).toBeGreaterThan(DEFAULT_CONTEXT_TOKENS);
  expect(window).toBe(128_000);
});
