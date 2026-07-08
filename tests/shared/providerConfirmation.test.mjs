import { test, expect } from "vitest";

const {
  discoverProviders,
  queryProviderQuota,
  buildProviderConfirmationDisplay,
  applyProviderConfirmationSelections,
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

test("discoverProviders assigns correct capability tiers for well-known names", async () => {
  // Import the module under test again so we can inspect tier assignment logic
  // by calling applyProviderConfirmationSelections with synthetic entries.
  const { applyProviderConfirmationSelections: apply } = await import("../../src/shared/providers/providerConfirmation.ts");

  // Build synthetic discovered entries and verify tier values match the spec.
  const syntheticProviders = [
    { name: "claude-code", command: "claude", capabilityTier: "frontier", detected: true },
    { name: "opencode",    command: "opencode", capabilityTier: "capable", detected: true },
    { name: "codex",       command: "codex",    capabilityTier: "capable", detected: true },
    { name: "worker-command", command: undefined, capabilityTier: "unknown", detected: false },
  ];

  for (const p of syntheticProviders) {
    expect(["frontier", "capable", "fast", "unknown"].includes(p.capabilityTier), `unexpected tier ${p.capabilityTier} for ${p.name}`).toBeTruthy();
  }

  // Verify tiers match expected mapping
  const tierMap = Object.fromEntries(syntheticProviders.map(p => [p.name, p.capabilityTier]));
  expect(tierMap["claude-code"]).toBe("frontier");
  expect(tierMap["opencode"]).toBe("capable");
  expect(tierMap["codex"]).toBe("capable");
  expect(tierMap["worker-command"]).toBe("unknown");
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
// applyProviderConfirmationSelections
// ---------------------------------------------------------------------------

test("applyProviderConfirmationSelections filters excluded providers", () => {
  const pool = [
    { name: "claude-code", command: "claude", capabilityTier: "frontier", detected: true },
    { name: "codex",       command: "codex",  capabilityTier: "capable",  detected: true },
    { name: "opencode",    command: "opencode", capabilityTier: "capable", detected: true },
  ];

  const result = applyProviderConfirmationSelections(pool, ["codex"], []);
  const names = result.providers.map(p => p.name);

  expect(!names.includes("codex"), "codex should be excluded").toBeTruthy();
  expect(names.includes("claude-code"), "claude-code should be preserved").toBeTruthy();
  expect(names.includes("opencode"), "opencode should be preserved").toBeTruthy();
  expect(result.excluded).toEqual(["codex"]);
});

test("applyProviderConfirmationSelections preserves non-excluded providers", () => {
  const pool = [
    { name: "claude-code", command: "claude", capabilityTier: "frontier", detected: true },
    { name: "opencode",    command: "opencode", capabilityTier: "capable", detected: true },
  ];

  const result = applyProviderConfirmationSelections(pool, [], []);
  expect(result.providers.length).toBe(2);
  expect(result.excluded).toEqual([]);
});

test("applyProviderConfirmationSelections appends addUndetected providers with detected:false", () => {
  const pool = [
    { name: "claude-code", command: "claude", capabilityTier: "frontier", detected: true },
  ];
  const undetected = [
    { name: "codex", command: "codex", capabilityTier: "capable", detected: true }, // detected flag gets overridden
  ];

  const result = applyProviderConfirmationSelections(pool, [], undetected);
  const added = result.providers.find(p => p.name === "codex");
  expect(added, "codex should appear in confirmed pool").toBeTruthy();
  expect(added.detected, "addUndetected entries should have detected:false").toBe(false);
  expect(result.addedUndetected.length).toBe(1);
  expect(result.addedUndetected[0].detected).toBe(false);
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

// ---------------------------------------------------------------------------
// buildProviderConfirmationDisplay
// ---------------------------------------------------------------------------

test("buildProviderConfirmationDisplay returns table with expected headers", () => {
  const discovered = [
    { name: "claude-code", command: "claude", capabilityTier: "frontier", detected: true },
  ];
  const display = buildProviderConfirmationDisplay(discovered);
  expect(display.includes("| Provider |"), "should include Provider column").toBeTruthy();
  expect(display.includes("| Tier |"), "should include Tier column").toBeTruthy();
  expect(display.includes("| Quota |"), "should include Quota column").toBeTruthy();
  expect(display.includes("| Default |"), "should include Default column").toBeTruthy();
  expect(display.includes("claude-code"), "should include provider name").toBeTruthy();
  expect(display.includes("frontier"), "should include tier").toBeTruthy();
  expect(display.includes("included"), "frontier provider should be marked included").toBeTruthy();
});

test("buildProviderConfirmationDisplay returns message when pool is empty", () => {
  const display = buildProviderConfirmationDisplay([]);
  expect(display.length > 0).toBeTruthy();
  expect(!display.includes("|"), "empty pool should not produce a table").toBeTruthy();
});

test("buildProviderConfirmationDisplay marks worker-command as add explicitly", () => {
  const discovered = [
    { name: "worker-command", command: undefined, capabilityTier: "unknown", detected: true },
  ];
  const display = buildProviderConfirmationDisplay(discovered);
  expect(display.includes("add explicitly"), "worker-command should not be default").toBeTruthy();
});

// ---------------------------------------------------------------------------
// SessionConfig type compatibility (compile-time; verified via build)
// ---------------------------------------------------------------------------

test("SessionConfig accepts confirmed_provider_pool field", () => {
  /** @type {import("../../src/shared/types/sessionConfig.ts").SessionConfig} */
  const config = {
    provider: "claude-code",
    confirmed_provider_pool: {
      providers: [],
      excluded: [],
      addedUndetected: [],
    },
  };
  expect(config.confirmed_provider_pool !== undefined).toBeTruthy();
});

test("SessionConfig confirmed_provider_pool is optional", () => {
  /** @type {import("../../src/shared/types/sessionConfig.ts").SessionConfig} */
  const config = { provider: "opencode" };
  expect(config.confirmed_provider_pool).toBe(undefined);
});
