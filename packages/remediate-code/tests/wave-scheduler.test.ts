import { describe, it, expect } from "vitest";
import {
  detectHostConcurrencyFromEnv,
  resolveHostConcurrencyLimit,
  scheduleWave,
  buildDispatchQuota,
} from "../src/steps/waveScheduler.js";

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
    expect(result!.active_subagents).toBe(6);
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
      estimatedTokensPerItem: 600,
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
      estimatedTokensPerItem: 600,
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
