import { test, expect } from "vitest";
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
  expect(snap.remaining_pct).toBe(0.3);
  expect(snap.reset_at).toBe(new Date(Date.parse("2026-06-17T05:00:00Z")).toISOString());
  expect(snap.source).toBe("antigravity");
});

test("mapAntigravityUsage returns null when no model has a numeric remainingFraction", () => {
  expect(mapAntigravityUsage({ models: [{ quotaInfo: null }, {}] }, NOW)).toBe(null);
  expect(mapAntigravityUsage({}, NOW)).toBe(null);
});

// ---- queryCurrentUsage ----

test("queryCurrentUsage returns null for a non-Antigravity provider without fetching", async () => {
  const fetchImpl = recordingFetch(ok(LIVE));
  const src = new AntigravityQuotaSource({ readAccessToken: () => "tok", fetchImpl, now: () => NOW });
  expect(await src.queryCurrentUsage("codex/*")).toBe(null);
  expect(fetchImpl.calls.length).toBe(0);
});

test("queryCurrentUsage POSTs fetchAvailableModels with Bearer + antigravity UA", async () => {
  const fetchImpl = recordingFetch(ok(LIVE));
  const src = new AntigravityQuotaSource({ readAccessToken: () => "tok", project: "proj-1", fetchImpl, now: () => NOW });
  const snap = await src.queryCurrentUsage("antigravity/*");
  expect(snap.remaining_pct).toBe(0.3);
  const c = fetchImpl.calls[0];
  expect(c.url).toMatch(/v1internal:fetchAvailableModels$/);
  expect(c.init.method).toBe("POST");
  expect(c.init.headers.Authorization).toBe("Bearer tok");
  expect(c.init.headers["User-Agent"]).toBe("antigravity");
  expect(c.init.body).toBe(JSON.stringify({ project: "proj-1" }));
});

test("reads the token from ANTIGRAVITY_ACCESS_TOKEN env (default reader)", async () => {
  const fetchImpl = recordingFetch(ok(LIVE));
  const src = new AntigravityQuotaSource({ env: { ANTIGRAVITY_ACCESS_TOKEN: "tok-env" }, stateDbPath: NOPATH, fetchImpl, now: () => NOW });
  const snap = await src.queryCurrentUsage("antigravity/*");
  expect(snap.remaining_pct).toBe(0.3);
  expect(fetchImpl.calls[0].init.headers.Authorization).toBe("Bearer tok-env");
});

test("degrades to null when no token resolves (no fetch)", async () => {
  const fetchImpl = recordingFetch(ok(LIVE));
  const src = new AntigravityQuotaSource({ readAccessToken: () => null, fetchImpl, now: () => NOW });
  expect(await src.queryCurrentUsage("antigravity/*")).toBe(null);
  expect(fetchImpl.calls.length).toBe(0);
});

test("degrades to null on 401", async () => {
  const fetchImpl = recordingFetch({ ok: false, status: 401, json: async () => ({}) });
  const src = new AntigravityQuotaSource({ readAccessToken: () => "tok", fetchImpl, now: () => NOW });
  expect(await src.queryCurrentUsage("antigravity/*")).toBe(null);
  expect(fetchImpl.calls.length).toBe(1);
});

test("the DEFAULT fetch makes no network call under a test runner", async () => {
  const src = new AntigravityQuotaSource({ env: { ANTIGRAVITY_ACCESS_TOKEN: "tok" }, stateDbPath: NOPATH, now: () => NOW });
  expect(await src.queryCurrentUsage("antigravity/*")).toBe(null);
});

test("fetchAntigravityUsage sends {} body when no project + maps", async () => {
  const fetchImpl = recordingFetch(ok(LIVE));
  const snap = await fetchAntigravityUsage({ accessToken: "t" }, { fetchImpl, now: () => NOW, userAgent: "antigravity" });
  expect(snap.remaining_pct).toBe(0.3);
  expect(fetchImpl.calls[0].init.body).toBe("{}");
});
