import { describe, test, expect } from "vitest";

// The current driver's `--auditor <json>` handshake must survive being re-emitted
// onto a continue-command and re-parsed by getAuditorDescriptor — otherwise the
// descriptor-riding (the founding-bug robustness fix) silently loses capability on
// every step. This pins the render↔parse round-trip. (G1 collapsed the former
// N `--host-*` flags into the single `--auditor` JSON transport; G2 folded the
// provider identity + host/IDE launch blocks onto `self` and resliced the dispatch
// backends to a top-level `sources[]`.)
const { renderAuditorDescriptor, nextStepCommand } = await import(
  "../../src/audit/cli/prompts.ts"
);
const { getAuditorDescriptor } = await import("../../src/audit/cli/args.ts");

describe("auditor descriptor round-trip", () => {
  test("a full descriptor renders to --auditor json that getAuditorDescriptor reproduces exactly", () => {
    const descriptor = {
      self: {
        provider: "claude-code",
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
    };
    const argv = renderAuditorDescriptor(descriptor);
    expect(argv[0]).toBe("--auditor");

    const parsed = getAuditorDescriptor(argv);
    expect(parsed.self.provider).toBe("claude-code");
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
    const argv = renderAuditorDescriptor({ self: { can_dispatch_subagents: true } });
    const parsed = getAuditorDescriptor(argv);
    expect(parsed.self.provider).toBeUndefined();
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
    const argv = renderAuditorDescriptor({ self: { can_dispatch_subagents: false } });
    expect(getAuditorDescriptor(argv).self.can_dispatch_subagents).toBe(false);
  });

  test("an undefined descriptor renders no flags (bare command)", () => {
    expect(renderAuditorDescriptor(undefined)).toEqual([]);
  });

  test("an empty descriptor (no self field, no sources) renders no flags", () => {
    expect(renderAuditorDescriptor({ self: {} })).toEqual([]);
  });

  // The reachable dispatch pool rides the same `--auditor` JSON as `self`, as a
  // top-level `sources[]` (G2 reslice).
  test("a sources[] pool round-trips inside the descriptor", () => {
    const sources = [
      { id: "s1", transport: "openai-compatible", endpoint: "https://e/v1", model: "m", api_key: "public", cost_per_mtok: 0 },
      { transport: "codex", endpoint: "codex", model: "gpt-x" },
    ];
    const argv = renderAuditorDescriptor({ self: { provider: "claude-code", can_dispatch_subagents: true }, sources });
    expect(argv).toContain("--auditor");
    const parsed = getAuditorDescriptor(argv);
    expect(parsed.sources).toEqual(sources);
    expect(parsed.self.provider).toBe("claude-code");
  });

  test("the driver's own host/IDE launch blocks round-trip on self", () => {
    const self = {
      provider: "vscode-task",
      can_dispatch_subagents: true,
      vscode_task: { command_template: ["code", "--task"] },
      claude_code: { command: "claude", dangerously_skip_permissions: true },
      antigravity: { command_template: ["agy", "task"] },
    };
    const argv = renderAuditorDescriptor({ self });
    const parsed = getAuditorDescriptor(argv);
    expect(parsed.self.vscode_task).toEqual(self.vscode_task);
    expect(parsed.self.claude_code).toEqual(self.claude_code);
    expect(parsed.self.antigravity).toEqual(self.antigravity);
  });

  test("absent sources re-parse to undefined; a bare command yields null", () => {
    const argv = renderAuditorDescriptor({ self: { can_dispatch_subagents: true } });
    expect(getAuditorDescriptor(argv).sources).toBeUndefined();
    expect(getAuditorDescriptor(["next-step"])).toBeNull();
  });

  test("--auditor throws loudly on malformed JSON / a non-object / a non-array sources (no silent downgrade)", () => {
    expect(() => getAuditorDescriptor(["--auditor", "{not json"])).toThrow(/JSON object/);
    expect(() => getAuditorDescriptor(["--auditor", "[1,2]"])).toThrow(/must be a JSON object/);
    expect(() => getAuditorDescriptor(["--auditor", '{"sources":{"x":1}}'])).toThrow(/sources/);
    expect(() => getAuditorDescriptor(["--auditor", '{"self":{"provider":"nope"}}'])).toThrow(/host-provider must be one of/);
  });

  test("descriptor dispatch content is mechanically validated (C1 quota + injection), not trusted", () => {
    // A malformed source quota (the C1 over-sizing guard) fails at the parse boundary.
    expect(() =>
      getAuditorDescriptor([
        "--auditor",
        JSON.stringify({ sources: [{ transport: "codex", quota: { context_tokens: -1 } }] }),
      ]),
    ).toThrow(/descriptor is invalid|context_tokens/);
    // A command-injection-shaped launch command in a host/IDE block fails too.
    expect(() =>
      getAuditorDescriptor([
        "--auditor",
        JSON.stringify({ self: { provider: "claude-code", claude_code: { command: "claude; rm -rf /" } } }),
      ]),
    ).toThrow(/descriptor is invalid/);
    // A well-formed descriptor with sources + parallel_workers round-trips cleanly.
    const argv = renderAuditorDescriptor({
      self: { provider: "claude-code", parallel_workers: 2 },
      sources: [{ transport: "openai-compatible", endpoint: "https://e/v1", model: "m", quota: { context_tokens: 128000, output_tokens: 8192 } }],
    });
    const parsed = getAuditorDescriptor(argv);
    expect(parsed.self.parallel_workers).toBe(2);
    expect(parsed.sources).toHaveLength(1);
  });

  test("nextStepCommand appends the --auditor descriptor after the base command", () => {
    const cmd = nextStepCommand("/repo", "/repo/.audit-tools/audit", {
      self: { can_dispatch_subagents: true, context_tokens: 128000 },
    });
    expect(cmd).toContain("next-step");
    expect(cmd).toContain("--auditor");
    expect(cmd).toContain("context_tokens");
    expect(cmd).toContain("128000");
    // The base flags precede the descriptor.
    expect(cmd.indexOf("--artifacts-dir")).toBeLessThan(cmd.indexOf("--auditor"));
  });
});
