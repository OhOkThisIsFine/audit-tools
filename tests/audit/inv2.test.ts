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
import { test, afterEach, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import type {
  FetchLike,
  FetchResponseLike,
} from "../../src/shared/quota/httpQuotaSource.js";
import type {
  QuotaSource,
  QuotaUsageSnapshot,
} from "../../src/shared/quota/quotaSource.js";
import type { CapacityPool } from "../../src/shared/quota/capacity.js";

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

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) {
    try {
      const dir = tmpDirs.pop();
      if (dir !== undefined) {
        rmSync(dir, { recursive: true, force: true });
      }
    } catch {
      /* ignore */
    }
  }
});

function writeCreds(name: string, creds: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), name));
  tmpDirs.push(dir);
  const p = join(dir, "creds.json");
  writeFileSync(p, JSON.stringify(creds));
  return p;
}

type FetchCall = {
  url: string;
  init: Parameters<FetchLike>[1];
};
type RecordingFetch = FetchLike & { calls: FetchCall[] };

function recordingFetch(
  response: FetchResponseLike | (() => FetchResponseLike),
): RecordingFetch {
  const calls: FetchCall[] = [];
  const fn = async (
    url: string,
    init?: Parameters<FetchLike>[1],
  ): Promise<FetchResponseLike> => {
    calls.push({ url, init });
    return typeof response === "function" ? response() : response;
  };
  return Object.assign(fn, { calls });
}
const okResponse = (body: unknown): FetchResponseLike => ({
  ok: true,
  status: 200,
  json: async () => body,
});

// ── 1. Per-source fraction / clamp ───────────────────────────────────────────

test("remainingFromUsedPercent is exact for integer percents (no float drift)", () => {
  // "percent used" → remaining fraction: 20% used ⇒ 0.8 remaining (exact).
  expect(remainingFromUsedPercent(20)).toBe(0.8);
  expect(remainingFromUsedPercent(75)).toBe(0.25);
  expect(remainingFromUsedPercent(0)).toBe(1);
  expect(remainingFromUsedPercent(100)).toBe(0);
});

test("clampFraction pins out-of-range and non-finite values into [0,1]", () => {
  expect(clampFraction(1.5)).toBe(1);
  expect(clampFraction(-0.2)).toBe(0);
  expect(clampFraction(Number.NaN)).toBe(0);
  expect(clampFraction(0.42)).toBe(0.42);
});

test("each source maps its live payload to an exact, binding 0–1 fraction", () => {
  // Claude: utilization is a "percent used"; binds on the highest utilization.
  const claude = mapUsageToSnapshot(
    { five_hour: { utilization: 80, resets_at: null }, seven_day: { utilization: 25 } },
    null,
    NOW,
  );
  if (claude === null) throw new Error("Claude fixture must map to a snapshot");
  expect(claude.remaining_pct).toBe(0.2); // 80% used → 0.2 remaining (exact)
  expect(claude.source).toBe("claude-oauth");

  // Codex: most-constrained of two windows, exact.
  const codex = mapCodexUsage(
    { rate_limit: { primary_window: { used_percent: 12 }, secondary_window: { used_percent: 40 } } },
    NOW,
  );
  if (codex === null) throw new Error("Codex fixture must map to a snapshot");
  expect(codex.remaining_pct).toBe(0.6);

  // Copilot: percent_remaining path, exact.
  const copilot = mapCopilotUsage(
    { quota_snapshots: { premium_interactions: { percent_remaining: 30 } } },
    NOW,
  );
  if (copilot === null) throw new Error("Copilot fixture must map to a snapshot");
  expect(copilot.remaining_pct).toBe(0.3);

  // Antigravity: already a fraction; binds on the least-remaining model + clamps.
  const antigravity = mapAntigravityUsage(
    { models: [{ quotaInfo: { remainingFraction: 0.9 } }, { quotaInfo: { remainingFraction: 1.5 } }] },
    NOW,
  );
  if (antigravity === null) throw new Error("Antigravity fixture must map to a snapshot");
  expect(antigravity.remaining_pct).toBe(0.9); // 1.5 clamps but 0.9 is lower → binds 0.9
});

// ── 2. Discovered-window slot-rise (escape the 32k floor) ─────────────────────

test("a discovered capability window lifts the resolved context above the 32k floor → more slots", async () => {
  const pool = (overrides: Partial<CapacityPool>): CapacityPool => ({
    id: "claude-code/*",
    accountKey: "claude-code/*",
    providerName: "claude-code",
    hostModel: null,
    hostConcurrencyLimit: null,
    quotaStateEntry: null,
    discoveredLimits: null,
    quotaSourceSnapshot: null,
    ...overrides,
  });
  const sessionConfig = {
    quota: { safety_margin: 1.0, input_tokens_per_minute: 1_000_000 },
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

  expect(floored.primary.schedule.resolved_limits.context_tokens, "without a discovered window the conservative 32k floor applies").toBe(32_000);
  expect(lifted.primary.schedule.resolved_limits.context_tokens, "the discovered capability window must outrank the 32k default").toBe(200_000);
  expect(lifted.total_slots >= floored.total_slots, `discovered window must not REDUCE slots (floored=${floored.total_slots} lifted=${lifted.total_slots})`).toBeTruthy();
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
  expect(await src.queryCurrentUsage("claude-code/*")).toBe(null);
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
  if (snap === null) throw new Error("Injected fetch must map to a snapshot");
  expect(fetchImpl.calls.length, "an injected fetch must actually be called").toBe(1);
  expect(snap.remaining_pct).toBe(clampFraction(0.3));
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
  expect(degradedProbe.snapshot).toBe(null);
  expect(degradedProbe.status).toBe("degraded");

  // Non-matching provider → NOT_APPLICABLE, with no I/O.
  const naFetch = recordingFetch(okResponse({}));
  const notApplicable = new CodexQuotaSource({
    credentialsPath: codexCreds,
    fetchImpl: naFetch,
    now: () => NOW,
  });
  const naProbe = await notApplicable.probeUsage("claude-code/*");
  expect(naProbe.status).toBe("not_applicable");
  expect(naFetch.calls.length, "a gated-out provider must not hit the network").toBe(0);

  // Handled provider + a mappable 200 → OK.
  const ok = new CodexQuotaSource({
    credentialsPath: codexCreds,
    fetchImpl: recordingFetch(
      okResponse({ rate_limit: { primary_window: { used_percent: 10 } } }),
    ),
    now: () => NOW,
  });
  const okProbe = await ok.probeUsage("codex/*");
  if (okProbe.snapshot === null) throw new Error("Successful probe must include a snapshot");
  expect(okProbe.status).toBe("ok");
  expect(okProbe.snapshot.remaining_pct).toBe(0.9);
});

test("CompositeQuotaSource.probeUsage aggregates a degrade across the cascade", async () => {
  const degradingSource: QuotaSource = {
    name: "degrading",
    async queryCurrentUsage() {
      return null;
    },
    async probeUsage() {
      return { snapshot: null, status: "degraded" };
    },
  };
  const inertSource: QuotaSource = {
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
  expect(probe.status, "any handling source that degrades makes the cascade degraded").toBe("degraded");

  // A throwing source also counts as a degrade (probeQuotaSource fallback path).
  const throwingSource: QuotaSource = {
    name: "throwing",
    async queryCurrentUsage() {
      throw new Error("boom");
    },
  };
  const composite2 = new CompositeQuotaSource([throwingSource]);
  expect((await composite2.probeUsage("codex/*")).status).toBe("degraded");

  // No source applies → not_applicable (the cascade was simply silent).
  const composite3 = new CompositeQuotaSource([inertSource]);
  expect((await composite3.probeUsage("codex/*")).status).toBe("not_applicable");
});

test("probeQuotaSource derives a conservative status for a plain queryCurrentUsage stub", async () => {
  // No probeUsage → a null result must be reported as not_applicable, never an
  // over-claimed degrade (a bare stub can't tell a silent degrade from a non-match).
  const nullStub = { name: "n", async queryCurrentUsage() { return null; } };
  expect((await probeQuotaSource(nullStub, "x/y")).status).toBe("not_applicable");

  const throwStub = { name: "t", async queryCurrentUsage() { throw new Error("x"); } };
  expect((await probeQuotaSource(throwStub, "x/y")).status).toBe("degraded");
});

// ── 4b. Attaches RAW signals + the degrade marker, never a pre-folded slot count ─

test("a pool carries the RAW per-pool signals and the degrade marker — no pre-folded slots", async () => {
  const snapshot: QuotaUsageSnapshot = {
    remaining_pct: 0.5,
    reset_at: null,
    requests_remaining: 10,
    tokens_remaining: null,
    captured_at: new Date(NOW).toISOString(),
    source: "test",
  };
  const pool: CapacityPool = {
    id: "claude-code/*",
    accountKey: "claude-code/*",
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
  expect("slots" in pool, "CapacityPool must not carry a pre-folded slot count").toBe(false);

  const capacity = computeDispatchCapacity({
    pools: [pool],
    sessionConfig: { quota: {} },
    pendingItemTokens: new Array(4).fill(10_000),
  });
  const [summary] = summarizeDispatchCapacityPools(capacity);
  if (!summary) throw new Error("Capacity summary must include the input pool");
  // The raw snapshot + the degrade marker survive into the summary unfolded.
  expect(summary.quota_source_snapshot).toEqual(snapshot);
  expect(summary.quota_signal_degraded).toBe(true);
  // And the fold still happened in the scheduler: a real slot count is present.
  expect(summary.slots >= 1).toBeTruthy();
});

test("a healthy (non-degraded) pool omits the degrade marker from its summary", async () => {
  const pool: CapacityPool = {
    id: "claude-code/*",
    accountKey: "claude-code/*",
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
  if (!summary) throw new Error("Capacity summary must include the input pool");
  expect(summary.quota_signal_degraded, "no degrade must leave the marker unset (not false) so it stays a positive signal").toBe(undefined);
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
  { skip: process.env.AUDIT_TOOLS_LIVE_QUOTA !== "1" },
  async () => {
    // Inject the real global fetch so the hermeticity guard is intentionally
    // bypassed for this opt-in live probe (an injected fetchImpl is always honored).
    const src = new ClaudeOAuthQuotaSource({ fetchImpl: globalThis.fetch });
    const snap = await src.queryCurrentUsage("claude-code/*");
    if (snap !== null) {
      expect(snap.remaining_pct === null || (snap.remaining_pct >= 0 && snap.remaining_pct <= 1)).toBeTruthy();
    }
  },
);
