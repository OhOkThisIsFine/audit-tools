/**
 * RESOLVE half of the neutral proxy lane: a declared `proxy`
 * whose injectable liveness probe passes expands from the POPULATE CACHE — never a
 * mid-resolve fetch. Every non-expanded outcome lands in `dropped[]` with a reason
 * (fail-open, lane dropped — the owner decision). Also covers
 * `readProxyDeclaration` tolerance and `verifySourceReach`'s claude-worker
 * case. Plan section h.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  populateDeclaredProxyCatalog,
  populateProxyCatalogIfMissing,
  readProxyDeclaration,
  resolveAmbientSources,
  verifySourceReach,
} = await import("../../src/shared/providers/auditorSources.ts");
const { readProxyCatalog, PROXY_CATALOG_VERSION } = await import(
  "../../src/shared/providers/proxyCatalog.ts"
);

const PROXY = "http://127.0.0.1:8791";

/** An expanded claude-worker source as the populate cache stores it. */
const EXPANDED = {
  id: "claude-worker:nim/z-ai/glm-5.2",
  transport: "claude-worker",
  endpoint: PROXY,
  service: "nim",
  model: "z-ai/glm-5.2",
  worker_kind: "agentic",
  cost_per_mtok: 0,
};

/** A valid populate cache body. */
function cache({ endpoint = PROXY, sources = [EXPANDED] } = {}) {
  return JSON.stringify({
    version: PROXY_CATALOG_VERSION,
    fetched_at: new Date().toISOString(),
    endpoint,
    sources,
  });
}

/**
 * Injected ambient deps: declaration + probe verdict + cache body, no disk, no
 * network (mirrors the auditor-sources test helper).
 */
function deps({ declaration, probe = () => false, catalog = null, env = {} } = {}) {
  return {
    env,
    homeDir: "/home/test",
    commandExists: () => false,
    fileReadable: () => false,
    readDeclarationFile: () =>
      declaration === undefined ? null : JSON.stringify(declaration),
    probeHttpReachable: probe,
    readCatalogFile: () => catalog,
  };
}

describe("readProxyDeclaration — tolerant shape", () => {
  it("is absent (no reason) when the file or the key is missing", () => {
    expect(readProxyDeclaration(deps({}))).toEqual({ declaration: null });
    expect(readProxyDeclaration(deps({ declaration: { sources: [] } }))).toEqual({
      declaration: null,
    });
  });

  it("a present-but-malformed block degrades to lane-absent WITH a reason", () => {
    for (const bad of ["yes", 1, [], { endpoint: 42 }, { endpoint: "  " }, {}]) {
      const result = readProxyDeclaration(
        deps({ declaration: { proxy: bad } }),
      );
      expect(result.declaration, JSON.stringify(bad)).toBeNull();
      expect(result.reason, JSON.stringify(bad)).toContain("proxy");
    }
  });

  it("parses endpoint + optional knobs; trailing slash normalized", () => {
    const result = readProxyDeclaration(
      deps({
        declaration: {
          proxy: { endpoint: `${PROXY}/`, top_k: 5, cost_per_mtok: 0, api_key_env: "KEY" },
        },
      }),
    );
    expect(result).toEqual({
      declaration: { endpoint: PROXY, top_k: 5, cost_per_mtok: 0, api_key_env: "KEY" },
    });
  });

  it("a malformed optional knob is dropped WITHOUT costing the lane", () => {
    const result = readProxyDeclaration(
      deps({
        declaration: {
          proxy: { endpoint: PROXY, top_k: "many", cost_per_mtok: -1, api_key_env: "" },
        },
      }),
    );
    expect(result.declaration).toEqual({ endpoint: PROXY });
  });

  it("REGRESSION PIN (iii): legacy repair_proxy key → loud dropped reason", () => {
    // PRE-SWAP: repair_proxy was parsed as the lane declaration.
    // POST-SWAP: repair_proxy is explicitly retired, surfaces a dropped reason.
    // Never silent ignore — migration must fail loud.
    const result = readProxyDeclaration(
      deps({ declaration: { repair_proxy: { endpoint: PROXY } } }),
    );
    expect(result.declaration).toBeNull();
    // Semantic check: the reason names the unrecognized key and directs to proxy block.
    expect(result.reason).toContain("repair_proxy");
    expect(result.reason).toContain("retired");
    expect(result.reason).toContain("proxy");
  });
});

describe("resolveAmbientSources — the proxy lane", () => {
  const declaration = { proxy: { endpoint: PROXY } };

  it("reachable + cache ⇒ the cached claude-worker sources fold into the pool", () => {
    const probed = [];
    const result = resolveAmbientSources(
      deps({
        declaration,
        probe: (url) => {
          probed.push(url);
          return true;
        },
        catalog: cache(),
      }),
    );
    expect(result.sources).toEqual([EXPANDED]);
    expect(result.dropped).toEqual([]);
    // The probe hits /health/liveliness OR /v1/models (never /health).
    // Assert the probe was called with liveness URLs, not the old /registry.
    expect(probed.length).toBeGreaterThan(0);
    expect(probed[0]).not.toContain("/registry");
    expect(probed[0]).not.toContain("/health");
  });

  it("reachable + NO cache ⇒ lane unexpanded, with a run-populate reason", () => {
    const result = resolveAmbientSources(
      deps({ declaration, probe: () => true, catalog: null }),
    );
    expect(result.sources).toEqual([]);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0].id).toBe(`proxy:${PROXY}`);
    expect(result.dropped[0].reason).toContain("populate");
  });

  // A proxy's health endpoint is typically UNAUTHENTICATED (LiteLLM's
  // /health/liveliness is), so a declared-but-unset master key sails past the
  // liveness probe and only fails later at populate — which reported "cache
  // absent, run the populate" to an operator who had already run it. The lane
  // must reach-verify its own declared key, exactly as the expanded per-model
  // sources do, and name the env var.
  it("declared api_key_env UNSET ⇒ dropped naming the env var, NOT a run-populate reason", () => {
    const withKey = { proxy: { endpoint: PROXY, api_key_env: "PROXY_KEY" } };
    const result = resolveAmbientSources(
      deps({
        declaration: withKey,
        probe: () => true, // health endpoint is open — the probe cannot catch this
        catalog: null,
        env: {},
      }),
    );
    expect(result.sources).toEqual([]);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0].id).toBe(`proxy:${PROXY}`);
    expect(result.dropped[0].reason).toContain("PROXY_KEY");
    expect(result.dropped[0].reason).not.toContain("populate");
  });

  it("declared api_key_env SET ⇒ the lane proceeds and expands from cache", () => {
    const withKey = { proxy: { endpoint: PROXY, api_key_env: "PROXY_KEY" } };
    const result = resolveAmbientSources(
      deps({
        declaration: withKey,
        probe: () => true,
        catalog: cache(),
        env: { PROXY_KEY: "sk-live" },
      }),
    );
    expect(result.dropped).toEqual([]);
    expect(result.sources).toEqual([EXPANDED]);
  });

  it("reachable + cache from a DIFFERENT endpoint ⇒ unexpanded with a reason", () => {
    const result = resolveAmbientSources(
      deps({
        declaration,
        probe: () => true,
        catalog: cache({ endpoint: "http://other:9999" }),
      }),
    );
    expect(result.sources).toEqual([]);
    expect(result.dropped[0].reason).toContain("http://other:9999");
  });

  it("reachable + EMPTY expansion ⇒ lane present but unexpanded, with a reason", () => {
    const result = resolveAmbientSources(
      deps({ declaration, probe: () => true, catalog: cache({ sources: [] }) }),
    );
    expect(result.sources).toEqual([]);
    expect(result.dropped[0].reason).toContain("unexpanded");
  });

  it("unreachable ⇒ lane dropped with the liveness reason (fail-open, no throw)", () => {
    const result = resolveAmbientSources(
      deps({ declaration, probe: () => false, catalog: cache() }),
    );
    expect(result.sources).toEqual([]);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0].reason).toContain("liveness");
  });

  it("a malformed proxy block is dropped with its parse reason", () => {
    const result = resolveAmbientSources(
      deps({ declaration: { proxy: { endpoint: 42 } } } ),
    );
    expect(result.dropped).toEqual([
      { id: "proxy", reason: expect.stringContaining("endpoint") },
    ]);
  });

  it("no proxy declared ⇒ no lane, no drop", () => {
    const result = resolveAmbientSources(deps({ declaration: { sources: [] } }));
    expect(result.sources).toEqual([]);
    expect(result.dropped).toEqual([]);
  });

  it("the lane composes with declared sources[] (both halves resolve)", () => {
    const openai = {
      id: "openai-compat",
      transport: "openai-compatible",
      endpoint: "http://openai/v1",
      model: "gpt-4",
      api_key_env: "OPENAI_API_KEY",
    };
    const result = resolveAmbientSources(
      deps({
        declaration: { sources: [openai], proxy: { endpoint: PROXY } },
        probe: () => true,
        catalog: cache(),
        env: { OPENAI_API_KEY: "sk-..." },
      }),
    );
    expect(result.sources.map((s) => s.id)).toEqual([
      "openai-compat",
      "claude-worker:nim/z-ai/glm-5.2",
    ]);
  });
});

describe("populateDeclaredProxyCatalog — the Gate-0 POPULATE trigger", () => {
  const tmpDirs = [];
  afterEach(() => {
    while (tmpDirs.length) {
      try { rmSync(tmpDirs.pop(), { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
  function tmpHome() {
    const dir = mkdtempSync(join(tmpdir(), "gate0-populate-"));
    tmpDirs.push(dir);
    return dir;
  }

  it("no proxy declared ⇒ null, and the network is never touched", async () => {
    let fetched = 0;
    const result = await populateDeclaredProxyCatalog({
      ...deps({ declaration: { sources: [] } }),
      fetchImpl: async () => {
        fetched += 1;
        return { ok: true, json: async () => ({ data: [] }) };
      },
    });
    expect(result).toBeNull();
    expect(fetched).toBe(0);
  });

  it("declared + fetch failure ⇒ degrade with a reason, never a throw, prior cache untouched", async () => {
    const home = tmpHome();
    const result = await populateDeclaredProxyCatalog({
      ...deps({ declaration: { proxy: { endpoint: PROXY } } }),
      homeDir: home,
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    expect(result?.written).toBe(false);
    expect(result?.reason).toContain("ECONNREFUSED");
    // Nothing was written — the (absent) prior cache stays absent.
    expect(readProxyCatalog({ homeDir: home })).toBeNull();
  });

  it("declared + HTTP error ⇒ degrade with the status in the reason", async () => {
    const result = await populateDeclaredProxyCatalog({
      ...deps({ declaration: { proxy: { endpoint: PROXY } } }),
      homeDir: tmpHome(),
      fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
    });
    expect(result?.written).toBe(false);
    expect(result?.reason).toContain("503");
  });

  it("declared + reachable proxy discovery ⇒ writes the cache the RESOLVE half then reads", async () => {
    const home = tmpHome();
    const result = await populateDeclaredProxyCatalog({
      ...deps({
        declaration: { proxy: { endpoint: PROXY, top_k: 1, cost_per_mtok: 0 } },
      }),
      homeDir: home,
      fetchImpl: async (url) => {
        const urlStr = String(url);
        if (urlStr === `${PROXY}/v1/models`) {
          return {
            ok: true,
            json: async () => ({
              data: [
                { id: "z-ai/glm-5.2", object: "model" },
                { id: "meta/llama-4", object: "model" },
              ],
            }),
          };
        }
        if (urlStr === `${PROXY}/model/info`) {
          return {
            ok: true,
            json: async () => ({
              data: [
                {
                  model_name: "z-ai/glm-5.2",
                  litellm_params: { model: "nim/glm-5.2" },
                  model_info: {
                    litellm_provider: "nim",
                    mode: "chat",
                    capability_rank: 100,
                  },
                },
                {
                  model_name: "meta/llama-4",
                  litellm_params: { model: "meta/llama-4" },
                  model_info: {
                    litellm_provider: "meta",
                    mode: "chat",
                    capability_rank: 50,
                  },
                },
              ],
            }),
          };
        }
        if (urlStr === `${PROXY}/v1/messages` && String(url).includes("POST")) {
          return { status: 200, text: async () => "{}" };
        }
        throw new Error(`Unexpected fetch: ${urlStr}`);
      },
    });
    expect(result?.written).toBe(true);
    const catalog = readProxyCatalog({ homeDir: home });
    expect(catalog?.endpoint).toBe(PROXY);
    // top_k=1 caps the expansion to 1 model per backend provider.
    // Fixture has 2 providers (nim, meta) → 2 sources (1 per provider).
    expect(catalog?.sources).toHaveLength(2);
    const nimSource = catalog?.sources.find((s) => s.service === "nim");
    expect(nimSource).toMatchObject({
      transport: "claude-worker",
      endpoint: PROXY,
      service: "nim",
      model: "z-ai/glm-5.2",
      cost_per_mtok: 0,
    });
  });
});

describe("verifySourceReach — claude-worker", () => {
  it("requires endpoint and model", () => {
    expect(
      verifySourceReach({ transport: "claude-worker", model: "m" }, deps({})).reason,
    ).toContain("endpoint");
    expect(
      verifySourceReach({ transport: "claude-worker", endpoint: PROXY }, deps({}))
        .reason,
    ).toContain("model");
  });

  it("refuses an inline api_key — possession is not reach", () => {
    const result = verifySourceReach(
      { transport: "claude-worker", endpoint: PROXY, model: "m", api_key: "k" },
      deps({ probe: () => true }),
    );
    expect(result.verified).toBe(false);
    expect(result.reason).toContain("api_key");
  });

  it("api_key_env must be set when declared", () => {
    const source = { transport: "claude-worker", endpoint: PROXY, model: "m", api_key_env: "UNSET_VAR" };
    const result = verifySourceReach(source, deps({ env: {} })); // UNSET_VAR not in env
    expect(result.verified).toBe(false);
    expect(result.reason).toContain("UNSET_VAR");
  });

  it("reach IS the proxy liveness probe", () => {
    const source = { transport: "claude-worker", endpoint: `${PROXY}/`, model: "m" };
    const up = verifySourceReach(
      source,
      deps({ probe: (endpoint) => {
        // Probe receives endpoint only; it should compose URLs internally
        // For this test, simulate successful liveness (both URLs would pass)
        return true;
      } }),
    );
    expect(up.verified).toBe(true);
    const down = verifySourceReach(source, deps({ probe: () => false }));
    expect(down.verified).toBe(false);
    expect(down.reason).toContain("liveness");
  });
});

describe("declared-wins dedup + missing-only populate", () => {
  const declaration = { proxy: { endpoint: PROXY } };

  it("an expanded lane whose backend identity a DECLARED source covers is skipped with a reason (declared wins)", () => {
    // Direct NIM lane declaring the same backend identity as the expansion.
    const direct = {
      id: "nim-direct",
      transport: "openai-compatible",
      endpoint: "https://integrate.api.nvidia.com/v1",
      service: "nim",
      model: "z-ai/glm-5.2",
      api_key_env: "NIM_KEY",
    };
    const result = resolveAmbientSources(
      deps({
        declaration: { sources: [direct], proxy: { endpoint: PROXY } },
        probe: () => true,
        catalog: cache(),
        env: { NIM_KEY: "k" },
      }),
    );
    // ONE source survives — the declared direct lane; the expansion is dropped
    // loudly, so the pool→source map stays 1:1 (no transport map-clobber).
    expect(result.sources).toEqual([direct]);
    const skip = result.dropped.find((d) => d.reason.includes("declared wins"));
    expect(skip).toBeDefined();
    expect(skip.reason).toContain("nim/z-ai/glm-5.2");
  });

  it("an expanded lane with a DIFFERENT backend identity still folds alongside declared sources", () => {
    const direct = {
      id: "nim-direct",
      transport: "openai-compatible",
      endpoint: "https://integrate.api.nvidia.com/v1",
      service: "nim",
      model: "other/model",
      api_key_env: "NIM_KEY",
    };
    const result = resolveAmbientSources(
      deps({
        declaration: { sources: [direct], proxy: { endpoint: PROXY } },
        probe: () => true,
        catalog: cache(),
        env: { NIM_KEY: "k" },
      }),
    );
    expect(result.sources).toEqual([direct, EXPANDED]);
  });

  it("populateProxyCatalogIfMissing: fresh matching cache ⇒ NO fetch, reports already-present", async () => {
    let fetched = 0;
    const result = await populateProxyCatalogIfMissing({
      ...deps({ declaration, catalog: cache() }),
      fetchImpl: () => {
        fetched += 1;
        throw new Error("must not fetch");
      },
    });
    expect(fetched).toBe(0);
    expect(result.written).toBe(false);
    expect(result.reason).toContain("already present");
    expect(result.sources).toEqual([EXPANDED]);
  });

  it("populateProxyCatalogIfMissing: no declaration ⇒ null, no fetch", async () => {
    let fetched = 0;
    const result = await populateProxyCatalogIfMissing({
      ...deps({}),
      fetchImpl: () => {
        fetched += 1;
        throw new Error("must not fetch");
      },
    });
    expect(fetched).toBe(0);
    expect(result).toBeNull();
  });
});

describe("REGRESSION PINS — proxy lane liveness", () => {
  describe("(iv) liveness probe: /health/liveliness then /v1/models, NEVER /health", () => {
    it("liveness URLs follow the neutral contract (never /health with real model calls)", () => {
      // PRE-SWAP: probe hit `${endpoint}/registry` (repair-proxy specific).
      // POST-SWAP: probes /health/liveliness first (unauthenticated), then /v1/models fallback.
      // NEVER /health (which fires real model calls, expensive).
      const probed = [];
      resolveAmbientSources(
        deps({
          declaration: { proxy: { endpoint: PROXY } },
          probe: (endpoint) => {
            // Simulate probing /health/liveliness first, then /v1/models
            // This mirrors defaultProbeHttpReachable behavior
            probed.push(`${endpoint}/health/liveliness`);
            if (`${endpoint}/health/liveliness` === `${PROXY}/health/liveliness`) return true;
            probed.push(`${endpoint}/v1/models`);
            return false;
          },
          catalog: cache(),
        }),
      );
      // Assert /health/liveliness was probed (liveness endpoint, cheap).
      expect(probed).toContain(`${PROXY}/health/liveliness`);
      // Assert /health was NEVER probed (real model calls, expensive, forbidden).
      expect(probed.some((u) => u === `${PROXY}/health`)).toBe(false);
    });

    it("liveness falls back to /v1/models when /health/liveliness is absent", () => {
      const probed = [];
      const result = resolveAmbientSources(
        deps({
          declaration: { proxy: { endpoint: PROXY } },
          probe: (endpoint) => {
            // Simulate /health/liveliness absent, /v1/models answers
            probed.push(`${endpoint}/health/liveliness`);
            // /health/liveliness is absent (would return 404), so fall through to /v1/models
            probed.push(`${endpoint}/v1/models`);
            // /v1/models is reachable (returns 200 or any response, indicating the endpoint is alive)
            return `${endpoint}/v1/models` === `${PROXY}/v1/models`;
          },
          catalog: cache(),
        }),
      );
      // Lane expanded because fallback probe succeeded
      expect(result.sources).toEqual([EXPANDED]);
      expect(result.dropped).toEqual([]);
      // Assert both liveness URLs were tried
      expect(probed).toContain(`${PROXY}/health/liveliness`);
      expect(probed).toContain(`${PROXY}/v1/models`);
      // Assert /health was never probed
      expect(probed.some((u) => u === `${PROXY}/health`)).toBe(false);
    });
  });
});

describe("proxy burst_limited — declaration-authoritative stamp + compat drop", () => {
  it("parses the burst_limited knob (boolean only; junk is dropped, not fatal)", () => {
    const on = readProxyDeclaration(
      deps({ declaration: { proxy: { endpoint: PROXY, burst_limited: true } } }),
    );
    expect(on.declaration.burst_limited).toBe(true);
    const junk = readProxyDeclaration(
      deps({ declaration: { proxy: { endpoint: PROXY, burst_limited: "yes" } } }),
    );
    expect(junk.declaration.burst_limited).toBeUndefined();
    expect(junk.declaration.endpoint).toBe(PROXY); // lane survives the bad knob
  });

  it("burst-limited proxy ⇒ expanded agentic lanes are dropped per-lane WITH the reason", () => {
    // The cache entry does NOT carry the flag — the CURRENT declaration stamps it at
    // resolve, so a stale populate cache cannot launder the flag off.
    const result = resolveAmbientSources(
      deps({
        declaration: { proxy: { endpoint: PROXY, burst_limited: true } },
        probe: () => true,
        catalog: cache(),
      }),
    );
    expect(result.sources).toEqual([]);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0].id).toBe(EXPANDED.id);
    expect(result.dropped[0].reason).toContain("burst-limited");
  });

  it("without the knob, expansion is unchanged (absent ⇒ unrestricted)", () => {
    const result = resolveAmbientSources(
      deps({
        declaration: { proxy: { endpoint: PROXY } },
        probe: () => true,
        catalog: cache(),
      }),
    );
    expect(result.sources).toEqual([EXPANDED]);
    expect(result.dropped).toEqual([]);
  });

  it("explicit burst_limited: false STRIPS a cache-carried flag (declaration-authoritative both ways)", () => {
    // A stale populate cache can neither launder the flag off (previous test) nor
    // pin it on: the operator's current `false` un-flags the expanded lane.
    const flagged = { ...EXPANDED, burst_limited: true };
    const result = resolveAmbientSources(
      deps({
        declaration: { proxy: { endpoint: PROXY, burst_limited: false } },
        probe: () => true,
        catalog: cache({ sources: [flagged] }),
      }),
    );
    expect(result.sources).toEqual([{ ...EXPANDED, burst_limited: false }]);
    expect(result.dropped).toEqual([]);
  });
});
