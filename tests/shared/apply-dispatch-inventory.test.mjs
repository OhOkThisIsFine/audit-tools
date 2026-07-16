/**
 * 2a-ii: `applyDispatchInventory` — the overlay that switches the dispatch/provider
 * consumers from the repo session-config to the per-auditor handshake inventory
 * (spec/unified-dispatch-worker-model.md). Pins the three semantics the switch depends on:
 *   1. absent inventory → repo config returned UNCHANGED (deprecated fallback = today's behavior),
 *   2. present inventory → authoritative WHOLESALE (no repo dispatch field leaks — the
 *      cross-contamination the rework kills), incl. a partial host-only inventory,
 *   3. intent fields preserved + the flat `rolling_engine` ↔ nested `dispatch.rolling_engine`
 *      reconciliation.
 * Plus a consumer-switch assertion: the effective config is what `collectDispatchableSources`
 * / `resolveFreshSessionProviderName` read.
 */

import { test, describe, expect } from "vitest";

const { applyDispatchInventory, DISPATCH_INVENTORY_FIELDS } = await import(
  "../../src/shared/types/sessionConfig.ts"
);
const { collectDispatchableSources } = await import("../../src/shared/quota/apiPool.ts");
const { resolveFreshSessionProviderName } = await import(
  "../../src/shared/providers/providerFactory.ts"
);

describe("applyDispatchInventory", () => {
  test("absent inventory returns the repo config unchanged (deprecated fallback)", () => {
    const repo = {
      provider: "codex",
      sources: [{ provider: "openai-compatible", endpoint: "https://e/v1", model: "m" }],
      synthesis: { narrative: true },
      dispatch: { max_packets: 7, rolling_engine: true },
    };
    // Both null and undefined → the SAME object reference back (no copy, no change).
    expect(applyDispatchInventory(repo, null)).toBe(repo);
    expect(applyDispatchInventory(repo, undefined)).toBe(repo);
  });

  test("present inventory is authoritative WHOLESALE — repo dispatch fields do not leak", () => {
    const repo = {
      provider: "codex",
      codex: { command: "codex", model: "gpt-x" },
      opencode: { command: "opencode" },
      sources: [{ provider: "openai-compatible", endpoint: "https://repo/v1", model: "repo" }],
      // intent — must survive untouched:
      synthesis: { narrative: false },
      analyzers: { gitleaks: "ephemeral" },
      block_quota: { host_model: "claude" },
      dispatch: { max_packets: 3, confirm_threshold: 5, rolling_engine: true },
    };
    const inventory = {
      provider: "claude-code",
      openai_compatible: { base_url: "https://nim/v1", model: "nim", api_key_env: "K" },
      // note: reports NO codex/opencode/sources → they must be DROPPED, not inherited.
    };
    const eff = applyDispatchInventory(repo, inventory);

    // Inventory's dispatch fields win.
    expect(eff.provider).toBe("claude-code");
    expect(eff.openai_compatible).toEqual(inventory.openai_compatible);
    // Repo dispatch fields the inventory did NOT report are gone (no cross-contamination).
    expect(eff.codex).toBeUndefined();
    expect(eff.opencode).toBeUndefined();
    expect(eff.sources).toBeUndefined();
    // Intent fields preserved identically.
    expect(eff.synthesis).toEqual({ narrative: false });
    expect(eff.analyzers).toEqual({ gitleaks: "ephemeral" });
    expect(eff.block_quota).toEqual({ host_model: "claude" });
    // dispatch.* intent kept; rolling_engine dropped (inventory did not report it).
    expect(eff.dispatch).toEqual({ max_packets: 3, confirm_threshold: 5 });
    // Input never mutated.
    expect(repo.codex).toEqual({ command: "codex", model: "gpt-x" });
    expect(repo.dispatch.rolling_engine).toBe(true);
  });

  test("a partial host-only inventory degrades to host-only (no repo sources/backends)", () => {
    const repo = {
      provider: "openai-compatible",
      openai_compatible: { base_url: "https://repo/v1", model: "repo", api_key_env: "K" },
      sources: [{ provider: "codex", endpoint: "codex" }],
    };
    const eff = applyDispatchInventory(repo, { provider: "claude-code" });
    expect(eff.provider).toBe("claude-code");
    expect(eff.openai_compatible).toBeUndefined();
    expect(eff.sources).toBeUndefined();
    // The consumer sees no dispatchable sources — host-only.
    expect(collectDispatchableSources(eff, "claude-code")).toEqual([]);
  });

  test("rolling_engine reconciles flat inventory ↔ nested dispatch.rolling_engine", () => {
    const repo = { dispatch: { max_packets: 9, rolling_engine: false } };
    const on = applyDispatchInventory(repo, { provider: "codex", rolling_engine: true });
    expect(on.dispatch).toEqual({ max_packets: 9, rolling_engine: true });
    // Inventory present but rolling_engine unreported → dropped, other dispatch.* kept.
    const off = applyDispatchInventory(repo, { provider: "codex" });
    expect(off.dispatch).toEqual({ max_packets: 9 });
    // Inventory present, no repo dispatch intent, no rolling_engine → dispatch omitted.
    const bare = applyDispatchInventory({ provider: "codex" }, { provider: "claude-code" });
    expect(bare.dispatch).toBeUndefined();
  });

  test("the effective config is what the provider resolver reads", () => {
    const repo = { provider: "codex" };
    const eff = applyDispatchInventory(repo, { provider: "opencode", opencode: { command: "opencode" } });
    expect(resolveFreshSessionProviderName(undefined, eff, { env: {} })).toBe("opencode");
    // The raw repo config still resolves to its own provider (overlay is non-mutating).
    expect(resolveFreshSessionProviderName(undefined, repo, { env: {} })).toBe("codex");
  });

  test("DISPATCH_INVENTORY_FIELDS lists the 12 flat fields (rolling_engine handled separately)", () => {
    expect([...DISPATCH_INVENTORY_FIELDS].sort()).toEqual(
      [
        "agy",
        "antigravity",
        "claude_code",
        "codex",
        "host_provider",
        "openai_compatible",
        "opencode",
        "parallel_workers",
        "provider",
        "sources",
        "subprocess_template",
        "vscode_task",
      ].sort(),
    );
    expect(DISPATCH_INVENTORY_FIELDS).not.toContain("rolling_engine");
  });
});
