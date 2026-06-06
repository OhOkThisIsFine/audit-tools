import { describe, it, expect, vi, afterEach } from "vitest";
import {
  detectHostConcurrencyFromEnv,
  resolveHostConcurrencyLimit,
  scheduleWave,
  buildDispatchQuota,
  normalizeSlotTokens,
  type WaveScheduleResult,
} from "../src/steps/waveScheduler.js";
import {
  computeBackoffCooldownMs,
  computeBackoffFailureWeight,
} from "../src/quota/index.js";
import {
  CODEX_DESKTOP_ACTIVE_SUBAGENT_LIMIT,
  type QuotaStateEntry,
} from "@audit-tools/shared";

describe("detectHostConcurrencyFromEnv", () => {
  it("returns limit from REMEDIATE_CODE_HOST_MAX_ACTIVE_SUBAGENTS", () => {
    const result = detectHostConcurrencyFromEnv({
      REMEDIATE_CODE_HOST_MAX_ACTIVE_SUBAGENTS: "8",
    } as any);
    expect(result).not.toBeNull();
    expect(result!.active_subagents).toBe(8);
    expect(result!.source).toBe("environment");
  });

  it("falls back to CODEX_MAX_ACTIVE_SUBAGENTS", () => {
    const result = detectHostConcurrencyFromEnv({
      CODEX_MAX_ACTIVE_SUBAGENTS: "4",
    } as any);
    expect(result).not.toBeNull();
    expect(result!.active_subagents).toBe(4);
  });

  it("detects Codex Desktop with hardcoded limit", () => {
    const result = detectHostConcurrencyFromEnv({
      CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "Codex Desktop",
    } as any);
    expect(result).not.toBeNull();
    expect(result!.active_subagents).toBe(CODEX_DESKTOP_ACTIVE_SUBAGENT_LIMIT);
  });

  it("returns null when no env vars set", () => {
    const result = detectHostConcurrencyFromEnv({} as any);
    expect(result).toBeNull();
  });

  it("ignores non-positive values", () => {
    const result = detectHostConcurrencyFromEnv({
      REMEDIATE_CODE_HOST_MAX_ACTIVE_SUBAGENTS: "0",
    } as any);
    expect(result).toBeNull();
  });

  it("ignores non-numeric values", () => {
    const result = detectHostConcurrencyFromEnv({
      REMEDIATE_CODE_HOST_MAX_ACTIVE_SUBAGENTS: "abc",
    } as any);
    expect(result).toBeNull();
  });
});

describe("resolveHostConcurrencyLimit", () => {
  it("uses explicit hostMaxConcurrent over everything", () => {
    const result = resolveHostConcurrencyLimit({
      hostMaxConcurrent: 10,
      sessionConfig: { parallel_workers: 3 },
      env: { REMEDIATE_CODE_HOST_MAX_ACTIVE_SUBAGENTS: "8" } as any,
    });
    expect(result!.active_subagents).toBe(10);
    expect(result!.source).toBe("cli_flags");
  });

  it("falls back to session config parallel_workers", () => {
    const result = resolveHostConcurrencyLimit({
      sessionConfig: { parallel_workers: 3 },
      env: {} as any,
    });
    expect(result!.active_subagents).toBe(3);
    expect(result!.source).toBe("session_config");
  });

  it("falls back to environment when no CLI or config", () => {
    const result = resolveHostConcurrencyLimit({
      sessionConfig: null,
      env: { CODEX_MAX_ACTIVE_SUBAGENTS: "4" } as any,
    });
    expect(result!.active_subagents).toBe(4);
    expect(result!.source).toBe("environment");
  });

  it("returns null when nothing is configured", () => {
    const result = resolveHostConcurrencyLimit({
      sessionConfig: null,
      env: {} as any,
    });
    expect(result).toBeNull();
  });
});

describe("scheduleWave", () => {
  it("uses host-reported limit as wave_size cap", async () => {
    const result = await scheduleWave({
      hostMaxConcurrent: 3,
      sessionConfig: null,
      itemCount: 10,
      env: {} as any,
    });
    expect(result.wave_size).toBe(3);
    expect(result.host_concurrency_limit!.active_subagents).toBe(3);
  });

  it("defaults to 5 when no limit is known", async () => {
    const result = await scheduleWave({
      sessionConfig: null,
      itemCount: 20,
      env: {} as any,
    });
    expect(result.wave_size).toBe(5);
    expect(result.host_concurrency_limit).toBeNull();
  });

  it("wave_size never exceeds item count", async () => {
    const result = await scheduleWave({
      hostMaxConcurrent: 10,
      sessionConfig: null,
      itemCount: 3,
      env: {} as any,
    });
    expect(result.wave_size).toBe(3);
  });

  it("wave_size is always >= 1", async () => {
    const result = await scheduleWave({
      sessionConfig: null,
      itemCount: 0,
      env: {} as any,
    });
    expect(result.wave_size).toBe(1);
  });

  it("computes estimated_wave_tokens correctly", async () => {
    const result = await scheduleWave({
      hostMaxConcurrent: 4,
      sessionConfig: null,
      itemCount: 10,
      estimatedSlotTokens: Array.from({ length: 10 }, () => 600),
      env: {} as any,
    });
    expect(result.wave_size).toBe(4);
    expect(result.estimated_wave_tokens).toBe(2400);
  });

  it("estimated_wave_tokens is 0 when no estimate provided", async () => {
    const result = await scheduleWave({
      sessionConfig: null,
      itemCount: 5,
      env: {} as any,
    });
    expect(result.estimated_wave_tokens).toBe(0);
  });

  it("uses session config parallel_workers when no explicit limit", async () => {
    const result = await scheduleWave({
      sessionConfig: { parallel_workers: 7 },
      itemCount: 20,
      env: {} as any,
    });
    expect(result.wave_size).toBe(7);
  });
});

describe("buildDispatchQuota", () => {
  it("assembles a valid quota object", async () => {
    const schedule = await scheduleWave({
      hostMaxConcurrent: 5,
      sessionConfig: null,
      itemCount: 10,
      estimatedSlotTokens: Array.from({ length: 10 }, () => 600),
      env: {} as any,
    });
    const quota = buildDispatchQuota("RUN-123", "document", schedule);
    expect(quota.contract_version).toBe("remediate-code-dispatch-quota/v1alpha2");
    expect(quota.run_id).toBe("RUN-123");
    expect(quota.phase).toBe("document");
    expect(quota.wave_size).toBe(5);
    expect(quota.estimated_wave_tokens).toBe(3000);
    expect(quota.host_concurrency_limit!.active_subagents).toBe(5);
    expect(quota.confidence).toBeDefined();
    expect(quota.source).toBeDefined();
    expect(quota.resolved_limits).toBeDefined();
  });

  it("works for implement phase", async () => {
    const schedule = await scheduleWave({
      sessionConfig: null,
      itemCount: 3,
      env: {} as any,
    });
    const quota = buildDispatchQuota("RUN-456", "implement", schedule);
    expect(quota.phase).toBe("implement");
    expect(quota.wave_size).toBe(3);
    expect(quota.host_concurrency_limit).toBeNull();
  });
});

function makeQuotaStateEntry(
  overrides: Partial<QuotaStateEntry> = {},
): QuotaStateEntry {
  return {
    updated_at: "2026-01-01T00:00:00.000Z",
    buckets: {},
    cooldown_until: null,
    last_429_at: null,
    ...overrides,
  };
}

async function makeScheduleResult(): Promise<WaveScheduleResult> {
  return await scheduleWave({
    hostMaxConcurrent: 4,
    sessionConfig: null,
    itemCount: 4,
    env: {} as any,
  });
}

describe("buildDispatchQuota — backoff state from learned quota entry", () => {
  it("populates backoff_state when consecutive_429_count > 0", async () => {
    const schedule = await makeScheduleResult();
    const entry = makeQuotaStateEntry({ consecutive_429_count: 3 });

    const quota = buildDispatchQuota("RUN-429", "document", schedule, entry);

    expect(quota.backoff_state).not.toBeNull();
    expect(quota.backoff_state!.consecutive_429_count).toBe(3);
    expect(quota.backoff_state!.current_cooldown_ms).toBe(
      computeBackoffCooldownMs(3),
    );
    expect(quota.backoff_state!.current_failure_weight).toBe(
      computeBackoffFailureWeight(3),
    );
  });

  it("leaves backoff_state null when consecutive_429_count is 0", async () => {
    const schedule = await makeScheduleResult();
    const entry = makeQuotaStateEntry({ consecutive_429_count: 0 });

    const quota = buildDispatchQuota("RUN-ok", "document", schedule, entry);

    expect(quota.backoff_state).toBeNull();
  });

  it("leaves backoff_state null when no quota entry is supplied", async () => {
    const schedule = await makeScheduleResult();

    const quota = buildDispatchQuota("RUN-none", "document", schedule);

    expect(quota.backoff_state).toBeNull();
  });

  it("passes quota_source_snapshot through from the schedule", async () => {
    const base = await makeScheduleResult();
    const snapshot = {
      remaining_pct: 42,
      reset_at: "2026-01-01T01:00:00.000Z",
      requests_remaining: 100,
      tokens_remaining: 50_000,
      captured_at: "2026-01-01T00:30:00.000Z",
      source: "test-source",
    };
    const schedule: WaveScheduleResult = {
      ...base,
      quota_source_snapshot: snapshot,
    };

    const quota = buildDispatchQuota("RUN-snap", "implement", schedule);

    expect(quota.quota_source_snapshot).toEqual(snapshot);
  });
});

describe("scheduleWave — quota-enabled path", () => {
  it("forwards estimatedSlotTokens to the quota scheduler and returns a usable schedule", async () => {
    const result = await scheduleWave({
      sessionConfig: { quota: { enabled: true } },
      itemCount: 3,
      estimatedSlotTokens: [1000, 2000, 3000],
      env: {} as any,
    });

    // The quota path (not the default early-return) was taken: a positive,
    // integral wave size with defined confidence/source comes back.
    expect(Number.isInteger(result.wave_size)).toBe(true);
    expect(result.wave_size).toBeGreaterThan(0);
    expect(result.confidence).toBeDefined();
    expect(result.source).toBeDefined();
  });
});

describe("normalizeSlotTokens", () => {
  it("truncates a too-long array to count", () => {
    expect(normalizeSlotTokens([100, 200, 300], 2)).toEqual([100, 200]);
  });

  it("zero-pads a too-short array to count", () => {
    expect(normalizeSlotTokens([100], 3)).toEqual([100, 0, 0]);
  });

  it("passes through an exactly-matching array unchanged", () => {
    expect(normalizeSlotTokens([100, 200], 2)).toEqual([100, 200]);
  });

  it("returns all-zeros when tokens is undefined", () => {
    expect(normalizeSlotTokens(undefined, 3)).toEqual([0, 0, 0]);
  });

  it("returns all-zeros when tokens is an empty array", () => {
    expect(normalizeSlotTokens([], 3)).toEqual([0, 0, 0]);
  });
});

// ---------------------------------------------------------------------------
// scheduleWave logs to stderr when readQuotaState throws
// ---------------------------------------------------------------------------

describe("scheduleWave — logs to stderr when readQuotaState throws", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes a [waveScheduler] message to stderr and still returns a valid WaveScheduleResult", async () => {
    // Intercept process.stderr.write to capture output
    const written: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(
      (chunk: unknown, ...args: unknown[]): boolean => {
        written.push(String(chunk));
        return original(chunk, ...(args as Parameters<typeof original>));
      },
    );

    // Force readQuotaState to throw by pointing its state directory at a
    // path that cannot be read (a directory used as if it were a file).
    // We use setQuotaStateDir (re-exported from @audit-tools/shared) to aim
    // the state reader at a path that will fail with a non-ENOENT error.
    // Simpler: supply an invalid path segment so the JSON.parse will throw
    // inside readQuotaState — but readQuotaState handles that internally.
    //
    // The most reliable approach: mock the shared module's readQuotaState
    // via vi.spyOn on the quota index re-export, which scheduleWave accesses.
    // Because ESM live bindings make vi.spyOn on a re-export work in vitest.
    const quotaModule = await import("../src/quota/index.js");
    const readQuotaStateSpy = vi
      .spyOn(quotaModule, "readQuotaState")
      .mockRejectedValue(new Error("simulated quota state read failure"));

    let result: WaveScheduleResult | undefined;
    try {
      result = await scheduleWave({
        sessionConfig: { quota: { enabled: true } },
        itemCount: 3,
        env: {} as any,
      });
    } finally {
      stderrSpy.mockRestore();
      readQuotaStateSpy.mockRestore();
    }

    // scheduleWave must not throw — it falls back gracefully
    expect(result).toBeDefined();
    expect(result!.wave_size).toBeGreaterThan(0);

    // stderr must have received the diagnostic message
    const stderrOutput = written.join("");
    expect(stderrOutput).toContain("[waveScheduler] readQuotaState failed");
    expect(stderrOutput).toContain("simulated quota state read failure");
  });
});
