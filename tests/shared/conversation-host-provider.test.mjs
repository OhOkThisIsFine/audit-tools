import { describe, it, expect } from "vitest";

// B1 host-identity sourcing: `resolveConversationHostProvider` resolves the
// provider identity of the auditor DRIVING this process (the quota-attribution
// key), auto-detecting a Codex host from the same in-session env signals the
// self-spawn guard reads so a Codex host no longer mis-charges fan-out to the
// exhausted Claude pool. `resolveHostProviderName` passes an EXPLICIT provider
// through and delegates the unset/auto fallback to it.
// [[host-provider-misattribution-nim-codex]] / [[capability-is-per-auditor-not-per-audit]]
const { resolveConversationHostProvider, resolveHostProviderName } = await import(
  "../../src/shared/providers/providerPathGuard.ts"
);

const CLEAN_ENV = {};
const CODEX_ENV = { CODEX_THREAD_ID: "t-1" };
const CLAUDE_ENV = { CLAUDECODE: "1" };

describe("resolveConversationHostProvider", () => {
  it("defaults to claude-code on a clean env (conversation-first host)", () => {
    expect(resolveConversationHostProvider({ env: CLEAN_ENV })).toBe("claude-code");
    expect(resolveConversationHostProvider()).not.toBe(undefined);
  });

  it("auto-detects the host from the run's own session env", () => {
    expect(resolveConversationHostProvider({ env: CODEX_ENV })).toBe("codex");
    expect(resolveConversationHostProvider({ env: CLAUDE_ENV })).toBe("claude-code");
  });

  it("codex is detected from any of its self-spawn signals", () => {
    for (const key of [
      "CODEX",
      "CODEX_SHELL",
      "CODEX_THREAD_ID",
      "CODEX_INTERNAL_ORIGINATOR_OVERRIDE",
    ]) {
      expect(resolveConversationHostProvider({ env: { [key]: "x" } })).toBe("codex");
    }
  });

  it("agy is detected from any of its self-spawn signals", () => {
    for (const key of ["AGY_CLI", "ANTIGRAVITY_CLI", "GEMINI_CLI"]) {
      expect(resolveConversationHostProvider({ env: { [key]: "x" } })).toBe("agy");
    }
  });

  it("codex wins over an also-present CLAUDECODE (a Codex host keeps its own meter)", () => {
    expect(
      resolveConversationHostProvider({ env: { ...CODEX_ENV, ...CLAUDE_ENV } }),
    ).toBe("codex");
  });

  it("sessionConfig.host_provider overrides env detection", () => {
    expect(
      resolveConversationHostProvider({
        sessionConfig: { host_provider: "opencode" },
        env: CODEX_ENV,
      }),
    ).toBe("opencode");
  });

  it("an explicit override wins over both config and env; auto is treated as unset", () => {
    expect(
      resolveConversationHostProvider({
        explicit: "vscode-task",
        sessionConfig: { host_provider: "opencode" },
        env: CODEX_ENV,
      }),
    ).toBe("vscode-task");
    // explicit "auto" falls through to config, then env
    expect(
      resolveConversationHostProvider({
        explicit: "auto",
        sessionConfig: { host_provider: "auto" },
        env: CODEX_ENV,
      }),
    ).toBe("codex");
  });
});

describe("resolveHostProviderName", () => {
  it("passes an explicit non-auto provider through verbatim", () => {
    expect(resolveHostProviderName({ provider: "codex" }, { env: CLEAN_ENV })).toBe("codex");
    expect(resolveHostProviderName({ provider: "opencode" }, { env: CODEX_ENV })).toBe("opencode");
  });

  it("falls back to the auto-detected conversation host when unset / auto", () => {
    expect(resolveHostProviderName(undefined, { env: CLEAN_ENV })).toBe("claude-code");
    expect(resolveHostProviderName({}, { env: CODEX_ENV })).toBe("codex");
    expect(resolveHostProviderName({ provider: "auto" }, { env: CODEX_ENV })).toBe("codex");
  });

  it("honors host_provider / explicit override on the fallback path", () => {
    expect(
      resolveHostProviderName({ provider: "auto", host_provider: "antigravity" }, { env: CODEX_ENV }),
    ).toBe("antigravity");
    expect(
      resolveHostProviderName({ provider: "auto" }, { explicit: "claude-code", env: CODEX_ENV }),
    ).toBe("claude-code");
  });
});
