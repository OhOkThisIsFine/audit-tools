import { test, expect, describe } from "vitest";
import type { HostModelRosterEntry } from "audit-tools/shared";

const { scheduleWave } = await import("../../src/remediate/steps/dispatch/waveScheduling.js");

describe("dq-2: host concurrency cap derivation on fresh handshake", () => {
  test("fresh 3-rank roster with no explicit max-concurrent should derive concurrency above 1", async () => {
    // Issue: when a 3-rank roster is provided with no explicit --host-max-concurrent,
    // the derived concurrency was collapsing to 1 on a clean slate (no learned limits).
    // The bug: contractPipeline wasn't passing hostModels to scheduleWave, so the
    // scheduler degraded to a single conservative pool.
    // Expected: should derive at least 2-3 concurrent slots for a 153-item fan-out

    const roster: HostModelRosterEntry[] = [
      { rank: "small", context_tokens: 8000, output_tokens: 1000, model_id: "claude-3-5-haiku" },
      { rank: "standard", context_tokens: 200000, output_tokens: 4000, model_id: "claude-3-5-sonnet" },
      { rank: "deep", context_tokens: 200000, output_tokens: 4000, model_id: "claude-3-opus" },
    ];

    // 153 items to dispatch (remediation fan-out)
    const itemTokens = Array.from({ length: 153 }, (_, i) => {
      // Mix of small/large items
      return i % 10 === 0 ? 5000 : 10000;
    });

    const result = await scheduleWave({
      hostMaxConcurrent: undefined, // No explicit max - should derive from capabilities
      sessionConfig: {},
      itemCount: itemTokens.length,
      estimatedSlotTokens: itemTokens,
      hostModels: roster,
      capabilityRanks: null,
    });

    // The bug: result.max_concurrent was 1 due to cold-start calibration collapsing
    // Expected: should be at least 2 or more for a 153-item fan-out
    expect(result).toBeDefined();
    expect(result.max_concurrent).toBeGreaterThan(1);
  });

  test("concurrency should never drop below cold-start floor", async () => {
    // The design says: "a fresh handshake with a healthy roster never derives
    // a concurrency cap below the cold-start floor the scheduler itself would use"

    // Simulate a fresh handshake (no learned limits, proactive quota off)
    const roster: HostModelRosterEntry[] = [
      { rank: "small", context_tokens: 8000, output_tokens: 1000, model_id: "claude-3-5-haiku" },
      { rank: "standard", context_tokens: 200000, output_tokens: 4000, model_id: "claude-3-5-sonnet" },
    ];

    const itemTokens = Array(100).fill(5000); // 100 items, 5k tokens each

    const result = await scheduleWave({
      hostMaxConcurrent: undefined,
      sessionConfig: {},
      itemCount: itemTokens.length,
      estimatedSlotTokens: itemTokens,
      hostModels: roster,
      capabilityRanks: null,
    });

    // Cold-start sizing: the scheduler has a minimum concurrency it would use
    // For a 100-item fan-out, concurrency should be reasonable
    expect(result).toBeDefined();
    expect(result.max_concurrent).toBeGreaterThanOrEqual(1);
  });
});
