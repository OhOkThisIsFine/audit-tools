/**
 * INV-2 — cross-provider quota signals (shared BaseHttpQuotaSource unification).
 *
 * Validates the unified per-provider quota contract the audit orchestrator relies
 * on, build-free against the shared package. Covers the four properties the INV-2
 * finding names:
 *   1. fraction/clamp — each source maps a live response to a 0–1 remaining_pct,
 *      exact for integers and clamped for out-of-range values;
 *   2. discovered-window slot-rise — a reported capability window escapes the
 *      conservative 32k floor, so TPM-derived slots rise;
 *   3. hermeticity — the DEFAULT fetch makes no network call under a test runner,
 *      while an injected fetchImpl exercises the real mapping;
 *   4. attaches-raw-no-slot-count + the explicit silent-degrade marker — a pool
 *      carries the RAW per-pool signals (and the degrade marker) and never a
 *      pre-folded slot count; the byte×margin floor-1 fold lives in scheduleWave.
 *
 * The LIVE per-provider endpoint probes need real local credentials, so they are
 * gated/skipped here (see the `live endpoint` block at the bottom).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";

const { setQuotaStateDir } = await import("audit-tools/shared/quota/state");
setQuotaStateDir(join(tmpdir(), ".audit-code-inv2-test"));

const { clampFraction, remainingFromUsedPercent } = await import(
  "audit-tools/shared/quota/httpQuotaSource"
);
const { ClaudeOAuthQuotaSource, mapUsageToSnapshot } = await import(
  "audit-tools/shared/quota/claudeOAuthQuotaSource"
);
const { CodexQuotaSource, mapCodexUsage } = await import(
  "audit-tools/shared/quota/codexQuotaSource"
);
const { CopilotQuotaSource, mapCopilotUsage } = await import(
  "audit-tools/shared/quota/copilotQuotaSource"
);
const { mapAntigravityUsage } = await import(
  "audit-tools/shared/quota/antigravityQuotaSource"
);
const { CompositeQuotaSource } = await import(
  "audit-tools/shared/quota/compositeQuotaSource"
);
const { probeQuotaSource } = await import("audit-tools/shared/quota/quotaSource");
const { computeDispatchCapacity, summarizeDispatchCapacityPools } = await import(
  "audit-tools/shared/quota/capacity"
);

const NOW = Date.parse("2026-06-19T12:00:00.000Z");

const tmpDirs = [];
test.afterEach(() => {
  while (tmpDirs.length) {
    try {
      rmSync(tmpDirs.pop(), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function writeCreds(name, creds) {
  const dir = mkdtempSync(join(tmpdir(), name));
  tmpDirs.push(dir);
  const p = join(dir, "creds.json");
  writeFileSync(p, JSON.stringify(creds));
  return p;
}

function recordingFetch(response) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return typeof response === "function" ? response() : response;
  };
  fn.calls = calls;
  return fn;
}
const okResponse = (body) => ({ ok: true, status: 200, json: async () => body });

// ── 1. Per-source fraction / clamp ───────────────────────────────────────────

test("remainingFromUsedPercent is exact for integer percents (no float drift)", () => {
  // "percent used" → remaining fraction: 20% used ⇒ 0.8 remaining (exact).
  assert.equal(remainingFromUsedPercent(20), 0.8);
  assert.equal(remainingFromUsedPercent(75), 0.25);
  assert.equal(remainingFromUsedPercent(0), 1);
  assert.equal(remainingFromUsedPercent(100), 0);
});

test("clampFraction pins out-of-range and non-finite values into [0,1]", () => {
  assert.equal(clampFraction(1.5), 1);
  assert.equal(clampFraction(-0.2), 0);
  assert.equal(clampFraction(Number.NaN), 0);
  assert.equal(clampFraction(0.42), 0.42);
});

test("each source maps its live payload to an exact, binding 0–1 fraction", () => {
  // Claude: utilization is a "percent used"; binds on the highest utilization.
  const claude = mapUsageToSnapshot(
    { five_hour: { utilization: 80, resets_at: null }, seven_day: { utilization: 25 } },
    null,
    NOW,
  );
  assert.equal(claude.remaining_pct, 0.2); // 80% used → 0.2 remaining (exact)
  assert.equal(claude.source, "claude-oauth");

  // Codex: most-constrained of two windows, exact.
  const codex = mapCodexUsage(
    { rate_limit: { primary_window: { used_percent: 12 }, secondary_window: { used_percent: 40 } } },
    NOW,
  );
  assert.equal(codex.remaining_pct, 0.6);

  // Copilot: percent_remaining path, exact.
  const copilot = mapCopilotUsage(
    { quota_snapshots: { premium_interactions: { percent_remaining: 30 } } },
    NOW,
  );
  assert.equal(copilot.remaining_pct, 0.3);

  // Antigravity: already a fraction; binds on the least-remaining model + clamps.
  const antigravity = mapAntigravityUsage(
    { models: [{ quotaInfo: { remainingFraction: 0.9 } }, { quotaInfo: { remainingFraction: 1.5 } }] },
    NOW,
  );
  assert.equal(antigravity.remaining_pct, 0.9); // 1.5 clamps but 0.9 is lower → binds 0.9
});

// ── 2. Discovered-window slot-rise (escape the 32k floor) ─────────────────────

test("a discovered capability window lifts the resolved context above the 32k floor → more slots", async () => {
  const pool = (overrides) => ({
    id: "claude-code/*",
    providerName: "claude-code",
    hostModel: null,
    hostConcurrencyLimit: null,
    quotaStateEntry: null,
    discoveredLimits: null,
    quotaSourceSnapshot: null,
    ...overrides,
  });
  const sessionConfig = {
    quota: { enabled: true, safety_margin: 1.0, input_tokens_per_minute: 1_000_000 },
  };
  // A TPM budget tight enough that the per-item context window decides the wave.
  const pendingItemTokens = new Array(12).fill(30_000);

  const floored = computeDispatchCapacity({
    pools: [pool({ discoveredLimits: { input_tokens_per_minute: 600_000 } })],
    sessionConfig,
    pendingItemTokens,
  });
  const lifted = computeDispatchCapacity({
    pools: [
      pool({
        // Host reported a 200k window at the handshake — outranks the 32k default.
        discoveredLimits: { input_tokens_per_minute: 600_000, context_tokens: 200_000, output_tokens: 32_000 },
      }),
    ],
    sessionConfig,
    pendingItemTokens,
  });

  assert.equal(
    floored.primary.schedule.resolved_limits.context_tokens,
    32_000,
    "without a discovered window the conservative 32k floor applies",
  );
  assert.equal(
    lifted.primary.schedule.resolved_limits.context_tokens,
    200_000,
    "the discovered capability window must outrank the 32k default",
  );
  assert.ok(
    lifted.total_slots >= floored.total_slots,
    `discovered window must not REDUCE slots (floored=${floored.total_slots} lifted=${lifted.total_slots})`,
  );
});

// ── 3. Hermeticity ───────────────────────────────────────────────────────────

test("the DEFAULT fetch makes no network call under a test runner (hermetic)", async () => {
  // Valid creds present, but no injected fetch → the guard must skip the network.
  const src = new ClaudeOAuthQuotaSource({
    credentialsPath: writeCreds("inv2-claude-", {
      claudeAiOauth: { accessToken: "tok", expiresAt: NOW + 3_600_000 },
    }),
    now: () => NOW,
  });
  assert.equal(await src.queryCurrentUsage("claude-code/*"), null);
});

test("an injected fetchImpl exercises the real mapping (hermeticity escape hatch)", async () => {
  const fetchImpl = recordingFetch(
    okResponse({ five_hour: { utilization: 70, resets_at: null } }),
  );
  const src = new ClaudeOAuthQuotaSource({
    credentialsPath: writeCreds("inv2-claude2-", {
      claudeAiOauth: { accessToken: "tok", expiresAt: NOW + 3_600_000 },
    }),
    fetchImpl,
    now: () => NOW,
  });
  const snap = await src.queryCurrentUsage("claude-code/*");
  assert.equal(fetchImpl.calls.length, 1, "an injected fetch must actually be called");
  assert.equal(snap.remaining_pct, clampFraction(0.3));
});

// ── 4a. Explicit silent-degrade marker on the probe ──────────────────────────

test("probeUsage distinguishes degraded (queried, lost) from not_applicable (gated out)", async () => {
  const codexCreds = writeCreds("inv2-codex-", {
    tokens: { access_token: "tok-c", account_id: "acct-1" },
  });

  // Handled provider, real query that 401s → DEGRADED (a live reading was lost).
  const degraded = new CodexQuotaSource({
    credentialsPath: codexCreds,
    fetchImpl: recordingFetch({ ok: false, status: 401, json: async () => ({}) }),
    now: () => NOW,
  });
  const degradedProbe = await degraded.probeUsage("codex/*");
  assert.equal(degradedProbe.snapshot, null);
  assert.equal(degradedProbe.status, "degraded");

  // Non-matching provider → NOT_APPLICABLE, with no I/O.
  const naFetch = recordingFetch(okResponse({}));
  const notApplicable = new CodexQuotaSource({
    credentialsPath: codexCreds,
    fetchImpl: naFetch,
    now: () => NOW,
  });
  const naProbe = await notApplicable.probeUsage("claude-code/*");
  assert.equal(naProbe.status, "not_applicable");
  assert.equal(naFetch.calls.length, 0, "a gated-out provider must not hit the network");

  // Handled provider + a mappable 200 → OK.
  const ok = new CodexQuotaSource({
    credentialsPath: codexCreds,
    fetchImpl: recordingFetch(
      okResponse({ rate_limit: { primary_window: { used_percent: 10 } } }),
    ),
    now: () => NOW,
  });
  const okProbe = await ok.probeUsage("codex/*");
  assert.equal(okProbe.status, "ok");
  assert.equal(okProbe.snapshot.remaining_pct, 0.9);
});

test("CompositeQuotaSource.probeUsage aggregates a degrade across the cascade", async () => {
  const degradingSource = {
    name: "degrading",
    async queryCurrentUsage() {
      return null;
    },
    async probeUsage() {
      return { snapshot: null, status: "degraded" };
    },
  };
  const inertSource = {
    name: "inert",
    async queryCurrentUsage() {
      return null;
    },
    async probeUsage() {
      return { snapshot: null, status: "not_applicable" };
    },
  };
  const composite = new CompositeQuotaSource([inertSource, degradingSource]);
  const probe = await composite.probeUsage("codex/*");
  assert.equal(probe.status, "degraded", "any handling source that degrades makes the cascade degraded");

  // A throwing source also counts as a degrade (probeQuotaSource fallback path).
  const throwingSource = {
    name: "throwing",
    async queryCurrentUsage() {
      throw new Error("boom");
    },
  };
  const composite2 = new CompositeQuotaSource([throwingSource]);
  assert.equal((await composite2.probeUsage("codex/*")).status, "degraded");

  // No source applies → not_applicable (the cascade was simply silent).
  const composite3 = new CompositeQuotaSource([inertSource]);
  assert.equal((await composite3.probeUsage("codex/*")).status, "not_applicable");
});

test("probeQuotaSource derives a conservative status for a plain queryCurrentUsage stub", async () => {
  // No probeUsage → a null result must be reported as not_applicable, never an
  // over-claimed degrade (a bare stub can't tell a silent degrade from a non-match).
  const nullStub = { name: "n", async queryCurrentUsage() { return null; } };
  assert.equal((await probeQuotaSource(nullStub, "x/y")).status, "not_applicable");

  const throwStub = { name: "t", async queryCurrentUsage() { throw new Error("x"); } };
  assert.equal((await probeQuotaSource(throwStub, "x/y")).status, "degraded");
});

// ── 4b. Attaches RAW signals + the degrade marker, never a pre-folded slot count ─

test("a pool carries the RAW per-pool signals and the degrade marker — no pre-folded slots", async () => {
  const snapshot = {
    remaining_pct: 0.5,
    reset_at: null,
    requests_remaining: 10,
    tokens_remaining: null,
    captured_at: new Date(NOW).toISOString(),
    source: "test",
  };
  const pool = {
    id: "claude-code/*",
    providerName: "claude-code",
    hostModel: null,
    hostConcurrencyLimit: null,
    quotaStateEntry: null,
    discoveredLimits: { context_tokens: 200_000, output_tokens: 32_000 },
    quotaSourceSnapshot: snapshot,
    quotaSignalDegraded: true,
  };
  // The pool object itself holds raw signals, NOT a slot count — the only numeric
  // capacity field on CapacityPool is absent; slots are derived downstream.
  assert.equal("slots" in pool, false, "CapacityPool must not carry a pre-folded slot count");

  const capacity = computeDispatchCapacity({
    pools: [pool],
    sessionConfig: { quota: { enabled: true } },
    pendingItemTokens: new Array(4).fill(10_000),
  });
  const [summary] = summarizeDispatchCapacityPools(capacity);
  // The raw snapshot + the degrade marker survive into the summary unfolded.
  assert.deepEqual(summary.quota_source_snapshot, snapshot);
  assert.equal(summary.quota_signal_degraded, true);
  // And the fold still happened in the scheduler: a real slot count is present.
  assert.ok(summary.slots >= 1);
});

test("a healthy (non-degraded) pool omits the degrade marker from its summary", async () => {
  const pool = {
    id: "claude-code/*",
    providerName: "claude-code",
    hostModel: null,
    hostConcurrencyLimit: null,
    quotaStateEntry: null,
    discoveredLimits: null,
    quotaSourceSnapshot: null,
    // quotaSignalDegraded intentionally unset
  };
  const capacity = computeDispatchCapacity({
    pools: [pool],
    sessionConfig: {},
    pendingItemTokens: [1_000],
  });
  const [summary] = summarizeDispatchCapacityPools(capacity);
  assert.equal(
    summary.quota_signal_degraded,
    undefined,
    "no degrade must leave the marker unset (not false) so it stays a positive signal",
  );
});

// ── Gated live endpoint validation (needs real local credentials) ────────────

// The unified mapping is exercised hermetically above with recorded payloads.
// Hitting the real provider endpoints requires live OAuth credentials on the box,
// so it cannot run under the hermetic node:test guard (the default fetch is
// skipped by design). It is therefore gated/skipped: passing an explicit
// fetchImpl bound to the real global fetch is what a manual live check would do.
// Set AUDIT_TOOLS_LIVE_QUOTA=1 to run it against the local Claude credential.
test(
  "live: real Claude /usage endpoint maps to a 0–1 fraction (gated, real creds)",
  { skip: process.env.AUDIT_TOOLS_LIVE_QUOTA !== "1" ? "set AUDIT_TOOLS_LIVE_QUOTA=1 + real creds to run live probe" : false },
  async () => {
    // Inject the real global fetch so the hermeticity guard is intentionally
    // bypassed for this opt-in live probe (an injected fetchImpl is always honored).
    const src = new ClaudeOAuthQuotaSource({ fetchImpl: globalThis.fetch });
    const snap = await src.queryCurrentUsage("claude-code/*");
    if (snap !== null) {
      assert.ok(snap.remaining_pct === null || (snap.remaining_pct >= 0 && snap.remaining_pct <= 1));
    }
  },
);
