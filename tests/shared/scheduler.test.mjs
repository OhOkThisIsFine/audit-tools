import { test, expect } from "vitest";

const { scheduleWave, TOKEN_BUDGET_COLD_START_SLOTS } = await import("../../src/shared/quota/scheduler.ts");

// A minimal session-config that keeps quota enabled.
function baseSessionConfig(overrides = {}) {
  return {
    quota: { safety_margin: 0.8,
      ...overrides,
    },
  };
}

// computeUncappedWaveSize input object — transposition safety
// Each sub-test exercises a distinct cap branch and confirms that the named-input
// refactor did not silently swap any of the 10 arguments.

test("rpm cap: scheduleWave respects requests_per_minute limit", () => {
  // Provide an RPM limit that is tighter than the requested concurrency.
  const schedule = scheduleWave({
    providerName: "claude-code",
    sessionConfig: {
      quota: { safety_margin: 1.0, // no safety shrinkage so cap is exact
        models: {
          "test/model": { requests_per_minute: 4 },
        },
      },
    },
    hostModel: "test/model",
    requestedConcurrency: 20,
    quotaStateEntry: null,
    hostConcurrencyLimit: null,
  });
  expect(schedule.max_concurrent, "max_concurrent should be capped by rpm").toBe(4);
  expect(schedule.binding_cap).toBe("rpm");
});

test("tpm cap: scheduleWave respects input_tokens_per_minute limit", () => {
  // 10 slots each costing 1000 tokens = 10_000 total; budget allows only 5_000
  // at safety_margin=1.0, so max_concurrent should be 5.
  const schedule = scheduleWave({
    providerName: "claude-code",
    sessionConfig: {
      quota: { safety_margin: 1.0,
        models: {
          "test/model": { input_tokens_per_minute: 5000 },
        },
      },
    },
    hostModel: "test/model",
    requestedConcurrency: 10,
    estimatedSlotTokens: new Array(10).fill(1000),
    quotaStateEntry: null,
    hostConcurrencyLimit: null,
  });
  expect(schedule.max_concurrent, "max_concurrent should be capped by tpm").toBe(5);
  expect(schedule.binding_cap).toBe("tpm");
});

test("no learned cap: a quotaStateEntry NEVER caps the wave (concurrency is declared or absent)", () => {
  // Historic behaviour: a quota-state entry carrying concurrency "evidence" drove
  // a learned ceiling and set binding_cap="learned". That inference is a category
  // error — concurrency is DECLARED by the provider or ABSENT. The entry now
  // carries only reactive backoff state, and never narrows a wave on its own.
  const quotaStateEntry = {
    updated_at: new Date().toISOString(),
    consecutive_429_count: 0,
    cooldown_until: null,
    last_429_at: null,
  };
  const schedule = scheduleWave({
    providerName: "claude-code",
    sessionConfig: baseSessionConfig(),
    hostModel: null,
    requestedConcurrency: 10,
    quotaStateEntry,
    hostConcurrencyLimit: null,
  });
  expect(schedule.max_concurrent, "a quota-state entry must not narrow the wave").toBe(10);
  expect(schedule.binding_cap).toBe("none");
});
test("no invented cap: scheduleWave leaves the wave uncapped with no learned/host/rate/budget signal", () => {
  // The former unknown_hosted / cold-start fallback caps are gone. With no
  // learned history, no host limit, no RPM/TPM, and no live snapshot, nothing
  // invents a ceiling — concurrency is the requested wave (token-budget model).
  const schedule = scheduleWave({
    providerName: "claude-code",
    sessionConfig: {
      quota: { safety_margin: 0.8 },
    },
    hostModel: null,
    requestedConcurrency: 20,
    quotaStateEntry: null,
    hostConcurrencyLimit: null,
  });
  expect(schedule.max_concurrent, "wave should be uncapped").toBe(20);
  expect(schedule.binding_cap).toBe("none");
});

test("no invented cap: an unconfigured local provider is also uncapped", () => {
  const schedule = scheduleWave({
    providerName: "worker-command",
    sessionConfig: {
      quota: { safety_margin: 0.8 },
    },
    hostModel: null,
    requestedConcurrency: 20,
    quotaStateEntry: null,
    hostConcurrencyLimit: null,
  });
  expect(schedule.max_concurrent).toBe(20);
  expect(schedule.binding_cap).toBe("none");
});

// ── Discovered-capability context window (N5a) ───────────────────────────────
// A host that reports its real context window at the dispatch handshake must
// outrank the conservative default AND the static known-model table.

test("discovered capability: context window overrides the 32k default for a null model", () => {
  // model:null normally falls to the 32k provider/default floor. A discovered
  // 200k window must take over so the partition sizes to the real model.
  const schedule = scheduleWave({
    providerName: "worker-command",
    sessionConfig: baseSessionConfig(),
    hostModel: null,
    requestedConcurrency: 4,
    quotaStateEntry: null,
    hostConcurrencyLimit: null,
    discoveredLimits: { context_tokens: 200_000, output_tokens: 32_000 },
  });
  expect(schedule.resolved_limits.context_tokens).toBe(200_000);
  expect(schedule.resolved_limits.output_tokens).toBe(32_000);
  expect(schedule.source).toBe("discovered_capability");
});

test("discovered capability: explicit per-model config still wins over discovery", () => {
  const schedule = scheduleWave({
    providerName: "claude-code",
    sessionConfig: {
      quota: { safety_margin: 0.8,
        models: { "test/model": { context_tokens: 128_000, output_tokens: 8_192 } },
      },
    },
    hostModel: "test/model",
    requestedConcurrency: 4,
    quotaStateEntry: null,
    hostConcurrencyLimit: null,
    discoveredLimits: { context_tokens: 200_000, output_tokens: 32_000 },
  });
  expect(schedule.resolved_limits.context_tokens).toBe(128_000);
  expect(schedule.source).toBe("explicit_config");
});

test("discovered capability: absent context window leaves resolution unchanged", () => {
  // Only RPM/TPM discovered (no context window) → context still resolves from
  // the existing rungs, not the discovered channel.
  const schedule = scheduleWave({
    providerName: "worker-command",
    sessionConfig: baseSessionConfig(),
    hostModel: null,
    requestedConcurrency: 4,
    quotaStateEntry: null,
    hostConcurrencyLimit: null,
    discoveredLimits: { requests_per_minute: 10 },
  });
  expect(schedule.resolved_limits.context_tokens).toBe(32_000);
  expect(schedule.source).not.toBe("discovered_capability");
});

// ── binding_cap precedence (TST-bf201bf7) ─────────────────────────────────────
// The earlier tests pin each individual cap (rpm/tpm/learned/fallback/first_contact)
// in isolation. These cover the *precedence* tail: the host-concurrency ceiling is
// applied last and must override a looser quota cap, and an active cooldown short-
// circuits all cap logic to a single slot.

test("host_concurrency cap: a tighter host ceiling overrides a looser quota cap and binds last", () => {
  // RPM would allow 8, but the host caps active_subagents at 2 → host wins.
  const schedule = scheduleWave({
    providerName: "claude-code",
    sessionConfig: {
      quota: { safety_margin: 1.0,
        models: { "test/model": { requests_per_minute: 8 } },
      },
    },
    hostModel: "test/model",
    requestedConcurrency: 8,
    quotaStateEntry: null,
    hostConcurrencyLimit: { active_subagents: 2 },
  });
  expect(schedule.max_concurrent, "host ceiling (2) must override the looser rpm cap (8)").toBe(2);
  expect(schedule.binding_cap).toBe("host_concurrency");
});

test("host_concurrency cap: a looser host ceiling does NOT override a tighter quota cap", () => {
  // RPM caps at 3; host allows 10 → rpm stays the binding cap, not host_concurrency.
  const schedule = scheduleWave({
    providerName: "claude-code",
    sessionConfig: {
      quota: { safety_margin: 1.0,
        models: { "test/model": { requests_per_minute: 3 } },
      },
    },
    hostModel: "test/model",
    requestedConcurrency: 20,
    quotaStateEntry: null,
    hostConcurrencyLimit: { active_subagents: 10 },
  });
  expect(schedule.max_concurrent, "rpm (3) is tighter than the host ceiling (10)").toBe(3);
  expect(schedule.binding_cap).toBe("rpm");
});

test("cooldown cap: an active cooldown throttles to one slot and short-circuits cap logic", () => {
  const future = new Date(Date.now() + 5 * 60_000).toISOString();
  const schedule = scheduleWave({
    providerName: "claude-code",
    sessionConfig: {
      quota: { safety_margin: 1.0,
        models: { "test/model": { requests_per_minute: 50 } },
      },
    },
    hostModel: "test/model",
    requestedConcurrency: 20,
    quotaStateEntry: { updated_at: new Date().toISOString(), buckets: {}, cooldown_until: future, last_429_at: future },
    hostConcurrencyLimit: null,
  });
  expect(schedule.max_concurrent, "an active cooldown caps the wave at a single slot").toBe(1);
  expect(schedule.binding_cap).toBe("cooldown");
  expect(schedule.cooldown_until).toBe(future);
});

// ── Cold-start CONCURRENCY sizing (2026-07-11 backlog Bug 1a + its two mis-fixes) ──
// scheduleWave's own calibrating clamp — which sizes BOTH the host-facing summary
// and the in-process rolling engine's own wave/partition (NIM/codex/opencode) — is
// bounded by a small CONCURRENCY default (TOKEN_BUDGET_COLD_START_SLOTS), never the
// host-grant's 1-packet slope-learning probe (COLD_START_PROBE_BATCH, which stays
// scoped to admissionLoop.ts's token-aware GRANT sizing — see the constant's doc in
// scheduler.ts) and never left unbounded against an unmeasured ceiling. Two prior
// regressions here: 9b5553c0 wrongly reused the 1-packet probe for this clamp
// (starved a healthy in-process partition to 1, breaking hybrid-inprocess);
// 5e697640 wrongly exempted "self-pacing" pools from the clamp entirely (left a
// calibrating in-process partition UNBOUNDED, breaking hybrid-dispatch's
// capacity-bounded assertion). Neither distinction (host-vs-probe sizing rule,
// self-pacing-vs-host exemption) survives — every calibrating pool, host or
// in-process, clamps to the SAME concurrency default.

test("cold start, one window known + a sibling window still calibrating: clamps to the cold-start concurrency default despite a known budget", () => {
  // "session" window has an absolute tokens_remaining (known budget = 100_000);
  // "weekly" window has only a remaining_pct with no learned slope (unresolved).
  // The pool-level MIN budget is still 100_000 (from the known window), but the
  // wave must clamp to the cold-start concurrency default because the OTHER
  // window's true budget is unknown — a healthy window must not over-dispatch an
  // un-calibrated sibling.
  const schedule = scheduleWave({
    providerName: "claude-code",
    sessionConfig: { quota: { safety_margin: 1.0 } },
    hostModel: null,
    requestedConcurrency: 10,
    estimatedSlotTokens: new Array(10).fill(1000),
    quotaSourceSnapshot: {
      remaining_pct: 0.5,
      reset_at: null,
      requests_remaining: null,
      tokens_remaining: null,
      captured_at: new Date().toISOString(),
      source: "test",
      windows: [
        { label: "session", scope: "account", remaining_pct: null, tokens_remaining: 100_000, reset_at: null },
        { label: "weekly", scope: "account", remaining_pct: 0.5, tokens_remaining: null, reset_at: null },
      ],
    },
  });
  expect(schedule.calibrating).toBe(true);
  expect(schedule.remaining_token_budget).toBe(100_000); // the KNOWN window's budget, surfaced verbatim
  expect(schedule.max_concurrent).toBe(TOKEN_BUDGET_COLD_START_SLOTS); // still clamped by the unresolved sibling
});

test("cold-start concurrency clamp binds an in-process (backend) pool identically to a host pool — no selfPacing exemption", () => {
  const base = {
    providerName: "openai-compatible", // in-process backend provider (NIM)
    sessionConfig: { quota: { safety_margin: 1.0 } },
    hostModel: null,
    requestedConcurrency: 10,
    estimatedSlotTokens: new Array(10).fill(1000),
    quotaSourceSnapshot: {
      remaining_pct: 0.5,
      reset_at: null,
      requests_remaining: null,
      tokens_remaining: null,
      captured_at: new Date().toISOString(),
      source: "test",
      windows: [
        { label: "session", scope: "account", remaining_pct: null, tokens_remaining: 100_000, reset_at: null },
        { label: "weekly", scope: "account", remaining_pct: 0.5, tokens_remaining: null, reset_at: null },
      ],
    },
  };
  const schedule = scheduleWave(base);
  expect(schedule.calibrating).toBe(true);
  // Bounded to the concurrency default, NOT unbounded (would be 10 if exempted)
  // and NOT the 1-packet host-grant probe.
  expect(schedule.max_concurrent).toBe(TOKEN_BUDGET_COLD_START_SLOTS);
});

test("fully cold in-process pool (no absolute or learned budget anywhere) clamps to the concurrency default, not the full requested wave", () => {
  const schedule = scheduleWave({
    providerName: "openai-compatible",
    sessionConfig: { quota: { safety_margin: 1.0 } },
    hostModel: null,
    requestedConcurrency: 12,
    estimatedSlotTokens: new Array(12).fill(500),
    quotaSourceSnapshot: {
      remaining_pct: 0.9,
      reset_at: null,
      requests_remaining: null,
      tokens_remaining: null,
      captured_at: new Date().toISOString(),
      source: "test",
    },
  });
  expect(schedule.calibrating).toBe(true);
  expect(schedule.max_concurrent).toBe(TOKEN_BUDGET_COLD_START_SLOTS);
  expect(schedule.max_concurrent).toBeGreaterThan(0);
  expect(schedule.max_concurrent).toBeLessThan(12);
});

test("a genuinely KNOWN-zero budget still throttles to 1 (real signal, not the calibration clamp)", () => {
  const schedule = scheduleWave({
    providerName: "openai-compatible",
    sessionConfig: { quota: { safety_margin: 1.0 } },
    hostModel: null,
    requestedConcurrency: 8,
    quotaSourceSnapshot: {
      remaining_pct: 0,
      reset_at: new Date(Date.now() + 60_000).toISOString(),
      requests_remaining: null,
      tokens_remaining: 0,
      captured_at: new Date().toISOString(),
      source: "test",
    },
  });
  expect(schedule.max_concurrent).toBe(1);
  expect(schedule.binding_cap).toBe("cooldown");
});

test("quota disabled: host ceiling still binds, otherwise binding_cap is 'none'", () => {
  const capped = scheduleWave({
    providerName: "claude-code",
    sessionConfig: { quota: {} },
    hostModel: null,
    requestedConcurrency: 6,
    quotaStateEntry: null,
    hostConcurrencyLimit: { active_subagents: 2 },
  });
  expect(capped.max_concurrent).toBe(2);
  expect(capped.binding_cap).toBe("host_concurrency");

  const uncapped = scheduleWave({
    providerName: "claude-code",
    sessionConfig: { quota: {} },
    hostModel: null,
    requestedConcurrency: 6,
    quotaStateEntry: null,
    hostConcurrencyLimit: null,
  });
  expect(uncapped.max_concurrent).toBe(6);
  expect(uncapped.binding_cap).toBe("none");
});


// Pins the scope guard's PLACEMENT, not merely its existence. `deriveTokenBudget`
// is skipped when a cooldown is active, so a guard living inside it is not a gate
// for that path — yet the snapshot is still stamped onto the returned schedule and
// flows downstream. An incomplete gate reads exactly like a working one.
test("window scope guard: fires on the COOLDOWN path, where budget derivation is skipped", () => {
  const future = new Date(Date.now() + 5 * 60_000).toISOString();
  const scopeless = {
    remaining_pct: 0.5,
    reset_at: null,
    requests_remaining: null,
    tokens_remaining: null,
    captured_at: new Date().toISOString(),
    source: "test",
    windows: [{ label: "session", remaining_pct: 0.5, reset_at: null }], // no scope
  };
  expect(() =>
    scheduleWave({
      providerName: "claude-code",
      sessionConfig: { quota: { safety_margin: 1.0 } },
      hostModel: null,
      requestedConcurrency: 4,
      quotaStateEntry: {
        updated_at: new Date().toISOString(),
        buckets: {},
        cooldown_until: future,
        last_429_at: future,
      },
      quotaSourceSnapshot: scopeless,
      hostConcurrencyLimit: null,
    }),
  ).toThrow(/no metering scope/);
});
