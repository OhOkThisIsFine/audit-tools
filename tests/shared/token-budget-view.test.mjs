import { test } from "node:test";
import assert from "node:assert/strict";
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
  assert.equal(renderTokenBudgetView(null), "");
  assert.equal(renderTokenBudgetView(undefined), "");
  assert.equal(renderTokenBudgetView("/no/such/dispatch-quota.json"), "");
});

test("renderTokenBudgetView: empty when no pool carries a snapshot or budget", () => {
  withQuotaFile({ capacity_pools: [{ pool_id: "claude-code/*", slots: 4 }] }, (file) => {
    assert.equal(renderTokenBudgetView(file), "");
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
      assert.match(out, /Dispatch token budget/);
      assert.match(out, /claude-code\/\*/);
      assert.match(out, /59%/);
      assert.match(out, /120,000/); // remaining budget, localized
      assert.match(out, /4,000/); // in-flight
      assert.match(out, /token_budget/);
      assert.match(out, /2026-07-01T01:59:59Z/);
      assert.match(out, /~12,000 tok/); // upcoming wave load
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
      assert.match(out, /cold-start/);
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
      assert.match(out, /session: 40%/);
      assert.match(out, /weekly: 86%/);
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
  assert.equal(schedule.remaining_token_budget, 5000);
  assert.equal(schedule.in_flight_tokens, 2000);
  // 5000 budget − 2000 in-flight = 3000 → only 3 slots of 1000 fit.
  assert.equal(schedule.max_concurrent, 3);
  assert.equal(schedule.binding_cap, "token_budget");
});
