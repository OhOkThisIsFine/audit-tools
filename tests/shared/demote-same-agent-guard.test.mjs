import { describe, it, expect } from "vitest";

// B1 same-agent guard (adversarial-review finding #1): an attended host demotes its
// primary in-process backend to a SEPARATE source pool only when the conversation
// host is a DIFFERENT provider than that backend. When they are the same provider
// (e.g. a Codex host running a `provider: codex` run inside a Codex session), the
// demoted source shares the host's own account — emitting both a host pool AND a
// demoted-source pool for that one meter double-books its budget/concurrency (and can
// collide on a single pool id). The guard suppresses the demote so the host
// self-drives as one pool. [[host-provider-misattribution-nim-codex]]
const { shouldDemotePrimaryInProcess } = await import(
  "../../src/shared/quota/apiPool.ts"
);

const CODEX_ENV = { CODEX_THREAD_ID: "t-1" };
const CLEAN_ENV = {};

describe("shouldDemotePrimaryInProcess", () => {
  it("demotes when host can dispatch and the host is a DIFFERENT provider than the backend", () => {
    // Claude host (clean/claude env), NIM backend → distinct meters → demote.
    expect(
      shouldDemotePrimaryInProcess({
        sessionConfig: { provider: "openai-compatible" },
        hostCanDispatch: true,
        env: CLEAN_ENV,
      }),
    ).toBe(true);
    // Codex host, NIM backend → still distinct → demote.
    expect(
      shouldDemotePrimaryInProcess({
        sessionConfig: { provider: "openai-compatible" },
        hostCanDispatch: true,
        env: CODEX_ENV,
      }),
    ).toBe(true);
  });

  it("SUPPRESSES the demote when the conversation host IS the primary backend (same account)", () => {
    // The finding-#1 case: codex host + provider:codex inside a codex session.
    expect(
      shouldDemotePrimaryInProcess({
        sessionConfig: { provider: "codex" },
        hostCanDispatch: true,
        env: CODEX_ENV,
      }),
    ).toBe(false);
    // An explicit host_provider override collapsing host onto the backend also suppresses.
    expect(
      shouldDemotePrimaryInProcess({
        sessionConfig: { provider: "opencode", host_provider: "opencode" },
        hostCanDispatch: true,
        env: CLEAN_ENV,
      }),
    ).toBe(false);
  });

  it("does not demote a non-demotable provider or when the host cannot dispatch", () => {
    expect(
      shouldDemotePrimaryInProcess({
        sessionConfig: { provider: "local-subprocess" },
        hostCanDispatch: true,
        env: CLEAN_ENV,
      }),
    ).toBe(false);
    expect(
      shouldDemotePrimaryInProcess({
        sessionConfig: { provider: "openai-compatible" },
        hostCanDispatch: false,
        env: CLEAN_ENV,
      }),
    ).toBe(false);
  });

  it("a codex backend under a CLAUDE host still demotes (distinct meters — the real defect-1 scenario)", () => {
    // provider:codex but the conversation host is claude-code (clean env, no CODEX*)
    // → different providers → demote is correct.
    expect(
      shouldDemotePrimaryInProcess({
        sessionConfig: { provider: "codex" },
        hostCanDispatch: true,
        env: CLEAN_ENV,
      }),
    ).toBe(true);
  });
});
