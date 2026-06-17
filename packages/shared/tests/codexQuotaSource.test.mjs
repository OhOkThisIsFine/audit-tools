import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";

const { CodexQuotaSource, mapCodexUsage, fetchCodexUsage } = await import(
  "../src/quota/codexQuotaSource.ts"
);

const NOW = Date.parse("2026-06-16T12:00:00.000Z");

// Real `wham/usage` shape (RateLimitStatusPayload, trimmed to mapped fields).
const LIVE = {
  plan_type: "plus",
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: { used_percent: 12, reset_at: 1781700000, reset_after_seconds: 9000, limit_window_seconds: 18000 },
    secondary_window: { used_percent: 40, reset_at: 1782200000, reset_after_seconds: 500000, limit_window_seconds: 604800 },
  },
};

const tmpDirs = [];
afterEach(() => {
  while (tmpDirs.length) {
    try { rmSync(tmpDirs.pop(), { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function writeCreds(creds) {
  const dir = mkdtempSync(join(tmpdir(), "codex-q-"));
  tmpDirs.push(dir);
  const p = join(dir, "auth.json");
  writeFileSync(p, JSON.stringify(creds));
  return p;
}
const validCreds = () => ({ auth_mode: "chatgpt", tokens: { access_token: "tok-c", account_id: "acct-1" } });

function recordingFetch(response) {
  const calls = [];
  const fn = async (url, init) => { calls.push({ url, init }); return typeof response === "function" ? response() : response; };
  fn.calls = calls;
  return fn;
}
const okResponse = (body) => ({ ok: true, status: 200, json: async () => body });

// ---- mapCodexUsage ----

test("mapCodexUsage binds on the most-constrained window (highest used_percent)", () => {
  const snap = mapCodexUsage(LIVE, NOW);
  assert.equal(snap.remaining_pct, 0.6); // secondary 40% used → 60% remaining
  assert.equal(snap.reset_at, new Date(1782200000 * 1000).toISOString());
  assert.equal(snap.source, "codex");
  assert.equal(snap.captured_at, new Date(NOW).toISOString());
});

test("mapCodexUsage falls back to reset_after_seconds when reset_at absent", () => {
  const snap = mapCodexUsage(
    { rate_limit: { primary_window: { used_percent: 90, reset_after_seconds: 3600 } } },
    NOW,
  );
  assert.equal(snap.remaining_pct, 0.1);
  assert.equal(snap.reset_at, new Date(NOW + 3600 * 1000).toISOString());
});

test("mapCodexUsage returns null when no window has a numeric used_percent", () => {
  assert.equal(mapCodexUsage({ rate_limit: { primary_window: null, secondary_window: null } }, NOW), null);
  assert.equal(mapCodexUsage({}, NOW), null);
});

// ---- queryCurrentUsage ----

test("queryCurrentUsage returns null for a non-Codex provider without fetching", async () => {
  const fetchImpl = recordingFetch(okResponse(LIVE));
  const src = new CodexQuotaSource({ credentialsPath: writeCreds(validCreds()), fetchImpl, now: () => NOW });
  assert.equal(await src.queryCurrentUsage("claude-code/*"), null);
  assert.equal(fetchImpl.calls.length, 0);
});

test("queryCurrentUsage maps a live 200 and sends Bearer + ChatGPT-Account-Id", async () => {
  const fetchImpl = recordingFetch(okResponse(LIVE));
  const src = new CodexQuotaSource({ credentialsPath: writeCreds(validCreds()), fetchImpl, now: () => NOW });
  const snap = await src.queryCurrentUsage("codex/*");
  assert.equal(snap.remaining_pct, 0.6);
  assert.equal(fetchImpl.calls.length, 1);
  const h = fetchImpl.calls[0].init.headers;
  assert.equal(h.Authorization, "Bearer tok-c");
  assert.equal(h["ChatGPT-Account-Id"], "acct-1");
  assert.match(fetchImpl.calls[0].url, /chatgpt\.com\/backend-api\/wham\/usage$/);
});

test("queryCurrentUsage returns null when auth.json is missing or lacks tokens", async () => {
  const fetchImpl = recordingFetch(okResponse(LIVE));
  const missing = new CodexQuotaSource({ credentialsPath: join(tmpdir(), "no-codex", "auth.json"), fetchImpl, now: () => NOW });
  assert.equal(await missing.queryCurrentUsage("codex/*"), null);
  const noTokens = new CodexQuotaSource({ credentialsPath: writeCreds({ auth_mode: "chatgpt", tokens: {} }), fetchImpl, now: () => NOW });
  assert.equal(await noTokens.queryCurrentUsage("codex/*"), null);
  assert.equal(fetchImpl.calls.length, 0);
});

test("queryCurrentUsage degrades to null on 401 and on a network throw", async () => {
  const f401 = recordingFetch({ ok: false, status: 401, json: async () => ({}) });
  const s401 = new CodexQuotaSource({ credentialsPath: writeCreds(validCreds()), fetchImpl: f401, now: () => NOW });
  assert.equal(await s401.queryCurrentUsage("codex/*"), null);
  assert.equal(f401.calls.length, 1);

  const fThrow = recordingFetch(() => Promise.reject(new Error("ECONNREFUSED")));
  const sThrow = new CodexQuotaSource({ credentialsPath: writeCreds(validCreds()), fetchImpl: fThrow, now: () => NOW });
  assert.equal(await sThrow.queryCurrentUsage("codex/*"), null);
});

test("queryCurrentUsage caches within the TTL", async () => {
  let clock = NOW;
  const fetchImpl = recordingFetch(okResponse(LIVE));
  const src = new CodexQuotaSource({ credentialsPath: writeCreds(validCreds()), fetchImpl, now: () => clock, cacheTtlMs: 45_000 });
  await src.queryCurrentUsage("codex/*");
  clock += 10_000;
  await src.queryCurrentUsage("codex/*");
  assert.equal(fetchImpl.calls.length, 1);
  clock += 60_000;
  await src.queryCurrentUsage("codex/*");
  assert.equal(fetchImpl.calls.length, 2);
});

test("the DEFAULT fetch makes no network call under a test runner", async () => {
  const src = new CodexQuotaSource({ credentialsPath: writeCreds(validCreds()), now: () => NOW });
  assert.equal(await src.queryCurrentUsage("codex/*"), null);
});

// ---- fetchCodexUsage (reused by the OpenCode broker) ----

test("fetchCodexUsage maps with an injected token (broker reuse path)", async () => {
  const fetchImpl = recordingFetch(okResponse(LIVE));
  const snap = await fetchCodexUsage(
    { accessToken: "x", accountId: "y" },
    { fetchImpl, now: () => NOW, userAgent: "ua" },
  );
  assert.equal(snap.remaining_pct, 0.6);
});
