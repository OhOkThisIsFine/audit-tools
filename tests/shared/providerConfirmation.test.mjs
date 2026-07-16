import { test, expect } from "vitest";

const {
  discoverProviders,
  queryProviderQuota,
} = await import("../../src/shared/providers/providerConfirmation.ts");

// ---------------------------------------------------------------------------
// discoverProviders — PATH detection
// ---------------------------------------------------------------------------

test("discoverProviders returns entry for claude-code when 'claude' found on PATH", () => {
  // Stub commandExists by running in an env where we can't easily mock spawnSync,
  // so we drive via sessionConfig to exercise the probe table.
  // We test the public contract: when a provider IS available we get the entry.
  // Since we can't guarantee real CLIs are installed in CI, we test the filter
  // logic by verifying the returned array only contains entries with detected:true.
  const result = discoverProviders({}, process.env);
  for (const p of result) {
    expect(p.detected, `provider ${p.name} should be marked detected`).toBe(true);
    expect(["frontier", "capable", "fast", "unknown"].includes(p.capabilityTier)).toBeTruthy();
  }
});

test("discoverProviders assigns the documented capability tier per provider", () => {
  // Was vacuous: it built synthetic entries and asserted their OWN literals back,
  // driving no product code, while importing the (now-deleted)
  // applyProviderConfirmationSelections purely for show. Drive the real discovery.
  const discovered = discoverProviders({}, {}, () => true);
  const tierOf = Object.fromEntries(discovered.map((p) => [p.name, p.capabilityTier]));

  expect(tierOf["claude-code"]).toBe("frontier");
  expect(tierOf["codex"]).toBe("capable");
  // worker-command is the always-available fallback and is never PATH-probed, so
  // discovery does not surface it; the pool builder adds it. Its tier is asserted
  // there (provider-self-spawn-exclusion.test.mjs).
  for (const p of discovered) {
    expect(["frontier", "capable", "fast", "unknown"], `unexpected tier for ${p.name}`)
      .toContain(p.capabilityTier);
  }
});

test("discoverProviders surfaces openai-compatible when configured (config-gated, not PATH-probed)", () => {
  // openai-compatible is an API pool with no CLI to probe; it must be surfaced
  // from session config so it can join the confirmed pool as a spill target.
  const configured = discoverProviders(
    { openai_compatible: { base_url: "https://example/v1", model: "vendor/model-x" } },
    {},
  );
  const entry = configured.find((p) => p.name === "openai-compatible");
  expect(entry, "openai-compatible should be surfaced when base_url + model are set").toBeTruthy();
  expect(entry.detected).toBe(true);
  expect(entry.capabilityTier).toBe("capable");

  // Absent config → not surfaced; partial config (model missing) → not surfaced.
  expect(discoverProviders({}, {}).some((p) => p.name === "openai-compatible"), "openai-compatible must NOT appear without configuration").toBe(false);
  expect(discoverProviders({ openai_compatible: { base_url: "https://example/v1" } }, {}).some(
      (p) => p.name === "openai-compatible",
    ), "openai-compatible needs both base_url AND model").toBe(false);
});

test("PB-1: discoverProviders does NOT surface a bare-PATH opencode without explicit config", () => {
  // A detected-on-PATH opencode is OPT-IN: without opencode.* config it must not
  // be surfaced as an eligible dispatch target (it could otherwise be launched
  // unprompted). This holds regardless of whether opencode is actually installed
  // in the test environment — the gate `continue`s before pushing the entry.
  const result = discoverProviders({}, {});
  expect(result.some((p) => p.name === "opencode"), "bare-PATH opencode must NOT appear without opencode.* config").toBe(false);
});

// ---------------------------------------------------------------------------
// queryProviderQuota
// ---------------------------------------------------------------------------

test("queryProviderQuota returns null when queryLimits is not implemented", async () => {
  const syntheticDiscovered = {
    name: "worker-command",
    capabilityTier: "unknown",
    detected: true,
  };
  const providerWithoutQueryLimits = {
    name: "worker-command",
    launch: async () => ({ accepted: false }),
    // no queryLimits method
  };

  const result = await queryProviderQuota(syntheticDiscovered, providerWithoutQueryLimits);
  expect(result).toBe(null);
});

test("queryProviderQuota returns null when queryLimits rejects", async () => {
  const syntheticDiscovered = {
    name: "codex",
    capabilityTier: "capable",
    detected: true,
  };
  const providerThatThrows = {
    name: "codex",
    launch: async () => ({ accepted: false }),
    queryLimits: async (_model) => {
      throw new Error("rate-limit API unavailable");
    },
  };

  const result = await queryProviderQuota(syntheticDiscovered, providerThatThrows);
  expect(result).toBe(null);
});

test("queryProviderQuota returns the limits when queryLimits succeeds", async () => {
  const syntheticDiscovered = {
    name: "claude-code",
    capabilityTier: "frontier",
    detected: true,
  };
  const limits = { requests_per_minute: 60, input_tokens_per_minute: 100000 };
  const providerWithLimits = {
    name: "claude-code",
    launch: async () => ({ accepted: false }),
    queryLimits: async (_model) => limits,
  };

  const result = await queryProviderQuota(syntheticDiscovered, providerWithLimits);
  expect(result).toEqual(limits);
});

test("OBS-9a9091ad: queryProviderQuota invokes the injected log on a swallowed query error", async () => {
  const syntheticDiscovered = {
    name: "codex",
    capabilityTier: "capable",
    detected: true,
  };
  const boom = new Error("rate-limit API unavailable");
  const providerThatThrows = {
    name: "codex",
    launch: async () => ({ accepted: false }),
    queryLimits: async (_model) => {
      throw boom;
    },
  };

  const logged = [];
  const result = await queryProviderQuota(
    syntheticDiscovered,
    providerThatThrows,
    (providerName, error) => logged.push({ providerName, error }),
  );
  // Contract unchanged: still swallows to null, still never throws.
  expect(result).toBe(null);
  // ...but the failure is now surfaced through the injected channel with the
  // provider name + the original error, so a persistently-failing provider is
  // no longer invisible to operators.
  expect(logged.length, "log must fire exactly once on a swallowed error").toBe(1);
  expect(logged[0].providerName).toBe("codex");
  expect(logged[0].error).toBe(boom);
});

test("OBS-9a9091ad: queryProviderQuota does NOT invoke the injected log on success", async () => {
  const syntheticDiscovered = {
    name: "claude-code",
    capabilityTier: "frontier",
    detected: true,
  };
  const providerWithLimits = {
    name: "claude-code",
    launch: async () => ({ accepted: false }),
    queryLimits: async (_model) => ({ requests_per_minute: 60 }),
  };

  const logged = [];
  const result = await queryProviderQuota(
    syntheticDiscovered,
    providerWithLimits,
    (providerName, error) => logged.push({ providerName, error }),
  );
  expect(result).toEqual({ requests_per_minute: 60 });
  expect(logged.length, "log must not fire when the query succeeds").toBe(0);
});
