/**
 * RESOLVE half of the repair-proxy lane (commit 3a): a declared `repair_proxy`
 * whose injectable liveness probe passes expands from the POPULATE CACHE — never a
 * mid-resolve fetch. Every non-expanded outcome lands in `dropped[]` with a reason
 * (fail-open, lane dropped — the owner decision in the plan). Also covers
 * `readRepairProxyDeclaration` tolerance and `verifySourceReach`'s claude-worker
 * case. Plan: docs/reviews/commit3-proxy-kind1-transport-plan-2026-07-16.md.
 */

import { describe, expect, it } from "vitest";

const {
  readRepairProxyDeclaration,
  resolveAmbientSources,
  verifySourceReach,
} = await import("../../src/shared/providers/auditorSources.ts");

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
