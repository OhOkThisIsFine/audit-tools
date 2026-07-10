import { describe, it, expect } from "vitest";
import { detectHostDispatchWall } from "audit-tools/shared";

const NOW = 1_000_000;
const future = () => new Date(NOW + 60_000).toISOString();
const past = () => new Date(NOW - 60_000).toISOString();

describe("detectHostDispatchWall", () => {
  it("not at wall when packets were granted and no cooldown", () => {
    const w = detectHostDispatchWall({ grantedCount: 3, cooldownUntil: null, now: NOW });
    expect(w).toEqual({ atWall: false, earliestResetAt: null, reason: null });
  });

  it("empty grant with no cooldown → wall, null reset (best-effort retry)", () => {
    const w = detectHostDispatchWall({ grantedCount: 0, cooldownUntil: null, now: NOW });
    expect(w).toEqual({ atWall: true, earliestResetAt: null, reason: "empty_grant" });
  });

  it("active cooldown → wall even when the grant is non-empty (the F1 over-grant)", () => {
    const reset = future();
    const w = detectHostDispatchWall({ grantedCount: 12, cooldownUntil: reset, now: NOW });
    expect(w).toEqual({ atWall: true, earliestResetAt: reset, reason: "cooldown" });
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
    expect(empty).toEqual({ atWall: true, earliestResetAt: null, reason: "empty_grant" });
  });

  it("malformed cooldown timestamp is treated as inactive", () => {
    const w = detectHostDispatchWall({ grantedCount: 4, cooldownUntil: "not-a-date", now: NOW });
    expect(w.atWall).toBe(false);
  });
});
