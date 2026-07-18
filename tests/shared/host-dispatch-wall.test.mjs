import { describe, it, expect } from "vitest";
import {
  detectHostDispatchWall,
  renderHostWallExplanation,
  admissionBlockedOnBudget,
} from "audit-tools/shared";

const NOW = 1_000_000;
const future = () => new Date(NOW + 60_000).toISOString();
const past = () => new Date(NOW - 60_000).toISOString();

describe("detectHostDispatchWall", () => {
  it("not at wall when packets were granted and no cooldown", () => {
    const w = detectHostDispatchWall({ grantedCount: 3, cooldownUntil: null, now: NOW });
    expect(w).toEqual({ atWall: false, earliestResetAt: null, reason: null, bindingWindow: null, emptyGrantCause: null });
  });

  it("empty grant with no cooldown and no binding window → wall, null reset (best-effort retry)", () => {
    const w = detectHostDispatchWall({ grantedCount: 0, cooldownUntil: null, now: NOW });
    expect(w).toEqual({ atWall: true, earliestResetAt: null, reason: "empty_grant", bindingWindow: null, emptyGrantCause: null });
  });

  it("active cooldown → wall even when the grant is non-empty (the F1 over-grant)", () => {
    const reset = future();
    const w = detectHostDispatchWall({ grantedCount: 12, cooldownUntil: reset, now: NOW });
    expect(w).toEqual({ atWall: true, earliestResetAt: reset, reason: "cooldown", bindingWindow: null, emptyGrantCause: null });
  });

  it("exhausted window carries its reset via cooldown_until", () => {
    const reset = future();
    const w = detectHostDispatchWall({ grantedCount: 0, cooldownUntil: reset, now: NOW });
    expect(w.atWall).toBe(true);
    expect(w.reason).toBe("cooldown");
    expect(w.earliestResetAt).toBe(reset);
  });

  it("expired cooldown does not gate — falls through to the grant check", () => {
    expect(detectHostDispatchWall({ grantedCount: 5, cooldownUntil: past(), now: NOW }).atWall).toBe(false);
    const empty = detectHostDispatchWall({ grantedCount: 0, cooldownUntil: past(), now: NOW });
    expect(empty).toEqual({ atWall: true, earliestResetAt: null, reason: "empty_grant", bindingWindow: null, emptyGrantCause: null });
  });

  it("malformed cooldown timestamp is treated as inactive", () => {
    const w = detectHostDispatchWall({ grantedCount: 4, cooldownUntil: "not-a-date", now: NOW });
    expect(w.atWall).toBe(false);
  });

  // D1 — the binding-window reset-time.
  it("empty grant derives earliestResetAt from the binding window (the low weekly window)", () => {
    const bindingWindow = { label: "weekly", reset_at: future(), budget: 1200 };
    const w = detectHostDispatchWall({ grantedCount: 0, cooldownUntil: null, bindingWindow, now: NOW });
    expect(w.atWall).toBe(true);
    expect(w.reason).toBe("empty_grant");
    // The bare-null "wait for the reset with no time" is fixed: reset comes from the binder.
    expect(w.earliestResetAt).toBe(bindingWindow.reset_at);
    expect(w.bindingWindow).toEqual(bindingWindow);
  });

  it("a binding window with no declared reset still surfaces the window (reset null-tolerant)", () => {
    const bindingWindow = { label: "session", reset_at: null, budget: 300 };
    const w = detectHostDispatchWall({ grantedCount: 0, cooldownUntil: null, bindingWindow, now: NOW });
    expect(w.earliestResetAt).toBeNull();
    expect(w.bindingWindow).toEqual(bindingWindow);
  });

  it("cooldown wins over a binding window (cooldown carries the authoritative reset)", () => {
    const reset = future();
    const bindingWindow = { label: "weekly", reset_at: new Date(NOW + 999_000).toISOString(), budget: 5 };
    const w = detectHostDispatchWall({ grantedCount: 0, cooldownUntil: reset, bindingWindow, now: NOW });
    expect(w.reason).toBe("cooldown");
    expect(w.earliestResetAt).toBe(reset);
    expect(w.bindingWindow).toBeNull();
  });
});

describe("renderHostWallExplanation", () => {
  it("names the binding window, budget, reset, and packet cost", () => {
    const clause = renderHostWallExplanation(
      { label: "weekly", reset_at: "2026-07-18T00:00:00.000Z", budget: 1200 },
      8000,
    );
    expect(clause).toContain("weekly");
    expect(clause).toContain("1200");
    expect(clause).toContain("2026-07-18T00:00:00.000Z");
    expect(clause).toContain("8000");
    expect(clause).toContain("none fit this pass");
  });

  it("handles a window with no declared reset", () => {
    const clause = renderHostWallExplanation({ label: "session", reset_at: null, budget: 50 }, null);
    expect(clause).toContain("no declared reset time");
    expect(clause).not.toContain("smallest packet");
  });

  it("is empty when there is no binding window (cooldown wall / no signal)", () => {
    expect(renderHostWallExplanation(null, 8000)).toBe("");
  });

  it("does NOT claim 'none fit' when the budget comfortably exceeds the packet cost", () => {
    // A healthy budget must never read 'none fit' (the C1 contradiction) — states the
    // cost without the false claim.
    const clause = renderHostWallExplanation(
      { label: "session", reset_at: null, budget: 500000 },
      8000,
    );
    expect(clause).toContain("8000");
    expect(clause).not.toContain("none fit");
  });
});

describe("admissionBlockedOnBudget", () => {
  it("true when a packet was blocked on budget", () => {
    expect(
      admissionBlockedOnBudget([
        { reason: "cap_reached" },
        { reason: "budget_exhausted" },
      ]),
    ).toBe(true);
  });

  it("false when the only blocks are cap_reached (ledger contention, not budget)", () => {
    expect(
      admissionBlockedOnBudget([{ reason: "cap_reached" }, { reason: "cap_reached" }]),
    ).toBe(false);
  });

  it("false for an empty / all-admitted explain set", () => {
    expect(admissionBlockedOnBudget([])).toBe(false);
    expect(admissionBlockedOnBudget([{ reason: "admitted" }])).toBe(false);
  });
});

// ── Unified-routing step E: honest empty-grant classification ────────────────
import { classifyEmptyGrantCause } from "../../src/shared/dispatch/hostDispatchWall.ts";

describe("classifyEmptyGrantCause (step E)", () => {
  it("any budget_exhausted dominates (the reset applies)", () => {
    expect(classifyEmptyGrantCause([
      { reason: "no_capable_pool" },
      { reason: "budget_exhausted" },
    ])).toBe("budget_exhausted");
  });
  it("cap_reached beats no_capable_pool in a mix (transient retry may still grant)", () => {
    expect(classifyEmptyGrantCause([
      { reason: "cap_reached" },
      { reason: "no_capable_pool" },
    ])).toBe("cap_reached");
  });
  it("no_capable_pool ONLY when every blocked packet fit no pool (structural)", () => {
    expect(classifyEmptyGrantCause([
      { reason: "no_capable_pool" },
      { reason: "no_capable_pool" },
    ])).toBe("no_capable_pool");
  });
  it("admitted explains are ignored; empty/unknown → null", () => {
    expect(classifyEmptyGrantCause([{ reason: "admitted", admitted: true }])).toBe(null);
    expect(classifyEmptyGrantCause([])).toBe(null);
  });
  it("detectHostDispatchWall stamps the cause on an empty grant — 'exhausted' is never claimed for a fit mismatch", () => {
    const w = detectHostDispatchWall({
      grantedCount: 0,
      explains: [{ reason: "no_capable_pool" }],
      now: Date.now(),
    });
    expect(w.atWall).toBe(true);
    expect(w.emptyGrantCause).toBe("no_capable_pool");
  });
});
