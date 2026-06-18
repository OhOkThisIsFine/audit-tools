import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { AntigravityQuotaSource, mapAntigravityUsage, fetchAntigravityUsage } = await import("../../src/shared/quota/antigravityQuotaSource.ts");

const NOW = Date.parse("2026-06-16T12:00:00.000Z");
const NOPATH = join(tmpdir(), "antigravity-none", "state.vscdb");

const LIVE = {
  userTier: { name: "g1-pro-tier" },
  models: [
    { quotaInfo: { remainingFraction: 0.8, resetTime: "2026-06-17T04:30:00Z" } },
    { quotaInfo: { remainingFraction: 0.3, resetTime: "2026-06-17T05:00:00Z" } },
    { quotaInfo: null },
  ],
};

function recordingFetch(response) {
  const calls = [];
  const fn = async (url, init) => { calls.push({ url, init }); return typeof response === "function" ? response() : response; };
  fn.calls = calls;
  return fn;
}
const ok = (body) => ({ ok: true, status: 200, json: async () => body });

// ---- mapAntigravityUsage ----

test("mapAntigravityUsage binds on the least-remaining model", () => {
  const snap = mapAntigravityUsage(LIVE, NOW);
  assert.equal(snap.remaining_pct, 0.3);
  assert.equal(snap.reset_at, new Date(Date.parse("2026-06-17T05:00:00Z")).toISOString());
  assert.equal(snap.source, "antigravity");
});

test("mapAntigravityUsage returns null when no model has a numeric remainingFraction", () => {
  assert.equal(mapAntigravityUsage({ models: [{ quotaInfo: null }, {}] }, NOW), null);
  assert.equal(mapAntigravityUsage({}, NOW), null);
});

// ---- queryCurrentUsage ----

test("queryCurrentUsage returns null for a non-Antigravity provider without fetching", async () => {
  const fetchImpl = recordingFetch(ok(LIVE));
  const src = new AntigravityQuotaSource({ readAccessToken: () => "tok", fetchImpl, now: () => NOW });
  assert.equal(await src.queryCurrentUsage("codex/*"), null);
  assert.equal(fetchImpl.calls.length, 0);
});

test("queryCurrentUsage POSTs fetchAvailableModels with Bearer + antigravity UA", async () => {
  const fetchImpl = recordingFetch(ok(LIVE));
  const src = new AntigravityQuotaSource({ readAccessToken: () => "tok", project: "proj-1", fetchImpl, now: () => NOW });
  const snap = await src.queryCurrentUsage("antigravity/*");
  assert.equal(snap.remaining_pct, 0.3);
  const c = fetchImpl.calls[0];
  assert.match(c.url, /v1internal:fetchAvailableModels$/);
  assert.equal(c.init.method, "POST");
  assert.equal(c.init.headers.Authorization, "Bearer tok");
  assert.equal(c.init.headers["User-Agent"], "antigravity");
  assert.equal(c.init.body, JSON.stringify({ project: "proj-1" }));
});

test("reads the token from ANTIGRAVITY_ACCESS_TOKEN env (default reader)", async () => {
  const fetchImpl = recordingFetch(ok(LIVE));
  const src = new AntigravityQuotaSource({ env: { ANTIGRAVITY_ACCESS_TOKEN: "tok-env" }, stateDbPath: NOPATH, fetchImpl, now: () => NOW });
  const snap = await src.queryCurrentUsage("antigravity/*");
  assert.equal(snap.remaining_pct, 0.3);
  assert.equal(fetchImpl.calls[0].init.headers.Authorization, "Bearer tok-env");
});

test("degrades to null when no token resolves (no fetch)", async () => {
  const fetchImpl = recordingFetch(ok(LIVE));
  const src = new AntigravityQuotaSource({ readAccessToken: () => null, fetchImpl, now: () => NOW });
  assert.equal(await src.queryCurrentUsage("antigravity/*"), null);
  assert.equal(fetchImpl.calls.length, 0);
});

test("degrades to null on 401", async () => {
  const fetchImpl = recordingFetch({ ok: false, status: 401, json: async () => ({}) });
  const src = new AntigravityQuotaSource({ readAccessToken: () => "tok", fetchImpl, now: () => NOW });
  assert.equal(await src.queryCurrentUsage("antigravity/*"), null);
  assert.equal(fetchImpl.calls.length, 1);
});

test("the DEFAULT fetch makes no network call under a test runner", async () => {
  const src = new AntigravityQuotaSource({ env: { ANTIGRAVITY_ACCESS_TOKEN: "tok" }, stateDbPath: NOPATH, now: () => NOW });
  assert.equal(await src.queryCurrentUsage("antigravity/*"), null);
});

test("fetchAntigravityUsage sends {} body when no project + maps", async () => {
  const fetchImpl = recordingFetch(ok(LIVE));
  const snap = await fetchAntigravityUsage({ accessToken: "t" }, { fetchImpl, now: () => NOW, userAgent: "antigravity" });
  assert.equal(snap.remaining_pct, 0.3);
  assert.equal(fetchImpl.calls[0].init.body, "{}");
});
