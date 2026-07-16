import { test, expect } from "vitest";

// ---------------------------------------------------------------------------
// CP-NODE-6 — provider confirmation must EXCLUDE self-spawn-blocked backends.
//
// A claude-code / codex provider detected on PATH while the host is already
// inside an active session of that same agent (CLAUDECODE / CODEX set) cannot be
// launched as a fresh subprocess — doing so would self-spawn. The Gate-0
// confirmation must:
//   - carry a MACHINE-READABLE blocked flag (not just a free-text reason),
//   - EXCLUDE the blocked provider from the dispatchable pool by default,
//   - allow the operator to explicitly re-include it,
//   - ALWAYS retain the worker-command fallback,
//   - single-source the PATH guard with a test-injectable detection hook.
// ---------------------------------------------------------------------------

const {
  discoverProviders,
} = await import("../../src/shared/providers/providerConfirmation.ts");
const {
  buildProviderConfirmationRender,
} = await import("../../src/shared/providers/sharedProviderConfirmation.ts");
const {
  isSelfSpawnBlocked,
  commandExists,
  setCommandExistsForTesting,
} = await import("../../src/shared/providers/providerPathGuard.ts");

// A PATH-detection hook that claims EVERY probed command exists, so discovery is
// deterministic regardless of what CLIs are installed in CI.
const detectAll = () => true;

// ── machine-readable self-spawn flag ─────────────────────────────────────────

test("isSelfSpawnBlocked is the single-sourced, machine-readable guard", () => {
  expect(isSelfSpawnBlocked("claude-code", { CLAUDECODE: "1" })).toBe(true);
  expect(isSelfSpawnBlocked("claude-code", {})).toBe(false);
  expect(isSelfSpawnBlocked("codex", { CODEX: "1" })).toBe(true);
  expect(isSelfSpawnBlocked("codex", {})).toBe(false);
  expect(isSelfSpawnBlocked("agy", { AGY_CLI: "1" })).toBe(true);
  expect(isSelfSpawnBlocked("agy", { ANTIGRAVITY_CLI: "1" })).toBe(true);
  expect(isSelfSpawnBlocked("agy", { GEMINI_CLI: "1" })).toBe(true);
  expect(isSelfSpawnBlocked("agy", {})).toBe(false);
  // Providers without a self-spawn hazard are never blocked.
  expect(isSelfSpawnBlocked("opencode", { OPENCODE: "1" })).toBe(false);
  expect(isSelfSpawnBlocked("worker-command", {})).toBe(false);
});

test("discoverProviders stamps a machine-readable selfSpawnBlocked flag", () => {
  const inSession = discoverProviders({}, { CLAUDECODE: "1" }, detectAll);
  const claude = inSession.find((p) => p.name === "claude-code");
  expect(claude, "claude-code is still surfaced (operator may override)").toBeTruthy();
  expect(claude.selfSpawnBlocked, "claude-code must carry a machine-readable selfSpawnBlocked flag in a CLAUDECODE session").toBe(true);

  const clean = discoverProviders({}, {}, detectAll);
  const claudeClean = clean.find((p) => p.name === "claude-code");
  expect(claudeClean).toBeTruthy();
  expect(claudeClean.selfSpawnBlocked, "claude-code must NOT be flagged blocked outside a CLAUDECODE session").not.toBe(true);
});

// ── exclusion from the confirmed pool ────────────────────────────────────────
//
// B+D: the reach half (`excluded` / `self_spawn_blocked` / `capability_tier`) is a
// RENDER concern — it is what the operator must SEE at Gate-0 — and is deliberately
// NOT persisted, so these drive `buildProviderConfirmationRender`. The persisted
// counterpart is pinned separately (`buildSharedProviderConfirmation` must NOT emit
// any of it).

test("a self-spawn-blocked provider is EXCLUDED from the confirmed pool by default", () => {
  const built = buildProviderConfirmationRender(
    {},
    { CLAUDECODE: "1" },
    [],
    [],
    detectAll,
  );
  const claude = built.provider_pool.find((e) => e.name === "claude-code");
  expect(claude, "claude-code is recorded in the pool").toBeTruthy();
  expect(claude.excluded, "a self-spawn-blocked claude-code must be excluded from the dispatchable pool").toBe(true);
  expect(claude.self_spawn_blocked, "the pool entry must carry the machine-readable self_spawn_blocked flag").toBe(true);
});

test("a NON-blocked provider stays included in the confirmed pool", () => {
  const built = buildProviderConfirmationRender({}, {}, [], [], detectAll);
  const claude = built.provider_pool.find((e) => e.name === "claude-code");
  expect(claude).toBeTruthy();
  expect(claude.excluded, "claude-code is dispatchable outside a CLAUDECODE session").toBe(false);
  expect(claude.self_spawn_blocked).not.toBe(true);
});

test("the operator can explicitly re-include a self-spawn-blocked provider", () => {
  const built = buildProviderConfirmationRender(
    {},
    { CLAUDECODE: "1" },
    [],
    ["claude-code"],
    detectAll,
  );
  const claude = built.provider_pool.find((e) => e.name === "claude-code");
  expect(claude).toBeTruthy();
  expect(claude.excluded, "an operator opt-in overrides the default self-spawn exclusion").toBe(false);
  // The machine-readable flag still records WHY it would otherwise be excluded.
  expect(claude.self_spawn_blocked).toBe(true);
});

test("an operator exclude always wins over an include", () => {
  const built = buildProviderConfirmationRender(
    {},
    { CLAUDECODE: "1" },
    ["claude-code"],
    ["claude-code"],
    detectAll,
  );
  const claude = built.provider_pool.find((e) => e.name === "claude-code");
  expect(claude).toBeTruthy();
  expect(claude.excluded, "explicit exclude wins over include").toBe(true);
});

// ── always-available worker-command fallback ───────────────────────────────

test("worker-command fallback is ALWAYS retained, even inside a blocked session", () => {
  const built = buildProviderConfirmationRender(
    {},
    { CLAUDECODE: "1", CODEX: "1" },
    [],
    [],
    detectAll,
  );
  const local = built.provider_pool.find((e) => e.name === "worker-command");
  expect(local, "worker-command must always be in the pool").toBeTruthy();
  expect(local.excluded, "the fallback is never excluded").toBe(false);
});

// ── test-injectable PATH-detection hook ──────────────────────────────────────

test("setCommandExistsForTesting drives discovery deterministically and restores", () => {
  try {
    setCommandExistsForTesting(() => true);
    expect(commandExists("definitely-not-a-real-binary-xyz")).toBe(true);
    // The globally-injected hook (no per-call `detectCommand` passed) reaches
    // discovery, so a PATH-probed backend surfaces deterministically in CI.
    const discovered = discoverProviders({}, {}).map((p) => p.name);
    expect(discovered.includes("claude-code"), "injected hook surfaces claude-code").toBeTruthy();
  } finally {
    setCommandExistsForTesting(null);
  }
  // Restored: the bogus binary no longer resolves.
  expect(commandExists("definitely-not-a-real-binary-xyz")).toBe(false);
});
