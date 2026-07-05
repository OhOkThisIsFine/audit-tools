import { test, expect } from "vitest";

const { HostSessionQuotaSource } = await import(
  "../../src/shared/quota/hostSessionQuotaSource.ts"
);

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
  expect(event.recorded, "result-channel limit string must not be recorded").toBe(false);
  expect(event.cooldown_until).toBe(null);

  const probe = await src.probeUsage(KEY);
  // Open with no limit known → the source has NO usage signal, so it passes
  // through (not_applicable / null snapshot) rather than masking the learned
  // source in the cascade. Composition over masking.
  expect(probe.status, "open + no limit → passes through").toBe("not_applicable");
  expect(probe.snapshot, "no snapshot asserted while window open with no limit").toBe(null);
  expect(src.cooldownUntil(), "no cooldown set").toBe(null);
  expect(escalations.length).toBe(0);

  // The SAME string on the error channel DOES record a limit.
  const real = src.recordLimit("error", LIMIT_TEXT, "pkt-1");
  expect(real.recorded, "error-channel limit must be recorded").toBe(true);
  expect(real.cooldown_until).not.toBe(null);
});

test("reset form 'resets 3:30pm' (clock time) → next-future-occurrence pause, auto-resume", async () => {
  // 10:00 local; reset 15:30 same day is in the future.
  const start = new Date(2026, 0, 1, 10, 0, 0).getTime();
  const now = fakeClock(start);
  const src = new HostSessionQuotaSource({ providerModelKey: KEY, now });

  const event = src.recordLimit("error", "session limit reached · resets 3:30pm", "pkt-a");
  expect(event.recorded).toBe(true);
  const resetMs = new Date(event.cooldown_until).getTime();
  const expected = new Date(2026, 0, 1, 15, 30, 0).getTime();
  expect(Math.abs(resetMs - expected) <= 6000, `reset should be ~15:30 today (+buffer); got ${event.cooldown_until}`).toBeTruthy();

  // Paused before reset.
  let probe = await src.probeUsage(KEY);
  expect(probe.snapshot.remaining_pct, "paused → remaining_pct 0").toBe(0);
  expect(probe.snapshot.reset_at).toBe(event.cooldown_until);

  // Advance past the reset → auto-resume. A limit was seen this cycle, so the
  // source now reports the near-wall band (CRITICAL throttle) rather than passing
  // through — the account approached the wall, the tracker is still live.
  now.set(resetMs + 1);
  probe = await src.probeUsage(KEY);
  expect(probe.status, "window reopened after reset").toBe("ok");
  expect(probe.snapshot.remaining_pct > 0 && probe.snapshot.remaining_pct < 0.1, `near-wall band after a recorded limit; got ${probe.snapshot.remaining_pct}`).toBeTruthy();
  expect(probe.snapshot.reset_at).toBe(null);
  expect(src.cooldownUntil()).toBe(null);
});

test("reset form 'Resets in 2h' (duration) → ~2h pause, auto-resume", async () => {
  const start = Date.UTC(2026, 0, 1, 10, 0, 0);
  const now = fakeClock(start);
  const src = new HostSessionQuotaSource({ providerModelKey: KEY, now });

  const event = src.recordLimit("status", "You've hit your usage limit. Resets in 2h", "pkt-b");
  expect(event.recorded).toBe(true);
  const resetMs = new Date(event.cooldown_until).getTime();
  expect(Math.abs(resetMs - (start + 2 * 3600_000)) <= 6000, `reset should be ~2h out (+buffer); got ${event.cooldown_until}`).toBeTruthy();

  now.set(start + 2 * 3600_000 - 1000);
  expect((await src.probeUsage(KEY)).snapshot.remaining_pct, "still paused just before reset").toBe(0);

  now.set(resetMs + 1);
  const resumed = await src.probeUsage(KEY);
  expect(resumed.status, "auto-resumed after reset").toBe("ok");
  expect(resumed.snapshot.remaining_pct > 0 && resumed.snapshot.remaining_pct < 0.1, "near-wall band after a recorded limit").toBeTruthy();
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
      expect(last.escalation, `cycle ${i + 1} within bound → no escalation yet`).toBe(null);
      now.advance(1000); // small drift, still well before the 1h reset
    }
  }

  expect(last.escalation, "4th re-limit (> bound 3) must escalate").not.toBe(null);
  expect(last.escalation.packet_id).toBe("pkt-loop");
  expect(last.escalation.consecutive_re_limits).toBe(4);
  expect(escalations.length, "operator surface invoked exactly once").toBe(1);
  expect(escalations[0].reason).toMatch(/escalating to operator/i);
  expect(src.isEscalated("pkt-loop"), "packet marked escalated → caller stops re-queuing").toBe(true);
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
  expect(second.escalation, "cumulative wall over bound → escalate").not.toBe(null);
  expect(escalations.length).toBe(1);
  expect(escalations[0].reason).toMatch(/cumulative/i);
});

test("own-provider only: a different provider/model key is not_applicable (composes, never overwrites)", async () => {
  const now = fakeClock(Date.UTC(2026, 0, 1, 10, 0, 0));
  const src = new HostSessionQuotaSource({ providerModelKey: KEY, now });
  src.recordLimit("error", LIMIT_TEXT, "pkt-x");

  const other = await src.probeUsage("other-provider/model");
  expect(other.status, "does not answer for other providers").toBe("not_applicable");
  expect(other.snapshot).toBe(null);
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
  expect(r2.escalation, "2 == bound, not yet over").toBe(null);

  // Advance past the reset → window reopened (cooldown cleared). The tracker
  // survives the auto-resume (so a probe between two pre-reset re-limits can't
  // silently reset the escalation count); near-wall band is still reported.
  now.advance(2 * 3600_000);
  const afterResume = await src.probeUsage(KEY);
  expect(afterResume.status, "resumed").toBe("ok");
  expect(src.cooldownUntil(), "cooldown cleared on resume").toBe(null);

  // A genuinely new limit on the same packet must NOT immediately escalate.
  const fresh = src.recordLimit("error", "session limit reached. Resets in 1h", "pkt-y");
  expect(fresh.escalation, "post-resume count restarts — no false escalation").toBe(null);
});
