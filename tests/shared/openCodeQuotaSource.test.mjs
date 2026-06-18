import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";

const { OpenCodeQuotaSource } = await import("../../src/shared/quota/openCodeQuotaSource.ts");

const NOW = Date.parse("2026-06-16T12:00:00.000Z");
const FUTURE = NOW + 3_600_000;

function authFixture(overrides = {}) {
  return {
    anthropic: { type: "oauth", access: "ant-tok", refresh: "r", expires: FUTURE },
    openai: { type: "oauth", access: "oai-tok", accountId: "acct", refresh: "r", expires: FUTURE },
    "github-copilot": { type: "oauth", access: "gho_tok", refresh: "r", expires: FUTURE },
    google: { type: "api", key: "AIza-key" },
    ...overrides,
  };
}

const tmpDirs = [];
afterEach(() => {
  while (tmpDirs.length) {
    try { rmSync(tmpDirs.pop(), { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
function writeAuth(auth) {
  const dir = mkdtempSync(join(tmpdir(), "opencode-q-"));
  tmpDirs.push(dir);
  const p = join(dir, "auth.json");
  writeFileSync(p, JSON.stringify(auth));
  return p;
}
const ok = (body) => ({ ok: true, status: 200, json: async () => body });

// Routes by URL so we can assert the broker hit the RIGHT underlying endpoint.
function routingFetch() {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    if (url.includes("api.anthropic.com")) return ok({ five_hour: { utilization: 30, resets_at: "2026-06-17T04:00:00Z" } });
    if (url.includes("wham/usage")) return ok({ rate_limit: { primary_window: { used_percent: 50, reset_at: 1781700000 } } });
    if (url.includes("copilot_internal/user")) return ok({ quota_snapshots: { premium_interactions: { percent_remaining: 80 } }, quota_reset_date: "2026-07-01" });
    return { ok: false, status: 404, json: async () => ({}) };
  };
  fn.calls = calls;
  return fn;
}

function source(auth, fetchImpl) {
  return new OpenCodeQuotaSource({ authPath: writeAuth(auth), fetchImpl, now: () => NOW });
}

test("returns null for a non-OpenCode provider without reading anything", async () => {
  const fetchImpl = routingFetch();
  assert.equal(await source(authFixture(), fetchImpl).queryCurrentUsage("claude-code/*"), null);
  assert.equal(fetchImpl.calls.length, 0);
});

test("routes opencode/anthropic/* to the Claude usage endpoint with OpenCode's anthropic token", async () => {
  const fetchImpl = routingFetch();
  const snap = await source(authFixture(), fetchImpl).queryCurrentUsage("opencode/anthropic/claude-sonnet-4-6");
  assert.equal(snap.source, "claude-oauth");
  assert.equal(snap.remaining_pct, 0.7); // five_hour 30% used
  assert.match(fetchImpl.calls[0].url, /api\.anthropic\.com/);
  assert.equal(fetchImpl.calls[0].init.headers.Authorization, "Bearer ant-tok");
  assert.equal(fetchImpl.calls[0].init.headers["User-Agent"], "claude-cli (external, cli)");
});

test("routes opencode/openai/* to the Codex wham endpoint with account id", async () => {
  const fetchImpl = routingFetch();
  const snap = await source(authFixture(), fetchImpl).queryCurrentUsage("opencode/openai/gpt-x");
  assert.equal(snap.source, "codex");
  assert.equal(snap.remaining_pct, 0.5);
  assert.match(fetchImpl.calls[0].url, /wham\/usage/);
  assert.equal(fetchImpl.calls[0].init.headers["ChatGPT-Account-Id"], "acct");
});

test("routes opencode/github-copilot/* to the Copilot endpoint", async () => {
  const fetchImpl = routingFetch();
  const snap = await source(authFixture(), fetchImpl).queryCurrentUsage("opencode/github-copilot/some-model");
  assert.equal(snap.source, "copilot");
  assert.equal(snap.remaining_pct, 0.8);
  assert.match(fetchImpl.calls[0].url, /copilot_internal\/user/);
});

test("returns null for google (API key, no proactive endpoint) and for un-namespaced models", async () => {
  const fetchImpl = routingFetch();
  const src = source(authFixture(), fetchImpl);
  assert.equal(await src.queryCurrentUsage("opencode/google/g-model"), null);
  assert.equal(await src.queryCurrentUsage("opencode/*"), null);
  assert.equal(fetchImpl.calls.length, 0);
});

test("degrades to null when the routed provider's token is expired or absent", async () => {
  const fetchImpl = routingFetch();
  const expired = source(authFixture({ anthropic: { type: "oauth", access: "ant-tok", expires: NOW - 1 } }), fetchImpl);
  assert.equal(await expired.queryCurrentUsage("opencode/anthropic/claude-x"), null);
  const absent = source(authFixture({ anthropic: undefined }), fetchImpl);
  assert.equal(await absent.queryCurrentUsage("opencode/anthropic/claude-x"), null);
  assert.equal(fetchImpl.calls.length, 0);
});

test("degrades to null when auth.json is missing", async () => {
  const fetchImpl = routingFetch();
  const src = new OpenCodeQuotaSource({ authPath: join(tmpdir(), "no-opencode", "auth.json"), fetchImpl, now: () => NOW });
  assert.equal(await src.queryCurrentUsage("opencode/anthropic/claude-x"), null);
});

test("the DEFAULT fetch makes no network call under a test runner", async () => {
  const src = new OpenCodeQuotaSource({ authPath: writeAuth(authFixture()), now: () => NOW });
  assert.equal(await src.queryCurrentUsage("opencode/anthropic/claude-x"), null);
});
