import { describe, test, expect } from "vitest";

// The current driver's `--host-*` handshake must survive being re-emitted onto a
// continue-command and re-parsed by the same `getHost*` parsers — otherwise the
// descriptor-riding (the founding-bug robustness fix) silently loses capability on
// every step. This pins the render↔parse round-trip.
const { renderHostDescriptorFlags, nextStepCommand } = await import(
  "../../src/audit/cli/prompts.ts"
);
const {
  getHostContextTokens,
  getHostOutputTokens,
  getHostMaxActiveSubagents,
  getHostModelRoster,
  getHostModelId,
  getOptionalBooleanFlag,
} = await import("../../src/audit/cli/args.ts");
const { parseHostBooleanFlag } = await import("../../src/audit/cli/nextStepCommand.ts");

describe("host descriptor round-trip", () => {
  test("a full descriptor renders to flags the getHost* parsers reproduce exactly", () => {
    const descriptor = {
      canDispatchSubagents: true,
      canRestrictSubagentTools: true,
      canSelectSubagentModel: true,
      maxActiveSubagents: 6,
      contextTokens: 200000,
      outputTokens: 8192,
      modelRoster: [
        { rank: "standard", context_tokens: 200000, output_tokens: 8192 },
        { rank: "deep", context_tokens: 400000, output_tokens: 16384, model_id: "opaque-1" },
      ],
      modelId: "opaque-host-id",
    };
    const argv = renderHostDescriptorFlags(descriptor);

    expect(getHostContextTokens(argv)).toBe(200000);
    expect(getHostOutputTokens(argv)).toBe(8192);
    expect(getHostMaxActiveSubagents(argv)).toBe(6);
    expect(getHostModelId(argv)).toBe("opaque-host-id");
    expect(getHostModelRoster(argv)).toEqual(descriptor.modelRoster);
    expect(parseHostBooleanFlag(argv, "--host-can-dispatch-subagents")).toBe(true);
    expect(getOptionalBooleanFlag(argv, "--host-can-restrict-subagent-tools")).toBe(true);
    expect(getOptionalBooleanFlag(argv, "--host-can-select-subagent-model")).toBe(true);
  });

  test("absent fields emit no flags; a resume then resolves them to their defaults", () => {
    const argv = renderHostDescriptorFlags({
      canDispatchSubagents: true,
      // everything else absent
      canRestrictSubagentTools: false,
      canSelectSubagentModel: false,
      maxActiveSubagents: null,
      contextTokens: null,
      outputTokens: null,
      modelRoster: null,
      modelId: null,
    });
    expect(getHostContextTokens(argv)).toBeNull();
    expect(getHostOutputTokens(argv)).toBeNull();
    expect(getHostMaxActiveSubagents(argv)).toBeNull();
    expect(getHostModelId(argv)).toBeNull();
    expect(getHostModelRoster(argv)).toBeNull();
    // The two prompt-wording booleans default false → not re-emitted when false.
    expect(argv).not.toContain("--host-can-restrict-subagent-tools");
    expect(argv).not.toContain("--host-can-select-subagent-model");
    // The dispatch capability is pinned explicitly.
    expect(parseHostBooleanFlag(argv, "--host-can-dispatch-subagents")).toBe(true);
  });

  test("canDispatchSubagents:false round-trips through the negated form", () => {
    const argv = renderHostDescriptorFlags({ canDispatchSubagents: false });
    expect(argv).toContain("--no-host-can-dispatch-subagents");
    expect(parseHostBooleanFlag(argv, "--host-can-dispatch-subagents")).toBe(false);
  });

  test("an undefined descriptor renders no flags (bare command)", () => {
    expect(renderHostDescriptorFlags(undefined)).toEqual([]);
  });

  test("nextStepCommand appends the descriptor flags after the base command", () => {
    const cmd = nextStepCommand("/repo", "/repo/.audit-tools/audit", {
      canDispatchSubagents: true,
      contextTokens: 128000,
    });
    expect(cmd).toContain("next-step");
    expect(cmd).toContain("--host-context-tokens");
    expect(cmd).toContain("128000");
    expect(cmd).toContain("--host-can-dispatch-subagents");
    // The base flags precede the descriptor flags.
    expect(cmd.indexOf("--artifacts-dir")).toBeLessThan(cmd.indexOf("--host-context-tokens"));
  });
});
