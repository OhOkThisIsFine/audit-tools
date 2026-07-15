/**
 * repair-proxy `/registry` discovery → dispatchable sources (Slice B).
 * Covers cost-aware top-K candidate selection (capability rank, null-last, provider
 * filtering, top_k), the DispatchableSource expansion shape (id / namespaced model /
 * account=provider / endpoint=proxy root), and the fail-open contract (a throwing /
 * non-200 fetch → [] , never throws). Fetch is mocked via the fetchFn param — no network.
 */

import { test, expect } from "vitest";

const { selectRepairProxyCandidates, expandRepairProxySources, fetchRepairProxyRegistry } =
  await import("../../src/shared/quota/repairProxyRegistry.ts");

/** A fetchFn returning a 200 JSON body. */
function okFetch(body) {
  return async () => ({ ok: true, status: 200, async json() { return body; } });
}

/** Build a registry with providers keyed by name. */
function registry(providers) {
  return { providers };
}

/** A model with a composite_rank (or null capability). */
function model(id, rank) {
  return { id, capability: rank === null ? null : { composite_rank: rank } };
}

const BASE = "http://proxy:8791";

test("selectRepairProxyCandidates: top-K by composite_rank, null-capability last", () => {
  const reg = registry({
    nim: {
      reachable: true,
      has_key: true,
      models: [
        model("m-slow", 30),
        model("m-null", null),
        model("m-fast", 5),
        model("m-mid", 12),
      ],
    },
  });
  const got = selectRepairProxyCandidates(reg, { base_url: BASE, top_k: 3 });
  expect(got.map((c) => c.model)).toEqual(["m-fast", "m-mid", "m-slow"]);
  // null-capability sorts last → excluded from top-3.
  expect(got.some((c) => c.model === "m-null")).toBe(false);
});

test("selectRepairProxyCandidates: default top_k is 5", () => {
  const models = Array.from({ length: 8 }, (_, i) => model(`m${i}`, i));
  const reg = registry({ nim: { reachable: true, has_key: true, models } });
  const got = selectRepairProxyCandidates(reg, { base_url: BASE });
  expect(got.length).toBe(5);
});

test("selectRepairProxyCandidates: filters unreachable / no-key / disabled providers", () => {
  const reg = registry({
    up: { reachable: true, has_key: true, models: [model("a", 1)] },
    down: { reachable: false, has_key: true, models: [model("b", 1)] },
    nokey: { reachable: true, has_key: false, models: [model("c", 1)] },
    off: { reachable: true, has_key: true, models: [model("d", 1)] },
  });
  const got = selectRepairProxyCandidates(reg, {
    base_url: BASE,
    providers: { off: { enabled: false } },
  });
  expect(got.map((c) => c.provider)).toEqual(["up"]);
});

test("selectRepairProxyCandidates: attaches operator cost override when declared", () => {
  const reg = registry({ nim: { reachable: true, has_key: true, models: [model("a", 1)] } });
  const got = selectRepairProxyCandidates(reg, {
    base_url: BASE,
    providers: { nim: { cost_per_mtok: 0 } },
  });
  expect(got[0].cost_per_mtok).toBe(0);
  // No override → undefined (resolved later by models.dev).
  const bare = selectRepairProxyCandidates(reg, { base_url: BASE });
  expect(bare[0].cost_per_mtok).toBeUndefined();
});

test("expandRepairProxySources: maps to the correct DispatchableSource shape", async () => {
  const reg = registry({ nim: { reachable: true, has_key: true, models: [model("llama-70b", 3)] } });
  const [src] = await expandRepairProxySources(
    { base_url: BASE, api_key_env: "PROXY_KEY" },
    okFetch(reg),
  );
  expect(src.id).toBe("repair-proxy/nim/llama-70b");
  expect(src.provider).toBe("openai-compatible");
  expect(src.endpoint).toBe(BASE); // proxy root; transport appends /chat/completions
  expect(src.model).toBe("nim/llama-70b"); // namespaced — proxy routes it
  expect(src.account).toBe("nim"); // per-backend-provider cooldown fold
  expect(src.api_key_env).toBe("PROXY_KEY");
});

test("expandRepairProxySources: one source per selected model, cost override propagates", async () => {
  const reg = registry({
    nim: { reachable: true, has_key: true, models: [model("a", 1), model("b", 2)] },
  });
  const sources = await expandRepairProxySources(
    { base_url: BASE, providers: { nim: { cost_per_mtok: 0 } } },
    okFetch(reg),
  );
  expect(sources.length).toBe(2);
  expect(sources.every((s) => s.cost_per_mtok === 0)).toBe(true);
  expect(new Set(sources.map((s) => s.id)).size).toBe(2);
});

test("expandRepairProxySources: 429 axis — provider-wide by default, per-model when flagged", async () => {
  const reg = registry({
    nim: { reachable: true, has_key: true, models: [model("a", 1), model("b", 2)] },
  });
  // default: all models share account=provider (one 429 propagates provider-wide)
  const shared = await expandRepairProxySources({ base_url: BASE }, okFetch(reg));
  expect(shared.map((s) => s.account)).toEqual(["nim", "nim"]);
  // opt-in per_model_limits: account=provider/model (isolated 429 domains)
  const isolated = await expandRepairProxySources(
    { base_url: BASE, providers: { nim: { per_model_limits: true } } },
    okFetch(reg),
  );
  expect(new Set(isolated.map((s) => s.account))).toEqual(new Set(["nim/a", "nim/b"]));
});

test("expandRepairProxySources: fail-open — fetch returning a non-200 → []", async () => {
  const notOk = async () => ({ ok: false, status: 500, async json() { return {}; } });
  const out = await expandRepairProxySources({ base_url: BASE }, notOk);
  expect(out).toEqual([]);
});

test("expandRepairProxySources: fail-open — a throwing fetch → [] (never throws)", async () => {
  const throwing = async () => {
    throw new Error("ECONNREFUSED");
  };
  await expect(expandRepairProxySources({ base_url: BASE }, throwing)).resolves.toEqual([]);
});

test("fetchRepairProxyRegistry: malformed body (no providers) → null", async () => {
  const bad = okFetch({ generated_at: "now" });
  expect(await fetchRepairProxyRegistry(BASE, bad)).toBeNull();
});

test("fetchRepairProxyRegistry: trims a trailing slash on base_url", async () => {
  let seen = null;
  const spy = async (url) => {
    seen = url;
    return { ok: true, status: 200, async json() { return { providers: {} }; } };
  };
  await fetchRepairProxyRegistry("http://proxy:8791/", spy);
  expect(seen).toBe("http://proxy:8791/registry");
});
