/**
 * Generic dispatchable sources — the uniform `{provider, endpoint, parameters, quota}`
 * shape any non-IDE backend (NIM/vLLM API, a CLI pool, …) is configured as. Asserts the
 * source→provider-config bridge, distinct ids (so two sources of the same provider stay
 * separate), the legacy `openai_compatible` fold-in, the per-launch config overlay, and
 * the pool→source index.
 */

import test from "node:test";
import assert from "node:assert/strict";

const {
  sourceProviderConfig,
  withSourceConfig,
  dispatchableSourceId,
  collectDispatchableSources,
  sourceByPoolId,
} = await import("../../src/shared/quota/apiPool.ts");

test("sourceProviderConfig bridges a source to its provider's config block", () => {
  const oc = sourceProviderConfig({
    provider: "openai-compatible",
    endpoint: "http://nim/v1",
    model: "m",
    api_key_env: "K",
    parameters: { temperature: 0.2 },
  });
  assert.equal(oc.openai_compatible.base_url, "http://nim/v1");
  assert.equal(oc.openai_compatible.model, "m");
  assert.equal(oc.openai_compatible.api_key_env, "K");
  assert.equal(oc.openai_compatible.temperature, 0.2);

  const cx = sourceProviderConfig({
    provider: "codex",
    endpoint: "codex",
    model: "gpt-5",
    parameters: { sandbox_mode: "workspace-write" },
  });
  assert.equal(cx.codex.command, "codex");
  assert.equal(cx.codex.model, "gpt-5");
  assert.equal(cx.codex.sandbox_mode, "workspace-write");

  // local-subprocess takes no construction config.
  assert.deepEqual(sourceProviderConfig({ provider: "local-subprocess" }), {});
});

test("dispatchableSourceId: explicit id wins; else provider:model keeps two sources distinct", () => {
  assert.equal(dispatchableSourceId({ provider: "openai-compatible", id: "nim-A" }), "nim-A");
  const a = dispatchableSourceId({ provider: "openai-compatible", model: "m1" });
  const b = dispatchableSourceId({ provider: "openai-compatible", model: "m2" });
  assert.notEqual(a, b);
});

test("collectDispatchableSources: explicit sources + legacy openai_compatible folded in when not primary", () => {
  const got = collectDispatchableSources(
    {
      sources: [{ provider: "codex", endpoint: "codex" }],
      openai_compatible: { base_url: "http://nim/v1", model: "m" },
    },
    "claude-code",
  );
  assert.equal(got.length, 2);
  assert.ok(got.some((s) => s.provider === "codex"));
  assert.ok(got.some((s) => s.provider === "openai-compatible" && s.endpoint === "http://nim/v1"));

  // When openai-compatible IS the primary, it is the primary worker, not a spill source.
  assert.deepEqual(
    collectDispatchableSources({ openai_compatible: { base_url: "x", model: "m" } }, "openai-compatible"),
    [],
  );

  // Two explicit NIM endpoints → two sources (distinct), no special-casing.
  const two = collectDispatchableSources(
    {
      sources: [
        { provider: "openai-compatible", endpoint: "http://a/v1", model: "m1" },
        { provider: "openai-compatible", endpoint: "http://b/v1", model: "m2" },
      ],
    },
    "claude-code",
  );
  assert.equal(two.length, 2);
  assert.notEqual(dispatchableSourceId(two[0]), dispatchableSourceId(two[1]));
});

test("withSourceConfig overlays the source's provider block; no source = passthrough", () => {
  const base = { provider: "claude-code", timeout_ms: 5 };
  const merged = withSourceConfig(base, {
    provider: "openai-compatible",
    endpoint: "http://nim/v1",
    model: "m",
  });
  assert.equal(merged.timeout_ms, 5); // untouched
  assert.equal(merged.openai_compatible.base_url, "http://nim/v1"); // overlaid
  assert.equal(withSourceConfig(base, undefined), base); // passthrough
});

test("sourceByPoolId indexes only source-backed pools by id", () => {
  const src = { provider: "openai-compatible", endpoint: "x", model: "m" };
  const map = sourceByPoolId([{ id: "p1", source: src }, { id: "p2" }]);
  assert.equal(map.size, 1);
  assert.equal(map.get("p1"), src);
});
