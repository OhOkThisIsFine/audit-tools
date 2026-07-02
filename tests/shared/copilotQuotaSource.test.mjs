import { test, afterEach, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";

const { CopilotQuotaSource, mapCopilotUsage, fetchCopilotUsage, resolveGhHostsPath } = await import("../../src/shared/quota/copilotQuotaSource.ts");

const NOW = Date.parse("2026-06-16T12:00:00.000Z");
const GHO = "gho_" + "A".repeat(36);

const LIVE = {
  quota_reset_date: "2026-07-01",
  quota_snapshots: {
    premium_interactions: { entitlement: 300, remaining: 75, percent_remaining: 25, unlimited: false },
    chat: { unlimited: true },
  },
};

const tmpDirs = [];
afterEach(() => {
  while (tmpDirs.length) {
    try { rmSync(tmpDirs.pop(), { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
function tmp(name, content) {
  const dir = mkdtempSync(join(tmpdir(), "copilot-q-"));
  tmpDirs.push(dir);
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
}
function recordingFetch(response) {
  const calls = [];
  const fn = async (url, init) => { calls.push({ url, init }); return typeof response === "function" ? response() : response; };
  fn.calls = calls;
  return fn;
}
const ok = (body) => ({ ok: true, status: 200, json: async () => body });
// A config path that doesn't exist, so token-source tests are isolated to what we pass.
const NOPATH = join(tmpdir(), "copilot-none", "x");

// ---- mapCopilotUsage ----

test("mapCopilotUsage uses premium_interactions percent_remaining", () => {
  const snap = mapCopilotUsage(LIVE, NOW);
  expect(snap.remaining_pct).toBe(0.25);
  expect(snap.reset_at).toBe(new Date(Date.parse("2026-07-01")).toISOString());
  expect(snap.requests_remaining).toBe(75);
  expect(snap.source).toBe("copilot");
});

test("mapCopilotUsage treats unlimited as full and falls back to entitlement ratio / chat", () => {
  expect(mapCopilotUsage({ quota_snapshots: { premium_interactions: { unlimited: true } } }, NOW).remaining_pct).toBe(1);
  expect(mapCopilotUsage({ quota_snapshots: { premium_interactions: { entitlement: 300, remaining: 75 } } }, NOW).remaining_pct).toBe(0.25);
  expect(mapCopilotUsage({ quota_snapshots: { chat: { percent_remaining: 50 } } }, NOW).remaining_pct).toBe(0.5);
  expect(mapCopilotUsage({ quota_snapshots: {} }, NOW)).toBe(null);
});

// ---- resolveGhHostsPath (OS-agnostic gh config dir) ----

test("resolveGhHostsPath is OS-agnostic: Windows AppData, Unix ~/.config, GH_CONFIG_DIR override", () => {
  const norm = (s) => s.replace(/\\/g, "/");
  // Unix default → ~/.config/gh/hosts.yml
  expect(norm(resolveGhHostsPath({}, "linux", "/home/u"))).toMatch(/^\/home\/u\/\.config\/gh\/hosts\.yml$/);
  // Windows default → %AppData%\GitHub CLI\hosts.yml (this is the bug the live probe found)
  expect(norm(resolveGhHostsPath({ APPDATA: "C:\\Users\\u\\AppData\\Roaming" }, "win32", "C:\\Users\\u"))).toMatch(/AppData\/Roaming\/GitHub CLI\/hosts\.yml$/);
  // Windows with no APPDATA env still derives a GitHub CLI dir under the home tree
  expect(norm(resolveGhHostsPath({}, "win32", "C:\\Users\\u"))).toMatch(/GitHub CLI\/hosts\.yml$/);
  // GH_CONFIG_DIR wins on any platform
  expect(norm(resolveGhHostsPath({ GH_CONFIG_DIR: "/custom/gh" }, "linux", "/home/u"))).toMatch(/^\/custom\/gh\/hosts\.yml$/);
});

// ---- queryCurrentUsage ----

test("queryCurrentUsage returns null for a non-Copilot provider without fetching", async () => {
  const fetchImpl = recordingFetch(ok(LIVE));
  const src = new CopilotQuotaSource({ copilotConfigPath: tmp("config.json", JSON.stringify({ token: GHO })), ghHostsPath: NOPATH, fetchImpl, now: () => NOW, env: {} });
  expect(await src.queryCurrentUsage("claude-code/*")).toBe(null);
  expect(fetchImpl.calls.length).toBe(0);
});

test("reads the gho token from the Copilot CLI config and maps a 200", async () => {
  const fetchImpl = recordingFetch(ok(LIVE));
  const src = new CopilotQuotaSource({
    copilotConfigPath: tmp("config.json", JSON.stringify({ github: { oauth_token: GHO } })),
    ghHostsPath: NOPATH, fetchImpl, now: () => NOW, env: {},
  });
  const snap = await src.queryCurrentUsage("copilot/*");
  expect(snap.remaining_pct).toBe(0.25);
  expect(fetchImpl.calls[0].init.headers.Authorization).toBe(`Bearer ${GHO}`);
  expect(fetchImpl.calls[0].url).toMatch(/copilot_internal\/user$/);
});

test("reads the gho token from the gh CLI hosts.yml", async () => {
  const fetchImpl = recordingFetch(ok(LIVE));
  const src = new CopilotQuotaSource({
    copilotConfigPath: NOPATH,
    ghHostsPath: tmp("hosts.yml", `github.com:\n  oauth_token: ${GHO}\n  user: testuser\n`),
    fetchImpl, now: () => NOW, env: {},
  });
  expect((await src.queryCurrentUsage("github-copilot/*")).remaining_pct).toBe(0.25);
});

test("honors an explicit GH_COPILOT_TOKEN env over files", async () => {
  const fetchImpl = recordingFetch(ok(LIVE));
  const src = new CopilotQuotaSource({ copilotConfigPath: NOPATH, ghHostsPath: NOPATH, fetchImpl, now: () => NOW, env: { GH_COPILOT_TOKEN: GHO } });
  expect((await src.queryCurrentUsage("copilot/*")).remaining_pct).toBe(0.25);
});

test("degrades to null when no gho token can be found (no fetch)", async () => {
  const fetchImpl = recordingFetch(ok(LIVE));
  const src = new CopilotQuotaSource({ copilotConfigPath: NOPATH, ghHostsPath: NOPATH, fetchImpl, now: () => NOW, env: {} });
  expect(await src.queryCurrentUsage("copilot/*")).toBe(null);
  expect(fetchImpl.calls.length).toBe(0);
});

test("degrades to null on 401", async () => {
  const fetchImpl = recordingFetch({ ok: false, status: 401, json: async () => ({}) });
  const src = new CopilotQuotaSource({ copilotConfigPath: tmp("config.json", JSON.stringify({ token: GHO })), ghHostsPath: NOPATH, fetchImpl, now: () => NOW, env: {} });
  expect(await src.queryCurrentUsage("copilot/*")).toBe(null);
  expect(fetchImpl.calls.length).toBe(1);
});

test("the DEFAULT fetch makes no network call under a test runner", async () => {
  const src = new CopilotQuotaSource({ copilotConfigPath: tmp("config.json", JSON.stringify({ token: GHO })), ghHostsPath: NOPATH, now: () => NOW, env: { GH_COPILOT_TOKEN: GHO } });
  expect(await src.queryCurrentUsage("copilot/*")).toBe(null);
});

test("fetchCopilotUsage maps with an injected token (broker reuse path)", async () => {
  const fetchImpl = recordingFetch(ok(LIVE));
  const snap = await fetchCopilotUsage({ token: GHO }, { fetchImpl, now: () => NOW, userAgent: "ua" });
  expect(snap.remaining_pct).toBe(0.25);
});
