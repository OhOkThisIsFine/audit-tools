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
} = await import("../../src/shared/providers/providerConfirmation.ts");
const {
  buildSharedProviderConfirmation,
  writeSharedProviderConfirmation,
  readConfirmedCostPositions,
} = await import("../../src/shared/providers/sharedProviderConfirmation.ts");

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
    expect(representativeModelId("local-subprocess", {})).toBeUndefined();
  });
});

describe("annotateConfirmedPoolCost", () => {
  const basePool = [
    { name: "claude-code", capability_tier: "frontier", excluded: false },
    { name: "openai-compatible", capability_tier: "capable", excluded: false },
    { name: "local-subprocess", capability_tier: "unknown", excluded: false },
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
