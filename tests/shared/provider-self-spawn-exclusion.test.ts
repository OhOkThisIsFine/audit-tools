import { test, expect } from "vitest";
import { buildSelfSpawnExclusion } from "../../src/shared/providers/dispatchExclusion.js";
import { isSelfSpawnBlocked } from "../../src/shared/providers/providerPathGuard.js";

test("isSelfSpawnBlocked remains the single-sourced environment guard", () => {
  expect(isSelfSpawnBlocked("codex", { CODEX_THREAD_ID: "thread" })).toBe(true);
  expect(isSelfSpawnBlocked("claude-code", { CLAUDECODE: "1" })).toBe(true);
  expect(isSelfSpawnBlocked("agy", { AGY_CLI: "1" })).toBe(true);
});

test("buildSelfSpawnExclusion rejects only the active host transport", () => {
  const exclusion = buildSelfSpawnExclusion({
    env: { CODEX_THREAD_ID: "thread" },
  });
  expect(exclusion.excludes({ transport: "codex" })).toBe(true);
  expect(exclusion.excludedBy({ transport: "codex" })).toBe("transport:codex");
  expect(exclusion.excludes({ transport: "openai-compatible" })).toBe(false);
  expect(exclusion.excludedBy({ transport: "openai-compatible" })).toBe(null);
});

test("buildSelfSpawnExclusion is empty outside an agent session", () => {
  const exclusion = buildSelfSpawnExclusion({ env: {} });
  expect(exclusion.excludes({ transport: "codex" })).toBe(false);
  expect(exclusion.excludes({ transport: "claude-code" })).toBe(false);
});

test("buildSelfSpawnExclusion honors an explicit markerless host identity", () => {
  const exclusion = buildSelfSpawnExclusion({
    env: {},
    activeHostProvider: "codex",
  });

  expect(exclusion.excludes({ transport: "codex" })).toBe(true);
  expect(exclusion.excludes({ transport: "claude-code" })).toBe(false);
});
