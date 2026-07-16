/**
 * G2: `resolveSessionConfig(intent, descriptor)` — the seam that replaced
 * `applyDispatchInventory`. The persisted repo INTENT carries NO dispatch inventory; the
 * effective config every dispatch/provider consumer reads comes from resolving the
 * per-auditor descriptor (`self.provider` + host/IDE launch blocks + `sources[]`) over it
 * (spec/unified-dispatch-worker-model.md). Pins:
 *   1. null descriptor → driver-self-only (intent verbatim, NO resolved backends),
 *   2. descriptor `self.provider` → effective provider + host_provider (the same identity),
 *   3. host/IDE launch blocks on `self` carried onto the effective config,
 *   4. `sources[]` → effective dispatch pool; a dispatchable DRIVER's flat block reconstructed,
 *   5. intent fields preserved identically; inputs never mutated.
 * Plus a consumer-switch assertion (`collectDispatchableSources` / `resolveFreshSessionProviderName`).
 */

import { test, describe, expect } from "vitest";

const { resolveSessionConfig } = await import(
  "../../src/shared/config/resolveSessionConfig.ts"
);
const { DISPATCH_INVENTORY_FIELDS } = await import(
  "../../src/shared/types/sessionConfig.ts"
);
const { collectDispatchableSources } = await import("../../src/shared/quota/apiPool.ts");
const { resolveFreshSessionProviderName } = await import(
  "../../src/shared/providers/providerFactory.ts"
);

describe("resolveSessionConfig", () => {
  test("null descriptor → driver-self-only: intent verbatim, no resolved backends", () => {
    const intent = {
      synthesis: { narrative: true },
      analyzers: { gitleaks: "ephemeral" },
      dispatch: { max_packets: 7 },
    };
    const eff = resolveSessionConfig(intent, null);
    expect(eff).toEqual(intent);
    expect(eff.provider).toBeUndefined();
    expect(eff.sources).toBeUndefined();
    // No dispatchable sources resolved — the driver self-drives.
    expect(collectDispatchableSources(eff, "claude-code")).toEqual([]);
  });

  test("self.provider → effective provider + host_provider (same attribution identity)", () => {
    const eff = resolveSessionConfig({}, { self: { provider: "claude-code" } });
    expect(eff.provider).toBe("claude-code");
    expect(eff.host_provider).toBe("claude-code");
  });

  test("host/IDE launch blocks on self are carried onto the effective config", () => {
    const eff = resolveSessionConfig(
      {},
      {
        self: {
          provider: "vscode-task",
          vscode_task: { command_template: ["code", "--task"] },
          claude_code: { command: "claude", dangerously_skip_permissions: true },
        },
      },
    );
    expect(eff.vscode_task).toEqual({ command_template: ["code", "--task"] });
    expect(eff.claude_code).toEqual({ command: "claude", dangerously_skip_permissions: true });
  });

  test("sources[] becomes the effective dispatch pool (host driver, no flat reconstruction)", () => {
    const intent = { synthesis: { narrative: false } };
    const sources = [
      { provider: "openai-compatible", endpoint: "https://nim/v1", model: "nim", api_key_env: "K" },
    ];
    const eff = resolveSessionConfig(intent, { self: { provider: "claude-code" }, sources });
    expect(eff.sources).toEqual(sources);
    // Host driver ⇒ no primary flat block reconstructed; the pool comes from sources[].
    expect(eff.openai_compatible).toBeUndefined();
    expect(collectDispatchableSources(eff, "claude-code")).toHaveLength(1);
    // Intent preserved.
    expect(eff.synthesis).toEqual({ narrative: false });
  });

  test("a dispatchable DRIVER reconstructs its flat block from the matching source", () => {
    const sources = [
      { provider: "openai-compatible", endpoint: "https://nim/v1", model: "nim", api_key_env: "K" },
    ];
    const eff = resolveSessionConfig({}, { self: { provider: "openai-compatible" }, sources });
    // The primary provider's flat block is rebuilt so createFreshSessionProvider can build it.
    expect(eff.openai_compatible).toMatchObject({ base_url: "https://nim/v1", model: "nim", api_key_env: "K" });
    expect(resolveFreshSessionProviderName(undefined, eff, { env: {} })).toBe("openai-compatible");
    // sources[] still carries the pool (no double-count — dedup by source id downstream).
    expect(eff.sources).toEqual(sources);
  });

  test("self.parallel_workers resolves onto the effective config (it has a descriptor home)", () => {
    const eff = resolveSessionConfig({}, { self: { provider: "claude-code", parallel_workers: 3 } });
    expect(eff.parallel_workers).toBe(3);
    // Absent on a null descriptor (driver-self-only, no dispatch fields).
    expect(resolveSessionConfig({}, null).parallel_workers).toBeUndefined();
  });

  test("intent is never mutated and no stored dispatch value can leak", () => {
    const intent = { synthesis: { narrative: true }, dispatch: { confirm_threshold: 5 } };
    const eff = resolveSessionConfig(intent, { self: { provider: "codex" }, sources: [{ provider: "codex", endpoint: "codex" }] });
    // A fresh object, intent untouched.
    expect(eff).not.toBe(intent);
    expect(intent.provider).toBeUndefined();
    expect(intent.sources).toBeUndefined();
    // Intent dispatch.* preserved.
    expect(eff.dispatch).toEqual({ confirm_threshold: 5 });
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
