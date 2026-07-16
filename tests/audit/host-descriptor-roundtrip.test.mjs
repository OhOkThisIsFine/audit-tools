import { describe, test, expect } from "vitest";

// The current driver's `--auditor <json>` handshake must survive being re-emitted
// onto a continue-command and re-parsed by getAuditorDescriptor — otherwise the
// descriptor-riding (the founding-bug robustness fix) silently loses capability on
// every step. This pins the render↔parse round-trip. (G1 collapsed the former
// N `--host-*` flags into the single `--auditor` JSON transport.)
const { renderAuditorDescriptor, nextStepCommand } = await import(
  "../../src/audit/cli/prompts.ts"
);
const { getAuditorDescriptor } = await import("../../src/audit/cli/args.ts");

describe("auditor descriptor round-trip", () => {
  test("a full descriptor renders to --auditor json that getAuditorDescriptor reproduces exactly", () => {
    const descriptor = {
      self: {
        can_dispatch_subagents: true,
        can_restrict_subagent_tools: true,
        can_select_subagent_model: true,
        max_active_subagents: 6,
        context_tokens: 200000,
        output_tokens: 8192,
        roster: [
          { rank: "standard", context_tokens: 200000, output_tokens: 8192 },
          { rank: "deep", context_tokens: 400000, output_tokens: 16384, model_id: "opaque-1" },
        ],
        model_id: "opaque-host-id",
      },
      inventory: null,
    };
    const argv = renderAuditorDescriptor(descriptor);
    expect(argv[0]).toBe("--auditor");

    const parsed = getAuditorDescriptor(argv);
    expect(parsed.self.context_tokens).toBe(200000);
    expect(parsed.self.output_tokens).toBe(8192);
    expect(parsed.self.max_active_subagents).toBe(6);
    expect(parsed.self.model_id).toBe("opaque-host-id");
    expect(parsed.self.roster).toEqual(descriptor.self.roster);
    expect(parsed.self.can_dispatch_subagents).toBe(true);
    expect(parsed.self.can_restrict_subagent_tools).toBe(true);
    expect(parsed.self.can_select_subagent_model).toBe(true);
  });

  test("absent self fields re-parse to undefined; a resume then resolves them to defaults", () => {
    const argv = renderAuditorDescriptor({
      self: { can_dispatch_subagents: true },
      inventory: null,
    });
    const parsed = getAuditorDescriptor(argv);
    expect(parsed.self.context_tokens).toBeUndefined();
    expect(parsed.self.output_tokens).toBeUndefined();
    expect(parsed.self.max_active_subagents).toBeUndefined();
    expect(parsed.self.model_id).toBeUndefined();
    expect(parsed.self.roster).toBeUndefined();
    // The two prompt-wording booleans default false → not carried when false.
    expect(parsed.self.can_restrict_subagent_tools).toBeUndefined();
    expect(parsed.self.can_select_subagent_model).toBeUndefined();
    // The dispatch capability is pinned explicitly.
    expect(parsed.self.can_dispatch_subagents).toBe(true);
  });

  test("can_dispatch_subagents:false round-trips through the JSON boolean", () => {
    const argv = renderAuditorDescriptor({ self: { can_dispatch_subagents: false }, inventory: null });
    expect(getAuditorDescriptor(argv).self.can_dispatch_subagents).toBe(false);
  });

  test("an undefined descriptor renders no flags (bare command)", () => {
    expect(renderAuditorDescriptor(undefined)).toEqual([]);
  });

  test("an empty descriptor (no self field, no inventory) renders no flags", () => {
    expect(renderAuditorDescriptor({ self: {}, inventory: null })).toEqual([]);
  });

  // The per-auditor dispatch inventory rides the same `--auditor` JSON as `self`.
  test("a dispatch inventory round-trips inside the descriptor", () => {
    const inventory = {
      provider: "claude-code",
      openai_compatible: { base_url: "https://nim.example/v1", model: "m", api_key_env: "NIM_KEY" },
      sources: [{ id: "s1", provider: "openai-compatible", endpoint: "https://e/v1", model: "m", api_key: "public", cost_per_mtok: 0 }],
      parallel_workers: 4,
      rolling_engine: true,
    };
    const argv = renderAuditorDescriptor({ self: { can_dispatch_subagents: true }, inventory });
    expect(argv).toContain("--auditor");
    expect(getAuditorDescriptor(argv).inventory).toEqual(inventory);
  });

  // null (absent) and `{}` (authoritatively-empty) are OPPOSITE semantics for
  // `applyDispatchInventory` (null ⇒ repo-config fallback; `{}` ⇒ host-only wholesale-
  // strip), so an empty `{}` MUST round-trip and NOT collapse to null on resume.
  test("absent inventory (null) re-parses to null", () => {
    const argv = renderAuditorDescriptor({ self: { can_dispatch_subagents: true }, inventory: null });
    expect(getAuditorDescriptor(argv).inventory).toBeNull();
    // A bare command with no --auditor also yields null.
    expect(getAuditorDescriptor(["next-step"])).toBeNull();
  });

  test("an empty `{}` inventory round-trips as `{}` (host-only), NOT dropped to null", () => {
    const argv = renderAuditorDescriptor({ self: { can_dispatch_subagents: true }, inventory: {} });
    expect(argv).toContain("--auditor");
    expect(getAuditorDescriptor(argv).inventory).toEqual({});
  });

  test("--auditor throws loudly on malformed JSON / a non-object (no silent downgrade)", () => {
    expect(() => getAuditorDescriptor(["--auditor", "{not json"])).toThrow(/JSON object/);
    expect(() => getAuditorDescriptor(["--auditor", "[1,2]"])).toThrow(/must be a JSON object/);
    expect(() => getAuditorDescriptor(["--auditor", '{"inventory":[1,2]}'])).toThrow(/inventory/);
  });

  test("nextStepCommand appends the --auditor descriptor after the base command", () => {
    const cmd = nextStepCommand("/repo", "/repo/.audit-tools/audit", {
      self: { can_dispatch_subagents: true, context_tokens: 128000 },
      inventory: null,
    });
    expect(cmd).toContain("next-step");
    expect(cmd).toContain("--auditor");
    expect(cmd).toContain("context_tokens");
    expect(cmd).toContain("128000");
    // The base flags precede the descriptor.
    expect(cmd.indexOf("--artifacts-dir")).toBeLessThan(cmd.indexOf("--auditor"));
  });
});
