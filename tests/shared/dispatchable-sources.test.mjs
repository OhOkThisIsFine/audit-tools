/**
 * Generic dispatchable sources — the uniform `{provider, endpoint, parameters, quota}`
 * shape any non-IDE backend (NIM/vLLM API, a CLI pool, …) is configured as. Asserts the
 * source→provider-config bridge, distinct ids (so two sources of the same provider stay
 * separate), the legacy `openai_compatible` fold-in, the per-launch config overlay, and
 * the pool→source index.
 */

import { test, afterEach, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";

const {
  sourceProviderConfig,
  withSourceConfig,
  dispatchableSourceId,
  collectDispatchableSources,
  primaryInProcessSource,
  isDemotableInProcessProvider,
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
  expect(oc.openai_compatible.base_url).toBe("http://nim/v1");
  expect(oc.openai_compatible.model).toBe("m");
  expect(oc.openai_compatible.api_key_env).toBe("K");
  expect(oc.openai_compatible.temperature).toBe(0.2);

  const cx = sourceProviderConfig({
    provider: "codex",
    endpoint: "codex",
    model: "gpt-5",
    parameters: { sandbox_mode: "workspace-write" },
  });
  expect(cx.codex.command).toBe("codex");
  expect(cx.codex.model).toBe("gpt-5");
  expect(cx.codex.sandbox_mode).toBe("workspace-write");

  // local-subprocess takes no construction config.
  expect(sourceProviderConfig({ provider: "local-subprocess" })).toEqual({});
});

test("dispatchableSourceId: explicit id wins; else provider:model keeps two sources distinct", () => {
  expect(dispatchableSourceId({ provider: "openai-compatible", id: "nim-A" })).toBe("nim-A");
  const a = dispatchableSourceId({ provider: "openai-compatible", model: "m1" });
  const b = dispatchableSourceId({ provider: "openai-compatible", model: "m2" });
  expect(a).not.toBe(b);
});

test("dispatchableSourceId folds the account segment into the pool id", () => {
  expect(dispatchableSourceId({ provider: "claude-code", model: "m" }, "acctB")).toBe("claude-code#acctB/m");
  expect(dispatchableSourceId({ provider: "openai-compatible", id: "nim-A" }, "k")).toBe("nim-A#k");
  // No account → unchanged (legacy key, no migration).
  expect(dispatchableSourceId({ provider: "claude-code", model: "m" }, null)).toBe("claude-code/m");
});

test("buildSourcePool keys a same-provider source on the account read from its OWN credential (§5b)", async () => {
  // A Claude CLI dispatch source signed into account B (its own creds file) →
  // pool keyed (claude-code, orgB), distinct from a host pool on account A.
  const source = { provider: "claude-code", credentials_path: writeClaudeCreds("orgB") };
  const pool = await buildSourcePool({ source, quotaSource: STUB_QUOTA, quotaEntries: {} });
  expect(pool.id).toBe("claude-code#orgB/*");
});

test("buildSourcePool: explicit source.account overrides the credential read", async () => {
  const source = { provider: "claude-code", account: "declared-X", credentials_path: writeClaudeCreds("orgB") };
  const pool = await buildSourcePool({ source, quotaSource: STUB_QUOTA, quotaEntries: {} });
  expect(pool.id).toBe("claude-code#declared-X/*");
});

test("buildSourcePool: source.quota.max_concurrent becomes the pool's concurrencyCap (else null)", async () => {
  // C3 (NIM/Codex fix set): the endpoint-declared max-concurrency flows to the
  // pool's count cap. A source is otherwise built hostConcurrencyLimit:null.
  const capped = await buildSourcePool({
    source: { provider: "openai-compatible", endpoint: "http://nim/v1", model: "m", account: "k", quota: { max_concurrent: 4 } },
    quotaSource: STUB_QUOTA,
    quotaEntries: {},
  });
  expect(capped.concurrencyCap).toBe(4);
  expect(capped.hostConcurrencyLimit, "the host subagent budget stays null for a source").toBe(null);

  const uncapped = await buildSourcePool({
    source: { provider: "openai-compatible", endpoint: "http://nim/v1", model: "m", account: "k" },
    quotaSource: STUB_QUOTA,
    quotaEntries: {},
  });
  expect(uncapped.concurrencyCap, "no max_concurrent → no cap").toBe(null);
});

test("buildSourcePool: a non-positive/non-finite max_concurrent clamps to null (never 0)", async () => {
  // Guards the wedge: a 0 cap (or the "0 = unlimited" convention, or a stray negative)
  // must NOT become concurrencyCap:0 — that would ceiling the pool to zero in-flight
  // and spin the rolling engine, and would violate the summary schema's min(1).
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 0.5]) {
    const pool = await buildSourcePool({
      source: { provider: "openai-compatible", endpoint: "http://nim/v1", model: "m", account: "k", quota: { max_concurrent: bad } },
      quotaSource: STUB_QUOTA,
      quotaEntries: {},
    });
    expect(pool.concurrencyCap, `max_concurrent=${bad} → null`).toBe(null);
  }
  // A fractional > 1 floors to an integer (schema requires int).
  const frac = await buildSourcePool({
    source: { provider: "openai-compatible", endpoint: "http://nim/v1", model: "m", account: "k", quota: { max_concurrent: 3.9 } },
    quotaSource: STUB_QUOTA,
    quotaEntries: {},
  });
  expect(frac.concurrencyCap).toBe(3);
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
  expect(pools.length).toBe(1);
  expect(pools[0].id).toBe("claude-code#orgA/*");
});

test("collectDispatchableSources: explicit sources + legacy openai_compatible folded in when not primary", () => {
  const got = collectDispatchableSources(
    {
      sources: [{ provider: "codex", endpoint: "codex" }],
      openai_compatible: { base_url: "http://nim/v1", model: "m" },
    },
    "claude-code",
  );
  expect(got.length).toBe(2);
  expect(got.some((s) => s.provider === "codex")).toBeTruthy();
  expect(got.some((s) => s.provider === "openai-compatible" && s.endpoint === "http://nim/v1")).toBeTruthy();

  // When openai-compatible IS the primary, it is the primary worker, not a spill source.
  expect(collectDispatchableSources({ openai_compatible: { base_url: "x", model: "m" } }, "openai-compatible")).toEqual([]);

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
  expect(two.length).toBe(2);
  expect(dispatchableSourceId(two[0])).not.toBe(dispatchableSourceId(two[1]));
});

// ── Defect-1: demote the primary in-process backend to a source (attended host) ──

test("isDemotableInProcessProvider: only the API/CLI worker backends demote", () => {
  expect(isDemotableInProcessProvider("codex")).toBeTruthy();
  expect(isDemotableInProcessProvider("opencode")).toBeTruthy();
  expect(isDemotableInProcessProvider("openai-compatible")).toBeTruthy();
  // Not demotable: the conversation host, IDE backends, host-dispatch defaults.
  expect(isDemotableInProcessProvider("claude-code")).toBeFalsy();
  expect(isDemotableInProcessProvider("local-subprocess")).toBeFalsy();
  expect(isDemotableInProcessProvider("subprocess-template")).toBeFalsy();
  expect(isDemotableInProcessProvider(undefined)).toBeFalsy();
});

test("primaryInProcessSource builds a source from the primary backend's own config block", () => {
  const codex = primaryInProcessSource(
    { codex: { command: "codex", model: "gpt-5", sandbox_mode: "workspace-write" } },
    "codex",
  );
  expect(codex.provider).toBe("codex");
  expect(codex.endpoint).toBe("codex");
  expect(codex.model).toBe("gpt-5");
  expect(codex.parameters.sandbox_mode).toBe("workspace-write");

  const oc = primaryInProcessSource(
    { openai_compatible: { base_url: "http://nim/v1", model: "m", api_key_env: "K" } },
    "openai-compatible",
  );
  expect(oc.provider).toBe("openai-compatible");
  expect(oc.endpoint).toBe("http://nim/v1");

  // Non-demotable primaries → null (nothing to demote).
  expect(primaryInProcessSource({}, "claude-code")).toBeNull();
  // openai-compatible named but not configured → null.
  expect(primaryInProcessSource({}, "openai-compatible")).toBeNull();
});

test("collectDispatchableSources: demotePrimaryInProcess adds the codex primary as a source", () => {
  const cfg = { codex: { command: "codex", model: "gpt-5" } };
  // Default (headless): codex is the in-process worker, NOT a source.
  expect(collectDispatchableSources(cfg, "codex")).toEqual([]);
  // Attended: codex is demoted to a source pool so the host fans out onto it.
  const demoted = collectDispatchableSources(cfg, "codex", { demotePrimaryInProcess: true });
  expect(demoted.length).toBe(1);
  expect(demoted[0].provider).toBe("codex");
});

test("collectDispatchableSources: attended openai-compatible primary demotes alongside a second NIM source", () => {
  const cfg = {
    sources: [{ provider: "codex", endpoint: "codex" }],
    openai_compatible: { base_url: "http://nim/v1", model: "m" },
  };
  const demoted = collectDispatchableSources(cfg, "openai-compatible", {
    demotePrimaryInProcess: true,
  });
  // The explicit codex source + the demoted openai-compatible primary, deduped once.
  expect(demoted.some((s) => s.provider === "codex")).toBeTruthy();
  expect(
    demoted.filter((s) => s.provider === "openai-compatible" && s.endpoint === "http://nim/v1").length,
  ).toBe(1);
});

test("collectDispatchableSources: demote is a no-op for a non-demotable primary (claude-code)", () => {
  const cfg = { openai_compatible: { base_url: "http://nim/v1", model: "m" } };
  // claude-code host + NIM source: demote adds nothing new; the legacy fold already
  // carries the NIM source (one, not duplicated).
  const got = collectDispatchableSources(cfg, "claude-code", { demotePrimaryInProcess: true });
  expect(got.filter((s) => s.provider === "openai-compatible").length).toBe(1);
});

test("withSourceConfig overlays the source's provider block; no source = passthrough", () => {
  const base = { provider: "claude-code", timeout_ms: 5 };
  const merged = withSourceConfig(base, {
    provider: "openai-compatible",
    endpoint: "http://nim/v1",
    model: "m",
  });
  expect(merged.timeout_ms).toBe(5); // untouched
  expect(merged.openai_compatible.base_url).toBe("http://nim/v1"); // overlaid
  expect(withSourceConfig(base, undefined)).toBe(base); // passthrough
});

test("sourceByPoolId indexes only source-backed pools by id", () => {
  const src = { provider: "openai-compatible", endpoint: "x", model: "m" };
  const map = sourceByPoolId([{ id: "p1", source: src }, { id: "p2" }]);
  expect(map.size).toBe(1);
  expect(map.get("p1")).toBe(src);
});
