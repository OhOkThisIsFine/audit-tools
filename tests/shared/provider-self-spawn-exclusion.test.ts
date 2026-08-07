import { test, expect } from "vitest";
import { buildSelfSpawnExclusion, buildDeadProviderExclusion, composeDispatchExclusions } from "../../src/shared/providers/dispatchExclusion.js";
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

test("buildDeadProviderExclusion excludes exactly the named dead providers", () => {
  const deadProviders = [
    { pool_id: "pool-1", provider_name: "codex" },
    { pool_id: "pool-2", provider_name: "agy" },
  ];
  const exclusion = buildDeadProviderExclusion(deadProviders);

  expect(exclusion.excludes({ transport: "codex" })).toBe(true);
  expect(exclusion.excludedBy({ transport: "codex" })).toBe("transport:codex");
  expect(exclusion.excludes({ transport: "agy" })).toBe(true);
  expect(exclusion.excludedBy({ transport: "agy" })).toBe("transport:agy");
  expect(exclusion.excludes({ transport: "claude-code" })).toBe(false);
  expect(exclusion.excludedBy({ transport: "claude-code" })).toBe(null);
});

test("buildDeadProviderExclusion with empty list excludes nothing", () => {
  const exclusion = buildDeadProviderExclusion([]);

  expect(exclusion.excludes({ transport: "codex" })).toBe(false);
  expect(exclusion.excludes({ transport: "agy" })).toBe(false);
});

test("buildDeadProviderExclusion with undefined excludes nothing", () => {
  const exclusion = buildDeadProviderExclusion(undefined);

  expect(exclusion.excludes({ transport: "codex" })).toBe(false);
  expect(exclusion.excludes({ transport: "agy" })).toBe(false);
});

test("composeDispatchExclusions combines exclusions with OR logic", () => {
  const selfSpawn = buildSelfSpawnExclusion({
    env: { CODEX_THREAD_ID: "thread" },
  });
  const deadProviders = buildDeadProviderExclusion([
    { pool_id: "pool-1", provider_name: "agy" },
  ]);
  const composed = composeDispatchExclusions(selfSpawn, deadProviders);

  // From self-spawn
  expect(composed.excludes({ transport: "codex" })).toBe(true);
  // From dead providers
  expect(composed.excludes({ transport: "agy" })).toBe(true);
  // Neither
  expect(composed.excludes({ transport: "openai-compatible" })).toBe(false);
});

test("composeDispatchExclusions returns first-match pattern", () => {
  const first = buildSelfSpawnExclusion({
    env: { CODEX_THREAD_ID: "thread" },
  });
  const second = buildDeadProviderExclusion([
    { pool_id: "pool-1", provider_name: "codex" },
  ]);
  const composed = composeDispatchExclusions(first, second);

  // First exclusion matches
  const pattern = composed.excludedBy({ transport: "codex" });
  expect(pattern).toBe("transport:codex");
  // Both matched, but first wins
  expect(pattern).not.toBe(null);
});
