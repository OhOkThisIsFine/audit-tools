/**
 * CP-NODE-5: every CapacityPool carries the model its quota key was derived from,
 * fixed at the single pool-construction seam (`buildHostModelPool` / `buildSourcePool`)
 * so all dispatch drivers are correct-by-construction. The roster case is the leak:
 * `buildHostModelPools` builds one pool per rank with a distinct per-rank model in the
 * key, but used to stamp the SAME scalar `hostModel` onto every pool — so a multi-rank
 * roster left every non-primary pool with `pool.hostModel !== parseProviderModelKey(pool.id).model`.
 */

import { test, expect } from "vitest";

const { buildHostModelPools, buildSourcePool } = await import(
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
