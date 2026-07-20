/**
 * POPULATE half of the neutral proxy lane: `populateProxyCatalog` fetches
 * `GET <proxy>/v1/models` (roster) + `GET <proxy>/model/info` (enrichment),
 * expands into `claude-worker` sources via the edge shape adapter, and writes
 * the machine-level cache `readProxyCatalog` later reads (resolve NEVER fetches).
 * Discovery tolerance: malformed entries are filtered, never thrown. Cost
 * precedence: declared `cost_per_mtok` > advert price > absent. Liveness probe:
 * `/v1/messages` per model, dropping 404/unavailable. Plan section h.
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
  POPULATE_PROBE_TIMEOUT_MS,
  POPULATE_PROBE_CONCURRENCY,
  POPULATE_CACHE_FRESH_TTL_MS,
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

/**
 * A fetchImpl serving the neutral contract endpoints: `/v1/models` roster
 * and `/model/info` enrichment (array form only — legacy map form is deleted).
 * Fixtures are from the recon surfaces doc.
 */
function neutralContractFetch(
  { roster = [], modelInfo = null } = {},
  { probeHandler } = {},
) {
  return async (url, options) => {
    const urlStr = String(url);
    // GET /v1/models — OpenAI-compatible roster (required baseline)
    if (urlStr === `${PROXY}/v1/models`) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: roster, object: "list" }),
      };
    }
    // GET /model/info — LiteLLM enrichment (optional, array form only)
    if (urlStr === `${PROXY}/model/info`) {
      if (modelInfo === null) {
        return { ok: false, status: 404, json: async () => ({}) };
      }
      // Current array form only: {data: [...]}
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: modelInfo }),
      };
    }
    // POST /v1/messages — model probe
    if (urlStr === `${PROXY}/v1/messages` && options?.method === "POST") {
      if (probeHandler) {
        return probeHandler(options);
      }
      // Default probe handler: return 200 OK
      return { status: 200, text: async () => "{}" };
    }
    throw new Error(`Unexpected request: ${urlStr}`);
  };
}

/**
 * Fixtures from the recon surfaces doc (verbatim example responses from
 * LiteLLM docs / BerriAI source). These test the edge adapter against
 * documented shapes, not invented test doubles.
 */
const V1_MODELS_ROSTER = [
  { id: "gpt-4", object: "model", created: 1677610602, owned_by: "openai" },
  { id: "xai/grok-2-1212", object: "model", created: 1677610602, owned_by: "openai" },
  { id: "claude-sonnet-4-6", object: "model", created: 1677610602, owned_by: "openai" },
];

const MODEL_INFO_ARRAY = [
  {
    model_name: "gpt-4",
    litellm_params: { model: "openai/gpt-4" },
    model_info: {
      id: "e889baacd17f591cce4c63639275ba5e8dc60765d6c553e6ee5a504b19e50ddc",
      db_model: false,
      key: "gpt-4",
      max_input_tokens: 8192,
      input_cost_per_token: 3e-05,
      output_cost_per_token: 6e-05,
      litellm_provider: "openai",
      mode: "chat",
    },
  },
  {
    model_name: "claude-sonnet-4-6",
    litellm_params: { model: "anthropic/claude-sonnet-4-6" },
    model_info: {
      db_model: false,
      key: "claude-sonnet",
      max_input_tokens: 200000,
      input_cost_per_token: 3e-06,
      output_cost_per_token: 15e-06,
      litellm_provider: "anthropic",
      mode: "chat",
      capability_rank: 50, // operator-declared rank via advert custom key
    },
  },
];

describe("populateProxyCatalog — discovery contract", () => {
  it("discovers roster via /v1/models and enriches via /model/info (array form)", async () => {
    const homeDir = tempHome();
    const result = await populateProxyCatalog({
      endpoint: PROXY,
      homeDir,
      fetchImpl: neutralContractFetch({
        roster: V1_MODELS_ROSTER,
        modelInfo: MODEL_INFO_ARRAY,
      }),
    });
    expect(result.written).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(result.dropped).toEqual([]);
    expect(result.sources).toHaveLength(3);
    // Discover by alias: roster id becomes the model name, enriched by model_name join
    const byAlias = Object.fromEntries(
      result.sources.map((s) => [s.model, s]),
    );
    expect(byAlias["gpt-4"]).toMatchObject({
      transport: "claude-worker",
      endpoint: PROXY,
      service: "openai",
      model: "gpt-4", // Alias VERBATIM (plan §e, regression pin i)
      worker_kind: "agentic",
      cost_per_mtok: (3e-05 + 6e-05) / 2, // cost blend = mean
      quota: { context_tokens: 8192 },
    });
    expect(byAlias["claude-sonnet-4-6"]).toMatchObject({
      service: "anthropic",
      capability_rank: 50, // advert custom key round-trips
    });
    // Roundtrip through the reader
    const catalog = readProxyCatalog({ homeDir });
    expect(catalog).not.toBeNull();
    expect(catalog.endpoint).toBe(PROXY);
    expect(Number.isNaN(Date.parse(catalog.fetched_at))).toBe(false);
    expect(catalog.sources).toEqual(result.sources);
  });

  it("degrades to roster-only when /model/info is absent (404)", async () => {
    // When /model/info returns 404, discover falls back to roster only (no enrichment).
    // Provider derivation: slash-prefix > "proxy" (default shared bucket).
    const homeDir = tempHome();
    const result = await populateProxyCatalog({
      endpoint: PROXY,
      homeDir,
      fetchImpl: neutralContractFetch({
        roster: V1_MODELS_ROSTER,
        modelInfo: null, // 404
      }),
    });
    expect(result.written).toBe(true);
    expect(result.dropped).toEqual([]);
    expect(result.sources).toHaveLength(3);
    // Without enrichment: provider derived from slash-prefix or "proxy"
    const xai = result.sources.find((s) => s.model === "xai/grok-2-1212");
    expect(xai).toMatchObject({
      service: "xai", // prefix before first /
      model: "xai/grok-2-1212",
    });
    // Roster-only models have no enrichment fields
    expect(xai.quota).toBeUndefined();
    expect(xai.cost_per_mtok).toBeUndefined();
    const unslashed = result.sources.find((s) => s.model === "claude-sonnet-4-6");
    expect(unslashed).toMatchObject({
      service: "proxy", // default shared bucket, owner decision
      model: "claude-sonnet-4-6",
    });
  });

  it("eligibility filter: mode != 'chat' → skip; supports_tool_calls === false → skip", async () => {
    // Models unsuitable for agentic workers are excluded at discovery time.
    const modelInfo = [
      {
        model_name: "chat-ok",
        litellm_params: { model: "openai/gpt" },
        model_info: { litellm_provider: "openai", mode: "chat" },
      },
      {
        model_name: "embedding-skip",
        litellm_params: { model: "openai/embed" },
        model_info: { litellm_provider: "openai", mode: "embedding" },
      },
      {
        model_name: "no-tools-skip",
        litellm_params: { model: "openai/no-tools" },
        model_info: {
          litellm_provider: "openai",
          mode: "chat",
          supports_tool_calls: false,
        },
      },
      {
        model_name: "tools-ok",
        litellm_params: { model: "openai/tools" },
        model_info: {
          litellm_provider: "openai",
          mode: "chat",
          supports_tool_calls: true,
        },
      },
      {
        model_name: "unknown-mode-ok",
        litellm_params: { model: "custom/unknown" },
        model_info: { litellm_provider: "custom" }, // mode absent = unknown ≠ incapable
      },
    ];
    const result = await populateProxyCatalog({
      endpoint: PROXY,
      homeDir: tempHome(),
      fetchImpl: neutralContractFetch({
        roster: modelInfo.map((m) => ({ id: m.model_name })),
        modelInfo,
      }),
    });
    expect(result.dropped).toEqual([]);
    expect(result.sources.map((s) => s.model).sort()).toEqual([
      "chat-ok",
      "tools-ok",
      "unknown-mode-ok",
    ]);
  });

  it("cost blend: mean of input/output when both present", async () => {
    // The plan's resolved decision: cost = (input + output) / 2
    const modelInfo = [
      {
        model_name: "both-prices",
        litellm_params: { model: "openai/both" },
        model_info: {
          litellm_provider: "openai",
          mode: "chat",
          input_cost_per_token: 2e-05,
          output_cost_per_token: 4e-05,
        },
      },
      {
        model_name: "input-only",
        litellm_params: { model: "openai/input" },
        model_info: {
          litellm_provider: "openai",
          mode: "chat",
          input_cost_per_token: 1e-05,
        },
      },
      {
        model_name: "output-only",
        litellm_params: { model: "openai/output" },
        model_info: {
          litellm_provider: "openai",
          mode: "chat",
          output_cost_per_token: 5e-05,
        },
      },
      {
        model_name: "no-price",
        litellm_params: { model: "openai/free" },
        model_info: { litellm_provider: "openai", mode: "chat" },
      },
    ];
    const result = await populateProxyCatalog({
      endpoint: PROXY,
      homeDir: tempHome(),
      topK: 10, // All 4 models must expand (default top_k=3 would truncate the 4th)
      fetchImpl: neutralContractFetch({
        roster: modelInfo.map((m) => ({ id: m.model_name })),
        modelInfo,
      }),
    });
    expect(result.dropped).toEqual([]);
    const byAlias = Object.fromEntries(
      result.sources.map((s) => [s.model, s.cost_per_mtok]),
    );
    expect(byAlias["both-prices"]).toBe((2e-05 + 4e-05) / 2);
    expect(byAlias["input-only"]).toBe(1e-05);
    expect(byAlias["output-only"]).toBe(5e-05);
    expect(byAlias["no-price"]).toBeUndefined();
  });

  it("cost precedence: declared cost_per_mtok wins over advert price", async () => {
    // The free-to-operator axis (declared cost) WINS (regression pin ii area).
    const modelInfo = [
      {
        model_name: "test-model",
        litellm_params: { model: "openai/test" },
        model_info: {
          litellm_provider: "openai",
          mode: "chat",
          input_cost_per_token: 1e-05,
          output_cost_per_token: 2e-05,
        },
      },
    ];
    const result = await populateProxyCatalog({
      endpoint: PROXY,
      homeDir: tempHome(),
      costPerMtok: 0, // Declared: free to operator
      fetchImpl: neutralContractFetch({
        roster: [{ id: "test-model" }],
        modelInfo,
      }),
    });
    expect(result.dropped).toEqual([]);
    expect(result.sources[0].cost_per_mtok).toBe(0); // declared wins
  });

  it("caps at top-K per backend provider, stable order (provider, score, alias)", async () => {
    const modelInfo = [
      {
        model_name: "anthropic-low",
        litellm_params: { model: "anthropic/low" },
        model_info: {
          litellm_provider: "anthropic",
          mode: "chat",
          capability_rank: 100,
        },
      },
      {
        model_name: "anthropic-high",
        litellm_params: { model: "anthropic/high" },
        model_info: {
          litellm_provider: "anthropic",
          mode: "chat",
          capability_rank: 10,
        },
      },
      {
        model_name: "openai-only",
        litellm_params: { model: "openai/gpt" },
        model_info: { litellm_provider: "openai", mode: "chat", capability_rank: 20 },
      },
    ];
    const result = await populateProxyCatalog({
      endpoint: PROXY,
      homeDir: tempHome(),
      topK: 1, // Only 1 per provider
      fetchImpl: neutralContractFetch({
        roster: modelInfo.map((m) => ({ id: m.model_name })),
        modelInfo,
      }),
    });
    expect(result.dropped).toEqual([]);
    // Alphabetical providers (anthropic, openai); each has top-1 by score
    expect(result.sources.map((s) => s.model)).toEqual([
      "anthropic-high", // anthropic's best (rank 10 < 100)
      "openai-only", // openai's only one
    ]);
    expect(DEFAULT_PROXY_TOP_K).toBeGreaterThan(0);
  });

  it("deduplicates by (provider, alias) — one identity, one source", async () => {
    // Without dedup the expansion would emit two identical sources for one pool identity.
    const modelInfo = [
      {
        model_name: "duplicate",
        litellm_params: { model: "openai/test" },
        model_info: { litellm_provider: "openai", mode: "chat" },
      },
    ];
    const result = await populateProxyCatalog({
      endpoint: PROXY,
      homeDir: tempHome(),
      fetchImpl: neutralContractFetch({
        roster: [{ id: "duplicate" }, { id: "duplicate" }], // Listed twice
        modelInfo,
      }),
    });
    expect(result.dropped).toEqual([]);
    expect(result.sources.map((s) => s.model)).toEqual(["duplicate"]);
  });

  it("consumed capability_rank from advert custom key", async () => {
    // Operator-declared rank via advert custom key (not a score) rides the source
    // → capability floor. The advert provides declared_rank; expansion stamps it as
    // capability_rank on the source.
    const modelInfo = [
      {
        model_name: "ranked",
        litellm_params: { model: "openai/ranked" },
        model_info: {
          litellm_provider: "openai",
          mode: "chat",
          capability_rank: 42, // Custom key (per operator setup in proxy config)
        },
      },
    ];
    const result = await populateProxyCatalog({
      endpoint: PROXY,
      homeDir: tempHome(),
      fetchImpl: neutralContractFetch({
        roster: [{ id: "ranked" }],
        modelInfo,
      }),
    });
    expect(result.dropped).toEqual([]);
    expect(result.sources[0]).toMatchObject({
      capability_rank: 42,
    });
  });

  it("strips trailing slashes from endpoint before composing url + sources", async () => {
    const result = await populateProxyCatalog({
      endpoint: `${PROXY}/`,
      homeDir: tempHome(),
      fetchImpl: neutralContractFetch({
        roster: [{ id: "test-model" }],
        modelInfo: [
          {
            model_name: "test-model",
            litellm_params: { model: "openai/test" },
            model_info: { litellm_provider: "openai", mode: "chat" },
          },
        ],
      }),
    });
    expect(result.dropped).toEqual([]);
    expect(result.sources[0].endpoint).toBe(PROXY);
  });
});

describe("populateProxyCatalog — degrade, never throw", () => {
  it("failed /v1/models fetch returns written:false with reason (prior cache untouched)", async () => {
    const homeDir = tempHome();
    // Seed a good cache first
    await populateProxyCatalog({
      endpoint: PROXY,
      homeDir,
      fetchImpl: neutralContractFetch({
        roster: [{ id: "test" }],
        modelInfo: [
          {
            model_name: "test",
            litellm_params: { model: "openai/test" },
            model_info: { litellm_provider: "openai", mode: "chat" },
          },
        ],
      }),
    });
    // Now fail the refresh (step past TTL so refresh actually attempts)
    const result = await populateProxyCatalog({
      endpoint: PROXY,
      homeDir,
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
      now: () => new Date(Date.now() + POPULATE_CACHE_FRESH_TTL_MS + 1_000),
    });
    expect(result.written).toBe(false);
    // Reason should carry the underlying error cause (ECONNREFUSED in this mock)
    expect(result.reason).toContain("failed");
    expect(result.reason).toContain("ECONNREFUSED");
    expect(result.dropped).toEqual([]);
    // Prior good cache survives
    expect(readProxyCatalog({ homeDir })?.sources).toHaveLength(1);
  });

  it("empty roster returns written:false (no models to fetch)", async () => {
    const result = await populateProxyCatalog({
      endpoint: PROXY,
      homeDir: tempHome(),
      fetchImpl: neutralContractFetch({
        roster: [],
        modelInfo: null,
      }),
    });
    expect(result.written).toBe(false);
    expect(result.reason).toContain("no models");
    expect(result.dropped).toEqual([]);
  });

  it("unparseable /v1/models (missing data[]) returns written:false", async () => {
    const result = await populateProxyCatalog({
      endpoint: PROXY,
      homeDir: tempHome(),
      fetchImpl: async (url) => {
        if (String(url).includes("/v1/models")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ not_data: "invalid" }), // Missing data[]
          };
        }
        throw new Error("unexpected");
      },
    });
    expect(result.written).toBe(false);
    expect(result.reason).toContain("no models");
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
        sources: [{ transport: "claude-worker", service: "nim" }],
      }),
    );
    expect(readProxyCatalog({ homeDir })).toBeNull();
  });

  it("the cache filename is the plain machine-level catalog-cache.json", () => {
    expect(resolveProxyCatalogPath("/home/test").replaceAll("\\", "/")).toBe(
      "/home/test/.audit-code/catalog-cache.json",
    );
  });

  it("populate writes valid JSON on disk", async () => {
    const homeDir = tempHome();
    const result = await populateProxyCatalog({
      endpoint: PROXY,
      homeDir,
      fetchImpl: neutralContractFetch({
        roster: [{ id: "test-model" }],
        modelInfo: [
          {
            model_name: "test-model",
            litellm_params: { model: "openai/test" },
            model_info: { litellm_provider: "openai", mode: "chat" },
          },
        ],
      }),
    });
    expect(result.dropped).toEqual([]);
    const raw = JSON.parse(readFileSync(resolveProxyCatalogPath(homeDir), "utf8"));
    expect(raw.endpoint).toBe(PROXY);
    expect(raw.sources[0].transport).toBe("claude-worker");
  });
});

describe("populateProxyCatalog — context-window from max_input_tokens", () => {
  it("advert max_input_tokens maps to quota.context_tokens", async () => {
    const modelInfo = [
      {
        model_name: "context-test",
        litellm_params: { model: "openai/test" },
        model_info: {
          litellm_provider: "openai",
          mode: "chat",
          max_input_tokens: 200000,
        },
      },
    ];
    const result = await populateProxyCatalog({
      endpoint: PROXY,
      homeDir: tempHome(),
      fetchImpl: neutralContractFetch({
        roster: [{ id: "context-test" }],
        modelInfo,
      }),
    });
    expect(result.dropped).toEqual([]);
    expect(result.sources[0]).toMatchObject({
      quota: { context_tokens: 200000 },
    });
  });

  it("advert without max_input_tokens has no quota", async () => {
    const modelInfo = [
      {
        model_name: "no-context",
        litellm_params: { model: "openai/test" },
        model_info: { litellm_provider: "openai", mode: "chat" },
      },
    ];
    const result = await populateProxyCatalog({
      endpoint: PROXY,
      homeDir: tempHome(),
      fetchImpl: neutralContractFetch({
        roster: [{ id: "no-context" }],
        modelInfo,
      }),
    });
    expect(result.dropped).toEqual([]);
    expect(result.sources[0].quota).toBeUndefined();
  });
});

describe("populateProxyCatalog — probe verification", () => {
  it("probe constants are exported", () => {
    expect(typeof POPULATE_PROBE_TIMEOUT_MS).toBe("number");
    expect(POPULATE_PROBE_TIMEOUT_MS).toBeGreaterThan(0);
    expect(typeof POPULATE_PROBE_CONCURRENCY).toBe("number");
    expect(POPULATE_PROBE_CONCURRENCY).toBeGreaterThan(0);
  });

  it("models probed 200 are kept; 404 dropped with reason", async () => {
    const modelInfo = [
      {
        model_name: "live-model",
        litellm_params: { model: "openai/live" },
        model_info: { litellm_provider: "openai", mode: "chat" },
      },
      {
        model_name: "dead-model",
        litellm_params: { model: "openai/dead" },
        model_info: { litellm_provider: "openai", mode: "chat" },
      },
    ];
    let probeCount = 0;
    const result = await populateProxyCatalog({
      endpoint: PROXY,
      homeDir: tempHome(),
      fetchImpl: neutralContractFetch(
        {
          roster: modelInfo.map((m) => ({ id: m.model_name })),
          modelInfo,
        },
        {
          probeHandler: (options) => {
            probeCount++;
            const body = JSON.parse(options.body);
            if (body.model === "dead-model") {
              return { status: 404, text: async () => "" };
            }
            return { status: 200, text: async () => "{}" };
          },
        },
      ),
    });
    expect(probeCount).toBe(2);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0]).toMatchObject({
      id: "claude-worker:openai/dead-model",
      reason: "HTTP 404",
    });
    expect(result.sources.map((s) => s.model)).toEqual(["live-model"]);
  });

  it("probe timeout or transport failure keep the model (fail-open)", async () => {
    const modelInfo = [
      {
        model_name: "slow-model",
        litellm_params: { model: "openai/slow" },
        model_info: { litellm_provider: "openai", mode: "chat" },
      },
    ];
    const result = await populateProxyCatalog({
      endpoint: PROXY,
      homeDir: tempHome(),
      fetchImpl: neutralContractFetch(
        {
          roster: [{ id: "slow-model" }],
          modelInfo,
        },
        {
          probeHandler: async () => {
            // Simulate network timeout
            throw new Error("timeout");
          },
        },
      ),
    });
    expect(result.dropped).toEqual([]);
    expect(result.sources.map((s) => s.model)).toEqual(["slow-model"]);
  });
});

describe("REGRESSION PINS — neutral proxy contract", () => {
  describe("(i) argv passes the alias VERBATIM to --model", () => {
    it("the model field carries the roster alias, not composed provider/alias", async () => {
      // PRE-SWAP: model was `${service}/${alias}` composition.
      // POST-SWAP: model is the alias verbatim (the proxy's routing key).
      const modelInfo = [
        {
          model_name: "my-alias",
          litellm_params: { model: "openai/gpt-4" },
          model_info: { litellm_provider: "openai", mode: "chat" },
        },
      ];
      const result = await populateProxyCatalog({
        endpoint: PROXY,
        homeDir: tempHome(),
        fetchImpl: neutralContractFetch({
          roster: [{ id: "my-alias" }],
          modelInfo,
        }),
      });
      expect(result.dropped).toEqual([]);
      // Must fail on pre-swap code that composed the model
      expect(result.sources[0].model).toBe("my-alias"); // VERBATIM, not "openai/my-alias"
    });
  });

  describe("(ii) api_key_env flows through sources for ANTHROPIC_AUTH_TOKEN overlay", () => {
    // Spawn-layer testing in claude-worker-provider.test.mjs.
    // Populate-layer: sources carry api_key_env from proxy declaration.
    it("sources carry api_key_env from proxy declaration", async () => {
      const modelInfo = [
        {
          model_name: "auth-test",
          litellm_params: { model: "openai/test" },
          model_info: { litellm_provider: "openai", mode: "chat" },
        },
      ];
      const result = await populateProxyCatalog({
        endpoint: PROXY,
        homeDir: tempHome(),
        apiKeyEnv: "MY_PROXY_KEY",
        fetchImpl: neutralContractFetch({
          roster: [{ id: "auth-test" }],
          modelInfo,
        }),
      });
      expect(result.dropped).toEqual([]);
      expect(result.sources[0]).toMatchObject({ api_key_env: "MY_PROXY_KEY" });
    });
  });

});
