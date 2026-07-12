import { test, expect } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { AuditResultSchema } = await import("../../src/audit/types.ts");
const { validateAuditResults } = await import(
  "../../src/audit/validation/auditResults.ts"
);
const {
  sumWaveTokenUsage,
  pickPrimaryCapacityPoolSummary,
  recordHostTokenUsageObservation,
  isImplausibleTokenSum,
} = await import("../../src/audit/cli/dispatch/tokenUsageObservation.ts");
const {
  setQuotaStateDir,
  readQuotaState,
  foldSlopeObservationFromPctMaps,
} = await import("../../src/shared/quota/state.ts");
const { mkdir } = await import("node:fs/promises");

async function withTempStateDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "audit-tools-token-usage-"));
  setQuotaStateDir(dir);
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function baseResult(overrides = {}) {
  return {
    task_id: "task-1",
    unit_id: "unit-1",
    pass_id: "pass:security",
    lens: "security",
    file_coverage: [{ path: "src/api/auth.ts", total_lines: 10 }],
    findings: [],
    ...overrides,
  };
}

const baseTask = {
  task_id: "task-1",
  unit_id: "unit-1",
  pass_id: "pass:security",
  lens: "security",
  file_paths: ["src/api/auth.ts"],
  rationale: "fixture",
};

// ── (a) AuditResult with/without token_usage both validate ─────────────────

test("AuditResultSchema accepts a result with no token_usage (backward-compatible)", () => {
  expect(() => AuditResultSchema.parse(baseResult())).not.toThrow();
});

test("AuditResultSchema accepts a result carrying a valid token_usage", () => {
  const parsed = AuditResultSchema.parse(
    baseResult({ token_usage: { input_tokens: 1200, output_tokens: 340 } }),
  );
  expect(parsed.token_usage).toEqual({ input_tokens: 1200, output_tokens: 340 });
});

test("AuditResultSchema rejects a token_usage missing a required sub-field", () => {
  expect(() =>
    AuditResultSchema.parse(baseResult({ token_usage: { input_tokens: 100 } })),
  ).toThrow();
});

test("validateAuditResults: absent token_usage produces no issue", () => {
  const issues = validateAuditResults([baseResult()], [baseTask]);
  expect(issues.some((i) => i.field.startsWith("token_usage"))).toBe(false);
});

test("validateAuditResults: valid token_usage produces no issue", () => {
  const issues = validateAuditResults(
    [baseResult({ token_usage: { input_tokens: 500, output_tokens: 120 } })],
    [baseTask],
  );
  expect(issues.some((i) => i.field.startsWith("token_usage"))).toBe(false);
});

test("validateAuditResults: malformed token_usage is a WARNING, never an error (never blocks ingest)", () => {
  const issues = validateAuditResults(
    [baseResult({ token_usage: { input_tokens: -5, output_tokens: "nope" } })],
    [baseTask],
  );
  const tokenIssues = issues.filter((i) => i.field.startsWith("token_usage"));
  expect(tokenIssues.length).toBeGreaterThan(0);
  expect(tokenIssues.every((i) => i.severity === "warning")).toBe(true);
});

// ── sumWaveTokenUsage ────────────────────────────────────────────────────────

test("sumWaveTokenUsage sums input+output across results, skipping absent/malformed usage", () => {
  const total = sumWaveTokenUsage([
    baseResult({ token_usage: { input_tokens: 1000, output_tokens: 200 } }),
    baseResult({ task_id: "task-2" }), // no token_usage
    baseResult({ task_id: "task-3", token_usage: { input_tokens: -1, output_tokens: 5 } }), // malformed → skipped whole
    baseResult({ task_id: "task-4", token_usage: { input_tokens: 300, output_tokens: 50 } }),
  ]);
  expect(total).toBe(1000 + 200 + 300 + 50);
});

test("sumWaveTokenUsage returns 0 for an empty or all-absent wave", () => {
  expect(sumWaveTokenUsage([])).toBe(0);
  expect(sumWaveTokenUsage([baseResult(), baseResult({ task_id: "task-2" })])).toBe(0);
});

// ── pickPrimaryCapacityPoolSummary ──────────────────────────────────────────

function poolSummary(overrides = {}) {
  return {
    pool_id: "claude-code/model-a",
    slots: 2,
    model: "model-a",
    confidence: "high",
    source: "discovered_capability",
    resolved_limits: {
      context_tokens: 100000,
      output_tokens: 8000,
      requests_per_minute: null,
      input_tokens_per_minute: null,
      output_tokens_per_minute: null,
    },
    host_concurrency_limit: null,
    is_conversation_host: true,
    cooldown_until: null,
    estimated_wave_tokens: 0,
    binding_cap: "none",
    ...overrides,
  };
}

test("pickPrimaryCapacityPoolSummary returns null for an absent/empty pool list", () => {
  expect(pickPrimaryCapacityPoolSummary(undefined)).toBe(null);
  expect(pickPrimaryCapacityPoolSummary([])).toBe(null);
});

test("pickPrimaryCapacityPoolSummary returns the sole pool in the common single-pool case", () => {
  const only = poolSummary();
  expect(pickPrimaryCapacityPoolSummary([only])).toBe(only);
});

test("pickPrimaryCapacityPoolSummary picks the most-slots pool, tie-broken by context then pool_id", () => {
  const small = poolSummary({ pool_id: "z-pool", slots: 1 });
  const big = poolSummary({ pool_id: "a-pool", slots: 4 });
  expect(pickPrimaryCapacityPoolSummary([small, big])).toBe(big);

  const sameSlotsSmallCtx = poolSummary({
    pool_id: "z-pool",
    slots: 2,
    resolved_limits: { ...poolSummary().resolved_limits, context_tokens: 1000 },
  });
  const sameSlotsBigCtx = poolSummary({
    pool_id: "a-pool",
    slots: 2,
    resolved_limits: { ...poolSummary().resolved_limits, context_tokens: 5000 },
  });
  expect(pickPrimaryCapacityPoolSummary([sameSlotsSmallCtx, sameSlotsBigCtx])).toBe(sameSlotsBigCtx);
});

// ── recordHostTokenUsageObservation ─────────────────────────────────────────

async function writeDispatchQuota(runDir, capacityPools) {
  await writeFile(
    join(runDir, "dispatch-quota.json"),
    JSON.stringify({ capacity_pools: capacityPools }, null, 2),
    "utf8",
  );
}

test("recordHostTokenUsageObservation: a wave with no token_usage leaves the pool calibrating (no false graduation)", async () => {
  await withTempStateDir(async (stateDir) => {
    const runDir = await mkdtemp(join(tmpdir(), "audit-tools-rundir-"));
    try {
      await writeDispatchQuota(runDir, [
        poolSummary({
          pool_id: "claude-code/model-a",
          quota_source_snapshot: {
            remaining_pct: 0.5,
            reset_at: null,
            requests_remaining: null,
            tokens_remaining: null,
            captured_at: new Date().toISOString(),
            source: "test",
          },
        }),
      ]);
      let probeCalled = false;
      const outcome = await recordHostTokenUsageObservation({
        runDir,
        passing: [baseResult()], // no token_usage
        probe: async () => {
          probeCalled = true;
          return null;
        },
      });
      expect(outcome.recorded).toBe(false);
      expect(outcome.reason).toBe("no_token_usage");
      expect(probeCalled, "must not probe when there is nothing to attribute").toBe(false);

      const state = await readQuotaState();
      expect(state.entries["claude-code/model-a"]).toBeUndefined();
    } finally {
      await rm(runDir, { recursive: true, force: true });
    }
  });
});

test("recordHostTokenUsageObservation: token_usage + pre/post snapshot delta graduates the pool's tokens_per_pct slope", async () => {
  await withTempStateDir(async (stateDir) => {
    const runDir = await mkdtemp(join(tmpdir(), "audit-tools-rundir-"));
    try {
      await writeDispatchQuota(runDir, [
        poolSummary({
          pool_id: "claude-code/model-a",
          quota_source_snapshot: {
            remaining_pct: 0.5,
            reset_at: null,
            requests_remaining: null,
            tokens_remaining: null,
            captured_at: new Date().toISOString(),
            source: "test",
          },
        }),
      ]);

      const outcome = await recordHostTokenUsageObservation({
        runDir,
        passing: [
          baseResult({ token_usage: { input_tokens: 8000, output_tokens: 2000 } }),
          baseResult({ task_id: "task-2", token_usage: { input_tokens: 4000, output_tokens: 1000 } }),
        ],
        // POST snapshot: percent dropped from 0.5 to 0.4 (a 10-point drop, well
        // past the 0.5-point floor) — the fold should attribute all 15000 tokens
        // to that drop.
        probe: async () => ({
          remaining_pct: 0.4,
          reset_at: null,
          requests_remaining: null,
          tokens_remaining: null,
          captured_at: new Date().toISOString(),
          source: "test",
        }),
      });

      expect(outcome.recorded).toBe(true);
      expect(outcome.poolId).toBe("claude-code/model-a");
      expect(outcome.tokens).toBe(15000);

      // BEFORE this fix the pool would show calibrating:true/no slope forever;
      // a real fold means quota-state now carries a learned tokens_per_pct for
      // the "default" (single-window) label.
      const state = await readQuotaState();
      const entry = state.entries["claude-code/model-a"];
      expect(entry, "quota-state entry created").toBeTruthy();
      expect(entry.tokens_per_pct, "tokens_per_pct slope learned").toBeTruthy();
      // 15000 tokens / (0.5-0.4)*100 = 10 percent → 1500 tokens/pct.
      expect(Math.abs(entry.tokens_per_pct.default - 1500) < 1e-6).toBe(true);
    } finally {
      await rm(runDir, { recursive: true, force: true });
    }
  });
});

test("recordHostTokenUsageObservation: no dispatch-quota.json (e.g. in-process-only round) degrades to a no-op", async () => {
  await withTempStateDir(async () => {
    const runDir = await mkdtemp(join(tmpdir(), "audit-tools-rundir-"));
    try {
      const outcome = await recordHostTokenUsageObservation({
        runDir,
        passing: [baseResult({ token_usage: { input_tokens: 100, output_tokens: 10 } })],
        probe: async () => null,
      });
      expect(outcome.recorded).toBe(false);
      expect(outcome.reason).toBe("no_dispatch_quota");
    } finally {
      await rm(runDir, { recursive: true, force: true });
    }
  });
});

test("recordHostTokenUsageObservation: a failed post-wave probe degrades to a no-op (never throws)", async () => {
  await withTempStateDir(async () => {
    const runDir = await mkdtemp(join(tmpdir(), "audit-tools-rundir-"));
    try {
      await writeDispatchQuota(runDir, [
        poolSummary({
          pool_id: "claude-code/model-a",
          quota_source_snapshot: {
            remaining_pct: 0.5,
            reset_at: null,
            requests_remaining: null,
            tokens_remaining: null,
            captured_at: new Date().toISOString(),
            source: "test",
          },
        }),
      ]);
      const outcome = await recordHostTokenUsageObservation({
        runDir,
        passing: [baseResult({ token_usage: { input_tokens: 100, output_tokens: 10 } })],
        probe: async () => null, // e.g. every quota source degraded/unavailable
      });
      expect(outcome.recorded).toBe(false);
      expect(outcome.reason).toBe("no_post_snapshot");

      const state = await readQuotaState();
      expect(state.entries["claude-code/model-a"]).toBeUndefined();
    } finally {
      await rm(runDir, { recursive: true, force: true });
    }
  });
});

// ── C4: plausibility ceiling on the summed token_usage ──────────────────────

test("isImplausibleTokenSum: accepts a sum within context_tokens * resultCount", () => {
  const pool = poolSummary({ resolved_limits: { ...poolSummary().resolved_limits, context_tokens: 100000 } });
  // 2 results, well under 200000.
  expect(isImplausibleTokenSum(15000, pool, 2)).toBe(false);
});

test("isImplausibleTokenSum: rejects a sum that grossly exceeds context_tokens * resultCount", () => {
  const pool = poolSummary({ resolved_limits: { ...poolSummary().resolved_limits, context_tokens: 100000 } });
  // 2 results → hard ceiling 200000; a "cumulative session total" style sum of
  // 5,000,000 is orders of magnitude past what 2 dispatches could plausibly report.
  expect(isImplausibleTokenSum(5_000_000, pool, 2)).toBe(true);
});

test("isImplausibleTokenSum: an unbound-able ceiling (bad context_tokens/resultCount) is treated as doubtful", () => {
  const pool = poolSummary({ resolved_limits: { ...poolSummary().resolved_limits, context_tokens: 0 } });
  expect(isImplausibleTokenSum(10, pool, 2)).toBe(true);
  const okPool = poolSummary();
  expect(isImplausibleTokenSum(10, okPool, 0)).toBe(true);
});

test("recordHostTokenUsageObservation: a wave-level cumulative-total-style token sum is REJECTED, not folded (C4)", async () => {
  await withTempStateDir(async () => {
    const runDir = await mkdtemp(join(tmpdir(), "audit-tools-rundir-"));
    try {
      // context_tokens=100000, 2 results → hard ceiling is 200000 tokens for
      // this wave. A host that mistakenly stamped each result with a
      // CUMULATIVE session running total (e.g. ~4M tokens deep into a long
      // session) blows past that ceiling by more than an order of magnitude.
      await writeDispatchQuota(runDir, [
        poolSummary({
          pool_id: "claude-code/model-a",
          quota_source_snapshot: {
            remaining_pct: 0.5,
            reset_at: null,
            requests_remaining: null,
            tokens_remaining: null,
            captured_at: new Date().toISOString(),
            source: "test",
          },
        }),
      ]);

      let probeCalled = false;
      const outcome = await recordHostTokenUsageObservation({
        runDir,
        passing: [
          baseResult({ token_usage: { input_tokens: 3_800_000, output_tokens: 40_000 } }),
          baseResult({ task_id: "task-2", token_usage: { input_tokens: 150_000, output_tokens: 10_000 } }),
        ],
        probe: async () => {
          probeCalled = true;
          return { remaining_pct: 0.4, reset_at: null, requests_remaining: null, tokens_remaining: null, captured_at: new Date().toISOString(), source: "test" };
        },
      });

      expect(outcome.recorded).toBe(false);
      expect(outcome.reason).toBe("implausible_token_sum");
      expect(outcome.tokens).toBe(3_800_000 + 40_000 + 150_000 + 10_000);
      expect(probeCalled, "must not even probe once the sum is implausible").toBe(false);

      const state = await readQuotaState();
      expect(state.entries["claude-code/model-a"]).toBeUndefined();
    } finally {
      await rm(runDir, { recursive: true, force: true });
    }
  });
});

// ── P1: window-identity (reset_at) guard across PRE/POST ────────────────────

test("recordHostTokenUsageObservation: a window rollover between PRE and POST (different reset_at) is NOT folded (P1)", async () => {
  await withTempStateDir(async () => {
    const runDir = await mkdtemp(join(tmpdir(), "audit-tools-rundir-"));
    try {
      await writeDispatchQuota(runDir, [
        poolSummary({
          pool_id: "claude-code/model-a",
          quota_source_snapshot: {
            // PRE: 0.5 remaining in a window resetting at T1.
            remaining_pct: 0.5,
            reset_at: "2026-07-11T10:00:00.000Z",
            requests_remaining: null,
            tokens_remaining: null,
            captured_at: new Date().toISOString(),
            source: "test",
          },
        }),
      ]);

      const outcome = await recordHostTokenUsageObservation({
        runDir,
        passing: [baseResult({ token_usage: { input_tokens: 8000, output_tokens: 2000 } })],
        // POST: the window has ROLLED OVER — a different reset_at (T2), even
        // though the raw percent (0.3) looks like a plausible ~20-point drop
        // from 0.5. Folding this would attribute tokens against a fake delta
        // instead of the real (unknown) in-window consumption.
        probe: async () => ({
          remaining_pct: 0.3,
          reset_at: "2026-07-11T15:00:00.000Z",
          requests_remaining: null,
          tokens_remaining: null,
          captured_at: new Date().toISOString(),
          source: "test",
        }),
      });

      expect(outcome.recorded).toBe(false);
      expect(outcome.reason).toBe("no_slope_delta");

      const state = await readQuotaState();
      expect(state.entries["claude-code/model-a"]).toBeUndefined();
    } finally {
      await rm(runDir, { recursive: true, force: true });
    }
  });
});

test("recordHostTokenUsageObservation: SAME reset_at on PRE/POST still folds normally (P1 doesn't over-block)", async () => {
  await withTempStateDir(async () => {
    const runDir = await mkdtemp(join(tmpdir(), "audit-tools-rundir-"));
    try {
      await writeDispatchQuota(runDir, [
        poolSummary({
          pool_id: "claude-code/model-a",
          quota_source_snapshot: {
            remaining_pct: 0.5,
            reset_at: "2026-07-11T10:00:00.000Z",
            requests_remaining: null,
            tokens_remaining: null,
            captured_at: new Date().toISOString(),
            source: "test",
          },
        }),
      ]);

      const outcome = await recordHostTokenUsageObservation({
        runDir,
        passing: [baseResult({ token_usage: { input_tokens: 8000, output_tokens: 2000 } })],
        probe: async () => ({
          remaining_pct: 0.4,
          reset_at: "2026-07-11T10:00:00.000Z", // same window
          requests_remaining: null,
          tokens_remaining: null,
          captured_at: new Date().toISOString(),
          source: "test",
        }),
      });

      expect(outcome.recorded).toBe(true);
      expect(outcome.reason).toBe("recorded");

      const state = await readQuotaState();
      expect(state.entries["claude-code/model-a"].tokens_per_pct.default).toBeGreaterThan(0);
    } finally {
      await rm(runDir, { recursive: true, force: true });
    }
  });
});

// ── Zero/negative delta guard ────────────────────────────────────────────────

test("recordHostTokenUsageObservation: an INCREASE (post_pct >= pre_pct) is rejected, never folded", async () => {
  await withTempStateDir(async () => {
    const runDir = await mkdtemp(join(tmpdir(), "audit-tools-rundir-"));
    try {
      await writeDispatchQuota(runDir, [
        poolSummary({
          pool_id: "claude-code/model-a",
          quota_source_snapshot: {
            remaining_pct: 0.4,
            reset_at: null,
            requests_remaining: null,
            tokens_remaining: null,
            captured_at: new Date().toISOString(),
            source: "test",
          },
        }),
      ]);

      const outcome = await recordHostTokenUsageObservation({
        runDir,
        passing: [baseResult({ token_usage: { input_tokens: 8000, output_tokens: 2000 } })],
        probe: async () => ({
          remaining_pct: 0.5, // INCREASED — e.g. window reopened
          reset_at: null,
          requests_remaining: null,
          tokens_remaining: null,
          captured_at: new Date().toISOString(),
          source: "test",
        }),
      });

      expect(outcome.recorded).toBe(false);
      expect(outcome.reason).toBe("no_slope_delta");

      const state = await readQuotaState();
      expect(state.entries["claude-code/model-a"]).toBeUndefined();
    } finally {
      await rm(runDir, { recursive: true, force: true });
    }
  });
});

test("recordHostTokenUsageObservation: ZERO delta (post_pct === pre_pct) is rejected, never folded", async () => {
  await withTempStateDir(async () => {
    const runDir = await mkdtemp(join(tmpdir(), "audit-tools-rundir-"));
    try {
      await writeDispatchQuota(runDir, [
        poolSummary({
          pool_id: "claude-code/model-a",
          quota_source_snapshot: {
            remaining_pct: 0.4,
            reset_at: null,
            requests_remaining: null,
            tokens_remaining: null,
            captured_at: new Date().toISOString(),
            source: "test",
          },
        }),
      ]);

      const outcome = await recordHostTokenUsageObservation({
        runDir,
        passing: [baseResult({ token_usage: { input_tokens: 8000, output_tokens: 2000 } })],
        probe: async () => ({
          remaining_pct: 0.4, // UNCHANGED
          reset_at: null,
          requests_remaining: null,
          tokens_remaining: null,
          captured_at: new Date().toISOString(),
          source: "test",
        }),
      });

      expect(outcome.recorded).toBe(false);
      expect(outcome.reason).toBe("no_slope_delta");

      const state = await readQuotaState();
      expect(state.entries["claude-code/model-a"]).toBeUndefined();
    } finally {
      await rm(runDir, { recursive: true, force: true });
    }
  });
});

// ── C2: folded label only reported after a SUCCESSFUL write ─────────────────

test("foldSlopeObservationFromPctMaps: a swallowed recordTokensPerPctObservation failure is NOT reported as folded (C2)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "audit-tools-c2-"));
  try {
    // Point the quota-state path at a DIRECTORY (not a file) so the
    // read-modify-write inside recordTokensPerPctObservation throws — this
    // reproduces the "fold labels are true progress" contract even when the
    // underlying write fails, which is exactly the C2 regression: before the
    // fix, `folded.push(label)` ran unconditionally, so this throw would
    // still be reported as a successful fold.
    setQuotaStateDir(dir);
    await mkdir(join(dir, "quota-state.json"));

    const prior = new Map([["default", { remainingPct: 0.5, resetAt: null }]]);
    const current = new Map([["default", { remainingPct: 0.4, resetAt: null }]]);
    const folded = await foldSlopeObservationFromPctMaps("claude-code/model-a", prior, current, 1000);

    expect(folded).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── C6: bounded probe timeout ────────────────────────────────────────────────

test("recordHostTokenUsageObservation: a HANGING probe times out and degrades to a no-op (C6)", async () => {
  await withTempStateDir(async () => {
    const runDir = await mkdtemp(join(tmpdir(), "audit-tools-rundir-"));
    try {
      await writeDispatchQuota(runDir, [
        poolSummary({
          pool_id: "claude-code/model-a",
          quota_source_snapshot: {
            remaining_pct: 0.5,
            reset_at: null,
            requests_remaining: null,
            tokens_remaining: null,
            captured_at: new Date().toISOString(),
            source: "test",
          },
        }),
      ]);

      const outcome = await recordHostTokenUsageObservation({
        runDir,
        passing: [baseResult({ token_usage: { input_tokens: 100, output_tokens: 10 } })],
        probe: () => new Promise(() => {}), // never resolves
        probeTimeoutMs: 50,
      });

      expect(outcome.recorded).toBe(false);
      expect(outcome.reason).toBe("probe_timeout");

      const state = await readQuotaState();
      expect(state.entries["claude-code/model-a"]).toBeUndefined();
    } finally {
      await rm(runDir, { recursive: true, force: true });
    }
  });
});
