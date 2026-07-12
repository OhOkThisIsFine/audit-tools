/**
 * CP-NODE-5: every CapacityPool carries the model its quota key was derived from,
 * fixed at the single pool-construction seam (`buildHostModelPool` / `buildSourcePool`)
 * so all dispatch drivers are correct-by-construction. The roster case is the leak:
 * `buildHostModelPools` builds one pool per rank with a distinct per-rank model in the
 * key, but used to stamp the SAME scalar `hostModel` onto every pool — so a multi-rank
 * roster left every non-primary pool with `pool.hostModel !== parseProviderModelKey(pool.id).model`.
 */

import { test, expect } from "vitest";

const { buildHostModelPools, buildSourcePool, buildSourcePools } = await import(
  "../../src/shared/quota/apiPool.ts"
);
const { parseProviderModelKey } = await import("../../src/shared/quota/httpQuotaSource.ts");

const STUB_QUOTA = { name: "stub", async queryCurrentUsage() { return null; } };

/** The invariant under test, stated once. */
function assertModelMatchesKey(pool) {
  expect(pool.hostModel, `pool ${pool.id}: hostModel ${pool.hostModel} must equal the model parsed from its quota key`).toBe(parseProviderModelKey(pool.id).model);
}

test("buildHostModelPools: every per-rank roster pool carries the model its key was derived from", async () => {
  // A 3-rank roster on the same provider — each rank a distinct model. The single
  // scalar hostModel passed in must NOT leak onto the per-rank pools.
  const roster = [
    { rank: "small", model_id: "model-small" },
    { rank: "standard", model_id: "model-standard" },
    { rank: "deep", model_id: "model-deep" },
  ];
  const pools = await buildHostModelPools({
    providerName: "claude-code",
    hostModel: "model-standard", // the scalar that used to be fanned across all ranks
    hostConcurrencyLimit: null,
    quotaSource: STUB_QUOTA,
    quotaEntries: {},
    roster,
    // The caller builds an account-less per-rank key from the rank's model_id.
    resolve: (entry) => ({
      poolKey: `claude-code/${entry.model_id}`,
      discoveredLimits: null,
    }),
  });

  expect(pools.length).toBe(3);
  // Each pool's hostModel must match its OWN key, not the scalar.
  expect(pools.map((p) => p.hostModel)).toEqual(["model-small", "model-standard", "model-deep"]);
  for (const pool of pools) assertModelMatchesKey(pool);
});

test("buildHostModelPools: scalar/absent handshake (no roster) — null model matches the provider/* key", async () => {
  const pools = await buildHostModelPools({
    providerName: "claude-code",
    hostModel: "ignored-scalar",
    hostConcurrencyLimit: null,
    quotaSource: STUB_QUOTA,
    quotaEntries: {},
    roster: null,
    resolve: () => ({ poolKey: "claude-code/*", discoveredLimits: null }),
  });
  expect(pools.length).toBe(1);
  expect(pools[0].hostModel).toBe(null); // provider/* → no model
  assertModelMatchesKey(pools[0]);
});

test("buildSourcePool: a provider-shaped source pool carries the model its key was derived from", async () => {
  const source = { provider: "openai-compatible", endpoint: "http://nim/v1", model: "m1" };
  const pool = await buildSourcePool({ source, quotaSource: STUB_QUOTA, quotaEntries: {} });
  expect(pool.hostModel).toBe("m1");
  assertModelMatchesKey(pool);
});

// ---------------------------------------------------------------------------
// buildSourcePools — account-axis cooldown fold (Bug 3 / Slice A3, backlog
// HIGH 2026-07-11): the construction-time counterpart to the live fold
// `selectProvider` applies in rollingDispatch.ts (`rollingDispatch.test.mjs`).
// Two same-account sources (same NVIDIA_API_KEY, same endpoint) must come out
// of `buildSourcePools` with a SHARED effective cooldown even though only one
// of them ever recorded a 429 under its OWN pool key.
// ---------------------------------------------------------------------------

test("buildSourcePools: a cooldown recorded under one same-account source's key folds onto its sibling's frozen quotaStateEntry", async () => {
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const sessionConfig = {
    sources: [
      {
        id: "nim-nano",
        provider: "openai-compatible",
        endpoint: "https://integrate.api.nvidia.com/v1",
        api_key_env: "NVIDIA_API_KEY",
        model: "nano",
      },
      {
        id: "nim-super",
        provider: "openai-compatible",
        endpoint: "https://integrate.api.nvidia.com/v1",
        api_key_env: "NVIDIA_API_KEY",
        model: "super",
      },
    ],
  };
  // Only nim-nano's OWN pool key ("nim-nano") carries the learned cooldown —
  // exactly what a real recordWaveOutcome(providerModelKey=poolId, ...) writes.
  const quotaEntries = {
    "nim-nano": {
      updated_at: new Date().toISOString(),
      cooldown_until: future,
      last_429_at: new Date().toISOString(),
      consecutive_429_count: 3,
    },
  };
  const pools = await buildSourcePools({
    sessionConfig,
    primaryProviderName: "claude-code",
    quotaSource: STUB_QUOTA,
    quotaEntries,
  });
  const nano = pools.find((p) => p.id === "nim-nano");
  const superPool = pools.find((p) => p.id === "nim-super");
  expect(nano.quotaStateEntry?.cooldown_until).toBe(future);
  expect(
    superPool.quotaStateEntry?.cooldown_until,
    "nim-super shares nim-nano's (endpoint, api_key_env) account — the cooldown recorded under nim-nano's OWN key must fold onto nim-super's effective entry too",
  ).toBe(future);
});

test("buildSourcePools: sources with DIFFERENT api_key_env do not fold cooldowns onto each other", async () => {
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const sessionConfig = {
    sources: [
      {
        id: "source-a",
        provider: "openai-compatible",
        endpoint: "https://integrate.api.nvidia.com/v1",
        api_key_env: "NVIDIA_API_KEY_A",
        model: "m1",
      },
      {
        id: "source-b",
        provider: "openai-compatible",
        endpoint: "https://integrate.api.nvidia.com/v1",
        api_key_env: "NVIDIA_API_KEY_B",
        model: "m2",
      },
    ],
  };
  const quotaEntries = {
    "source-a": {
      updated_at: new Date().toISOString(),
      cooldown_until: future,
      last_429_at: null,
    },
  };
  const pools = await buildSourcePools({
    sessionConfig,
    primaryProviderName: "claude-code",
    quotaSource: STUB_QUOTA,
    quotaEntries,
  });
  const sourceB = pools.find((p) => p.id === "source-b");
  expect(
    sourceB.quotaStateEntry?.cooldown_until ?? null,
    "a different api_key_env is a different account — source-a's cooldown must not fold onto source-b",
  ).toBe(null);
});
