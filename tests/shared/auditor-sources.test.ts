import { describe, expect, it } from "vitest";

import {
  probeReachableWithEscalation,
  readSourceDeclaration,
  resolveAmbientSources,
  resolveSourceDeclarationPath,
  verifySourceReach,
  type AmbientSourceDeps,
} from "../../src/shared/providers/auditorSources.js";
import { resolveSessionConfig } from "../../src/shared/config/resolveSessionConfig.js";
import type {
  DispatchableSource,
  RepoSessionIntent,
} from "../../src/shared/types/sessionConfig.js";
import type { AuditorDescriptor } from "../../src/shared/types/auditorDescriptor.js";

/**
 * Narrow the discriminated `verifySourceReach` result to its `reason`-carrying
 * branch after a runtime `verified === false` check. The preceding
 * `expect(result.verified).toBe(false)` line proves this at runtime but does not
 * narrow the TYPE, so `.reason` is otherwise unreachable under strict mode.
 */
function assertUnverified(
  result: ReturnType<typeof verifySourceReach>,
): asserts result is { verified: false; reason: string } {
  if (result.verified) throw new Error("expected an unverified reach result");
}

/** Build deps with a declaration served from memory — no disk, no real PATH. */
function deps(
  {
    declaration,
    env = {},
    onPath = [],
    readable = [],
  }: {
    declaration?: unknown;
    env?: NodeJS.ProcessEnv;
    onPath?: string[];
    readable?: string[];
    /** Accepted-but-unused here — some call sites pass it through inline. */
    probeHttpReachable?: (url: string) => boolean;
  } = {},
): AmbientSourceDeps {
  return {
    env,
    homeDir: "/home/test",
    commandExists: (cmd: string) => onPath.includes(cmd),
    fileReadable: (path: string) => readable.includes(path),
    readDeclarationFile: () =>
      declaration === undefined ? null : JSON.stringify(declaration),
  };
}

const NIM: DispatchableSource = {
  id: "nim",
  transport: "openai-compatible",
  endpoint: "https://integrate.api.nvidia.com/v1",
  model: "openai/gpt-oss-120b",
  api_key_env: "NVIDIA_API_KEY",
};

describe("verifySourceReach — a keyless openai-compatible endpoint is declarable", () => {
  // An unauthenticated local proxy (LiteLLM with no master key, LM Studio, local
  // vLLM) needs no credential, but the reach check used to hard-drop any
  // openai-compatible source without `api_key_env` — so those lanes had to declare
  // a semantically unrelated set var just to pass. `no_auth: true` swaps the env-var
  // proof for the endpoint liveness proof the claude-worker lane already uses.
  const KEYLESS: DispatchableSource = {
    id: "local",
    transport: "openai-compatible",
    endpoint: "http://127.0.0.1:4000/v1",
    model: "glm-5.2",
    no_auth: true,
  };

  it("verifies a keyless source when the endpoint answers the probe", () => {
    const result = verifySourceReach(KEYLESS, {
      ...deps({ env: {} }),
      probeHttpReachable: () => true,
    });
    expect(result.verified).toBe(true);
  });

  it("REFUSES a keyless source whose endpoint is dead — keyless is not unverified", () => {
    const result = verifySourceReach(KEYLESS, {
      ...deps({ env: {} }),
      probeHttpReachable: () => false,
    });
    expect(result.verified).toBe(false);
    assertUnverified(result);
    expect(result.reason).toMatch(/liveness probe/u);
  });

  it("refuses a contradictory declaration (no_auth AND api_key_env)", () => {
    const result = verifySourceReach(
      { ...KEYLESS, api_key_env: "SOME_KEY" },
      { ...deps({ env: { SOME_KEY: "k" } }), probeHttpReachable: () => true },
    );
    expect(result.verified).toBe(false);
    assertUnverified(result);
    expect(result.reason).toMatch(/BOTH no_auth and api_key_env/u);
  });

  it("an OMITTED key is still a drop — forgetting the key must not read as keyless", () => {
    const { no_auth, ...noMarker } = KEYLESS;
    const result = verifySourceReach(noMarker, {
      ...deps({ env: {} }),
      probeHttpReachable: () => true,
    });
    expect(result.verified).toBe(false);
    assertUnverified(result);
    expect(result.reason).toMatch(/no_auth: true/u);
  });
});

describe("verifySourceReach — api_key_env must be a NAME, not NAME=value", () => {
  // A declaration carrying `NAME=value` was accepted verbatim and then reported as
  // an unset var named `NAME=value`, which sends the operator to their shell
  // instead of to the typo.
  it("names the NAME=value mistake instead of reporting an unset var", () => {
    const result = verifySourceReach(
      { ...NIM, api_key_env: "NVIDIA_API_KEY=sk-live" },
      deps({ env: {} }),
    );
    expect(result.verified).toBe(false);
    assertUnverified(result);
    expect(result.reason).toMatch(/NAME=value pair/u);
    expect(result.reason).not.toMatch(/unset or empty/u);
  });

  it("rejects other non-NAME shapes", () => {
    for (const bad of ["1KEY", "has space", "dash-key"]) {
      const r = verifySourceReach({ ...NIM, api_key_env: bad }, deps({ env: {} }));
      expect(r.verified, `expected "${bad}" refused`).toBe(false);
      assertUnverified(r);
      expect(r.reason).toMatch(/environment variable NAME/u);
    }
  });

  it("still accepts a well-formed NAME whose var is set", () => {
    expect(verifySourceReach(NIM, deps({ env: { NVIDIA_API_KEY: "sk" } })).verified).toBe(true);
  });

  // The rule is a property of `api_key_env`, not of one transport's branch. The
  // claude-worker proxy lane read the same field and inherited the symptom the
  // openai-compatible branch was fixed for.
  it("applies to the claude-worker proxy lane too", () => {
    const result = verifySourceReach(
      {
        id: "cw",
        transport: "claude-worker",
        endpoint: "http://127.0.0.1:4000",
        model: "glm-5.2",
        api_key_env: "PROXY_KEY=sk-live",
      },
      deps({ env: {}, probeHttpReachable: () => true }),
    );
    expect(result.verified).toBe(false);
    assertUnverified(result);
    expect(result.reason).toMatch(/NAME=value pair/u);
    expect(result.reason).not.toMatch(/unset or empty/u);
  });
});

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
    const declaration = { sources: [{ ...NIM, transport: "not-a-provider" }] };
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
    assertUnverified(result);
    expect(result.reason).toContain("NVIDIA_API_KEY");
  });

  it("drops openai-compatible when the env var is present but empty", () => {
    const result = verifySourceReach(NIM, deps({ env: { NVIDIA_API_KEY: "   " } }));
    expect(result.verified).toBe(false);
  });

  // No inline-`api_key` refusal is pinned here any more: the field is RETIRED, so a
  // pasted key is refused at validation before it can reach this gate. The refusal
  // lives in tests/audit/validation-remediation.test.mjs ("C1: … sources[] transport
  // + quota"), which pins both declaration shapes.

  it("drops openai-compatible with no endpoint or no model", () => {
    expect(verifySourceReach({ ...NIM, endpoint: undefined }, deps({ env: { NVIDIA_API_KEY: "k" } })).verified).toBe(false);
    expect(verifySourceReach({ ...NIM, model: undefined }, deps({ env: { NVIDIA_API_KEY: "k" } })).verified).toBe(false);
  });

  it("verifies a CLI source by its default launcher on PATH", () => {
    expect(verifySourceReach({ transport: "codex" }, deps({ onPath: ["codex"] })).verified).toBe(true);
    expect(verifySourceReach({ transport: "codex" }, deps({ onPath: [] })).verified).toBe(false);
  });

  it("probes a CLI source's endpoint override rather than the default", () => {
    const source: DispatchableSource = { transport: "opencode", endpoint: "opencode-canary" };
    expect(verifySourceReach(source, deps({ onPath: ["opencode-canary"] })).verified).toBe(true);
    // The default being present must NOT rescue a declared override that is absent.
    expect(verifySourceReach(source, deps({ onPath: ["opencode"] })).verified).toBe(false);
  });

  it("falls back to the legacy gemini binary for agy (2026-07-18 sunset gate)", () => {
    expect(verifySourceReach({ transport: "agy" }, deps({ onPath: ["gemini"] })).verified).toBe(true);
  });

  it("probes subprocess-template's command_template[0]", () => {
    const source: DispatchableSource = { transport: "subprocess-template", parameters: { command_template: ["pwsh", "-c", "x"] } };
    expect(verifySourceReach(source, deps({ onPath: ["pwsh"] })).verified).toBe(true);
    expect(verifySourceReach(source, deps({ onPath: [] })).verified).toBe(false);
    expect(verifySourceReach({ transport: "subprocess-template" }, deps({})).verified).toBe(false);
  });

  it("refuses worker-command — its reach is per-task", () => {
    const result = verifySourceReach({ transport: "worker-command" }, deps({}));
    expect(result.verified).toBe(false);
    assertUnverified(result);
    expect(result.reason).toContain("per-task");
  });

  it("drops any source whose credentials_path is unreadable", () => {
    const source = { ...NIM, credentials_path: "/nope/creds.json" };
    const result = verifySourceReach(source, deps({ env: { NVIDIA_API_KEY: "k" } }));
    expect(result.verified).toBe(false);
    assertUnverified(result);
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
    const declaration = { sources: [NIM, { id: "cx", transport: "codex" }] };
    const result = resolveAmbientSources(
      deps({ declaration, env: { NVIDIA_API_KEY: "k" }, onPath: [] }),
    );
    expect(result.sources.map((s) => s.id)).toEqual(["nim"]);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0].id).toBe("cx");
    expect(result.dropped[0].reason).toContain("PATH");
  });

  it("never silently discards — every declared source is kept or explained", () => {
    const declaration = { sources: [NIM, { id: "cx", transport: "codex" }, { id: "wc", transport: "worker-command" }] };
    const result = resolveAmbientSources(deps({ declaration }));
    expect(result.sources.length + result.dropped.length).toBe(3);
  });

  it("derives a drop id for a source that declared none", () => {
    const declaration = { sources: [{ transport: "codex", model: "gpt-5-codex" }] };
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
  // `lenses` (and `rich.synthesis.enabled` below) are synthetic passthrough-probe
  // fields, not real RepoSessionIntent contract fields — the point of these tests
  // is that `resolveSessionConfig` preserves whatever the intent carries, verbatim,
  // regardless of field identity. The intersection widens the declared type just
  // enough for the compiler to see these as legitimate (if synthetic) intent
  // fields, without changing a single runtime value or assertion.
  const intent: RepoSessionIntent & { lenses?: string[] } = { lenses: ["correctness"] };

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
    const forced: DispatchableSource[] = [{ id: "forced", transport: "codex" }];
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
    const descriptor: AuditorDescriptor = { self: { provider: "claude-code" } };
    const effective = resolveSessionConfig(intent, descriptor, deps({}));
    expect(effective).toEqual({ lenses: ["correctness"], provider: "claude-code", host_provider: "claude-code" });
  });

  it("preserves every intent field", () => {
    const rich: RepoSessionIntent & { lenses?: string[]; synthesis?: { enabled?: boolean } } = {
      lenses: ["security"],
      synthesis: { enabled: true },
      dispatch: { max_packets: 4 },
    };
    const effective = resolveSessionConfig(rich, { self: {} }, { env: {} });
    expect(effective.synthesis).toEqual({ enabled: true });
    expect(effective.dispatch).toEqual({ max_packets: 4 });
  });
});

describe("probeReachableWithEscalation", () => {
  it("returns true on the first (cheap) attempt without escalating", () => {
    const budgets: number[] = [];
    const ok = probeReachableWithEscalation((ms) => {
      budgets.push(ms);
      return true;
    }, [1000, 4000]);
    expect(ok).toBe(true);
    expect(budgets).toEqual([1000]); // warm proxy: no second attempt
  });

  it("retries at a larger budget when the first attempt fails (cold-probe survival)", () => {
    const budgets: number[] = [];
    const ok = probeReachableWithEscalation((ms) => {
      budgets.push(ms);
      return ms >= 4000; // first (1s) attempt times out; second (4s) succeeds
    }, [1000, 4000]);
    expect(ok).toBe(true);
    expect(budgets).toEqual([1000, 4000]); // a healthy lane is NOT dropped on one cold probe
  });

  it("returns false only after every budget fails (genuinely-dead endpoint)", () => {
    const budgets: number[] = [];
    const ok = probeReachableWithEscalation((ms) => {
      budgets.push(ms);
      return false;
    }, [1000, 4000]);
    expect(ok).toBe(false);
    expect(budgets).toEqual([1000, 4000]);
  });
});

describe("worker-kind × pool-class compatibility (burst_limited)", () => {
  const BURSTY_CW: DispatchableSource = {
    id: "cw-nim",
    transport: "claude-worker",
    endpoint: "http://127.0.0.1:4000",
    service: "nvidia_nim",
    model: "glm-5.2",
    burst_limited: true,
  };

  it("drops a declared agentic lane on a burst-limited backend WITH the reason", () => {
    const result = resolveAmbientSources({
      ...deps({ declaration: { sources: [BURSTY_CW] } }),
      probeHttpReachable: () => true, // reach passes — the drop is the compat rule, not reach
    });
    expect(result.sources).toEqual([]);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0].id).toBe("cw-nim");
    expect(result.dropped[0].reason).toContain("burst-limited");
    expect(result.dropped[0].reason).toContain("single-shot");
  });

  it("keeps a single-shot lane on the same burst-limited backend", () => {
    const declaration = { sources: [{ ...NIM, burst_limited: true }] };
    const result = resolveAmbientSources(
      deps({ declaration, env: { NVIDIA_API_KEY: "k" } }),
    );
    expect(result.sources).toHaveLength(1);
    expect(result.dropped).toEqual([]);
  });

  it("a single_shot label on a claude-worker lane does NOT bypass the rule (transport is authoritative)", () => {
    // The declaration cannot change what the transport DOES — `claude -p` is a tool
    // loop regardless of the label, so honoring it here would reproduce the live
    // storm through a one-word config edit (AGY review finding #1).
    const declaration = {
      sources: [{ ...BURSTY_CW, worker_kind: "single_shot" }],
    };
    const result = resolveAmbientSources({
      ...deps({ declaration }),
      probeHttpReachable: () => true,
    });
    expect(result.sources).toEqual([]);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0].reason).toContain("burst-limited");
  });

  it("burst_limited: false is explicit-unrestricted (no drop)", () => {
    const declaration = { sources: [{ ...BURSTY_CW, burst_limited: false }] };
    const result = resolveAmbientSources({
      ...deps({ declaration }),
      probeHttpReachable: () => true,
    });
    expect(result.sources).toHaveLength(1);
    expect(result.dropped).toEqual([]);
  });

  it("keeps the never-silently-discarded invariant: kept + dropped = declared", () => {
    const declaration = {
      sources: [BURSTY_CW, { ...NIM, burst_limited: true }, { id: "cx", transport: "codex" }],
    };
    const result = resolveAmbientSources({
      ...deps({ declaration, env: { NVIDIA_API_KEY: "k" } }),
      probeHttpReachable: () => true,
    });
    expect(result.sources.length + result.dropped.length).toBe(3);
  });
});
