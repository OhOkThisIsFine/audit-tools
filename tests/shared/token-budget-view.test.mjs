import { test, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { renderTokenBudgetView, scheduleWave } from "audit-tools/shared";

function withQuotaFile(contract, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "tbv-"));
  const file = path.join(dir, "dispatch-quota.json");
  writeFileSync(file, JSON.stringify(contract));
  try {
    return fn(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("renderTokenBudgetView: empty for missing/unreadable path", () => {
  expect(renderTokenBudgetView(null)).toBe("");
  expect(renderTokenBudgetView(undefined)).toBe("");
  expect(renderTokenBudgetView("/no/such/dispatch-quota.json")).toBe("");
});

test("renderTokenBudgetView: empty when no pool carries a snapshot or budget", () => {
  withQuotaFile({ capacity_pools: [{ pool_id: "claude-code/*", slots: 4 }] }, (file) => {
    expect(renderTokenBudgetView(file)).toBe("");
  });
});

test("renderTokenBudgetView: renders per-pool budget, remaining %, in-flight, bound-by", () => {
  withQuotaFile(
    {
      estimated_wave_tokens: 12000,
      capacity_pools: [
        {
          pool_id: "claude-code/*",
          slots: 3,
          binding_cap: "token_budget",
          remaining_token_budget: 120000,
          in_flight_tokens: 4000,
          quota_source_snapshot: {
            remaining_pct: 0.59,
            reset_at: "2026-07-01T01:59:59Z",
          },
        },
      ],
    },
    (file) => {
      const out = renderTokenBudgetView(file);
      expect(out).toMatch(/Dispatch token budget/);
      expect(out).toMatch(/claude-code\/\*/);
      expect(out).toMatch(/59%/);
      expect(out).toMatch(/120,000/); // remaining budget, localized
      expect(out).toMatch(/4,000/); // in-flight
      expect(out).toMatch(/token_budget/);
      expect(out).toMatch(/2026-07-01T01:59:59Z/);
      expect(out).toMatch(/~12,000 tok/); // upcoming wave load
    },
  );
});

test("renderTokenBudgetView: shows cold-start when budget is unknown", () => {
  withQuotaFile(
    {
      capacity_pools: [
        {
          pool_id: "codex/*",
          slots: 2,
          binding_cap: "token_budget",
          remaining_token_budget: null,
          in_flight_tokens: 0,
          quota_source_snapshot: { remaining_pct: 0.8, reset_at: null },
        },
      ],
    },
    (file) => {
      const out = renderTokenBudgetView(file);
      expect(out).toMatch(/cold-start/);
    },
  );
});

test("renderTokenBudgetView: multi-window snapshot renders a per-window breakdown", () => {
  withQuotaFile(
    {
      capacity_pools: [
        {
          pool_id: "claude-code/*",
          slots: 3,
          binding_cap: "token_budget",
          remaining_token_budget: 90000,
          in_flight_tokens: 0,
          quota_source_snapshot: {
            remaining_pct: 0.4,
            reset_at: "2026-07-01T01:59:59Z",
            windows: [
              { label: "session", remaining_pct: 0.4, reset_at: "2026-07-01T01:59:59Z" },
              { label: "weekly", remaining_pct: 0.86, reset_at: "2026-07-07T16:59:59Z" },
            ],
          },
        },
      ],
    },
    (file) => {
      const out = renderTokenBudgetView(file);
      expect(out).toMatch(/session: 40%/);
      expect(out).toMatch(/weekly: 86%/);
    },
  );
});

test("scheduleWave stamps remaining_token_budget + in_flight_tokens on the schedule", () => {
  const schedule = scheduleWave({
    providerName: "claude-code",
    sessionConfig: { quota: { enabled: true, safety_margin: 1 } },
    hostModel: null,
    requestedConcurrency: 10,
    estimatedSlotTokens: [1000, 1000, 1000, 1000, 1000],
    inFlightTokens: 2000,
    quotaSourceSnapshot: {
      remaining_pct: 0.5,
      reset_at: null,
      requests_remaining: null,
      tokens_remaining: 5000, // absolute budget → surfaced verbatim + binds the gate
      captured_at: new Date().toISOString(),
      source: "test",
    },
  });
  expect(schedule.remaining_token_budget).toBe(5000);
  expect(schedule.in_flight_tokens).toBe(2000);
  // 5000 budget − 2000 in-flight = 3000 → only 3 slots of 1000 fit.
  expect(schedule.max_concurrent).toBe(3);
  expect(schedule.binding_cap).toBe("token_budget");
});
