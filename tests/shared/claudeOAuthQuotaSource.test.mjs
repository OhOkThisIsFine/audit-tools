import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";

const { ClaudeOAuthQuotaSource, parseProviderModelKey, mapUsageToSnapshot } = await import("../../src/shared/quota/claudeOAuthQuotaSource.ts");

const NOW = Date.parse("2026-06-16T12:00:00.000Z");

// The real /usage body captured live 2026-06-16 (trimmed to mapped fields).
const LIVE_USAGE = {
  five_hour: { utilization: 10, resets_at: "2026-06-17T04:30:00.038674+00:00" },
  seven_day: { utilization: 5, resets_at: "2026-06-23T17:00:00.038699+00:00" },
  seven_day_opus: null,
  seven_day_sonnet: { utilization: 0, resets_at: null },
  limits: [
    { kind: "session", percent: 10, resets_at: "2026-06-17T04:30:00.038674+00:00", scope: null, is_active: true },
    { kind: "weekly_all", percent: 5, resets_at: "2026-06-23T17:00:00.038699+00:00", scope: null, is_active: false },
    { kind: "weekly_scoped", percent: 0, resets_at: null, scope: { model: { id: null, display_name: "Sonnet" } }, is_active: false },
  ],
};

const tmpDirs = [];
afterEach(() => {
  while (tmpDirs.length) {
    try { rmSync(tmpDirs.pop(), { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function writeCreds(creds) {
  const dir = mkdtempSync(join(tmpdir(), "claude-oauth-"));
  tmpDirs.push(dir);
  const p = join(dir, ".credentials.json");
  writeFileSync(p, JSON.stringify(creds));
  return p;
}

function validCreds(overrides = {}) {
  return { claudeAiOauth: { accessToken: "tok-abc", expiresAt: NOW + 600_000, ...overrides } };
}

function recordingFetch(response) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    if (typeof response === "function") return response(url, init);
    return response;
  };
  fn.calls = calls;
  return fn;
}

function okResponse(body) {
  return { ok: true, status: 200, json: async () => body };
}

// ---- parseProviderModelKey ----

test("parseProviderModelKey splits provider/model and normalizes wildcard/empty", () => {
  assert.deepEqual(parseProviderModelKey("claude-code/*"), { provider: "claude-code", model: null });
  assert.deepEqual(parseProviderModelKey("claude-code/"), { provider: "claude-code", model: null });
  assert.deepEqual(parseProviderModelKey("claude-code/claude-opus-4-8"), {
    provider: "claude-code",
    model: "claude-opus-4-8",
  });
  assert.deepEqual(parseProviderModelKey("codex"), { provider: "codex", model: null });
});

// ---- mapUsageToSnapshot ----

test("mapUsageToSnapshot picks the least-remaining window as a 0-1 fraction", () => {
  const snap = mapUsageToSnapshot(LIVE_USAGE, null, NOW);
  assert.equal(snap.remaining_pct, 0.9); // five_hour util 10 → 90% remaining
  assert.equal(snap.reset_at, "2026-06-17T04:30:00.038674+00:00");
  assert.equal(snap.source, "claude-oauth");
  assert.equal(snap.requests_remaining, null);
  assert.equal(snap.captured_at, new Date(NOW).toISOString());
});

test("mapUsageToSnapshot returns null when no window has a numeric utilization", () => {
  assert.equal(mapUsageToSnapshot({ five_hour: null, seven_day: null, limits: [] }, null, NOW), null);
  assert.equal(mapUsageToSnapshot({}, null, NOW), null);
});

test("mapUsageToSnapshot honors a per-model scoped limits[] entry when the model is known", () => {
  // Per-model constraint is data-driven via limits[].scope.model (no hardcoded
  // model-family names in the source — INV-QD-04).
  const body = {
    five_hour: { utilization: 10, resets_at: "r5h" },
    seven_day: { utilization: 5, resets_at: "r7d" },
    limits: [
      { percent: 80, resets_at: "r-sonnet", scope: { model: { display_name: "Sonnet" } } },
    ],
  };
  const known = mapUsageToSnapshot(body, "claude-sonnet-4-6", NOW);
  assert.equal(known.remaining_pct, 0.2); // scoped window binds at 80% util
  // Unknown model → the scoped 80% window is skipped, five_hour(10) binds.
  const unknown = mapUsageToSnapshot(body, null, NOW);
  assert.equal(unknown.remaining_pct, 0.9);
});

test("mapUsageToSnapshot lets a high limits[] entry bind over top-level windows", () => {
  const body = {
    five_hour: { utilization: 10, resets_at: "r5h" },
    limits: [{ percent: 95, resets_at: "r-crit", scope: null }],
  };
  const snap = mapUsageToSnapshot(body, null, NOW);
  assert.equal(snap.remaining_pct, 0.05);
  assert.equal(snap.reset_at, "r-crit");
});

test("mapUsageToSnapshot clamps over-cap utilization to 0 remaining", () => {
  const snap = mapUsageToSnapshot({ five_hour: { utilization: 130, resets_at: "r" } }, null, NOW);
  assert.equal(snap.remaining_pct, 0);
});

// ---- queryCurrentUsage ----

test("queryCurrentUsage returns null for a non-Claude provider without fetching", async () => {
  const fetchImpl = recordingFetch(okResponse(LIVE_USAGE));
  const src = new ClaudeOAuthQuotaSource({
    credentialsPath: writeCreds(validCreds()),
    fetchImpl,
    now: () => NOW,
  });
  assert.equal(await src.queryCurrentUsage("codex/*"), null);
  assert.equal(fetchImpl.calls.length, 0);
});

test("queryCurrentUsage maps a live 200 response and sends auth + beta headers", async () => {
  const fetchImpl = recordingFetch(okResponse(LIVE_USAGE));
  const src = new ClaudeOAuthQuotaSource({
    credentialsPath: writeCreds(validCreds()),
    fetchImpl,
    now: () => NOW,
  });
  const snap = await src.queryCurrentUsage("claude-code/*");
  assert.equal(snap.remaining_pct, 0.9);
  assert.equal(snap.source, "claude-oauth");
  assert.equal(fetchImpl.calls.length, 1);
  const headers = fetchImpl.calls[0].init.headers;
  assert.equal(headers.Authorization, "Bearer tok-abc");
  assert.equal(headers["anthropic-beta"], "oauth-2025-04-20");
});

test("queryCurrentUsage returns null when the credentials file is missing", async () => {
  const fetchImpl = recordingFetch(okResponse(LIVE_USAGE));
  const src = new ClaudeOAuthQuotaSource({
    credentialsPath: join(tmpdir(), "does-not-exist-claude", ".credentials.json"),
    fetchImpl,
    now: () => NOW,
  });
  assert.equal(await src.queryCurrentUsage("claude-code/*"), null);
  assert.equal(fetchImpl.calls.length, 0);
});

test("queryCurrentUsage returns null for an expired token without fetching", async () => {
  const fetchImpl = recordingFetch(okResponse(LIVE_USAGE));
  const src = new ClaudeOAuthQuotaSource({
    credentialsPath: writeCreds(validCreds({ expiresAt: NOW - 1 })),
    fetchImpl,
    now: () => NOW,
  });
  assert.equal(await src.queryCurrentUsage("claude-code/*"), null);
  assert.equal(fetchImpl.calls.length, 0);
});

test("queryCurrentUsage degrades to null on a 401 response", async () => {
  const fetchImpl = recordingFetch({ ok: false, status: 401, json: async () => ({}) });
  const src = new ClaudeOAuthQuotaSource({
    credentialsPath: writeCreds(validCreds()),
    fetchImpl,
    now: () => NOW,
  });
  assert.equal(await src.queryCurrentUsage("claude-code/*"), null);
  assert.equal(fetchImpl.calls.length, 1);
});

test("queryCurrentUsage degrades to null when fetch throws", async () => {
  const fetchImpl = recordingFetch(() => Promise.reject(new Error("ECONNREFUSED")));
  const src = new ClaudeOAuthQuotaSource({
    credentialsPath: writeCreds(validCreds()),
    fetchImpl,
    now: () => NOW,
  });
  assert.equal(await src.queryCurrentUsage("claude-code/*"), null);
});

test("queryCurrentUsage caches within the TTL and refetches after it elapses", async () => {
  let clock = NOW;
  const fetchImpl = recordingFetch(okResponse(LIVE_USAGE));
  const src = new ClaudeOAuthQuotaSource({
    credentialsPath: writeCreds(validCreds({ expiresAt: NOW + 3_600_000 })),
    fetchImpl,
    now: () => clock,
    cacheTtlMs: 45_000,
  });
  await src.queryCurrentUsage("claude-code/*");
  clock += 10_000; // within TTL
  await src.queryCurrentUsage("claude-code/*");
  assert.equal(fetchImpl.calls.length, 1);
  clock += 60_000; // past TTL
  await src.queryCurrentUsage("claude-code/*");
  assert.equal(fetchImpl.calls.length, 2);
});

test("queryCurrentUsage with the DEFAULT fetch makes no network call under a test runner", async () => {
  // No fetchImpl injected → usingDefaultFetch; this test process sets
  // NODE_TEST_CONTEXT → the live endpoint must be skipped (hermeticity).
  const src = new ClaudeOAuthQuotaSource({
    credentialsPath: writeCreds(validCreds()),
    now: () => NOW,
  });
  assert.equal(await src.queryCurrentUsage("claude-code/*"), null);
});

test("AUDIT_TOOLS_DISABLE_PROACTIVE_QUOTA disables the source even with an injected fetch", async () => {
  const prev = process.env.AUDIT_TOOLS_DISABLE_PROACTIVE_QUOTA;
  process.env.AUDIT_TOOLS_DISABLE_PROACTIVE_QUOTA = "1";
  try {
    const fetchImpl = recordingFetch(okResponse(LIVE_USAGE));
    const src = new ClaudeOAuthQuotaSource({
      credentialsPath: writeCreds(validCreds()),
      fetchImpl,
      now: () => NOW,
    });
    assert.equal(await src.queryCurrentUsage("claude-code/*"), null);
    assert.equal(fetchImpl.calls.length, 0);
  } finally {
    if (prev === undefined) delete process.env.AUDIT_TOOLS_DISABLE_PROACTIVE_QUOTA;
    else process.env.AUDIT_TOOLS_DISABLE_PROACTIVE_QUOTA = prev;
  }
});
