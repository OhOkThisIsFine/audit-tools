/**
 * Regression tests for quota maintainability findings:
 *
 *   FND-MNT-56e100e0 — computeDispatchCapacity iterative trim loop refactored into
 *                       schedulePoolConverging() helper; 3-pass algorithm now named
 *                       and documented rather than inline.
 *
 *   FND-MNT-bf201bf7 — scheduleWave real-time quota-source-snapshot adjustment
 *                       extracted into applyQuotaSourceAdjustment(); scheduleWave
 *                       is now ~100 lines with named concerns.
 */

import test from "node:test";
import assert from "node:assert/strict";

const { computeDispatchCapacity } = await import("../../src/shared/quota/capacity.ts");
const { scheduleWave } = await import("../../src/shared/quota/scheduler.ts");

function hostPool(id, overrides = {}) {
  return {
    id,
    providerName: "claude-code",
    hostModel: null,
    hostConcurrencyLimit: null,
    quotaStateEntry: null,
    discoveredLimits: null,
    quotaSourceSnapshot: null,
    ...overrides,
  };
}

function hostLimit(n) {
  return { active_subagents: n, source: "cli_flags", description: "test limit" };
}

// ── FND-MNT-56e100e0: schedulePoolConverging 3-pass algorithm ────────────────
// These tests drive the convergence path in schedulePoolConverging to confirm
// that refactoring the inline loop into a named helper preserved the behaviour.

test("MNT-56e100e0: converging allocation does not exceed host concurrency limit", () => {
  // 10 pending items, host cap = 3 → should assign exactly 3, not overshoot.
  const capacity = computeDispatchCapacity({
    pools: [hostPool("host", { hostConcurrencyLimit: hostLimit(3) })],
    sessionConfig: {},
    pendingItemTokens: new Array(10).fill(20_000),
  });
  assert.equal(capacity.total_slots, 3);
  assert.equal(capacity.binding_cap, "host_concurrency");
});

test("MNT-56e100e0: converging allocation never returns more slots than pending items", () => {
  // 2 items, generous host cap → slots ≤ 2.
  const capacity = computeDispatchCapacity({
    pools: [hostPool("host", { hostConcurrencyLimit: hostLimit(10) })],
    sessionConfig: {},
    pendingItemTokens: [5_000, 3_000],
  });
  assert.ok(
    capacity.total_slots <= 2,
    `slots ${capacity.total_slots} must not exceed 2 pending items`,
  );
});

test("MNT-56e100e0: converging allocation preserves exploratory binding cap on narrow slice", () => {
  // TPM cap fires on the exploratory pass (full remaining). The narrow assigned
  // slice may be so small it fits within any limit — the binding cap from the
  // exploratory pass must still be reflected on the final allocation.
  const capacity = computeDispatchCapacity({
    pools: [
      hostPool("host", {
        discoveredLimits: { input_tokens_per_minute: 3_000 },
      }),
    ],
    sessionConfig: {
      quota: {
        enabled: true,
        safety_margin: 1.0,
        empirical_half_life_hours: 24,
        unknown_hosted_concurrency: 1, // force narrow slice
      },
    },
    // Many large items so TPM fires on the exploratory pass.
    pendingItemTokens: new Array(20).fill(2_000),
  });
  // With unknown_hosted_concurrency=1 and a tight TPM budget, cap must be set.
  assert.ok(
    capacity.binding_cap !== "none",
    `expected a binding cap, got 'none'`,
  );
});

test("MNT-56e100e0: multi-pool: second pool receives items not consumed by the first", () => {
  // First pool capped at 2, second pool picks up the rest.
  const capacity = computeDispatchCapacity({
    pools: [
      hostPool("pool-a", { hostConcurrencyLimit: hostLimit(2) }),
      hostPool("pool-b", { hostConcurrencyLimit: hostLimit(3) }),
    ],
    sessionConfig: {},
    pendingItemTokens: [1_000, 1_000, 1_000, 1_000, 1_000],
  });
  assert.equal(capacity.total_slots, 5);
  assert.equal(capacity.pools[0].slots, 2);
  assert.equal(capacity.pools[1].slots, 3);
});

// ── FND-MNT-bf201bf7: applyQuotaSourceAdjustment extracted from scheduleWave ──
// These tests confirm that the extracted helper preserves the existing snapshot
// adjustment behaviour: critical → throttle to 1 + cooldown, low → halve wave.

test("MNT-bf201bf7: quota snapshot below CRITICAL throttles scheduleWave to 1", () => {
  const schedule = scheduleWave({
    providerName: "claude-code",
    sessionConfig: { quota: { enabled: true } },
    hostModel: null,
    requestedConcurrency: 10,
    quotaSourceSnapshot: {
      remaining_pct: 0.05, // below QUOTA_REMAINING_PCT_CRITICAL (0.1)
      reset_at: null,
    },
  });
  assert.equal(schedule.max_concurrent, 1);
  assert.equal(schedule.binding_cap, "cooldown");
});

test("MNT-bf201bf7: quota snapshot in LOW band halves scheduleWave", () => {
  // remaining_pct = 0.2, which is between LOW (0.3) and CRITICAL (0.1)
  // safety_margin=1.0 so the fallback cap is the binding limit; then the snapshot
  // halves whatever that resolved to.
  const schedule = scheduleWave({
    providerName: "claude-code",
    sessionConfig: {
      quota: {
        enabled: true,
        safety_margin: 1.0,
        unknown_hosted_concurrency: 8,
      },
    },
    hostModel: null,
    requestedConcurrency: 8,
    quotaSourceSnapshot: {
      remaining_pct: 0.2, // between 0.1 and 0.3 → LOW band
      reset_at: null,
    },
  });
  assert.equal(schedule.max_concurrent, 4); // halved from 8
  assert.equal(schedule.binding_cap, "cooldown");
});

test("MNT-bf201bf7: quota snapshot at or above LOW does not reduce scheduleWave", () => {
  const schedule = scheduleWave({
    providerName: "claude-code",
    sessionConfig: {
      quota: {
        enabled: true,
        safety_margin: 1.0,
        unknown_hosted_concurrency: 4,
      },
    },
    hostModel: null,
    requestedConcurrency: 4,
    quotaSourceSnapshot: {
      remaining_pct: 0.5, // well above LOW (0.3)
      reset_at: null,
    },
  });
  assert.equal(schedule.max_concurrent, 4); // no reduction
  assert.ok(
    schedule.binding_cap !== "cooldown",
    `expected no cooldown cap, got '${schedule.binding_cap}'`,
  );
});

test("MNT-bf201bf7: critical snapshot with reset_at sets cooldown_until", () => {
  const resetAt = new Date(Date.now() + 60_000).toISOString();
  const schedule = scheduleWave({
    providerName: "claude-code",
    sessionConfig: { quota: { enabled: true } },
    hostModel: null,
    requestedConcurrency: 10,
    quotaSourceSnapshot: {
      remaining_pct: 0.02,
      reset_at: resetAt,
    },
  });
  assert.equal(schedule.max_concurrent, 1);
  assert.equal(schedule.cooldown_until, resetAt);
});

test("MNT-bf201bf7: quota snapshot skipped when cooldown already active", () => {
  // If a cooldown is active from the quota-state entry, the snapshot block
  // must not run (guard: !cooldownUntil). Wave stays at 1 from the cooldown,
  // not set again by the snapshot path.
  const futureExpiry = new Date(Date.now() + 120_000).toISOString();
  const schedule = scheduleWave({
    providerName: "claude-code",
    sessionConfig: { quota: { enabled: true } },
    hostModel: null,
    requestedConcurrency: 5,
    quotaStateEntry: {
      buckets: {},
      consecutive_429_count: 0,
      cooldown_until: futureExpiry,
    },
    quotaSourceSnapshot: {
      remaining_pct: 0.9, // would NOT reduce wave — confirms snapshot is skipped
      reset_at: null,
    },
  });
  // Cooldown active → max_concurrent must be 1, binding_cap must be "cooldown"
  assert.equal(schedule.max_concurrent, 1);
  assert.equal(schedule.binding_cap, "cooldown");
  assert.equal(schedule.cooldown_until, futureExpiry);
});
