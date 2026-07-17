import { describe, expect, it } from "vitest";

import {
  probeReachableWithEscalation,
  readSourceDeclaration,
  resolveAmbientSources,
  resolveSourceDeclarationPath,
  verifySourceReach,
} from "../../dist/shared/providers/auditorSources.js";
import { resolveSessionConfig } from "../../dist/shared/config/resolveSessionConfig.js";

/** Build deps with a declaration served from memory — no disk, no real PATH. */
function deps({ declaration, env = {}, onPath = [], readable = [] } = {}) {
  return {
    env,
    homeDir: "/home/test",
    commandExists: (cmd) => onPath.includes(cmd),
    fileReadable: (path) => readable.includes(path),
    readDeclarationFile: () =>
      declaration === undefined ? null : JSON.stringify(declaration),
  };
}

const NIM = {
  id: "nim",
  provider: "openai-compatible",
  endpoint: "https://integrate.api.nvidia.com/v1",
  model: "openai/gpt-oss-120b",
  api_key_env: "NVIDIA_API_KEY",
};

describe("resolveSourceDeclarationPath", () => {
  it("is machine-level — no auditor id in the name", () => {
    const path = resolveSourceDeclarationPath("/home/test");
    expect(path).toMatch(/sources-declared\.json$/u);
    // The spec reserves `catalog-<auditor-id>.json` for the POPULATE cache; squatting
    // it would make this read a direct cache read (never-inherit violation).
    expect(path).not.toMatch(/catalog-/u);
  });
});

describe("readSourceDeclaration — degrades, never throws", () => {
  it("returns [] when the file is absent", () => {
    expect(readSourceDeclaration(deps({}))).toEqual([]);
  });

  it("returns [] on malformed JSON", () => {
    const d = deps({});
    d.readDeclarationFile = () => "{not json";
    expect(readSourceDeclaration(d)).toEqual([]);
  });

  it("returns [] when the declaration is an array, not an object", () => {
    expect(readSourceDeclaration(deps({ declaration: [NIM] }))).toEqual([]);
  });

  it("returns [] when a source fails the shared validator", () => {
    const declaration = { sources: [{ ...NIM, provider: "not-a-provider" }] };
    expect(readSourceDeclaration(deps({ declaration }))).toEqual([]);
  });

  it("returns [] when a string field is the wrong type (the coercion hole)", () => {
    // Pre-G2.5 this passed the validator and `env[{...}]` coerced to "[object Object]".
    const declaration = { sources: [{ ...NIM, api_key_env: { a: 1 } }] };
    expect(readSourceDeclaration(deps({ declaration }))).toEqual([]);
  });

  it("parses a valid declaration", () => {
    const declaration = { sources: [NIM] };
    expect(readSourceDeclaration(deps({ declaration }))).toEqual([NIM]);
  });
});

describe("verifySourceReach — declared ∩ ambient", () => {
  it("verifies openai-compatible when api_key_env is populated", () => {
    const result = verifySourceReach(NIM, deps({ env: { NVIDIA_API_KEY: "sk-live" } }));
    expect(result.verified).toBe(true);
  });

  it("drops openai-compatible when the env var is unset", () => {
    const result = verifySourceReach(NIM, deps({ env: {} }));
    expect(result.verified).toBe(false);
    expect(result.reason).toContain("NVIDIA_API_KEY");
  });

  it("drops openai-compatible when the env var is present but empty", () => {
    const result = verifySourceReach(NIM, deps({ env: { NVIDIA_API_KEY: "   " } }));
    expect(result.verified).toBe(false);
  });

  it("refuses an inline api_key — possession is not reach", () => {
    const inline = { id: "zen", provider: "openai-compatible", endpoint: "https://x/v1", model: "m", api_key: "public" };
    const result = verifySourceReach(inline, deps({}));
    expect(result.verified).toBe(false);
    expect(result.reason).toContain("api_key_env");
  });

  it("drops openai-compatible with no endpoint or no model", () => {
    expect(verifySourceReach({ ...NIM, endpoint: undefined }, deps({ env: { NVIDIA_API_KEY: "k" } })).verified).toBe(false);
    expect(verifySourceReach({ ...NIM, model: undefined }, deps({ env: { NVIDIA_API_KEY: "k" } })).verified).toBe(false);
  });

  it("verifies a CLI source by its default launcher on PATH", () => {
    expect(verifySourceReach({ provider: "codex" }, deps({ onPath: ["codex"] })).verified).toBe(true);
    expect(verifySourceReach({ provider: "codex" }, deps({ onPath: [] })).verified).toBe(false);
  });

  it("probes a CLI source's endpoint override rather than the default", () => {
    const source = { provider: "opencode", endpoint: "opencode-canary" };
    expect(verifySourceReach(source, deps({ onPath: ["opencode-canary"] })).verified).toBe(true);
    // The default being present must NOT rescue a declared override that is absent.
    expect(verifySourceReach(source, deps({ onPath: ["opencode"] })).verified).toBe(false);
  });

  it("falls back to the legacy gemini binary for agy (2026-07-18 sunset gate)", () => {
    expect(verifySourceReach({ provider: "agy" }, deps({ onPath: ["gemini"] })).verified).toBe(true);
  });

  it("probes subprocess-template's command_template[0]", () => {
    const source = { provider: "subprocess-template", parameters: { command_template: ["pwsh", "-c", "x"] } };
    expect(verifySourceReach(source, deps({ onPath: ["pwsh"] })).verified).toBe(true);
    expect(verifySourceReach(source, deps({ onPath: [] })).verified).toBe(false);
    expect(verifySourceReach({ provider: "subprocess-template" }, deps({})).verified).toBe(false);
  });

  it("refuses worker-command — its reach is per-task", () => {
    const result = verifySourceReach({ provider: "worker-command" }, deps({}));
    expect(result.verified).toBe(false);
    expect(result.reason).toContain("per-task");
  });

  it("drops any source whose credentials_path is unreadable", () => {
    const source = { ...NIM, credentials_path: "/nope/creds.json" };
    const result = verifySourceReach(source, deps({ env: { NVIDIA_API_KEY: "k" } }));
    expect(result.verified).toBe(false);
    expect(result.reason).toContain("credentials_path");
  });

  it("admits a source whose credentials_path IS readable", () => {
    const source = { ...NIM, credentials_path: "/home/test/creds.json" };
    const d = deps({ env: { NVIDIA_API_KEY: "k" }, readable: ["/home/test/creds.json"] });
    expect(verifySourceReach(source, d).verified).toBe(true);
  });
});

describe("resolveAmbientSources", () => {
  it("keeps reachable sources and drops the rest WITH a reason", () => {
    const declaration = { sources: [NIM, { id: "cx", provider: "codex" }] };
    const result = resolveAmbientSources(
      deps({ declaration, env: { NVIDIA_API_KEY: "k" }, onPath: [] }),
    );
    expect(result.sources.map((s) => s.id)).toEqual(["nim"]);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0].id).toBe("cx");
    expect(result.dropped[0].reason).toContain("PATH");
  });

  it("never silently discards — every declared source is kept or explained", () => {
    const declaration = { sources: [NIM, { id: "cx", provider: "codex" }, { id: "wc", provider: "worker-command" }] };
    const result = resolveAmbientSources(deps({ declaration }));
    expect(result.sources.length + result.dropped.length).toBe(3);
  });

  it("derives a drop id for a source that declared none", () => {
    const declaration = { sources: [{ provider: "codex", model: "gpt-5-codex" }] };
    const result = resolveAmbientSources(deps({ declaration, onPath: [] }));
    expect(result.dropped[0].id).toBe("codex:gpt-5-codex");
  });

  it("is empty when there is no declaration (the inert default)", () => {
    expect(resolveAmbientSources(deps({})).sources).toEqual([]);
  });

  // The multi-IDE property, tested directly rather than assumed: the SAME declaration
  // resolves differently per process because each inherits its own IDE's env.
  it("resolves per-env — two IDEs, one declaration, different pools", () => {
    const declaration = { sources: [NIM] };
    const claudeDesktop = resolveAmbientSources(
      deps({ declaration, env: { NVIDIA_API_KEY: "k" } }),
    );
    const codexDesktop = resolveAmbientSources(deps({ declaration, env: {} }));
    expect(claudeDesktop.sources).toHaveLength(1);
    expect(codexDesktop.sources).toHaveLength(0);
  });
});

describe("resolveSessionConfig — the G2.5 wiring", () => {
  const intent = { lenses: ["correctness"] };

  it("folds the ambient-verified sources in when the descriptor declares none", () => {
    const effective = resolveSessionConfig(
      intent,
      { self: { provider: "claude-code" } },
      deps({ declaration: { sources: [NIM] }, env: { NVIDIA_API_KEY: "k" } }),
    );
    expect(effective.sources).toEqual([NIM]);
  });

  it("folds in NOTHING the process cannot reach", () => {
    const effective = resolveSessionConfig(
      intent,
      { self: { provider: "claude-code" } },
      deps({ declaration: { sources: [NIM] }, env: {} }),
    );
    expect(effective.sources).toBeUndefined();
  });

  it("an explicit descriptor.sources still wins — the operator escape hatch", () => {
    const forced = [{ id: "forced", provider: "codex" }];
    const effective = resolveSessionConfig(
      intent,
      { self: {}, sources: forced },
      deps({ declaration: { sources: [NIM] }, env: { NVIDIA_API_KEY: "k" } }),
    );
    expect(effective.sources).toEqual(forced);
  });

  it("a null descriptor stays fail-closed to driver-self-only", () => {
    const effective = resolveSessionConfig(
      intent,
      null,
      deps({ declaration: { sources: [NIM] }, env: { NVIDIA_API_KEY: "k" } }),
    );
    expect(effective.sources).toBeUndefined();
  });

  it("with no declaration, behavior is byte-identical to pre-G2.5 (the inert window)", () => {
    const descriptor = { self: { provider: "claude-code" } };
    const effective = resolveSessionConfig(intent, descriptor, deps({}));
    expect(effective).toEqual({ lenses: ["correctness"], provider: "claude-code", host_provider: "claude-code" });
  });

  it("preserves every intent field", () => {
    const rich = { lenses: ["security"], synthesis: { enabled: true }, dispatch: { max_packets: 4 } };
    const effective = resolveSessionConfig(rich, { self: {} }, { env: {} });
    expect(effective.synthesis).toEqual({ enabled: true });
    expect(effective.dispatch).toEqual({ max_packets: 4 });
  });
});

describe("probeReachableWithEscalation", () => {
  it("returns true on the first (cheap) attempt without escalating", () => {
    const budgets = [];
    const ok = probeReachableWithEscalation((ms) => {
      budgets.push(ms);
      return true;
    }, [1000, 4000]);
    expect(ok).toBe(true);
    expect(budgets).toEqual([1000]); // warm proxy: no second attempt
  });

  it("retries at a larger budget when the first attempt fails (cold-probe survival)", () => {
    const budgets = [];
    const ok = probeReachableWithEscalation((ms) => {
      budgets.push(ms);
      return ms >= 4000; // first (1s) attempt times out; second (4s) succeeds
    }, [1000, 4000]);
    expect(ok).toBe(true);
    expect(budgets).toEqual([1000, 4000]); // a healthy lane is NOT dropped on one cold probe
  });

  it("returns false only after every budget fails (genuinely-dead endpoint)", () => {
    const budgets = [];
    const ok = probeReachableWithEscalation((ms) => {
      budgets.push(ms);
      return false;
    }, [1000, 4000]);
    expect(ok).toBe(false);
    expect(budgets).toEqual([1000, 4000]);
  });
});
