/**
 * Regression tests for quota maintainability findings:
 *
 *   FND-MNT-56e100e0 — computeDispatchCapacity iterative trim loop refactored into
 *                       schedulePoolConverging() helper; 3-pass algorithm now named
 *                       and documented rather than inline.
 *
 *   FND-MNT-bf201bf7 — scheduleWave's real-time quota-source adjustment is now the
 *                       token-budget gate (per-window remaining budget, learned
 *                       tokens_per_pct slope), replacing the old remaining_pct
 *                       cliff step-function.
 */

import { test, expect } from "vitest";

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
  expect(capacity.total_slots).toBe(3);
  expect(capacity.binding_cap).toBe("host_concurrency");
});

test("MNT-56e100e0: converging allocation never returns more slots than pending items", () => {
  // 2 items, generous host cap → slots ≤ 2.
  const capacity = computeDispatchCapacity({
    pools: [hostPool("host", { hostConcurrencyLimit: hostLimit(10) })],
    sessionConfig: {},
    pendingItemTokens: [5_000, 3_000],
  });
  expect(capacity.total_slots <= 2, `slots ${capacity.total_slots} must not exceed 2 pending items`).toBeTruthy();
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
      quota: { safety_margin: 1.0,
      },
    },
    // Many large items so TPM fires on the exploratory pass (3000 TPM / 2000 per
    // item → the TPM cap binds).
    pendingItemTokens: new Array(20).fill(2_000),
  });
  // The tight TPM budget must set a binding cap on the exploratory pass.
  expect(capacity.binding_cap !== "none", `expected a binding cap, got 'none'`).toBeTruthy();
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
  expect(capacity.total_slots).toBe(5);
  expect(capacity.pools[0].slots).toBe(2);
  expect(capacity.pools[1].slots).toBe(3);
});

// ── FND-MNT-bf201bf7: token-budget gate (replaces the extracted cliff helper) ──
// The old applyQuotaSourceAdjustment step-function (critical → 1, low → halve) is
// gone; these confirm the token-budget gate: an exhausted window → 1 + cooldown,
// a cold-start window → small calibration batch, a healthy window → no reduction.

test("MNT-bf201bf7: an exhausted window throttles scheduleWave to 1", () => {
  const schedule = scheduleWave({
    providerName: "claude-code",
    sessionConfig: { quota: {} },
    hostModel: null,
    requestedConcurrency: 10,
    quotaSourceSnapshot: {
      remaining_pct: 0, // genuinely empty → known-zero budget for any slope
      reset_at: null,
    },
  });
  expect(schedule.max_concurrent).toBe(1);
});

test("MNT-bf201bf7: a cold-start window admits only a small calibration batch", () => {
  const schedule = scheduleWave({
    providerName: "claude-code",
    sessionConfig: { quota: {} },
    hostModel: null,
    requestedConcurrency: 8,
    quotaStateEntry: null, // no learned slope
    quotaSourceSnapshot: {
      remaining_pct: 0.5, // healthy pct, but nothing learned → calibration
      reset_at: null,
    },
  });
  expect(schedule.max_concurrent <= 3, `cold-start batch, got ${schedule.max_concurrent}`).toBeTruthy();
  expect(schedule.binding_cap).toBe("token_budget");
});

test("MNT-bf201bf7: a healthy learned window does not reduce scheduleWave", () => {
  const schedule = scheduleWave({
    providerName: "claude-code",
    sessionConfig: { quota: { safety_margin: 1.0 } },
    hostModel: null,
    requestedConcurrency: 4,
    quotaStateEntry: {
      updated_at: new Date().toISOString(),
      buckets: {
        "1": { success_weight: 5, failure_weight: 0 },
        "2": { success_weight: 5, failure_weight: 0 },
        "3": { success_weight: 5, failure_weight: 0 },
        "4": { success_weight: 5, failure_weight: 0 },
      },
      cooldown_until: null,
      last_429_at: null,
      tokens_per_pct: { "account:default": 1_000_000 }, // huge budget
    },
    estimatedSlotTokens: [1000, 1000, 1000, 1000],
    quotaSourceSnapshot: {
      remaining_pct: 0.5,
      reset_at: null,
    },
  });
  expect(schedule.max_concurrent).toBe(4); // no reduction
  expect(schedule.binding_cap).toBe("none");
});

test("MNT-bf201bf7: exhausted snapshot with reset_at sets cooldown_until", () => {
  const resetAt = new Date(Date.now() + 60_000).toISOString();
  const schedule = scheduleWave({
    providerName: "claude-code",
    sessionConfig: { quota: {} },
    hostModel: null,
    requestedConcurrency: 10,
    quotaSourceSnapshot: {
      remaining_pct: 0, // genuinely empty → throttle + persist cooldown (anti-flap)
      reset_at: resetAt,
    },
  });
  expect(schedule.max_concurrent).toBe(1);
  expect(schedule.cooldown_until).toBe(resetAt);
});

test("MNT-bf201bf7: quota snapshot skipped when cooldown already active", () => {
  // If a cooldown is active from the quota-state entry, the snapshot block
  // must not run (guard: !cooldownUntil). Wave stays at 1 from the cooldown,
  // not set again by the snapshot path.
  const futureExpiry = new Date(Date.now() + 120_000).toISOString();
  const schedule = scheduleWave({
    providerName: "claude-code",
    sessionConfig: { quota: {} },
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
  expect(schedule.max_concurrent).toBe(1);
  expect(schedule.binding_cap).toBe("cooldown");
  expect(schedule.cooldown_until).toBe(futureExpiry);
});

