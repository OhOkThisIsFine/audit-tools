import test from "node:test";
import assert from "node:assert/strict";

const { HostSessionQuotaSource } = await import(
  "../../src/shared/quota/hostSessionQuotaSource.ts"
);
const { buildQuotaSource, CompositeQuotaSource } = await import(
  "../../src/shared/quota/compositeQuotaSource.ts"
);
const { createRollingDispatcher } = await import(
  "../../src/shared/dispatch/rollingDispatch.ts"
);
const {
  QUOTA_REMAINING_PCT_CRITICAL,
  QUOTA_REMAINING_PCT_LOW,
} = await import("../../src/shared/quota/scheduler.ts");

const KEY = "claude-code/standard";
const OTHER_KEY = "openai-compatible/some-model";

function fakeClock(startMs) {
  let t = startMs;
  const now = () => t;
  now.advance = (ms) => {
    t += ms;
  };
  now.set = (ms) => {
    t = ms;
  };
  return now;
}

/** A learned-style stub that ALWAYS answers (for any key) with a healthy snapshot. */
function alwaysHealthySource(name) {
  return {
    name,
    async queryCurrentUsage() {
      return null;
    },
    async probeUsage(providerModelKey) {
      return {
        snapshot: {
          remaining_pct: 0.9,
          reset_at: null,
          requests_remaining: null,
          tokens_remaining: null,
          captured_at: new Date(0).toISOString(),
          source: name,
        },
        status: "ok",
      };
    },
  };
}

test("CE-001/CE-002 prepend: host-session source is consulted FIRST for its own key", async () => {
  const now = fakeClock(Date.UTC(2026, 0, 1, 10, 0, 0));
  const hostSession = new HostSessionQuotaSource({ providerModelKey: KEY, now });
  // Record a limit so the host source has a definite (paused) signal for its key.
  hostSession.recordLimit("error", "session limit reached. Resets in 1h", "pkt-1");

  const learned = alwaysHealthySource("learned-stub");
  const composite = new CompositeQuotaSource([hostSession, learned]);

  const own = await composite.probeUsage(KEY);
  assert.equal(own.snapshot.source, "host_session", "host-session wins for its own key");
  assert.equal(own.snapshot.remaining_pct, 0, "paused → 0, not the learned 0.9");
});

test("passthrough: host-session never masks the learned source for a DIFFERENT key", async () => {
  const now = fakeClock(0);
  const hostSession = new HostSessionQuotaSource({ providerModelKey: KEY, now });
  hostSession.recordLimit("error", "session limit reached. Resets in 1h", "pkt-1");

  const learned = alwaysHealthySource("learned-stub");
  const composite = new CompositeQuotaSource([hostSession, learned]);

  const other = await composite.probeUsage(OTHER_KEY);
  assert.equal(other.snapshot.source, "learned-stub", "other key → learned answers");
  assert.equal(other.snapshot.remaining_pct, 0.9);
});

test("composition: open + no limit known passes through to the learned source for its OWN key", async () => {
  const now = fakeClock(0);
  const hostSession = new HostSessionQuotaSource({ providerModelKey: KEY, now });
  const learned = alwaysHealthySource("learned-stub");
  const composite = new CompositeQuotaSource([hostSession, learned]);

  // No limit ever recorded → host-session has no usage signal → it must not win.
  const own = await composite.probeUsage(KEY);
  assert.equal(own.snapshot.source, "learned-stub", "no signal → defers to learned (no masking)");
});

/** A minimal real-shaped CapacityPool for the rolling-dispatch tests. */
function singlePool() {
  return {
    id: KEY,
    providerName: "claude-code",
    hostModel: "standard",
    rank: "standard",
    hostConcurrencyLimit: null,
    quotaStateEntry: null,
    discoveredLimits: { context_tokens: 100_000, output_tokens: 8_000 },
    quotaSourceSnapshot: null,
  };
}

test("buildQuotaSource PREPENDS the host-session source before proactive sources", async () => {
  const now = fakeClock(0);
  const hostSession = new HostSessionQuotaSource({ providerModelKey: KEY, now });
  hostSession.recordLimit("error", "session limit reached. Resets in 1h", "pkt-1");

  const composite = buildQuotaSource({ claudeOAuth: false, hostSession });
  const own = await composite.probeUsage(KEY);
  assert.equal(own.snapshot.source, "host_session", "prepended → answers first for its key");
  assert.equal(own.snapshot.remaining_pct, 0, "paused signal surfaced through the cascade");
});

test("graduated pre-wall: after a recorded limit the band is below CRITICAL (scheduler throttles pre-429)", async () => {
  const start = Date.UTC(2026, 0, 1, 10, 0, 0);
  const now = fakeClock(start);
  const hostSession = new HostSessionQuotaSource({ providerModelKey: KEY, now });
  const event = hostSession.recordLimit("error", "session limit reached. Resets in 1h", "pkt-1");
  const resetMs = new Date(event.cooldown_until).getTime();

  // Advance past the reset so the window reopened but the tracker is still live —
  // the account just brushed the wall. The graduated band must be < CRITICAL so
  // applyQuotaSourceAdjustment throttles the wave to 1 BEFORE a hard 429.
  now.set(resetMs + 1);
  const probe = await hostSession.probeUsage(KEY);
  assert.equal(probe.status, "ok");
  assert.ok(
    probe.snapshot.remaining_pct > 0,
    "graduated, not a hard 0",
  );
  assert.ok(
    probe.snapshot.remaining_pct < QUOTA_REMAINING_PCT_CRITICAL,
    `near-wall band must be below CRITICAL (${QUOTA_REMAINING_PCT_CRITICAL}); got ${probe.snapshot.remaining_pct}`,
  );
  assert.ok(probe.snapshot.remaining_pct < QUOTA_REMAINING_PCT_LOW);
});

test("isPaused fix: an in-flight same-packet re-limit sequence still escalates even when probed between limits", async () => {
  const now = fakeClock(0);
  const escalations = [];
  const hostSession = new HostSessionQuotaSource({
    providerModelKey: KEY,
    now,
    maxConsecutiveReLimits: 3,
    onEscalation: (e) => escalations.push(e),
  });

  // The same packet keeps re-limiting against a 1h wall. Between each limit a
  // PROBE fires (as the scheduler would) AFTER the prior reset has nominally
  // elapsed. The old code nulled the tracker on that auto-resume, resetting the
  // escalation count so the wall livelocked forever. The fix preserves the
  // tracker across the probe, so the bound still accrues and escalation fires.
  let last;
  for (let i = 0; i < 4; i++) {
    last = hostSession.recordLimit("error", "session limit reached. Resets in 1h", "pkt-loop");
    // Advance to just past the reset and PROBE — the resume path runs here.
    now.advance(3600_000 + 10);
    const probe = await hostSession.probeUsage(KEY);
    assert.equal(probe.status, "ok", `probe ${i + 1} sees the window reopened`);
  }
  assert.notEqual(last.escalation, null, "livelock detected despite resume-probes between limits");
  assert.equal(hostSession.isEscalated("pkt-loop"), true);
  assert.equal(escalations.length, 1);
});

test("rollingDispatch consults isPacketEscalated: an escalated packet is STRANDED, not re-queued (INV-QD-07 preserved)", async () => {
  const now = fakeClock(0);
  const hostSession = new HostSessionQuotaSource({
    providerModelKey: KEY,
    now,
    maxConsecutiveReLimits: 1,
  });
  // Drive the packet over the bound so it is escalated.
  hostSession.recordLimit("error", "session limit reached. Resets in 1h", "pkt-esc");
  hostSession.recordLimit("error", "session limit reached. Resets in 1h", "pkt-esc");
  assert.equal(hostSession.isEscalated("pkt-esc"), true);

  const dispatcher = createRollingDispatcher({
    confirmedPools: [singlePool()],
    sessionConfig: {},
    dispatchPacket: async (packet) => ({
      packet,
      outcome: "rate_limited",
    }),
    isPacketEscalated: (id) => hostSession.isEscalated(id),
  });

  dispatcher.enqueue([
    { id: "pkt-esc", payload: {}, estimatedTokens: 10, complexity: 0.5 },
  ]);
  const results = await dispatcher.run();

  // The escalated packet is neither completed nor infinitely re-queued: it is
  // stranded and surfaced via the empty-pool terminal.
  assert.equal(results.length, 0, "no terminal result for an escalated/stranded packet");
  const terminal = dispatcher.getTerminal();
  assert.notEqual(terminal, null, "stranded packet surfaces a terminal");
  assert.ok(
    terminal.stranded_ids.includes("pkt-esc"),
    `terminal names the stranded packet: ${JSON.stringify(terminal)}`,
  );
});

test("rollingDispatch without escalation: a non-escalated rate_limited packet keeps INV-QD-07 re-route/strand semantics", async () => {
  // No isPacketEscalated predicate → behaviour is unchanged: the single pool
  // exhausts and the packet strands via the normal INV-QD-07 empty-pool terminal.
  const dispatcher = createRollingDispatcher({
    confirmedPools: [singlePool()],
    sessionConfig: {},
    dispatchPacket: async (packet) => ({ packet, outcome: "rate_limited" }),
  });
  dispatcher.enqueue([{ id: "pkt-rl", payload: {}, estimatedTokens: 10, complexity: 0.5 }]);
  const results = await dispatcher.run();
  assert.equal(results.length, 0, "rate_limited packet not recorded as a terminal result");
  assert.notEqual(dispatcher.getTerminal(), null, "stranded via the normal empty-pool terminal");
});
