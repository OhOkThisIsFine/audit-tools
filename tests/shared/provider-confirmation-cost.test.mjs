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
