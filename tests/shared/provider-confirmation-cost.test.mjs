// Gate-0 cost-first annotation + the confirmation→dispatch cost link
// (spec/cost-first-routing.md). Locks that: (1) a configured API/CLI model is
// priced + given a suggested cost_order at confirmation; (2) an unpriceable entry
// degrades safely (null price, no model_id, still ordered); (3) the persisted
// confirmation round-trips into a model-keyed position map the dispatch build
// sites read as rung 1 of costRank.

import { test, describe, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  representativeModelId,
  annotateConfirmedPoolCost,
  annotateConfirmedPool,
} = await import("../../src/shared/providers/providerConfirmation.ts");
const {
  buildSharedProviderConfirmation,
  writeSharedProviderConfirmation,
  readConfirmedCostPositions,
  readConfirmedDispatchBias,
  clampDispatchBias,
  parseProviderConfirmationInput,
  readProviderConfirmationInput,
  PROVIDER_CONFIRMATION_INPUT_FILENAME,
} = await import("../../src/shared/providers/sharedProviderConfirmation.ts");
const { PROVIDER_CONFIRMATION_INPUT_VERSION } = await import(
  "../../src/shared/types/providerConfirmation.ts"
);
const { mkdir, writeFile } = await import("node:fs/promises");

const NIM_CONFIG = {
  openai_compatible: { base_url: "http://nim.local/v1", model: "claude-haiku-4-5" },
};

describe("representativeModelId", () => {
  test("resolves the configured model for openai-compatible and codex", () => {
    expect(representativeModelId("openai-compatible", NIM_CONFIG)).toBe("claude-haiku-4-5");
    expect(representativeModelId("codex", { codex: { model: "gpt-4o" } })).toBe("gpt-4o");
  });
  test("returns undefined for providers with no configured model", () => {
    expect(representativeModelId("claude-code", NIM_CONFIG)).toBeUndefined();
    expect(representativeModelId("openai-compatible", {})).toBeUndefined();
    expect(representativeModelId("worker-command", {})).toBeUndefined();
  });
});

describe("annotateConfirmedPoolCost", () => {
  const basePool = [
    { name: "claude-code", capability_tier: "frontier", excluded: false },
    { name: "openai-compatible", capability_tier: "capable", excluded: false },
    { name: "worker-command", capability_tier: "unknown", excluded: false },
  ];

  test("prices the configured model and orders it ahead of unpriceable entries", () => {
    const annotated = annotateConfirmedPoolCost(basePool, NIM_CONFIG);
    const nim = annotated.find((e) => e.name === "openai-compatible");
    expect(nim.model_id).toBe("claude-haiku-4-5");
    expect(nim.blended_price_usd_per_mtok).toBeCloseTo(2.0); // 1*.75 + 5*.25
    // Priced entry sorts first (cost_order 0); unpriceable entries follow.
    expect(nim.cost_order).toBe(0);
    for (const e of annotated) {
      if (e.name !== "openai-compatible") {
        expect(e.model_id).toBeUndefined();
        expect(e.blended_price_usd_per_mtok).toBeNull();
        expect(e.cost_order).toBeGreaterThan(0);
      }
    }
  });

  test("a model unknown to the dataset gets a null price but is still ordered", () => {
    const annotated = annotateConfirmedPoolCost(
      [{ name: "openai-compatible", capability_tier: "capable", excluded: false }],
      { openai_compatible: { base_url: "http://x/v1", model: "no-such-model-000" } },
    );
    const nim = annotated[0];
    expect(nim.model_id).toBe("no-such-model-000");
    expect(nim.blended_price_usd_per_mtok).toBeNull();
    expect(nim.cost_order).toBe(0);
  });

  test("cost_order is a total ordering over the pool (dense 0..n-1)", () => {
    const annotated = annotateConfirmedPoolCost(basePool, NIM_CONFIG);
    expect([...annotated.map((e) => e.cost_order)].sort((a, b) => a - b)).toEqual([0, 1, 2]);
  });
});

describe("readConfirmedCostPositions — confirmation→dispatch link", () => {
  test("round-trips a written confirmation into a model-keyed position map", async () => {
    const root = await mkdtemp(join(tmpdir(), "audit-cost-conf-"));
    try {
      // Build + persist a confirmation with the SAME session config we read with,
      // so the roster matches and the read resolves to `confirmed` (not reconfirm).
      const confirmation = buildSharedProviderConfirmation(NIM_CONFIG);
      await writeSharedProviderConfirmation(root, confirmation);

      const positions = await readConfirmedCostPositions(root, NIM_CONFIG);
      // openai-compatible's configured model carries a confirmed cost_order.
      expect(positions.get("claude-haiku-4-5")).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a folded source pool threads its confirmed position by model_id", async () => {
    const root = await mkdtemp(join(tmpdir(), "audit-cost-conf-"));
    try {
      const sources = [
        { id: "rp/nvidia", provider: "openai-compatible", model: "nvidia/llama-x", cost_per_mtok: 4, capability_rank: 7 },
      ];
      const confirmation = buildSharedProviderConfirmation(
        NIM_CONFIG,
        process.env,
        [],
        [],
        undefined,
        undefined,
        sources,
      );
      expect(confirmation.source_pool_cost_order?.[0]?.model_id).toBe("nvidia/llama-x");
      await writeSharedProviderConfirmation(root, confirmation);
      const positions = await readConfirmedCostPositions(root, NIM_CONFIG);
      // The source's model id resolves to its confirmed cost position — the SAME key a
      // repair-proxy dispatch pool (pool.model = "nvidia/llama-x") looks up at dispatch.
      expect(positions.has("nvidia/llama-x")).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("degrades to an empty map when root is absent", async () => {
    const positions = await readConfirmedCostPositions(undefined, NIM_CONFIG);
    expect(positions.size).toBe(0);
  });

  test("degrades to an empty map when no confirmation file exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "audit-cost-conf-"));
    try {
      const positions = await readConfirmedCostPositions(root, NIM_CONFIG);
      expect(positions.size).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// -----------------------------------------------------------------------------
// Interactive Gate-0: operator input (reorder + host roster) — follow-ups a/b/c
// -----------------------------------------------------------------------------

describe("annotateConfirmedPool — operator ordering override (b)", () => {
  const basePool = [
    { name: "claude-code", capability_tier: "frontier", excluded: false },
    { name: "openai-compatible", capability_tier: "capable", excluded: false },
    { name: "worker-command", capability_tier: "unknown", excluded: false },
  ];

  test("no input → price-ascending suggestion (openai-compatible first)", () => {
    const { provider_pool, host_model_cost_order } = annotateConfirmedPool(
      basePool,
      NIM_CONFIG,
    );
    expect(host_model_cost_order).toEqual([]);
    expect(provider_pool.find((e) => e.name === "openai-compatible").cost_order).toBe(0);
  });

  test("operator cost_order wins for named keys; omitted keep suggested order", () => {
    const input = {
      schema_version: PROVIDER_CONFIRMATION_INPUT_VERSION,
      // Operator demotes the priced pool below worker-command.
      cost_order: ["worker-command", "claude-code"],
    };
    const { provider_pool } = annotateConfirmedPool(basePool, NIM_CONFIG, input);
    const order = Object.fromEntries(provider_pool.map((e) => [e.name, e.cost_order]));
    expect(order["worker-command"]).toBe(0);
    expect(order["claude-code"]).toBe(1);
    // openai-compatible was not named → appended after, still dense.
    expect(order["openai-compatible"]).toBe(2);
  });

  test("unknown keys in operator cost_order are ignored (degrade-safe)", () => {
    const input = {
      schema_version: PROVIDER_CONFIRMATION_INPUT_VERSION,
      cost_order: ["does-not-exist", "openai-compatible"],
    };
    const { provider_pool } = annotateConfirmedPool(basePool, NIM_CONFIG, input);
    expect(provider_pool.find((e) => e.name === "openai-compatible").cost_order).toBe(0);
  });
});

describe("annotateConfirmedPool — host roster pricing (c)", () => {
  const basePool = [
    { name: "claude-code", capability_tier: "frontier", excluded: false },
    { name: "worker-command", capability_tier: "unknown", excluded: false },
  ];

  test("host models become priced, ordered entries in host_model_cost_order", () => {
    const input = {
      schema_version: PROVIDER_CONFIRMATION_INPUT_VERSION,
      host_models: [{ model_id: "claude-haiku-4-5" }],
    };
    const { host_model_cost_order } = annotateConfirmedPool(basePool, NIM_CONFIG, input);
    expect(host_model_cost_order).toHaveLength(1);
    const haiku = host_model_cost_order[0];
    expect(haiku.model_id).toBe("claude-haiku-4-5");
    expect(haiku.blended_price_usd_per_mtok).toBeCloseTo(2.0);
    // Priced host model sorts ahead of the unpriceable providers.
    expect(haiku.cost_order).toBe(0);
  });

  test("unpriceable host model gets null price but is still ordered", () => {
    const input = {
      schema_version: PROVIDER_CONFIRMATION_INPUT_VERSION,
      host_models: [{ model_id: "no-such-model-000" }],
    };
    const { host_model_cost_order } = annotateConfirmedPool(basePool, NIM_CONFIG, input);
    expect(host_model_cost_order[0].blended_price_usd_per_mtok).toBeNull();
    expect(typeof host_model_cost_order[0].cost_order).toBe("number");
  });
});

describe("annotateConfirmedPool — source pool fold (Gate-0 source ordering)", () => {
  const basePool = [
    { name: "claude-code", capability_tier: "frontier", excluded: false },
    { name: "worker-command", capability_tier: "unknown", excluded: false },
  ];

  test("declared-free source sorts first and threads its position by model_id", () => {
    const sources = [
      // A declared-free arbitrage pool (cost 0 → routes first) and a declared-priced one.
      { id: "opencode-free", provider: "opencode", model: "free/model-x", cost_per_mtok: 0 },
      { id: "rp/paid", provider: "openai-compatible", model: "nvidia/paid-y", cost_per_mtok: 5 },
    ];
    const { source_pool_cost_order } = annotateConfirmedPool(basePool, {}, undefined, sources);
    const byId = Object.fromEntries(source_pool_cost_order.map((e) => [e.source_id, e]));
    expect(byId["opencode-free"].cost_order).toBeLessThan(byId["rp/paid"].cost_order);
    expect(byId["opencode-free"].price_declared).toBe(true);
    expect(byId["opencode-free"].blended_price_usd_per_mtok).toBe(0);
    expect(byId["opencode-free"].model_id).toBe("free/model-x");
  });

  test("capability_rank breaks a cost-equal tie among source pools (lower = first)", () => {
    const sources = [
      { id: "rp/weak", provider: "openai-compatible", model: "prov/weak", cost_per_mtok: 3, capability_rank: 40 },
      { id: "rp/strong", provider: "openai-compatible", model: "prov/strong", cost_per_mtok: 3, capability_rank: 2 },
    ];
    const { source_pool_cost_order } = annotateConfirmedPool(basePool, {}, undefined, sources);
    const byId = Object.fromEntries(source_pool_cost_order.map((e) => [e.source_id, e.cost_order]));
    expect(byId["rp/strong"]).toBeLessThan(byId["rp/weak"]);
  });

  test("no sources → empty source_pool_cost_order (headless / no-source path unchanged)", () => {
    const { source_pool_cost_order } = annotateConfirmedPool(basePool, NIM_CONFIG);
    expect(source_pool_cost_order).toEqual([]);
  });
});

describe("parseProviderConfirmationInput — degrade-safe", () => {
  test("wrong/absent schema_version → null", () => {
    expect(parseProviderConfirmationInput(null)).toBeNull();
    expect(parseProviderConfirmationInput({})).toBeNull();
    expect(parseProviderConfirmationInput({ schema_version: "bogus" })).toBeNull();
  });

  test("minimal valid input (accept suggestion) → empty-but-versioned", () => {
    const parsed = parseProviderConfirmationInput({
      schema_version: PROVIDER_CONFIRMATION_INPUT_VERSION,
    });
    expect(parsed).toEqual({ schema_version: PROVIDER_CONFIRMATION_INPUT_VERSION });
  });

  test("malformed fields are dropped, not fatal", () => {
    const parsed = parseProviderConfirmationInput({
      schema_version: PROVIDER_CONFIRMATION_INPUT_VERSION,
      cost_order: "not-an-array",
      host_models: [{ nope: 1 }, { model_id: "claude-haiku-4-5" }],
    });
    expect(parsed.cost_order).toBeUndefined();
    expect(parsed.host_models).toEqual([{ model_id: "claude-haiku-4-5" }]);
  });
});

// -----------------------------------------------------------------------------
// Cost↔speed dispatch dial — Gate-0 bias capture + read-back
// (spec/dispatch-cost-speed-dial.md)
// -----------------------------------------------------------------------------

describe("clampDispatchBias", () => {
  test("clamps into [0,1]; non-finite/absent → undefined", () => {
    expect(clampDispatchBias(0)).toBe(0);
    expect(clampDispatchBias(1)).toBe(1);
    expect(clampDispatchBias(0.4)).toBe(0.4);
    expect(clampDispatchBias(5)).toBe(1);
    expect(clampDispatchBias(-3)).toBe(0);
    expect(clampDispatchBias(undefined)).toBeUndefined();
    expect(clampDispatchBias("0.5")).toBeUndefined();
    expect(clampDispatchBias(NaN)).toBeUndefined();
  });
});

describe("parseProviderConfirmationInput — dispatch_bias", () => {
  test("valid bias is clamped and retained", () => {
    const parsed = parseProviderConfirmationInput({
      schema_version: PROVIDER_CONFIRMATION_INPUT_VERSION,
      dispatch_bias: 1.5,
    });
    expect(parsed.dispatch_bias).toBe(1); // clamped
  });
  test("absent/malformed bias is dropped (cost-first default)", () => {
    const noField = parseProviderConfirmationInput({
      schema_version: PROVIDER_CONFIRMATION_INPUT_VERSION,
    });
    expect(noField.dispatch_bias).toBeUndefined();
    const bad = parseProviderConfirmationInput({
      schema_version: PROVIDER_CONFIRMATION_INPUT_VERSION,
      dispatch_bias: "fast",
    });
    expect(bad.dispatch_bias).toBeUndefined();
  });
});

describe("readConfirmedDispatchBias — Gate-0 → dispatch link", () => {
  test("round-trips a confirmed bias through the shared artifact", async () => {
    const root = await mkdtemp(join(tmpdir(), "audit-bias-conf-"));
    try {
      const input = {
        schema_version: PROVIDER_CONFIRMATION_INPUT_VERSION,
        dispatch_bias: 0.75,
      };
      const confirmation = buildSharedProviderConfirmation(NIM_CONFIG, process.env, [], [], undefined, input);
      expect(confirmation.dispatch_bias).toBe(0.75);
      await writeSharedProviderConfirmation(root, confirmation);
      expect(await readConfirmedDispatchBias(root, NIM_CONFIG)).toBe(0.75);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("out-of-range operator bias is clamped on the way in", async () => {
    const root = await mkdtemp(join(tmpdir(), "audit-bias-conf-"));
    try {
      const input = { schema_version: PROVIDER_CONFIRMATION_INPUT_VERSION, dispatch_bias: 9 };
      const confirmation = buildSharedProviderConfirmation(NIM_CONFIG, process.env, [], [], undefined, input);
      await writeSharedProviderConfirmation(root, confirmation);
      expect(await readConfirmedDispatchBias(root, NIM_CONFIG)).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("defaults to 0 (cost-first) when absent, no root, or no bias set", async () => {
    expect(await readConfirmedDispatchBias(undefined, NIM_CONFIG)).toBe(0);
    const root = await mkdtemp(join(tmpdir(), "audit-bias-conf-"));
    try {
      // No confirmation file at all → 0.
      expect(await readConfirmedDispatchBias(root, NIM_CONFIG)).toBe(0);
      // A confirmation with NO dispatch_bias field → 0 (backward compatible).
      const confirmation = buildSharedProviderConfirmation(NIM_CONFIG);
      expect(confirmation.dispatch_bias).toBeUndefined();
      await writeSharedProviderConfirmation(root, confirmation);
      expect(await readConfirmedDispatchBias(root, NIM_CONFIG)).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("readProviderConfirmationInput + dispatch merge (c)", () => {
  test("reads the operator input file from the artifacts dir", async () => {
    const dir = await mkdtemp(join(tmpdir(), "audit-conf-input-"));
    try {
      await writeFile(
        join(dir, PROVIDER_CONFIRMATION_INPUT_FILENAME),
        JSON.stringify({
          schema_version: PROVIDER_CONFIRMATION_INPUT_VERSION,
          host_models: [{ model_id: "claude-haiku-4-5" }],
        }),
      );
      const input = await readProviderConfirmationInput(dir);
      expect(input.host_models).toEqual([{ model_id: "claude-haiku-4-5" }]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("absent input file → null", async () => {
    const dir = await mkdtemp(join(tmpdir(), "audit-conf-input-"));
    try {
      expect(await readProviderConfirmationInput(dir)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("host roster position round-trips into the dispatch positions map", async () => {
    const root = await mkdtemp(join(tmpdir(), "audit-cost-conf-"));
    try {
      const input = {
        schema_version: PROVIDER_CONFIRMATION_INPUT_VERSION,
        host_models: [{ model_id: "claude-haiku-4-5" }],
      };
      const confirmation = buildSharedProviderConfirmation(
        {},
        process.env,
        [],
        [],
        undefined,
        input,
      );
      await writeSharedProviderConfirmation(root, confirmation);
      const positions = await readConfirmedCostPositions(root, {});
      // The host-native tier now threads to dispatch by its model_id.
      expect(positions.get("claude-haiku-4-5")).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
