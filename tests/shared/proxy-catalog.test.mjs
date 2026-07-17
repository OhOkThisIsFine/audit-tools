/**
 * POPULATE half of the repair-proxy lane (commit 3a): `populateProxyCatalog` fetches
 * `GET <proxy>/registry`, expands the reachable+keyed backends' top-K models into
 * `claude-worker` sources, and writes the machine-level cache `readProxyCatalog`
 * later reads (resolve NEVER fetches). Registry tolerance: malformed entries are
 * filtered, never thrown. Cost precedence: declared `cost_per_mtok` > registry price
 * > absent. Plan: docs/reviews/commit3-proxy-kind1-transport-plan-2026-07-16.md.
 */

import { afterEach, describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";

const {
  DEFAULT_PROXY_TOP_K,
  populateProxyCatalog,
  readProxyCatalog,
  resolveProxyCatalogPath,
} = await import("../../src/shared/providers/proxyCatalog.ts");

const PROXY = "http://127.0.0.1:8791";

const tmpDirs = [];
afterEach(() => {
  while (tmpDirs.length) {
    try {
      rmSync(tmpDirs.pop(), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});
function tempHome() {
  const dir = mkdtempSync(join(tmpdir(), "proxy-catalog-"));
  tmpDirs.push(dir);
  return dir;
}

/** A fetchImpl serving one JSON payload for `GET <PROXY>/registry`. */
function registryFetch(payload, { status = 200 } = {}) {
  return async (url) => {
    expect(String(url)).toBe(`${PROXY}/registry`);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
    };
  };
}

const NIM_A = { provider: "nim", model: "z-ai/glm-5.2", score: 0.9, has_key: true, reachable: true };
const NIM_B = { provider: "nim", model: "meta/llama-4", score: 0.7, has_key: true, reachable: true, price_per_mtok: 0.4 };

describe("populateProxyCatalog — expansion", () => {
  it("expands reachable+keyed entries into claude-worker sources and writes the cache", async () => {
    const homeDir = tempHome();
    const result = await populateProxyCatalog({
      endpoint: PROXY,
      homeDir,
      fetchImpl: registryFetch([NIM_A, NIM_B]),
    });
    expect(result.written).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(result.sources).toHaveLength(2);
    const [first] = result.sources;
    // Shape per the plan's identity section: transport never enters the identity.
    expect(first).toMatchObject({
      provider: "claude-worker",
      endpoint: PROXY,
      backend_provider: "nim",
      model: "z-ai/glm-5.2", // score 0.9 ranks first
      worker_kind: "agentic",
    });
    // Roundtrip through the reader: entries + fetched_at (no TTL enforcement).
    const catalog = readProxyCatalog({ homeDir });
    expect(catalog).not.toBeNull();
    expect(catalog.endpoint).toBe(PROXY);
    expect(Number.isNaN(Date.parse(catalog.fetched_at))).toBe(false);
    expect(catalog.sources).toEqual(result.sources);
  });

  it("filters malformed / unreachable / keyless entries, never throws", async () => {
    const result = await populateProxyCatalog({
      endpoint: PROXY,
      homeDir: tempHome(),
      fetchImpl: registryFetch([
        NIM_A,
        { provider: "nim", model: "dead/model", has_key: true, reachable: false },
        { provider: "nim", model: "keyless/model", has_key: false, reachable: true },
        { provider: "", model: "no-provider", has_key: true, reachable: true },
        { provider: "nim", model: 42, has_key: true, reachable: true },
        "not-an-object",
        null,
      ]),
    });
    expect(result.sources.map((s) => s.model)).toEqual(["z-ai/glm-5.2"]);
  });

  it("caps at top-K per backend provider, best score first (unscored last)", async () => {
    const entries = [
      { provider: "nim", model: "m-low", score: 0.1, has_key: true, reachable: true },
      NIM_A,
      NIM_B,
      { provider: "nim", model: "m-unscored", has_key: true, reachable: true },
      { provider: "openrouter", model: "only-one", score: 0.5, has_key: true, reachable: true },
    ];
    const result = await populateProxyCatalog({
      endpoint: PROXY,
      homeDir: tempHome(),
      topK: 2,
      fetchImpl: registryFetch(entries),
    });
    // 2 per provider max; nim keeps its two best scores, openrouter keeps its one.
    expect(result.sources.map((s) => s.model)).toEqual([
      "z-ai/glm-5.2",
      "meta/llama-4",
      "only-one",
    ]);
    expect(DEFAULT_PROXY_TOP_K).toBeGreaterThan(0); // the default cap exists and is small
  });

  it("cost precedence: declared cost_per_mtok > registry price > absent", async () => {
    const declared = await populateProxyCatalog({
      endpoint: PROXY,
      homeDir: tempHome(),
      costPerMtok: 0,
      fetchImpl: registryFetch([NIM_A, NIM_B]),
    });
    // Declared (the free-to-operator axis) wins over the registry list price.
    expect(declared.sources.map((s) => s.cost_per_mtok)).toEqual([0, 0]);

    const fromRegistry = await populateProxyCatalog({
      endpoint: PROXY,
      homeDir: tempHome(),
      fetchImpl: registryFetch([NIM_A, NIM_B]),
    });
    const byModel = Object.fromEntries(
      fromRegistry.sources.map((s) => [s.model, s.cost_per_mtok]),
    );
    expect(byModel["meta/llama-4"]).toBe(0.4); // registry price fallback
    expect(byModel["z-ai/glm-5.2"]).toBeUndefined(); // no price anywhere → absent
  });

  it("tolerates a provider-grouped registry shape", async () => {
    const result = await populateProxyCatalog({
      endpoint: PROXY,
      homeDir: tempHome(),
      fetchImpl: registryFetch({
        providers: [
          {
            name: "nim",
            has_key: true,
            reachable: true,
            models: [{ id: "z-ai/glm-5.2", score: 0.9 }, "meta/llama-4"],
          },
        ],
      }),
    });
    expect(result.sources.map((s) => s.model).sort()).toEqual([
      "meta/llama-4",
      "z-ai/glm-5.2",
    ]);
  });

  it("strips a trailing slash from the endpoint before composing the url + sources", async () => {
    const result = await populateProxyCatalog({
      endpoint: `${PROXY}/`,
      homeDir: tempHome(),
      fetchImpl: registryFetch([NIM_A]),
    });
    expect(result.sources[0].endpoint).toBe(PROXY);
  });
});

describe("populateProxyCatalog — degrade, never throw", () => {
  it("a failed fetch returns written:false with a reason (prior cache untouched)", async () => {
    const homeDir = tempHome();
    await populateProxyCatalog({ endpoint: PROXY, homeDir, fetchImpl: registryFetch([NIM_A]) });
    const result = await populateProxyCatalog({
      endpoint: PROXY,
      homeDir,
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    expect(result.written).toBe(false);
    expect(result.reason).toContain("ECONNREFUSED");
    // The earlier good cache survives a failed refresh.
    expect(readProxyCatalog({ homeDir })?.sources).toHaveLength(1);
  });

  it("a non-2xx response returns written:false with the status", async () => {
    const result = await populateProxyCatalog({
      endpoint: PROXY,
      homeDir: tempHome(),
      fetchImpl: registryFetch({}, { status: 503 }),
    });
    expect(result.written).toBe(false);
    expect(result.reason).toContain("503");
  });

  it("an empty/unrecognizable registry WRITES an empty expansion (fresh knowledge)", async () => {
    const homeDir = tempHome();
    const result = await populateProxyCatalog({
      endpoint: PROXY,
      homeDir,
      fetchImpl: registryFetch({ nothing: "here" }),
    });
    expect(result.written).toBe(true);
    expect(result.sources).toEqual([]);
    expect(readProxyCatalog({ homeDir })?.sources).toEqual([]);
  });
});

describe("readProxyCatalog — degrades to null, never throws", () => {
  it("returns null when the cache is absent", () => {
    expect(readProxyCatalog({ homeDir: tempHome() })).toBeNull();
  });

  it("returns null on malformed JSON / wrong shape / missing fetched_at", () => {
    const homeDir = tempHome();
    const path = resolveProxyCatalogPath(homeDir);
    mkdirSync(join(homeDir, ".audit-code"), { recursive: true });
    for (const raw of [
      "{not json",
      JSON.stringify([]),
      JSON.stringify({ endpoint: PROXY, sources: [] }), // no fetched_at
      JSON.stringify({ fetched_at: "t", endpoint: PROXY, sources: "nope" }),
    ]) {
      writeFileSync(path, raw);
      expect(readProxyCatalog({ homeDir }), raw).toBeNull();
    }
  });

  it("returns null when a cached source fails the shared validator", () => {
    const homeDir = tempHome();
    mkdirSync(join(homeDir, ".audit-code"), { recursive: true });
    writeFileSync(
      resolveProxyCatalogPath(homeDir),
      JSON.stringify({
        fetched_at: new Date().toISOString(),
        endpoint: PROXY,
        // claude-worker without endpoint/model — must not be admitted half-checked.
        sources: [{ provider: "claude-worker", backend_provider: "nim" }],
      }),
    );
    expect(readProxyCatalog({ homeDir })).toBeNull();
  });

  it("the cache filename is the plain machine-level catalog-cache.json", () => {
    // Ambient callers have no auditor id, so the reserved `catalog-<auditor-id>.json`
    // form is NOT used (see the rationale in proxyCatalog.ts).
    expect(resolveProxyCatalogPath("/home/test").replaceAll("\\", "/")).toBe(
      "/home/test/.audit-code/catalog-cache.json",
    );
  });

  it("populate writes valid JSON on disk (spot-check the raw file)", async () => {
    const homeDir = tempHome();
    await populateProxyCatalog({ endpoint: PROXY, homeDir, fetchImpl: registryFetch([NIM_A]) });
    const raw = JSON.parse(readFileSync(resolveProxyCatalogPath(homeDir), "utf8"));
    expect(raw.endpoint).toBe(PROXY);
    expect(raw.sources[0].provider).toBe("claude-worker");
  });
});
