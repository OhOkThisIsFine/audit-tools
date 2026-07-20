/**
 * `ambientAuditorDescriptor()` — the descriptor for a driver with NO host handshake.
 *
 * REGRESSION GUARD. Between v0.32.68 and this commit, remediate resolved its session
 * config with a `null` descriptor, which FAILS CLOSED to driver-self-only — so remediate
 * dispatched with no pool at all, where v0.32.68 read `sources[]` straight off disk. The
 * mechanism that closes it is the ambient descriptor: no host self-report, but the
 * environment still resolves.
 *
 * Pins the semantic these tests exist to keep apart:
 *   1. `null`      ⇒ resolve NO pool (short-circuits before ambient resolution),
 *   2. ambient     ⇒ resolve the pool from `declared ∩ ambient-verifiable`,
 *   3. ambient carries NO host-self-class fields (model/window/roster stay absent →
 *      the conservative floor, a fidelity degradation, never a block),
 *   4. it returns a FRESH object (no shared-literal mutation across callers).
 *
 * SCOPE — read this before trusting it as the regression guard. This pins the MECHANISM
 * (the ambient-vs-null semantic), not the WIRING. Verified by experiment: reverting a
 * remediate call site to `null` does NOT fail this file. The call-site guard is
 * `tests/remediate/session-config-load.test.ts`, which exercises the single loader every
 * remediate site routes through.
 *
 * Red-green validated for what it does cover: breaking `resolveSessionConfig`'s ambient
 * resolution (`descriptor.sources ?? resolveAmbientSources(...)` → `?? []`) fails case 2.
 */

import { test, describe, expect } from "vitest";

const { resolveSessionConfig } = await import(
  "../../src/shared/config/resolveSessionConfig.ts"
);
const { ambientAuditorDescriptor } = await import(
  "../../src/shared/types/auditorDescriptor.ts"
);

/** A declaration + env in which exactly one NIM lane is ambient-verifiable. */
const ambientDeps = () => ({
  env: { NIM_KEY: "sk-real" },
  homeDir: "/home/t",
  commandExists: () => false,
  fileReadable: () => false,
  readDeclarationFile: () =>
    JSON.stringify({
      sources: [
        {
          transport: "openai-compatible",
          endpoint: "https://nim.example/v1",
          model: "reachable-model",
          api_key_env: "NIM_KEY",
        },
        {
          // Unreachable: its key env var is unset → dropped by `declared ∩ ambient`.
          transport: "openai-compatible",
          endpoint: "https://nim.example/v1",
          model: "unreachable-model",
          api_key_env: "ABSENT_KEY",
        },
      ],
    }),
});

describe("ambientAuditorDescriptor", () => {
  test("null descriptor resolves NO pool — the fail-closed path (the regression)", () => {
    const eff = resolveSessionConfig({ synthesis: { narrative: true } }, null, ambientDeps());
    // Fails closed BEFORE ambient resolution: a declared+reachable lane is NOT picked up.
    expect(eff.sources).toBeUndefined();
  });

  test("ambient descriptor resolves the pool from declared ∩ ambient-verifiable", () => {
    const eff = resolveSessionConfig(
      { synthesis: { narrative: true } },
      ambientAuditorDescriptor(),
      ambientDeps(),
    );
    expect(eff.sources).toBeDefined();
    expect(eff.sources.map((s) => s.model)).toEqual(["reachable-model"]);
  });

  test("ambient descriptor reports nothing host-self-class (model/window/roster absent)", () => {
    const d = ambientAuditorDescriptor();
    expect(d.self).toEqual({});
    expect(d.self.model_id).toBeUndefined();
    expect(d.self.context_tokens).toBeUndefined();
    expect(d.self.output_tokens).toBeUndefined();
    expect(d.self.roster).toBeUndefined();
    // …so the effective config gains no provider/window identity from it.
    const eff = resolveSessionConfig({}, d, ambientDeps());
    expect(eff.provider).toBeUndefined();
  });

  test("returns a fresh object per call — no shared-literal mutation", () => {
    const a = ambientAuditorDescriptor();
    const b = ambientAuditorDescriptor();
    expect(a).not.toBe(b);
    expect(a.self).not.toBe(b.self);
    a.self.model_id = "mutated";
    expect(b.self.model_id).toBeUndefined();
  });

  test("intent fields survive ambient resolution untouched", () => {
    const intent = {
      synthesis: { narrative: true },
      analyzers: { gitleaks: "ephemeral" },
      dispatch: { max_packets: 7 },
    };
    const eff = resolveSessionConfig(intent, ambientAuditorDescriptor(), ambientDeps());
    expect(eff.synthesis).toEqual(intent.synthesis);
    expect(eff.analyzers).toEqual(intent.analyzers);
    expect(eff.dispatch).toEqual(intent.dispatch);
    // Input never mutated.
    expect(intent.sources).toBeUndefined();
  });
});
