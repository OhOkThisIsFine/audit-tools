/**
 * Generic dispatchable sources — the uniform `{transport, endpoint, parameters, quota}`
 * shape any non-IDE backend (NIM/vLLM API, a CLI pool, …) is configured as. Asserts the
 * source→provider-config bridge, distinct ids (so two sources of the same transport stay
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
    transport: "openai-compatible",
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
    transport: "codex",
    endpoint: "codex",
    model: "gpt-5",
    parameters: { sandbox_mode: "workspace-write" },
  });
  expect(cx.codex.command).toBe("codex");
  expect(cx.codex.model).toBe("gpt-5");
  expect(cx.codex.sandbox_mode).toBe("workspace-write");

  // worker-command takes no construction config.
  expect(sourceProviderConfig({ transport: "worker-command" })).toEqual({});
});

test("dispatchableSourceId: explicit id wins; else transport:model keeps two sources distinct", () => {
  expect(dispatchableSourceId({ transport: "openai-compatible", id: "nim-A" })).toBe("nim-A");
  const a = dispatchableSourceId({ transport: "openai-compatible", model: "m1" });
  const b = dispatchableSourceId({ transport: "openai-compatible", model: "m2" });
  expect(a).not.toBe(b);
});

test("dispatchableSourceId folds the account segment into the pool id", () => {
  expect(dispatchableSourceId({ transport: "claude-code", model: "m" }, "acctB")).toBe("claude-code#acctB/m");
  expect(dispatchableSourceId({ transport: "openai-compatible", id: "nim-A" }, "k")).toBe("nim-A#k");
  // No account → unchanged (legacy key, no migration).
  expect(dispatchableSourceId({ transport: "claude-code", model: "m" }, null)).toBe("claude-code/m");
});

test("buildSourcePool keys a same-transport source on the account read from its OWN credential (§5b)", async () => {
  // A Claude CLI dispatch source signed into account B (its own creds file) →
  // pool keyed (claude-code, orgB), distinct from a host pool on account A.
  const source = { transport: "claude-code", credentials_path: writeClaudeCreds("orgB") };
  const pool = await buildSourcePool({ source, quotaSource: STUB_QUOTA, quotaEntries: {} });
  expect(pool.id).toBe("claude-code#orgB/*");
});

test("buildSourcePool: explicit source.account overrides the credential read", async () => {
  const source = { transport: "claude-code", account: "declared-X", credentials_path: writeClaudeCreds("orgB") };
  const pool = await buildSourcePool({ source, quotaSource: STUB_QUOTA, quotaEntries: {} });
  expect(pool.id).toBe("claude-code#declared-X/*");
});

test("buildSourcePool: source.quota.max_concurrent becomes the pool's concurrencyCap (else null)", async () => {
  // C3 (NIM/Codex fix set): the endpoint-declared max-concurrency flows to the
  // pool's count cap. A source is otherwise built hostConcurrencyLimit:null.
  const capped = await buildSourcePool({
    source: { transport: "openai-compatible", endpoint: "http://nim/v1", model: "m", account: "k", quota: { max_concurrent: 4 } },
    quotaSource: STUB_QUOTA,
    quotaEntries: {},
  });
  expect(capped.concurrencyCap).toBe(4);
  expect(capped.hostConcurrencyLimit, "the host subagent budget stays null for a source").toBe(null);

  const uncapped = await buildSourcePool({
    source: { transport: "openai-compatible", endpoint: "http://nim/v1", model: "m", account: "k" },
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
      source: { transport: "openai-compatible", endpoint: "http://nim/v1", model: "m", account: "k", quota: { max_concurrent: bad } },
      quotaSource: STUB_QUOTA,
      quotaEntries: {},
    });
    expect(pool.concurrencyCap, `max_concurrent=${bad} → null`).toBe(null);
  }
  // A fractional > 1 floors to an integer (schema requires int).
  const frac = await buildSourcePool({
    source: { transport: "openai-compatible", endpoint: "http://nim/v1", model: "m", account: "k", quota: { max_concurrent: 3.9 } },
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
      sources: [{ transport: "codex", endpoint: "codex" }],
      openai_compatible: { base_url: "http://nim/v1", model: "m" },
    },
    "claude-code",
  );
  expect(got.length).toBe(2);
  expect(got.some((s) => s.transport === "codex")).toBeTruthy();
  expect(got.some((s) => s.transport === "openai-compatible" && s.endpoint === "http://nim/v1")).toBeTruthy();

  // When openai-compatible IS the primary, the unconditional primary fold (H2+H4
  // collapse) carries it as a source pool — the primary is just a source now.
  const primaryFold = collectDispatchableSources(
    { openai_compatible: { base_url: "x", model: "m" } },
    "openai-compatible",
  );
  expect(primaryFold.length).toBe(1);
  expect(primaryFold[0].transport).toBe("openai-compatible");
  expect(primaryFold[0].endpoint).toBe("x");

  // Two explicit NIM endpoints → two sources (distinct), no special-casing.
  const two = collectDispatchableSources(
    {
      sources: [
        { transport: "openai-compatible", endpoint: "http://a/v1", model: "m1" },
        { transport: "openai-compatible", endpoint: "http://b/v1", model: "m2" },
      ],
    },
    "claude-code",
  );
  expect(two.length).toBe(2);
  expect(dispatchableSourceId(two[0])).not.toBe(dispatchableSourceId(two[1]));
});

// ── Commit 3c: transport-agnostic quota identity (service keying) ──
// Plan: docs/reviews/commit3-proxy-kind1-transport-plan-2026-07-16.md §"Identity &
// quota keying" — the transport NEVER enters the ledger/pool identity; the key is
// `service[#account]/model`.

test("3c red-green: proxied claude-worker lane + direct lane to the SAME backend dedup to ONE pool identity", async () => {
  // Direct lane: an operator-declared OpenAI-compatible endpoint that IS NIM. The
  // operator asserts the backend identity via `service` — without it the
  // tool cannot know a generic openai-compatible endpoint is the same backend the
  // proxy routes to, and the two lanes legitimately stay distinct pools.
  const direct = {
    transport: "openai-compatible",
    endpoint: "https://integrate.api.nvidia.com/v1",
    model: "z-ai/glm-5.2",
    api_key_env: "NVIDIA_API_KEY",
    service: "nim",
    account: "X",
  };
  // Proxied lane: the populate-cache expansion (claude-worker transport). The cache
  // stamps NO id — an id is an operator override that outranks derivation, so a
  // tool-stamped one would re-split exactly the identity `service` exists to merge.
  const proxied = {
    transport: "claude-worker",
    endpoint: "http://127.0.0.1:8791",
    service: "nim",
    model: "z-ai/glm-5.2",
    worker_kind: "agentic",
    account: "X",
  };
  // The ledger key is `service[#account]/model` for BOTH lanes.
  expect(dispatchableSourceId(direct, "X")).toBe("nim#X/z-ai/glm-5.2");
  expect(dispatchableSourceId(proxied, "X")).toBe("nim#X/z-ai/glm-5.2");
  // And the CapacityPool ids (the admission/ledger identity) collide to ONE.
  const directPool = await buildSourcePool({ source: direct, quotaSource: STUB_QUOTA, quotaEntries: {} });
  const proxiedPool = await buildSourcePool({ source: proxied, quotaSource: STUB_QUOTA, quotaEntries: {} });
  expect(directPool.id).toBe(proxiedPool.id);
  expect(directPool.id).toBe("nim#X/z-ai/glm-5.2");
});

test("3c: the transport never enters the identity — service keying, and an operator id outranks it", () => {
  const proxied = {
    transport: "claude-worker",
    endpoint: "http://127.0.0.1:8791",
    service: "nim",
    model: "z-ai/glm-5.2",
  };
  expect(dispatchableSourceId(proxied)).toBe("nim/z-ai/glm-5.2");
  expect(dispatchableSourceId(proxied)).not.toContain("claude-worker");
  // An OPERATOR-declared id is an override and outranks the service derivation
  // (spec/backend-identity-axes.md). This is only safe because nothing auto-stamps
  // one — see the populate-cache pin below.
  expect(dispatchableSourceId({ ...proxied, id: "my-lane" })).toBe("my-lane");
  // The declared `account` folds in even when the caller passes none (the gather-time
  // dedup path), so two same-backend lanes on DIFFERENT accounts stay distinct pools.
  expect(dispatchableSourceId({ ...proxied, account: "X" })).toBe("nim#X/z-ai/glm-5.2");
});

test("3c: a source WITHOUT service keeps the existing id/transport keying (no behavior change)", () => {
  expect(dispatchableSourceId({ transport: "openai-compatible", id: "nim-A" })).toBe("nim-A");
  expect(dispatchableSourceId({ transport: "openai-compatible", model: "m1" })).toBe(
    "openai-compatible/m1",
  );
});

// ── H2+H4 collapse: the primary in-process backend ALWAYS folds in as a source ──

test("primaryInProcessSource builds a source from the primary backend's own config block", () => {
  const codex = primaryInProcessSource(
    { codex: { command: "codex", model: "gpt-5", sandbox_mode: "workspace-write" } },
    "codex",
  );
  expect(codex.transport).toBe("codex");
  expect(codex.endpoint).toBe("codex");
  expect(codex.model).toBe("gpt-5");
  expect(codex.parameters.sandbox_mode).toBe("workspace-write");

  const oc = primaryInProcessSource(
    { openai_compatible: { base_url: "http://nim/v1", model: "m", api_key_env: "K" } },
    "openai-compatible",
  );
  expect(oc.transport).toBe("openai-compatible");
  expect(oc.endpoint).toBe("http://nim/v1");

  // Host-shaped primaries → null (the conversation host / IDE is never a source).
  expect(primaryInProcessSource({}, "claude-code")).toBeNull();
  expect(primaryInProcessSource({}, "vscode-task")).toBeNull();
  // openai-compatible named but not configured → null.
  expect(primaryInProcessSource({}, "openai-compatible")).toBeNull();
});

test("primaryInProcessSource: agy synthesizes from its config block (D4 — no silent fail-closed)", () => {
  const agy = primaryInProcessSource(
    {
      agy: {
        command: "agy",
        model: "gemini-3-pro",
        extra_args: ["--foo"],
        dangerously_skip_permissions: true,
      },
    },
    "agy",
  );
  expect(agy.transport).toBe("agy");
  expect(agy.endpoint).toBe("agy");
  expect(agy.model).toBe("gemini-3-pro");
  expect(agy.parameters.extra_args).toEqual(["--foo"]);
  expect(agy.parameters.dangerously_skip_permissions).toBe(true);
  // An EMPTY agy block still folds (the CLI has PATH defaults, like codex).
  expect(primaryInProcessSource({}, "agy").transport).toBe("agy");
});

test("primaryInProcessSource: command-shaped primaries fold ONLY under commandWorkers policy (D3)", () => {
  const cfg = {
    subprocess_template: { command_template: ["run", "{prompt}"], env: { A: "1" } },
  };
  // Audit policy (default, no command workers): no fold.
  expect(primaryInProcessSource(cfg, "subprocess-template")).toBeNull();
  expect(primaryInProcessSource({}, "worker-command")).toBeNull();
  // Remediate policy (commandWorkers): subprocess-template from its block …
  const sub = primaryInProcessSource(cfg, "subprocess-template", { commandWorkers: true });
  expect(sub.transport).toBe("subprocess-template");
  expect(sub.parameters.command_template).toEqual(["run", "{prompt}"]);
  expect(sub.parameters.env).toEqual({ A: "1" });
  // … but an absent/empty template block is no pool (nothing to launch).
  expect(primaryInProcessSource({}, "subprocess-template", { commandWorkers: true })).toBeNull();
  // worker-command has NO session-level block: a bare transport source (the command
  // is per-node on the task, resolved at dispatch).
  expect(
    primaryInProcessSource({}, "worker-command", { commandWorkers: true }),
  ).toEqual({ transport: "worker-command" });
});

test("collectDispatchableSources: the codex primary ALWAYS folds in as a source (no flag)", () => {
  const cfg = { codex: { command: "codex", model: "gpt-5" } };
  // Headless and attended alike: the primary is a member source pool of the ONE
  // eligible set (the demote flag is retired — H4).
  const folded = collectDispatchableSources(cfg, "codex");
  expect(folded.length).toBe(1);
  expect(folded[0].transport).toBe("codex");
});

// ── C1: legacy openai_compatible block's quota converges onto the source pool ──

test("C1: a legacy openai_compatible.quota converges onto the folded source (legacy fold + primary fold)", () => {
  const quota = { context_tokens: 128_000, output_tokens: 8_000, max_concurrent: 6 };
  // Fold-in path (openai-compatible is NOT the primary).
  const folded = collectDispatchableSources(
    { openai_compatible: { base_url: "http://nim/v1", model: "m", quota } },
    "claude-code",
  );
  expect(folded.length).toBe(1);
  expect(folded[0].transport).toBe("openai-compatible");
  expect(folded[0].quota).toEqual(quota);

  // Primary-fold path (openai-compatible IS the primary).
  const primary = primaryInProcessSource(
    { openai_compatible: { base_url: "http://nim/v1", model: "m", quota } },
    "openai-compatible",
  );
  expect(primary.quota).toEqual(quota);

  // Absent quota stays undefined → the source falls to the conservative floor,
  // exactly as before C1 (no regression for unconfigured operators).
  const noQuota = collectDispatchableSources(
    { openai_compatible: { base_url: "http://nim/v1", model: "m" } },
    "claude-code",
  );
  expect(noQuota[0].quota).toBeUndefined();
});

test("C1: a legacy-derived source's quota reaches discoveredLimits + concurrencyCap (off the floor)", async () => {
  const quota = { context_tokens: 128_000, output_tokens: 8_000, max_concurrent: 6 };
  const [source] = collectDispatchableSources(
    { openai_compatible: { base_url: "http://nim/v1", model: "m", quota } },
    "claude-code",
  );
  const pool = await buildSourcePool({ source, quotaSource: STUB_QUOTA, quotaEntries: {} });
  // discoveredLimits feeds resolveLimits' discovered_capability rung → real window,
  // not DEFAULT_CONTEXT_TOKENS. concurrencyCap comes from the same quota.
  expect(pool.discoveredLimits?.context_tokens).toBe(128_000);
  expect(pool.discoveredLimits?.output_tokens).toBe(8_000);
  expect(pool.concurrencyCap).toBe(6);

  // Legacy block WITHOUT quota → discoveredLimits null → resolveLimits floor.
  const [floorSource] = collectDispatchableSources(
    { openai_compatible: { base_url: "http://nim/v1", model: "m" } },
    "claude-code",
  );
  const floorPool = await buildSourcePool({ source: floorSource, quotaSource: STUB_QUOTA, quotaEntries: {} });
  expect(floorPool.discoveredLimits).toBe(null);
});

test("collectDispatchableSources: openai-compatible primary folds alongside a second explicit source", () => {
  const cfg = {
    sources: [{ transport: "codex", endpoint: "codex" }],
    openai_compatible: { base_url: "http://nim/v1", model: "m" },
  };
  const got = collectDispatchableSources(cfg, "openai-compatible");
  // The explicit codex source + the folded openai-compatible primary, deduped once.
  expect(got.some((s) => s.transport === "codex")).toBeTruthy();
  expect(
    got.filter((s) => s.transport === "openai-compatible" && s.endpoint === "http://nim/v1").length,
  ).toBe(1);
});

test("collectDispatchableSources: the fold is a no-op for a host-shaped primary (claude-code)", () => {
  const cfg = { openai_compatible: { base_url: "http://nim/v1", model: "m" } };
  // claude-code host + NIM source: the primary fold adds nothing; the legacy fold
  // already carries the NIM source (one, not duplicated).
  const got = collectDispatchableSources(cfg, "claude-code");
  expect(got.filter((s) => s.transport === "openai-compatible").length).toBe(1);
});

test("withSourceConfig overlays the source's provider block; no source = passthrough", () => {
  const base = { provider: "claude-code", timeout_ms: 5 };
  const merged = withSourceConfig(base, {
    transport: "openai-compatible",
    endpoint: "http://nim/v1",
    model: "m",
  });
  expect(merged.timeout_ms).toBe(5); // untouched
  expect(merged.openai_compatible.base_url).toBe("http://nim/v1"); // overlaid
  expect(withSourceConfig(base, undefined)).toBe(base); // passthrough
});

test("sourceByPoolId indexes only source-backed pools by id", () => {
  const src = { transport: "openai-compatible", endpoint: "x", model: "m" };
  const map = sourceByPoolId([{ id: "p1", source: src }, { id: "p2" }]);
  expect(map.size).toBe(1);
  expect(map.get("p1")).toBe(src);
});
