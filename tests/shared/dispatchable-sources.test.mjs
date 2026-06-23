/**
 * Generic dispatchable sources — the uniform `{provider, endpoint, parameters, quota}`
 * shape any non-IDE backend (NIM/vLLM API, a CLI pool, …) is configured as. Asserts the
 * source→provider-config bridge, distinct ids (so two sources of the same provider stay
 * separate), the legacy `openai_compatible` fold-in, the per-launch config overlay, and
 * the pool→source index.
 */

import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";

const {
  sourceProviderConfig,
  withSourceConfig,
  dispatchableSourceId,
  collectDispatchableSources,
  sourceByPoolId,
  buildSourcePool,
  buildHostModelPools,
} = await import("../../src/shared/quota/apiPool.ts");
const { ClaudeOAuthQuotaSource } = await import("../../src/shared/quota/claudeOAuthQuotaSource.ts");

const tmpDirs = [];
afterEach(() => {
  while (tmpDirs.length) {
    try { rmSync(tmpDirs.pop(), { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
/** Write a Claude creds file carrying `organizationUuid` and return its path. */
function writeClaudeCreds(org) {
  const dir = mkdtempSync(join(tmpdir(), "acct-pool-"));
  tmpDirs.push(dir);
  const p = join(dir, ".credentials.json");
  writeFileSync(p, JSON.stringify({
    claudeAiOauth: { accessToken: "t", expiresAt: Date.now() + 3_600_000 },
    organizationUuid: org,
  }));
  return p;
}
const STUB_QUOTA = { name: "stub", async queryCurrentUsage() { return null; } };

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

test("dispatchableSourceId folds the account segment into the pool id", () => {
  assert.equal(dispatchableSourceId({ provider: "claude-code", model: "m" }, "acctB"), "claude-code#acctB/m");
  assert.equal(dispatchableSourceId({ provider: "openai-compatible", id: "nim-A" }, "k"), "nim-A#k");
  // No account → unchanged (legacy key, no migration).
  assert.equal(dispatchableSourceId({ provider: "claude-code", model: "m" }, null), "claude-code/m");
});

test("buildSourcePool keys a same-provider source on the account read from its OWN credential (§5b)", async () => {
  // A Claude CLI dispatch source signed into account B (its own creds file) →
  // pool keyed (claude-code, orgB), distinct from a host pool on account A.
  const source = { provider: "claude-code", credentials_path: writeClaudeCreds("orgB") };
  const pool = await buildSourcePool({ source, quotaSource: STUB_QUOTA, quotaEntries: {} });
  assert.equal(pool.id, "claude-code#orgB/*");
});

test("buildSourcePool: explicit source.account overrides the credential read", async () => {
  const source = { provider: "claude-code", account: "declared-X", credentials_path: writeClaudeCreds("orgB") };
  const pool = await buildSourcePool({ source, quotaSource: STUB_QUOTA, quotaEntries: {} });
  assert.equal(pool.id, "claude-code#declared-X/*");
});

test("buildHostModelPools stamps the host account (from the host credential) into every pool id", async () => {
  const quotaSource = new ClaudeOAuthQuotaSource({
    credentialsPath: writeClaudeCreds("orgA"),
    readEnvToken: () => null,
  });
  const pools = await buildHostModelPools({
    providerName: "claude-code",
    hostModel: null,
    hostConcurrencyLimit: null,
    quotaSource,
    quotaEntries: {},
    roster: null,
    // Caller builds an account-less key; buildHostModelPools re-stamps it.
    resolve: () => ({ poolKey: "claude-code/*", discoveredLimits: null }),
  });
  assert.equal(pools.length, 1);
  assert.equal(pools[0].id, "claude-code#orgA/*");
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
