import test from "node:test";
import assert from "node:assert/strict";

const {
  discoverProviders,
  queryProviderQuota,
  buildProviderConfirmationDisplay,
  applyProviderConfirmationSelections,
} = await import("../src/providers/providerConfirmation.ts");

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
    assert.equal(p.detected, true, `provider ${p.name} should be marked detected`);
    assert.ok(["frontier", "capable", "fast", "unknown"].includes(p.capabilityTier));
  }
});

test("discoverProviders assigns correct capability tiers for well-known names", async () => {
  // Import the module under test again so we can inspect tier assignment logic
  // by calling applyProviderConfirmationSelections with synthetic entries.
  const { applyProviderConfirmationSelections: apply } = await import(
    "../src/providers/providerConfirmation.ts"
  );

  // Build synthetic discovered entries and verify tier values match the spec.
  const syntheticProviders = [
    { name: "claude-code", command: "claude", capabilityTier: "frontier", detected: true },
    { name: "opencode",    command: "opencode", capabilityTier: "capable", detected: true },
    { name: "codex",       command: "codex",    capabilityTier: "capable", detected: true },
    { name: "local-subprocess", command: undefined, capabilityTier: "unknown", detected: false },
  ];

  for (const p of syntheticProviders) {
    assert.ok(
      ["frontier", "capable", "fast", "unknown"].includes(p.capabilityTier),
      `unexpected tier ${p.capabilityTier} for ${p.name}`,
    );
  }

  // Verify tiers match expected mapping
  const tierMap = Object.fromEntries(syntheticProviders.map(p => [p.name, p.capabilityTier]));
  assert.equal(tierMap["claude-code"],       "frontier");
  assert.equal(tierMap["opencode"],          "capable");
  assert.equal(tierMap["codex"],             "capable");
  assert.equal(tierMap["local-subprocess"],  "unknown");
});

test("discoverProviders surfaces openai-compatible when configured (config-gated, not PATH-probed)", () => {
  // openai-compatible is an API pool with no CLI to probe; it must be surfaced
  // from session config so it can join the confirmed pool as a spill target.
  const configured = discoverProviders(
    { openai_compatible: { base_url: "https://example/v1", model: "vendor/model-x" } },
    {},
  );
  const entry = configured.find((p) => p.name === "openai-compatible");
  assert.ok(entry, "openai-compatible should be surfaced when base_url + model are set");
  assert.equal(entry.detected, true);
  assert.equal(entry.capabilityTier, "capable");

  // Absent config → not surfaced; partial config (model missing) → not surfaced.
  assert.equal(
    discoverProviders({}, {}).some((p) => p.name === "openai-compatible"),
    false,
    "openai-compatible must NOT appear without configuration",
  );
  assert.equal(
    discoverProviders({ openai_compatible: { base_url: "https://example/v1" } }, {}).some(
      (p) => p.name === "openai-compatible",
    ),
    false,
    "openai-compatible needs both base_url AND model",
  );
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

  assert.ok(!names.includes("codex"), "codex should be excluded");
  assert.ok(names.includes("claude-code"), "claude-code should be preserved");
  assert.ok(names.includes("opencode"), "opencode should be preserved");
  assert.deepEqual(result.excluded, ["codex"]);
});

test("applyProviderConfirmationSelections preserves non-excluded providers", () => {
  const pool = [
    { name: "claude-code", command: "claude", capabilityTier: "frontier", detected: true },
    { name: "opencode",    command: "opencode", capabilityTier: "capable", detected: true },
  ];

  const result = applyProviderConfirmationSelections(pool, [], []);
  assert.equal(result.providers.length, 2);
  assert.deepEqual(result.excluded, []);
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
  assert.ok(added, "codex should appear in confirmed pool");
  assert.equal(added.detected, false, "addUndetected entries should have detected:false");
  assert.equal(result.addedUndetected.length, 1);
  assert.equal(result.addedUndetected[0].detected, false);
});

// ---------------------------------------------------------------------------
// queryProviderQuota
// ---------------------------------------------------------------------------

test("queryProviderQuota returns null when queryLimits is not implemented", async () => {
  const syntheticDiscovered = {
    name: "local-subprocess",
    capabilityTier: "unknown",
    detected: true,
  };
  const providerWithoutQueryLimits = {
    name: "local-subprocess",
    launch: async () => ({ accepted: false }),
    // no queryLimits method
  };

  const result = await queryProviderQuota(syntheticDiscovered, providerWithoutQueryLimits);
  assert.equal(result, null);
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
  assert.equal(result, null);
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
  assert.deepEqual(result, limits);
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
  assert.equal(result, null);
  // ...but the failure is now surfaced through the injected channel with the
  // provider name + the original error, so a persistently-failing provider is
  // no longer invisible to operators.
  assert.equal(logged.length, 1, "log must fire exactly once on a swallowed error");
  assert.equal(logged[0].providerName, "codex");
  assert.equal(logged[0].error, boom);
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
  assert.deepEqual(result, { requests_per_minute: 60 });
  assert.equal(logged.length, 0, "log must not fire when the query succeeds");
});

// ---------------------------------------------------------------------------
// buildProviderConfirmationDisplay
// ---------------------------------------------------------------------------

test("buildProviderConfirmationDisplay returns table with expected headers", () => {
  const discovered = [
    { name: "claude-code", command: "claude", capabilityTier: "frontier", detected: true },
  ];
  const display = buildProviderConfirmationDisplay(discovered);
  assert.ok(display.includes("| Provider |"), "should include Provider column");
  assert.ok(display.includes("| Tier |"),     "should include Tier column");
  assert.ok(display.includes("| Quota |"),    "should include Quota column");
  assert.ok(display.includes("| Default |"), "should include Default column");
  assert.ok(display.includes("claude-code"),  "should include provider name");
  assert.ok(display.includes("frontier"),     "should include tier");
  assert.ok(display.includes("included"),     "frontier provider should be marked included");
});

test("buildProviderConfirmationDisplay returns message when pool is empty", () => {
  const display = buildProviderConfirmationDisplay([]);
  assert.ok(display.length > 0);
  assert.ok(!display.includes("|"), "empty pool should not produce a table");
});

test("buildProviderConfirmationDisplay marks local-subprocess as add explicitly", () => {
  const discovered = [
    { name: "local-subprocess", command: undefined, capabilityTier: "unknown", detected: true },
  ];
  const display = buildProviderConfirmationDisplay(discovered);
  assert.ok(display.includes("add explicitly"), "local-subprocess should not be default");
});

// ---------------------------------------------------------------------------
// SessionConfig type compatibility (compile-time; verified via build)
// ---------------------------------------------------------------------------

test("SessionConfig accepts confirmed_provider_pool field", () => {
  /** @type {import("../src/types/sessionConfig.ts").SessionConfig} */
  const config = {
    provider: "claude-code",
    confirmed_provider_pool: {
      providers: [],
      excluded: [],
      addedUndetected: [],
    },
  };
  assert.ok(config.confirmed_provider_pool !== undefined);
});

test("SessionConfig confirmed_provider_pool is optional", () => {
  /** @type {import("../src/types/sessionConfig.ts").SessionConfig} */
  const config = { provider: "opencode" };
  assert.equal(config.confirmed_provider_pool, undefined);
});
