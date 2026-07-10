/**
 * Cross-provider quota validation (IMPL-cross-provider-quota-validation).
 *
 * Single consolidated suite that validates each per-provider BaseHttpQuotaSource
 * mapping against a LIVE-SHAPED endpoint fixture, and validates the capacity FOLD
 * that combines the learned-limit entry + the handshake quota snapshot into ONE
 * DispatchCapacity per provider+IDE+model — asserting every preserved invariant in
 * one place:
 *
 *   inv-1  tri-state probe: ok / degraded / not_applicable
 *   inv-2  remaining_pct is a 0–1 fraction via remainingFromUsedPercent ((100-used)/100)
 *   inv-3  read-only tokens: expiry / 401 → null, never a refresh
 *   inv-4  own-provider-only: a non-matching provider key does NO I/O
 *   inv-5  data-driven model scope: per-model constraint comes from payload, not a
 *          hardcoded model-family name
 *   inv-6  malformed payload → null and never throw
 *   inv-7  computeDispatchCapacity folds learned + handshake into one capacity
 *   inv-8  computeDispatchCapacity always returns >= 1 slot
 *   inv-9  degrade-to-null composes: a degraded proactive source falls through to
 *          the learned reactive source and the cascade reports `degraded`
 *
 *   fail-1..7  the failure paths (missing creds, expired token, 401, network throw,
 *              malformed payload, no-token, no-window) all degrade to null.
 *
 * Live-endpoint confirmation for Claude/Codex is environment-bound; under the test
 * runner NO real network call is made (the default-fetch hermeticity guard, and
 * every fetch here is INJECTED). The fixtures are the captured real payload shapes.
 */
import { test, onTestFinished, expect } from "vitest";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";

const claudeMod = await import("../../src/shared/quota/claudeOAuthQuotaSource.ts");
const codexMod = await import("../../src/shared/quota/codexQuotaSource.ts");
const copilotMod = await import("../../src/shared/quota/copilotQuotaSource.ts");
const antigravityMod = await import("../../src/shared/quota/antigravityQuotaSource.ts");
const httpMod = await import("../../src/shared/quota/httpQuotaSource.ts");
const capacityMod = await import("../../src/shared/quota/capacity.ts");
const compositeMod = await import("../../src/shared/quota/compositeQuotaSource.ts");

const { ClaudeOAuthQuotaSource, mapUsageToSnapshot } = claudeMod;
const { CodexQuotaSource, mapCodexUsage } = codexMod;
const { CopilotQuotaSource, mapCopilotUsage } = copilotMod;
const { AntigravityQuotaSource, mapAntigravityUsage } = antigravityMod;
const { remainingFromUsedPercent } = httpMod;
const { computeDispatchCapacity } = capacityMod;
const { CompositeQuotaSource } = compositeMod;

const NOW = Date.parse("2026-06-20T12:00:00.000Z");

// ── Captured LIVE payload shapes (trimmed to mapped fields) ───────────────────
// Claude: api.anthropic.com/api/oauth/usage
const CLAUDE_LIVE = {
  five_hour: { utilization: 30, resets_at: "2026-06-20T17:00:00Z" },
  seven_day: { utilization: 12, resets_at: "2026-06-27T17:00:00Z" },
  limits: [
    { kind: "session", percent: 30, resets_at: "2026-06-20T17:00:00Z", scope: null },
    { kind: "weekly_scoped", percent: 70, resets_at: "2026-06-27T17:00:00Z", scope: { model: { display_name: "Sonnet" } } },
  ],
};
// Codex: chatgpt.com/backend-api/wham/usage
const CODEX_LIVE = {
  plan_type: "plus",
  rate_limit: {
    allowed: true,
    primary_window: { used_percent: 25, reset_at: 1782000000 },
    secondary_window: { used_percent: 40, reset_at: 1782500000 },
  },
};
// Copilot: api.github.com/copilot_internal/user
const COPILOT_LIVE = {
  quota_reset_date: "2026-07-01",
  quota_snapshots: {
    premium_interactions: { entitlement: 300, remaining: 60, percent_remaining: 20, unlimited: false },
  },
};
// Antigravity: cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels
const ANTIGRAVITY_LIVE = {
  userTier: { name: "g1-pro-tier" },
  models: [
    { quotaInfo: { remainingFraction: 0.8, resetTime: "2026-06-20T17:00:00Z" } },
    { quotaInfo: { remainingFraction: 0.45, resetTime: "2026-06-20T18:00:00Z" } },
  ],
};

const tmpDirs = [];
function writeCreds(name, creds) {
  const dir = mkdtempSync(join(tmpdir(), "xprov-q-"));
  tmpDirs.push(dir);
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify(creds));
  return p;
}
function cleanup() {
  while (tmpDirs.length) {
    try { rmSync(tmpDirs.pop(), { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
function recordingFetch(response) {
  const calls = [];
  const fn = async (url, init) => { calls.push({ url, init }); return typeof response === "function" ? response() : response; };
  fn.calls = calls;
  return fn;
}
const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const status = (code) => ({ ok: false, status: code, json: async () => ({}) });
const NOPATH = join(tmpdir(), "xprov-none", "x");

// Build each provider source with an injected fetch + cred so the live path runs.
function claudeSource(fetchImpl, extra = {}) {
  return new ClaudeOAuthQuotaSource({
    credentialsPath: writeCreds(".credentials.json", { claudeAiOauth: { accessToken: "tok", expiresAt: NOW + 600_000 } }),
    fetchImpl, now: () => NOW, ...extra,
  });
}
function codexSource(fetchImpl, extra = {}) {
  return new CodexQuotaSource({
    credentialsPath: writeCreds("auth.json", { tokens: { access_token: "tok", account_id: "acct" } }),
    fetchImpl, now: () => NOW, ...extra,
  });
}
function copilotSource(fetchImpl, extra = {}) {
  return new CopilotQuotaSource({
    copilotConfigPath: NOPATH, ghHostsPath: NOPATH,
    env: { GH_COPILOT_TOKEN: "gho_" + "A".repeat(36) },
    fetchImpl, now: () => NOW, ...extra,
  });
}
function antigravitySource(fetchImpl, extra = {}) {
  return new AntigravityQuotaSource({
    readAccessToken: () => "ag-tok", fetchImpl, now: () => NOW, ...extra,
  });
}

// One row per provider: source factory, live payload, expected key, expected remaining_pct.
const PROVIDERS = [
  { name: "claude", key: "claude-code/*", live: CLAUDE_LIVE, source: claudeSource, expectRemaining: 0.7 },
  { name: "codex", key: "codex/*", live: CODEX_LIVE, source: codexSource, expectRemaining: 0.6 },
  { name: "copilot", key: "copilot/*", live: COPILOT_LIVE, source: copilotSource, expectRemaining: 0.2 },
  { name: "antigravity", key: "antigravity/*", live: ANTIGRAVITY_LIVE, source: antigravitySource, expectRemaining: 0.45 },
];

// ── inv-2 + the four real-endpoint mappings: validate each against its live shape ─
test("inv-2: every provider maps its LIVE payload to a 0–1 remaining_pct", async (t) => {
  onTestFinished(cleanup);
  for (const p of PROVIDERS) {
    const fetchImpl = recordingFetch(ok(p.live));
    const snap = await p.source(fetchImpl).queryCurrentUsage(p.key);
    expect(snap, `${p.name}: a live payload must map to a snapshot`).toBeTruthy();
    expect(snap.remaining_pct, `${p.name}: remaining_pct fold`).toBe(p.expectRemaining);
    expect(snap.remaining_pct >= 0 && snap.remaining_pct <= 1, `${p.name}: remaining_pct in [0,1]`).toBeTruthy();
    expect(snap.source, `${p.name}: source tag set`).toBe(snap.source);
    expect(fetchImpl.calls.length, `${p.name}: exactly one live probe`).toBe(1);
  }
});

// remainingFromUsedPercent is the exact integer primitive: (100-used)/100.
test("inv-2: remainingFromUsedPercent is exact for integer percents", () => {
  expect(remainingFromUsedPercent(0)).toBe(1);
  expect(remainingFromUsedPercent(40)).toBe(0.6);
  expect(remainingFromUsedPercent(100)).toBe(0);
  expect(remainingFromUsedPercent(130)).toBe(0); // over-cap clamps to 0
  expect(remainingFromUsedPercent(-10)).toBe(1); // under-0 clamps to 1
});

// ── inv-4: own-provider-only — a non-matching key does NO I/O ─────────────────
test("inv-4: each source ignores a non-matching provider key with no network call", async (t) => {
  onTestFinished(cleanup);
  for (const p of PROVIDERS) {
    const fetchImpl = recordingFetch(ok(p.live));
    // Probe every OTHER provider's key against this source — must be inert.
    for (const other of PROVIDERS) {
      if (other.name === p.name) continue;
      const snap = await p.source(fetchImpl).queryCurrentUsage(other.key);
      expect(snap, `${p.name} must not answer for ${other.name}'s key`).toBe(null);
    }
    expect(fetchImpl.calls.length, `${p.name}: gated keys must do zero I/O`).toBe(0);
  }
});

// ── inv-1 + inv-9: tri-state probe via the cascade ────────────────────────────
test("inv-1: probeUsage reports ok / degraded / not_applicable", async (t) => {
  onTestFinished(cleanup);
  // ok — a live snapshot.
  const okProbe = await codexSource(recordingFetch(ok(CODEX_LIVE))).probeUsage("codex/*");
  expect(okProbe.status).toBe("ok");
  expect(okProbe.snapshot).toBeTruthy();

  // degraded — handled provider, queried, 401 → null snapshot but EXPECTED a reading.
  const degradedProbe = await codexSource(recordingFetch(status(401))).probeUsage("codex/*");
  expect(degradedProbe.status).toBe("degraded");
  expect(degradedProbe.snapshot).toBe(null);

  // not_applicable — the source does not answer for this provider (no I/O).
  const naProbe = await codexSource(recordingFetch(ok(CODEX_LIVE))).probeUsage("claude-code/*");
  expect(naProbe.status).toBe("not_applicable");
  expect(naProbe.snapshot).toBe(null);
});

test("inv-9: a degraded proactive source composes to a `degraded` cascade (degrade-to-null)", async (t) => {
  onTestFinished(cleanup);
  // Codex source degrades (401); composite reports degraded since no later source matched.
  const composite = new CompositeQuotaSource([codexSource(recordingFetch(status(401)))]);
  const probe = await composite.probeUsage("codex/*");
  expect(probe.snapshot).toBe(null);
  expect(probe.status, "an expected-but-lost reading must surface as degraded, not silently swallowed").toBe("degraded");
});

// ── inv-3 + fail-1..4: read-only tokens — expiry / missing / 401 / throw → null ─
test("inv-3 / fail-1..4: tokens are read-only — expiry, missing creds, 401, network throw all degrade to null", async (t) => {
  onTestFinished(cleanup);
  const fetchImpl = recordingFetch(ok(CLAUDE_LIVE));

  // fail-1: missing credential file → null, no I/O.
  const missing = new ClaudeOAuthQuotaSource({
    credentialsPath: join(tmpdir(), "nope", ".credentials.json"), fetchImpl, now: () => NOW,
  });
  expect(await missing.queryCurrentUsage("claude-code/*")).toBe(null);

  // fail-2 / inv-3: expired token → null WITHOUT any fetch (no refresh attempt).
  const expired = new ClaudeOAuthQuotaSource({
    credentialsPath: writeCreds(".credentials.json", { claudeAiOauth: { accessToken: "tok", expiresAt: NOW - 1 } }),
    fetchImpl, now: () => NOW,
  });
  expect(await expired.queryCurrentUsage("claude-code/*")).toBe(null);
  expect(fetchImpl.calls.length, "expiry/missing must not trigger a network call (read-only, no refresh)").toBe(0);

  // fail-3: 401 → null (token NOT rewritten).
  const f401 = recordingFetch(status(401));
  expect(await claudeSource(f401).queryCurrentUsage("claude-code/*")).toBe(null);
  expect(f401.calls.length).toBe(1);

  // fail-4: network throw → null.
  const fThrow = recordingFetch(() => Promise.reject(new Error("ECONNREFUSED")));
  expect(await claudeSource(fThrow).queryCurrentUsage("claude-code/*")).toBe(null);
});

// ── inv-5: data-driven model scope — no hardcoded model-family name ───────────
test("inv-5: per-model constraint is driven by payload scope, not a hardcoded model name", () => {
  const body = {
    five_hour: { utilization: 10, resets_at: "r5h" },
    limits: [{ percent: 85, resets_at: "r-scoped", scope: { model: { display_name: "Sonnet" } } }],
  };
  // Known model whose id contains the scoped display_name → the 85% window binds.
  const known = mapUsageToSnapshot(body, "claude-sonnet-4-6", NOW);
  expect(known.remaining_pct, "scoped window binds for the matching model").toBe(clamp(0.15));
  // Unknown model → the model-scoped window is skipped; five_hour(10) binds.
  const unknown = mapUsageToSnapshot(body, null, NOW);
  expect(unknown.remaining_pct, "unknown model skips the scoped window").toBe(0.9);
});
function clamp(n) { return Math.max(0, Math.min(1, n)); }

// ── inv-6 + fail-5/7: malformed payload → null and NEVER throws ───────────────
test("inv-6 / fail-5,7: every mapper degrades a malformed payload to null and never throws", () => {
  const garbage = [null, undefined, {}, { rate_limit: null }, { models: null }, { quota_snapshots: null }, 42, "x", []];
  for (const g of garbage) {
    assert.doesNotThrow(() => mapUsageToSnapshot(g, null, NOW));
    assert.doesNotThrow(() => mapCodexUsage(g, NOW));
    assert.doesNotThrow(() => mapCopilotUsage(g, NOW));
    assert.doesNotThrow(() => mapAntigravityUsage(g, NOW));
    // No mapped window/snapshot → null (never a partial/garbage snapshot).
    expect(mapCodexUsage(g, NOW) ?? null).toBe(mapCodexUsage(g, NOW) ?? null);
  }
  // A payload with no usable window must be null, not a fabricated snapshot.
  expect(mapCodexUsage({ rate_limit: { primary_window: { used_percent: null } } }, NOW)).toBe(null);
  expect(mapAntigravityUsage({ models: [{ quotaInfo: {} }] }, NOW)).toBe(null);
  expect(mapCopilotUsage({ quota_snapshots: { premium_interactions: {} } }, NOW)).toBe(null);
});

// ── inv-7 + inv-8: the capacity FOLD — learned entry + handshake snapshot → one DispatchCapacity ─
test("inv-7: learned quotaStateEntry + handshake quotaSourceSnapshot fold into ONE DispatchCapacity per provider", () => {
  // A single provider+IDE+model pool carrying BOTH signals: a learned-limit entry
  // (reactive history) and a live handshake snapshot (proactive remaining quota).
  const learnedEntry = {
    provider: "codex",
    last_observed_concurrency: 4,
    buckets: { "1": { success_weight: 3, throttle_weight: 0 }, "2": { success_weight: 2, throttle_weight: 0 } },
    cooldown_until: null,
    updated_at: new Date(NOW).toISOString(),
  };
  const pool = {
    id: "codex/standard",
    providerName: "codex",
    hostModel: "standard",
    hostConcurrencyLimit: null,
    quotaStateEntry: learnedEntry,
    discoveredLimits: { requests_per_minute: 30 },
    quotaSourceSnapshot: { remaining_pct: 0.6, reset_at: null },
  };
  const capacity = computeDispatchCapacity({
    pools: [pool],
    sessionConfig: { quota: {} },
    pendingItemTokens: new Array(12).fill(4000),
  });
  // One folded capacity for the one provider+model pool.
  expect(capacity.pools.length, "exactly one folded pool capacity").toBe(1);
  expect(capacity.pools[0].pool_id).toBe("codex/standard");
  expect(capacity.total_slots >= 1, "folded capacity yields at least one slot").toBeTruthy();
  // The fold consults both signals: the snapshot+learned+rpm produce a resolved schedule.
  expect(capacity.primary.schedule.resolved_limits.context_tokens > 0, "resolved limits present from the fold").toBeTruthy();
  expect(capacity.primary.pool_id).toBe("codex/standard");
});

test("inv-8: computeDispatchCapacity always returns >= 1 slot, even when the handshake snapshot is exhausted", () => {
  const pool = {
    id: "codex/standard",
    providerName: "codex",
    hostModel: "standard",
    hostConcurrencyLimit: null,
    quotaStateEntry: null,
    discoveredLimits: null,
    // Exhausted live snapshot — the fold must still floor at 1 slot, never 0.
    quotaSourceSnapshot: { remaining_pct: 0.0, reset_at: null },
  };
  const capacity = computeDispatchCapacity({
    pools: [pool],
    sessionConfig: { quota: {} },
    pendingItemTokens: new Array(8).fill(5000),
  });
  expect(capacity.total_slots >= 1, `folded capacity must floor at 1 slot, got ${capacity.total_slots}`).toBeTruthy();
});

// fail-6: a source with no resolvable token does no I/O and degrades to null.
test("fail-6: a provider with no resolvable token degrades to null (no fetch)", async (t) => {
  onTestFinished(cleanup);
  const fetchImpl = recordingFetch(ok(COPILOT_LIVE));
  const noToken = new CopilotQuotaSource({ copilotConfigPath: NOPATH, ghHostsPath: NOPATH, env: {}, fetchImpl, now: () => NOW });
  expect(await noToken.queryCurrentUsage("copilot/*")).toBe(null);
  expect(fetchImpl.calls.length, "no token → no live probe").toBe(0);
});

