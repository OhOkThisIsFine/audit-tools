import { test, expect } from "vitest";

const { resolveRollingEngineFlag, assertHostProviderName, PROVIDER_NAMES } =
  await import("../../src/shared/types/sessionConfig.ts");

/**
 * Tier B: resolveRollingEngineFlag single-sources the resolution order behind
 * remediate's resolveRollingEngineEnabled and audit's
 * resolveAuditRollingEngineEnabled — both now ~5-line bindings over this,
 * parameterized only by the env var name and (unchanged) their own defaults.
 */

test("resolveRollingEngineFlag: explicit true wins over sessionConfig false and env false", () => {
  expect(
    resolveRollingEngineFlag({
      explicit: true,
      sessionConfig: { dispatch: { rolling_engine: false } },
      envVarName: "SOME_ROLLING_ENGINE",
      env: { SOME_ROLLING_ENGINE: "false" },
    }),
  ).toBe(true);
});

test("resolveRollingEngineFlag: explicit false wins over sessionConfig true and env true", () => {
  expect(
    resolveRollingEngineFlag({
      explicit: false,
      sessionConfig: { dispatch: { rolling_engine: true } },
      envVarName: "SOME_ROLLING_ENGINE",
      env: { SOME_ROLLING_ENGINE: "true" },
    }),
  ).toBe(false);
});

test("resolveRollingEngineFlag: sessionConfig wins when explicit is undefined", () => {
  expect(
    resolveRollingEngineFlag({
      sessionConfig: { dispatch: { rolling_engine: false } },
      envVarName: "SOME_ROLLING_ENGINE",
      env: { SOME_ROLLING_ENGINE: "true" },
    }),
  ).toBe(false);
});

test("resolveRollingEngineFlag: env var used when explicit and sessionConfig both absent", () => {
  expect(
    resolveRollingEngineFlag({
      envVarName: "SOME_ROLLING_ENGINE",
      env: { SOME_ROLLING_ENGINE: "false" },
    }),
  ).toBe(false);
  expect(
    resolveRollingEngineFlag({
      envVarName: "SOME_ROLLING_ENGINE",
      env: { SOME_ROLLING_ENGINE: "true" },
    }),
  ).toBe(true);
});

test("resolveRollingEngineFlag: defaults to true when all inputs absent", () => {
  expect(resolveRollingEngineFlag({ envVarName: "SOME_ROLLING_ENGINE", env: {} })).toBe(true);
});

test("resolveRollingEngineFlag: garbage env var value falls back to default true", () => {
  expect(
    resolveRollingEngineFlag({
      envVarName: "SOME_ROLLING_ENGINE",
      env: { SOME_ROLLING_ENGINE: "yes-please" },
    }),
  ).toBe(true);
});

test("resolveRollingEngineFlag: distinct env var names stay independent (no cross-tool leak)", () => {
  const env = { AUDIT_CODE_ROLLING_ENGINE: "false", REMEDIATE_ROLLING_ENGINE: "true" };
  expect(resolveRollingEngineFlag({ envVarName: "AUDIT_CODE_ROLLING_ENGINE", env })).toBe(false);
  expect(resolveRollingEngineFlag({ envVarName: "REMEDIATE_ROLLING_ENGINE", env })).toBe(true);
});

// ── assertHostProviderName (Tier D) ─────────────────────────────────────────

test("assertHostProviderName: accepts every known ProviderName without throwing", () => {
  for (const name of PROVIDER_NAMES) {
    expect(() => assertHostProviderName(name)).not.toThrow();
  }
});

test("assertHostProviderName: rejects an unknown value with the shared message", () => {
  expect(() => assertHostProviderName("not-a-real-provider")).toThrow(
    /--host-provider must be one of:.*got "not-a-real-provider"/,
  );
});
