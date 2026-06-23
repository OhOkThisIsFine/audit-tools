import test from "node:test";
import assert from "node:assert/strict";

const { HostSessionQuotaSource } = await import(
  "../../src/shared/quota/hostSessionQuotaSource.ts"
);
const { dropProvider } = await import("../../src/shared/quota/rollingEngine.ts");

const KEY = "claude-code/standard";
const LIMIT_TEXT = "You've hit your session limit · resets 3:30pm";

/** A controllable injected clock. */
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

test("CE-003 channel isolation: a healthy result quoting a limit string never pauses", async () => {
  const now = fakeClock(Date.UTC(2026, 0, 1, 10, 0, 0));
  const escalations = [];
  const src = new HostSessionQuotaSource({
    providerModelKey: KEY,
    now,
    onEscalation: (e) => escalations.push(e),
  });

  // The consumed AuditResult finding content quotes the exact session-limit
  // string — but it arrives on the `result` channel and must be ignored.
  const event = src.recordLimit("result", `Finding: code prints "${LIMIT_TEXT}"`, "pkt-1");
  assert.equal(event.recorded, false, "result-channel limit string must not be recorded");
  assert.equal(event.cooldown_until, null);

  const probe = await src.probeUsage(KEY);
  assert.equal(probe.status, "ok");
  assert.equal(probe.snapshot.remaining_pct, 1, "window stays open — no pause from result content");
  assert.equal(probe.snapshot.reset_at, null);
  assert.equal(src.cooldownUntil(), null, "no cooldown set");
  assert.equal(escalations.length, 0);

  // The SAME string on the error channel DOES record a limit.
  const real = src.recordLimit("error", LIMIT_TEXT, "pkt-1");
  assert.equal(real.recorded, true, "error-channel limit must be recorded");
  assert.notEqual(real.cooldown_until, null);
});

test("reset form 'resets 3:30pm' (clock time) → next-future-occurrence pause, auto-resume", async () => {
  // 10:00 local; reset 15:30 same day is in the future.
  const start = new Date(2026, 0, 1, 10, 0, 0).getTime();
  const now = fakeClock(start);
  const src = new HostSessionQuotaSource({ providerModelKey: KEY, now });

  const event = src.recordLimit("error", "session limit reached · resets 3:30pm", "pkt-a");
  assert.equal(event.recorded, true);
  const resetMs = new Date(event.cooldown_until).getTime();
  const expected = new Date(2026, 0, 1, 15, 30, 0).getTime();
  assert.ok(
    Math.abs(resetMs - expected) <= 6000,
    `reset should be ~15:30 today (+buffer); got ${event.cooldown_until}`,
  );

  // Paused before reset.
  let probe = await src.probeUsage(KEY);
  assert.equal(probe.snapshot.remaining_pct, 0, "paused → remaining_pct 0");
  assert.equal(probe.snapshot.reset_at, event.cooldown_until);

  // Advance past the reset → auto-resume.
  now.set(resetMs + 1);
  probe = await src.probeUsage(KEY);
  assert.equal(probe.snapshot.remaining_pct, 1, "window reopened after reset");
  assert.equal(probe.snapshot.reset_at, null);
  assert.equal(src.cooldownUntil(), null);
});

test("reset form 'Resets in 2h' (duration) → ~2h pause, auto-resume", async () => {
  const start = Date.UTC(2026, 0, 1, 10, 0, 0);
  const now = fakeClock(start);
  const src = new HostSessionQuotaSource({ providerModelKey: KEY, now });

  const event = src.recordLimit("status", "You've hit your usage limit. Resets in 2h", "pkt-b");
  assert.equal(event.recorded, true);
  const resetMs = new Date(event.cooldown_until).getTime();
  assert.ok(
    Math.abs(resetMs - (start + 2 * 3600_000)) <= 6000,
    `reset should be ~2h out (+buffer); got ${event.cooldown_until}`,
  );

  now.set(start + 2 * 3600_000 - 1000);
  assert.equal((await src.probeUsage(KEY)).snapshot.remaining_pct, 0, "still paused just before reset");

  now.set(resetMs + 1);
  assert.equal((await src.probeUsage(KEY)).snapshot.remaining_pct, 1, "auto-resumed after reset");
});

test("non-consuming re-queue: dropProvider returns the packet to pending, never consumed", async () => {
  // The host-session source pauses the pool; the rolling engine performs the
  // actual non-consuming re-queue — the packet moves to pending_tokens and is
  // never recorded as a completed/consumed result.
  const now = fakeClock(Date.UTC(2026, 0, 1, 10, 0, 0));
  const src = new HostSessionQuotaSource({ providerModelKey: KEY, now });
  const event = src.recordLimit("error", LIMIT_TEXT, "pkt-c");
  assert.equal(event.recorded, true);

  const state = {
    active_pools: [{ pool: { id: "host" }, provider: {} }],
    exhausted_pools: [],
    in_flight_tokens: [{ id: "pkt-c", assigned_pool_id: "host", estimated_tokens: 100 }],
    pending_tokens: [],
    event_log: [],
  };

  const next = dropProvider(state, "host", "exhausted");
  // The packet is re-queued (pending), not lost and not consumed.
  assert.deepEqual(
    next.pending_tokens.map((t) => t.id),
    ["pkt-c"],
    "limit-message packet returned to pending (non-consuming re-queue)",
  );
  assert.equal(next.in_flight_tokens.length, 0, "no longer in-flight");
  assert.equal(next.event_log[0].requeued_count, 1, "re-queue is recorded, not a consume");
});

test("bounded escalation: same packet re-limiting past the bound escalates to a terminal operator surface", async () => {
  const now = fakeClock(Date.UTC(2026, 0, 1, 10, 0, 0));
  const escalations = [];
  const src = new HostSessionQuotaSource({
    providerModelKey: KEY,
    now,
    maxConsecutiveReLimits: 3,
    onEscalation: (e) => escalations.push(e),
  });

  // An unresettable wall: the same packet trips the limit repeatedly. Crucially
  // we do NOT advance the clock past the reset, so each is a "same window"
  // re-limit, not normal progress.
  let last;
  for (let i = 0; i < 4; i++) {
    last = src.recordLimit("error", "session limit reached. Resets in 1h", "pkt-loop");
    if (i < 3) {
      assert.equal(last.escalation, null, `cycle ${i + 1} within bound → no escalation yet`);
      now.advance(1000); // small drift, still well before the 1h reset
    }
  }

  assert.notEqual(last.escalation, null, "4th re-limit (> bound 3) must escalate");
  assert.equal(last.escalation.packet_id, "pkt-loop");
  assert.equal(last.escalation.consecutive_re_limits, 4);
  assert.equal(escalations.length, 1, "operator surface invoked exactly once");
  assert.match(escalations[0].reason, /escalating to operator/i);
  assert.equal(src.isEscalated("pkt-loop"), true, "packet marked escalated → caller stops re-queuing");
});

test("escalation also fires on cumulative wall bound", async () => {
  const now = fakeClock(0);
  const escalations = [];
  const src = new HostSessionQuotaSource({
    providerModelKey: KEY,
    now,
    maxConsecutiveReLimits: 100, // not the binding bound here
    maxCumulativeWallMs: 90 * 60_000, // 90 min
    onEscalation: (e) => escalations.push(e),
  });

  // Each re-limit adds ~1h (+5s buffer). Two cycles = ~2h > 90min bound.
  src.recordLimit("error", "session limit reached. Resets in 1h", "pkt-wall");
  const second = src.recordLimit("error", "session limit reached. Resets in 1h", "pkt-wall");
  assert.notEqual(second.escalation, null, "cumulative wall over bound → escalate");
  assert.equal(escalations.length, 1);
  assert.match(escalations[0].reason, /cumulative/i);
});

test("own-provider only: a different provider/model key is not_applicable (composes, never overwrites)", async () => {
  const now = fakeClock(Date.UTC(2026, 0, 1, 10, 0, 0));
  const src = new HostSessionQuotaSource({ providerModelKey: KEY, now });
  src.recordLimit("error", LIMIT_TEXT, "pkt-x");

  const other = await src.probeUsage("other-provider/model");
  assert.equal(other.status, "not_applicable", "does not answer for other providers");
  assert.equal(other.snapshot, null);
});

test("a fresh genuine limit after auto-resume starts a new (un-escalated) re-limit count", async () => {
  const now = fakeClock(0);
  const src = new HostSessionQuotaSource({
    providerModelKey: KEY,
    now,
    maxConsecutiveReLimits: 2,
  });

  // Two same-window re-limits (within bound), then resume, then a fresh limit:
  src.recordLimit("error", "session limit reached. Resets in 1h", "pkt-y");
  const r2 = src.recordLimit("error", "session limit reached. Resets in 1h", "pkt-y");
  assert.equal(r2.escalation, null, "2 == bound, not yet over");

  // Advance past the reset → auto-resume clears the tracker.
  now.advance(2 * 3600_000);
  assert.equal((await src.probeUsage(KEY)).snapshot.remaining_pct, 1, "resumed");

  // A genuinely new limit on the same packet must NOT immediately escalate.
  const fresh = src.recordLimit("error", "session limit reached. Resets in 1h", "pkt-y");
  assert.equal(fresh.escalation, null, "post-resume count restarts — no false escalation");
});
