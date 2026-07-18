/**
 * RESOLVE half of the repair-proxy lane (commit 3a): a declared `repair_proxy`
 * whose injectable liveness probe passes expands from the POPULATE CACHE — never a
 * mid-resolve fetch. Every non-expanded outcome lands in `dropped[]` with a reason
 * (fail-open, lane dropped — the owner decision in the plan). Also covers
 * `readRepairProxyDeclaration` tolerance and `verifySourceReach`'s claude-worker
 * case. Plan: docs/reviews/commit3-proxy-kind1-transport-plan-2026-07-16.md.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  populateDeclaredProxyCatalog,
  populateProxyCatalogIfMissing,
  readRepairProxyDeclaration,
  resolveAmbientSources,
  verifySourceReach,
} = await import("../../src/shared/providers/auditorSources.ts");
const { readProxyCatalog } = await import(
  "../../src/shared/providers/proxyCatalog.ts"
);

const PROXY = "http://127.0.0.1:8791";

/** An expanded claude-worker source as the populate cache stores it. */
const EXPANDED = {
  id: "claude-worker:nim/z-ai/glm-5.2",
  provider: "claude-worker",
  endpoint: PROXY,
  backend_provider: "nim",
  model: "z-ai/glm-5.2",
  worker_kind: "agentic",
  cost_per_mtok: 0,
};

/** A valid populate cache body. */
function cache({ endpoint = PROXY, sources = [EXPANDED] } = {}) {
  return JSON.stringify({ fetched_at: new Date().toISOString(), endpoint, sources });
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

describe("readRepairProxyDeclaration — tolerant shape", () => {
  it("is absent (no reason) when the file or the key is missing", () => {
    expect(readRepairProxyDeclaration(deps({}))).toEqual({ declaration: null });
    expect(readRepairProxyDeclaration(deps({ declaration: { sources: [] } }))).toEqual({
      declaration: null,
    });
  });

  it("a present-but-malformed block degrades to lane-absent WITH a reason", () => {
    for (const bad of ["yes", 1, [], { endpoint: 42 }, { endpoint: "  " }, {}]) {
      const result = readRepairProxyDeclaration(
        deps({ declaration: { repair_proxy: bad } }),
      );
      expect(result.declaration, JSON.stringify(bad)).toBeNull();
      expect(result.reason, JSON.stringify(bad)).toContain("repair_proxy");
    }
  });

  it("parses endpoint + optional knobs; trailing slash normalized", () => {
    const result = readRepairProxyDeclaration(
      deps({
        declaration: {
          repair_proxy: { endpoint: `${PROXY}/`, top_k: 5, cost_per_mtok: 0 },
        },
      }),
    );
    expect(result).toEqual({
      declaration: { endpoint: PROXY, top_k: 5, cost_per_mtok: 0 },
    });
  });

  it("a malformed optional knob is dropped WITHOUT costing the lane", () => {
    const result = readRepairProxyDeclaration(
      deps({
        declaration: {
          repair_proxy: { endpoint: PROXY, top_k: "many", cost_per_mtok: -1 },
        },
      }),
    );
    expect(result.declaration).toEqual({ endpoint: PROXY });
  });
});

describe("resolveAmbientSources — the repair-proxy lane", () => {
  const declaration = { repair_proxy: { endpoint: PROXY } };

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
    // The probe hits the registry endpoint (a liveness check, not a fetch).
    expect(probed).toEqual([`${PROXY}/registry`]);
  });

  it("reachable + NO cache ⇒ lane unexpanded, with a run-populate reason", () => {
    const result = resolveAmbientSources(
      deps({ declaration, probe: () => true, catalog: null }),
    );
    expect(result.sources).toEqual([]);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0].id).toBe(`repair-proxy:${PROXY}`);
    expect(result.dropped[0].reason).toContain("populate");
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

  it("a malformed repair_proxy block is dropped with its parse reason", () => {
    const result = resolveAmbientSources(
      deps({ declaration: { repair_proxy: { endpoint: 42 } } }),
    );
    expect(result.dropped).toEqual([
      { id: "repair-proxy", reason: expect.stringContaining("endpoint") },
    ]);
  });

  it("no repair_proxy declared ⇒ no lane, no drop (byte-identical to before 3a)", () => {
    const result = resolveAmbientSources(deps({ declaration: { sources: [] } }));
    expect(result.sources).toEqual([]);
    expect(result.dropped).toEqual([]);
  });

  it("the lane composes with declared sources[] (both halves resolve)", () => {
    const nim = {
      id: "nim",
      provider: "openai-compatible",
      endpoint: "http://nim/v1",
      model: "m",
      api_key_env: "NVIDIA_API_KEY",
    };
    const result = resolveAmbientSources(
      deps({
        declaration: { sources: [nim], repair_proxy: { endpoint: PROXY } },
        probe: () => true,
        catalog: cache(),
        env: { NVIDIA_API_KEY: "k" },
      }),
    );
    expect(result.sources.map((s) => s.id)).toEqual([
      "nim",
      "claude-worker:nim/z-ai/glm-5.2",
    ]);
  });
});

describe("populateDeclaredProxyCatalog — the Gate-0 POPULATE trigger (3c)", () => {
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
  /** A minimal registry payload with two reachable+keyed nim models. */
  const REGISTRY = [
    { provider: "nim", model: "z-ai/glm-5.2", reachable: true, has_key: true, score: 9 },
    { provider: "nim", model: "meta/llama-4", reachable: true, has_key: true, score: 5 },
  ];
  const okFetch = async () => ({ ok: true, json: async () => REGISTRY });

  it("a registry capability block stamps capability_rank onto the expanded source (step C, proxy-agnostic)", async () => {
    // The capability data is best-effort: composite_rank (LOWER = better) stamps
    // through so the admission floor reads per-model capability with no operator
    // declaration. A registry with no capability block (e.g. LiteLLM) emits no
    // field — the floor then fails open, by design.
    const home = tmpHome();
    const result = await populateDeclaredProxyCatalog({
      ...deps({ declaration: { repair_proxy: { endpoint: PROXY, cost_per_mtok: 0 } } }),
      homeDir: home,
      fetchImpl: async () => ({
        ok: true,
        json: async () => [
          {
            provider: "groq", model: "strong-model", reachable: true, has_key: true,
            capability: { composite_rank: 3, arena_rating: 1400 },
          },
          { provider: "groq", model: "unscored-model", reachable: true, has_key: true },
        ],
      }),
    });
    expect(result?.written).toBe(true);
    const sources = readProxyCatalog({ homeDir: home })?.sources ?? [];
    const strong = sources.find((s) => s.model === "strong-model");
    const unscored = sources.find((s) => s.model === "unscored-model");
    expect(strong?.capability_rank).toBe(3);
    expect(unscored ? "capability_rank" in unscored : null).toBe(false);
  });

  it("no repair_proxy declared ⇒ null, and the network is never touched", async () => {
    let fetched = 0;
    const result = await populateDeclaredProxyCatalog({
      ...deps({ declaration: { sources: [] } }),
      fetchImpl: async () => {
        fetched += 1;
        return { ok: true, json: async () => [] };
      },
    });
    expect(result).toBeNull();
    expect(fetched).toBe(0);
  });

  it("declared + fetch failure ⇒ degrade with a reason, never a throw, prior cache untouched", async () => {
    const home = tmpHome();
    const result = await populateDeclaredProxyCatalog({
      ...deps({ declaration: { repair_proxy: { endpoint: PROXY } } }),
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
      ...deps({ declaration: { repair_proxy: { endpoint: PROXY } } }),
      homeDir: tmpHome(),
      fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
    });
    expect(result?.written).toBe(false);
    expect(result?.reason).toContain("503");
  });

  it("declared + reachable registry ⇒ writes the cache the RESOLVE half then reads", async () => {
    const home = tmpHome();
    const result = await populateDeclaredProxyCatalog({
      ...deps({
        declaration: { repair_proxy: { endpoint: PROXY, top_k: 1, cost_per_mtok: 0 } },
      }),
      homeDir: home,
      fetchImpl: okFetch,
    });
    expect(result?.written).toBe(true);
    const catalog = readProxyCatalog({ homeDir: home });
    expect(catalog?.endpoint).toBe(PROXY);
    // top_k=1 caps the expansion to the best-scored nim model; the declared
    // cost_per_mtok (free-to-operator axis) wins over any registry price.
    expect(catalog?.sources).toEqual([
      {
        id: "claude-worker:nim/z-ai/glm-5.2",
        provider: "claude-worker",
        endpoint: PROXY,
        backend_provider: "nim",
        model: "z-ai/glm-5.2",
        worker_kind: "agentic",
        cost_per_mtok: 0,
      },
    ]);
  });
});

describe("verifySourceReach — claude-worker", () => {
  it("requires endpoint and model", () => {
    expect(
      verifySourceReach({ provider: "claude-worker", model: "m" }, deps({})).reason,
    ).toContain("endpoint");
    expect(
      verifySourceReach({ provider: "claude-worker", endpoint: PROXY }, deps({}))
        .reason,
    ).toContain("model");
  });

  it("refuses an inline api_key — possession is not reach", () => {
    const result = verifySourceReach(
      { provider: "claude-worker", endpoint: PROXY, model: "m", api_key: "k" },
      deps({ probe: () => true }),
    );
    expect(result.verified).toBe(false);
    expect(result.reason).toContain("api_key");
  });

  it("reach IS the proxy liveness probe", () => {
    const source = { provider: "claude-worker", endpoint: `${PROXY}/`, model: "m" };
    const up = verifySourceReach(
      source,
      deps({ probe: (url) => url === `${PROXY}/registry` }),
    );
    expect(up.verified).toBe(true);
    const down = verifySourceReach(source, deps({ probe: () => false }));
    expect(down.verified).toBe(false);
    expect(down.reason).toContain("liveness");
  });
});

describe("declared-wins dedup + missing-only populate (3c MUST-FIX round)", () => {
  const declaration = { repair_proxy: { endpoint: PROXY } };

  it("an expanded lane whose backend identity a DECLARED source covers is skipped with a reason (declared wins)", () => {
    // Direct NIM lane declaring the same backend identity as the expansion.
    const direct = {
      id: "nim-direct",
      provider: "openai-compatible",
      endpoint: "https://integrate.api.nvidia.com/v1",
      backend_provider: "nim",
      model: "z-ai/glm-5.2",
      api_key_env: "NIM_KEY",
    };
    const result = resolveAmbientSources(
      deps({
        declaration: { sources: [direct], repair_proxy: { endpoint: PROXY } },
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
      provider: "openai-compatible",
      endpoint: "https://integrate.api.nvidia.com/v1",
      backend_provider: "nim",
      model: "other/model",
      api_key_env: "NIM_KEY",
    };
    const result = resolveAmbientSources(
      deps({
        declaration: { sources: [direct], repair_proxy: { endpoint: PROXY } },
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
