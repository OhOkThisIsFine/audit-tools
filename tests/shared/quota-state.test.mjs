import { test, expect } from "vitest";
import { mkdtemp, mkdir, rm, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const {
  setQuotaStateDir,
  getQuotaStatePath,
  readQuotaState,
  readQuotaStateOrDegrade,
  writeQuotaState,
  emptyQuotaState,
  QuotaStateUnavailableError,
  recordWaveOutcome,
  foldTokensPerPctObservation,
  recordTokensPerPctObservation,
  quotaSnapshotWindowPctMap,
  foldSlopeObservationFromPctMaps,
  foldSlopeObservationFromSnapshots,
} = await import("../../src/shared/quota/state.ts");

const { windowSlopeKey } = await import("../../src/shared/quota/quotaSource.ts");

// Tests key the slope map the same way production does. Passing a bare label here
// would exercise a key space the scheduler never reads — the branded WindowSlopeKey
// stops that in TypeScript, but these tests are .mjs and are not typechecked, so
// going through the constructor is the discipline that keeps them honest.
const SESSION = windowSlopeKey("account", "session");
const WEEKLY = windowSlopeKey("account", "weekly");

async function withTempStateDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "audit-tools-quota-"));
  setQuotaStateDir(dir);
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const KEY = "provider/model";

test("recordWaveOutcome success clears the 429 streak once the cooldown has run its course", async () => {
  await withTempStateDir(async () => {
    // A 429 sets a LIVE cooldown; a success while it is live must not cancel it
    // (INV-QD-16). Only after it expires does a success reset the pool.
    await recordWaveOutcome(KEY, { outcome: "rate_limited" });
    const after429 = (await readQuotaState()).entries[KEY];
    expect(after429.cooldown_until !== null, "cooldown_until should be set after a rate_limited outcome").toBeTruthy();

    // Rewind the cooldown to the past, then record the success.
    await writeQuotaState({
      version: 2,
      entries: { [KEY]: { ...after429, cooldown_until: new Date(Date.now() - 1_000).toISOString() } },
    });
    await recordWaveOutcome(KEY, { outcome: "success" });

    const entry = (await readQuotaState()).entries[KEY];
    expect(entry.cooldown_until, "an expired cooldown must be cleared by a success").toBe(null);
    expect(entry.consecutive_429_count).toBe(0);
  });

  await withTempStateDir(async () => {
    // No prior 429 — success keeps cooldown_until null (no regression).
    await recordWaveOutcome(KEY, { outcome: "success" });
    const state = await readQuotaState();
    expect(state.entries[KEY].cooldown_until, "cooldown_until should remain null when no prior cooldown existed").toBe(null);
  });
});

test("COR-d528d2cd: an 'error' outcome does NOT set a rate-limit cooldown", async () => {
  await withTempStateDir(async () => {
    // Record an 'error' outcome (non-quota failure).
    await recordWaveOutcome(KEY, { outcome: "error" });

    const state = await readQuotaState();
    const entry = state.entries[KEY];

    // consecutive_429_count must NOT be incremented — errors are not rate limits.
    expect(entry.consecutive_429_count ?? 0, "error outcome must not increment consecutive_429_count").toBe(0);

    // cooldown_until must NOT be set — only rate_limited triggers exponential backoff cooldown.
    expect(entry.cooldown_until, "error outcome must not set cooldown_until (was collapased to timeout — COR-d528d2cd regression)").toBe(null);

    // last_429_at must NOT be stamped — an 'error' is not a rate-limit signal
    // (COR-610ddf2c: the field meant "last 429" but was stamped on every failure).
    expect(entry.last_429_at ?? null, "error outcome must not stamp last_429_at (COR-610ddf2c regression)").toBe(null);
  });
});

test("COR-d528d2cd: a 'timeout' outcome does NOT set a rate-limit cooldown", async () => {
  await withTempStateDir(async () => {
    await recordWaveOutcome(KEY, { outcome: "timeout" });

    const state = await readQuotaState();
    const entry = state.entries[KEY];
    expect(entry.consecutive_429_count ?? 0, "timeout must not increment consecutive_429_count").toBe(0);
    expect(entry.cooldown_until, "timeout must not set cooldown_until").toBe(null);
    // COR-610ddf2c: a timeout is not a 429 — last_429_at must stay null.
    expect(entry.last_429_at ?? null, "timeout outcome must not stamp last_429_at (COR-610ddf2c)").toBe(null);
  });
});

test("COR-610ddf2c: only a 'rate_limited' outcome stamps last_429_at", async () => {
  await withTempStateDir(async () => {
    await recordWaveOutcome(KEY, { outcome: "rate_limited" });
    const entry = (await readQuotaState()).entries[KEY];
    expect(typeof entry.last_429_at === "string" && entry.last_429_at.length > 0, "a rate_limited outcome must stamp last_429_at with an ISO timestamp").toBeTruthy();
  });
});

test("COR-d528d2cd: 'error' and 'timeout' produce identical quota state (both are non-quota failures)", async () => {
  const KEY_ERR = "provider/model-error";
  const KEY_TMO = "provider/model-timeout";

  await withTempStateDir(async () => {
    await recordWaveOutcome(KEY_ERR, { outcome: "error" });
    await recordWaveOutcome(KEY_TMO, { outcome: "timeout" });

    const state = await readQuotaState();
    const errEntry = state.entries[KEY_ERR];
    const tmoEntry = state.entries[KEY_TMO];

    // Both are non-quota failures: no cooldown, no 429 streak.
    expect(errEntry.cooldown_until, "error: no cooldown").toBe(null);
    expect(tmoEntry.cooldown_until, "timeout: no cooldown").toBe(null);
    expect(errEntry.consecutive_429_count ?? 0, "error: no 429 count").toBe(0);
    expect(tmoEntry.consecutive_429_count ?? 0, "timeout: no 429 count").toBe(0);
  });
});

test("COR-d528d2cd: 'rate_limited' outcome correctly increments 429 count and sets cooldown", async () => {
  await withTempStateDir(async () => {
    // Confirm rate_limited is not confused with error/timeout.
    await recordWaveOutcome(KEY, { outcome: "rate_limited" });

    const state = await readQuotaState();
    const entry = state.entries[KEY];
    expect(entry.consecutive_429_count > 0, "rate_limited must increment consecutive_429_count").toBeTruthy();
    expect(entry.cooldown_until !== null, "rate_limited must set cooldown_until").toBeTruthy();
  });
});

test("foldTokensPerPctObservation seeds a new window slope from the first sample", () => {
  // 5000 tokens over a 5-percent drop (0.50 → 0.45) → slope 1000 tokens/percent.
  const updated = foldTokensPerPctObservation(undefined, SESSION, 0.5, 0.45, 5000);
  expect(Math.abs(updated[SESSION] - 1000) < 1, `expected ~1000, got ${updated[SESSION]}`).toBeTruthy();
});

test("foldTokensPerPctObservation blends into the prior EWMA and learns per label", () => {
  const prior = { [SESSION]: 1000, [WEEKLY]: 40 };
  // New session sample: 3000 tokens over 0.10 → 0.05 (5 percent) → 600/pct sample.
  const updated = foldTokensPerPctObservation(prior, SESSION, 0.1, 0.05, 3000);
  // EWMA(alpha 0.3): 1000*0.7 + 600*0.3 = 880. weekly untouched.
  expect(Math.abs(updated[SESSION] - 880) < 1, `expected ~880, got ${updated[SESSION]}`).toBeTruthy();
  expect(updated[WEEKLY]).toBe(40);
});

test("foldTokensPerPctObservation ignores a below-threshold or non-positive delta (degrade-safe)", () => {
  const prior = { [SESSION]: 1000 };
  // Δpercent = 0.3 (< 0.5 floor) → unchanged.
  expect(foldTokensPerPctObservation(prior, SESSION, 0.5, 0.497, 5000)).toEqual(prior);
  // Non-positive tokens → unchanged.
  expect(foldTokensPerPctObservation(prior, SESSION, 0.5, 0.4, 0)).toEqual(prior);
  // Percent went UP (no consumption) → unchanged.
  expect(foldTokensPerPctObservation(prior, SESSION, 0.4, 0.5, 5000)).toEqual(prior);
});

test("recordTokensPerPctObservation persists a per-window slope to quota-state", async () => {
  await withTempStateDir(async () => {
    // Must be written under the SAME key production reads (`windowSlopeKey`), or
    // the slope persists somewhere the scheduler will never look it up.
    const key = windowSlopeKey("account", "weekly");
    await recordTokensPerPctObservation("prov/model", key, 0.2, 0.1, 2000);
    const state = await readQuotaState();
    const entry = state.entries["prov/model"];
    expect(entry, "entry created").toBeTruthy();
    // 2000 tokens / (0.2-0.1)*100 = 10 percent → 200 tokens/pct.
    expect(Math.abs(entry.tokens_per_pct[key] - 200) < 1e-9).toBeTruthy();
    expect(key).toBe("account:weekly");
  });
});

// ── quotaSnapshotWindowPctMap / foldSlopeObservationFromPctMaps ─────────────
// The single-sourced fold CORE behind both slope-learning call sites (the
// in-process rolling dispatcher's observeSlope AND the host-dispatch merge
// path's foldSlopeObservationFromSnapshots) — a fix here applies to both.

test("quotaSnapshotWindowPctMap: single-window snapshot falls back to an account-scoped 'default' window, carrying reset_at", () => {
  const map = quotaSnapshotWindowPctMap({
    remaining_pct: 0.6,
    reset_at: "2026-07-11T10:00:00.000Z",
    requests_remaining: null,
    tokens_remaining: null,
    captured_at: "2026-07-11T09:00:00.000Z",
    source: "test",
  });
  // A source exposing one aggregate number is stating an ACCOUNT-wide allowance.
  expect(map.get("account:default")).toEqual({ remainingPct: 0.6, resetAt: "2026-07-11T10:00:00.000Z" });
});

test("quotaSnapshotWindowPctMap: multi-window snapshot keys by (scope,label), each with its own reset_at", () => {
  const map = quotaSnapshotWindowPctMap({
    remaining_pct: 0.6,
    reset_at: "2026-07-11T10:00:00.000Z",
    requests_remaining: null,
    tokens_remaining: null,
    captured_at: "2026-07-11T09:00:00.000Z",
    source: "test",
    windows: [
      { label: "session", scope: "account", remaining_pct: 0.6, reset_at: "2026-07-11T10:00:00.000Z" },
      { label: "weekly", scope: "account", remaining_pct: 0.9, reset_at: "2026-07-18T00:00:00.000Z" },
    ],
  });
  expect(map.get("account:session")).toEqual({ remainingPct: 0.6, resetAt: "2026-07-11T10:00:00.000Z" });
  expect(map.get("account:weekly")).toEqual({ remainingPct: 0.9, resetAt: "2026-07-18T00:00:00.000Z" });
  expect(map.has("account:default")).toBe(false);
});

test("quotaSnapshotWindowPctMap: a scope-less window is SKIPPED, not keyed as 'undefined:'", () => {
  // Scope entered the slope key, so a window missing it would key under
  // "undefined:session" — a key no production reader ever looks up, i.e. a silently
  // orphaned slope. This is NOT hypothetical: dispatch-quota.json artifacts written
  // before scope existed are read back raw with no schema parse, and real ones on
  // disk carry scope-less windows. Throwing would violate
  // foldSlopeObservationFromSnapshots' documented "never throws" contract and kill
  // slope learning on any run resumed across the upgrade, so the window is dropped
  // and the rest of the fold proceeds.
  const map = quotaSnapshotWindowPctMap({
    remaining_pct: 0.6,
    reset_at: null,
    requests_remaining: null,
    tokens_remaining: null,
    captured_at: "2026-07-11T09:00:00.000Z",
    source: "test",
    windows: [
      { label: "session", remaining_pct: 0.6, reset_at: null },
      { label: "weekly", scope: "account", remaining_pct: 0.9, reset_at: null },
    ],
  });
  expect([...map.keys()]).toEqual(["account:weekly"]);
  expect([...map.keys()].some((k) => k.startsWith("undefined"))).toBe(false);
});

test("foldSlopeObservationFromSnapshots does not throw on a pre-scope persisted snapshot", async () => {
  // The regression guard for the above: this function documents "never throws", and
  // it is fed snapshots read back from dispatch-quota.json.
  await withTempStateDir(async () => {
    const preScope = (pct) => ({
      remaining_pct: pct,
      reset_at: null,
      requests_remaining: null,
      tokens_remaining: null,
      captured_at: "2026-07-11T09:00:00.000Z",
      source: "test",
      windows: [{ label: "session", remaining_pct: pct, reset_at: null }],
    });
    const folded = await foldSlopeObservationFromSnapshots(
      "prov/model",
      preScope(0.5),
      preScope(0.4),
      1500,
    );
    // No scoped window survived, so nothing folds — but it returns, it does not throw.
    expect(folded).toEqual([]);
  });
});

test("quotaSnapshotWindowPctMap: same label at two scopes stays TWO entries (no blended slope)", () => {
  const map = quotaSnapshotWindowPctMap({
    remaining_pct: 0.6,
    reset_at: "2026-07-11T10:00:00.000Z",
    requests_remaining: null,
    tokens_remaining: null,
    captured_at: "2026-07-11T09:00:00.000Z",
    source: "test",
    windows: [
      { label: "session", scope: "account", remaining_pct: 0.6, reset_at: "2026-07-11T10:00:00.000Z" },
      { label: "session", scope: "model", remaining_pct: 0.2, reset_at: "2026-07-11T10:00:00.000Z" },
    ],
  });
  // Keyed by label alone these would collapse onto one entry, blending the shared
  // account allowance's exchange rate with the model-scoped one's.
  expect(map.size).toBe(2);
  expect(map.get("account:session").remainingPct).toBe(0.6);
  expect(map.get("model:session").remainingPct).toBe(0.2);
});

test("foldSlopeObservationFromPctMaps: zero/negative delta is rejected for both an increase and no change", async () => {
  await withTempStateDir(async () => {
    const priorIncrease = new Map([["default", { remainingPct: 0.4, resetAt: null }]]);
    const currentIncrease = new Map([["default", { remainingPct: 0.5, resetAt: null }]]); // went UP
    const foldedIncrease = await foldSlopeObservationFromPctMaps("prov/model", priorIncrease, currentIncrease, 5000);
    expect(foldedIncrease).toEqual([]);

    const priorSame = new Map([["default", { remainingPct: 0.4, resetAt: null }]]);
    const currentSame = new Map([["default", { remainingPct: 0.4, resetAt: null }]]); // unchanged
    const foldedSame = await foldSlopeObservationFromPctMaps("prov/model", priorSame, currentSame, 5000);
    expect(foldedSame).toEqual([]);

    const state = await readQuotaState();
    expect(state.entries["prov/model"]).toBeUndefined();
  });
});

test("foldSlopeObservationFromPctMaps (P1): a label whose reset_at differs between PRE and POST (rollover) is skipped", async () => {
  await withTempStateDir(async () => {
    // PRE: 0.5 remaining in the window resetting at T1. POST: 0.3 remaining but
    // reset_at moved to T2 — the window rolled over, so this is NOT the ~20pt
    // drop it looks like; folding it would learn a fake slope.
    const prior = new Map([["session", { remainingPct: 0.5, resetAt: "2026-07-11T10:00:00.000Z" }]]);
    const current = new Map([["session", { remainingPct: 0.3, resetAt: "2026-07-11T15:00:00.000Z" }]]);
    const folded = await foldSlopeObservationFromPctMaps("prov/model", prior, current, 5000);
    expect(folded).toEqual([]);

    const state = await readQuotaState();
    expect(state.entries["prov/model"]).toBeUndefined();
  });
});

test("foldSlopeObservationFromPctMaps (P1): matching reset_at (or an unknown one on either side) still folds", async () => {
  await withTempStateDir(async () => {
    const prior = new Map([["session", { remainingPct: 0.5, resetAt: "2026-07-11T10:00:00.000Z" }]]);
    const current = new Map([["session", { remainingPct: 0.4, resetAt: "2026-07-11T10:00:00.000Z" }]]);
    const folded = await foldSlopeObservationFromPctMaps("prov/model", prior, current, 5000);
    expect(folded).toEqual(["session"]);

    // An unknown reset_at on one side cannot prove a rollover, so it doesn't block.
    const prior2 = new Map([["weekly", { remainingPct: 0.5, resetAt: null }]]);
    const current2 = new Map([["weekly", { remainingPct: 0.4, resetAt: "2026-07-18T00:00:00.000Z" }]]);
    const folded2 = await foldSlopeObservationFromPctMaps("prov/model2", prior2, current2, 5000);
    expect(folded2).toEqual(["weekly"]);
  });
});

test("foldSlopeObservationFromSnapshots (C1 shared-core wrapper): folds a real PRE/POST snapshot pair end to end", async () => {
  await withTempStateDir(async () => {
    const pre = {
      remaining_pct: 0.5,
      reset_at: null,
      requests_remaining: null,
      tokens_remaining: null,
      captured_at: "2026-07-11T09:00:00.000Z",
      source: "test",
    };
    const post = {
      remaining_pct: 0.4,
      reset_at: null,
      requests_remaining: null,
      tokens_remaining: null,
      captured_at: "2026-07-11T09:05:00.000Z",
      source: "test",
    };
    const folded = await foldSlopeObservationFromSnapshots("prov/model", pre, post, 1500);
    expect(folded).toEqual(["account:default"]);
    const state = await readQuotaState();
    // 1500 tokens / (0.5-0.4)*100 = 10 percent → 150 tokens/pct.
    expect(Math.abs(state.entries["prov/model"].tokens_per_pct["account:default"] - 150) < 1e-6).toBe(true);
  });
});

test("foldSlopeObservationFromPctMaps (C2): a swallowed write failure is never reported as folded", async () => {
  const dir = await mkdtemp(join(tmpdir(), "audit-tools-quota-c2-"));
  try {
    setQuotaStateDir(dir);
    // Force recordTokensPerPctObservation's read-modify-write to throw: point
    // the state PATH at a directory instead of a file (EISDIR on read).
    await mkdir(join(dir, "quota-state.json"));

    const prior = new Map([["default", { remainingPct: 0.5, resetAt: null }]]);
    const current = new Map([["default", { remainingPct: 0.4, resetAt: null }]]);
    const folded = await foldSlopeObservationFromPctMaps("prov/model", prior, current, 1000);

    // BEFORE the C2 fix this would be ["default"] even though nothing was
    // actually written — the caller (rollingDispatch's observeSlope) would
    // wrongly re-baseline as if a fold had occurred.
    expect(folded).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── INV-QD-15: an unusable quota-state file must never masquerade as cold start ──
//
// `refreshQuotaStateIfNeeded` reads quota-state.json WITHOUT the writer's lock.
// The old `writeQuotaState` truncated in place, so a co-located peer could read a
// prefix; `readQuotaState` swallowed the JSON.parse throw and returned an EMPTY
// state — no cooldown_until, no learned limits — i.e. the degrade direction was
// FAIL-OPEN (unbounded dispatch). Two properties close it: writes are atomic
// (rename-over-destination, so no torn read exists), and an unusable file throws
// rather than silently becoming `{}`.

const __testDir = dirname(fileURLToPath(import.meta.url));
const STATE_SRC = resolve(__testDir, "../../src/shared/quota/state.ts");

test("INV-QD-15: writeQuotaState delegates to the shared atomic writer, never a truncating writeFile", async () => {
  const source = await readFile(STATE_SRC, "utf8");
  expect(source).toContain("writeJsonFile");
  // A bare `writeFile(` here reintroduces the in-place truncation the lock-free
  // reader is exposed to. `readFile` is fine — only the write path must be atomic.
  expect(/\bwriteFile\s*\(/.test(source)).toBe(false);
});

test("INV-QD-15: an ABSENT state file is cold start, not an error", async () => {
  await withTempStateDir(async () => {
    expect(await readQuotaState()).toEqual(emptyQuotaState());
  });
});

test("INV-QD-15: a torn/invalid-JSON state file throws instead of degrading to empty", async () => {
  await withTempStateDir(async () => {
    // A truncated prefix — exactly what a torn read of a large state file yields.
    await writeFile(getQuotaStatePath(), '{"version":2,"entries":{"a/b":{"buck', "utf8");
    await expect(readQuotaState()).rejects.toThrow(QuotaStateUnavailableError);
  });
});

test("INV-QD-15: a well-formed-JSON but wrong-shape state file throws", async () => {
  await withTempStateDir(async () => {
    await writeFile(getQuotaStatePath(), '{"version":99,"entries":{}}', "utf8");
    await expect(readQuotaState()).rejects.toThrow(QuotaStateUnavailableError);
  });
});

test("INV-QD-15: readQuotaStateOrDegrade is the ONE opt-in degrade, and it is loud", async () => {
  await withTempStateDir(async () => {
    await writeFile(getQuotaStatePath(), "not json at all", "utf8");
    const written = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk) => {
      written.push(String(chunk));
      return true;
    };
    try {
      expect(await readQuotaStateOrDegrade("unit test")).toEqual(emptyQuotaState());
    } finally {
      process.stderr.write = original;
    }
    expect(written.join("")).toContain("unit test");
  });
});

test("INV-QD-15: a lock-free reader never observes a torn file while writes are in flight", async () => {
  await withTempStateDir(async () => {
    // A payload big enough that a non-atomic write would be observably partial.
    const entries = {};
    for (let i = 0; i < 400; i++) {
      entries[`provider-${i}/model-${i}`] = {
        updated_at: new Date().toISOString(),
        consecutive_429_count: i % 3,
        tokens_per_pct: { session: 1000 + i },
        cooldown_until: null,
        last_429_at: null,
      };
    }
    await writeQuotaState({ version: 2, entries });

    let stop = false;
    const reader = (async () => {
      // Reads take NO lock — atomicity of the write is the only thing protecting them.
      while (!stop) {
        const state = await readQuotaState();
        expect(Object.keys(state.entries).length).toBe(400);
      }
    })();
    for (let round = 0; round < 25; round++) {
      await writeQuotaState({ version: 2, entries });
    }
    stop = true;
    await reader;
  });
});

test("INV-QD-15: a lock-held RMW quarantines a CORRUPT file, preserves the bytes, and heals", async () => {
  await withTempStateDir(async (dir) => {
    const corrupt = '{"version":2,"entries":{"a/b":{"buck';
    await writeFile(getQuotaStatePath(), corrupt, "utf8");

    const stderrSpy = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk) => (stderrSpy.push(String(chunk)), true);
    try {
      // Without a repair path a corrupt file is TERMINAL: cooldown persistence and
      // limit learning stay dead for the life of that file.
      await recordWaveOutcome(KEY, { outcome: "rate_limited" });
    } finally {
      process.stderr.write = original;
    }

    // Healed: the live file is valid again and carries the new outcome.
    const healed = await readQuotaState();
    expect(healed.entries[KEY].consecutive_429_count).toBe(1);
    expect(healed.entries[KEY].cooldown_until).not.toBe(null);

    // Evidence preserved, never deleted.
    const quarantined = (await readdir(dir)).filter((f) => f.includes(".corrupt-"));
    expect(quarantined.length).toBe(1);
    expect(await readFile(join(dir, quarantined[0]), "utf8")).toBe(corrupt);

    // And it said so.
    expect(stderrSpy.join("")).toContain("quarantined");
  });
});

test("INV-QD-15: a transient-UNREADABLE file is never quarantined and never silently emptied", async () => {
  await withTempStateDir(async (dir) => {
    // A directory where the state file should be → EISDIR/EPERM on read, not ENOENT.
    // The bytes of a real state file in this situation may be perfectly good, so the
    // RMW must reject rather than destroy them.
    await mkdir(getQuotaStatePath());

    await expect(
      recordWaveOutcome(KEY, { outcome: "success" }),
    ).rejects.toThrow(QuotaStateUnavailableError);

    // Nothing was quarantined; the path is untouched.
    expect((await readdir(dir)).filter((f) => f.includes(".corrupt-")).length).toBe(0);
    expect((await stat(getQuotaStatePath())).isDirectory()).toBe(true);
  });
});

// ── INV-QD-16: a concurrent success must not cancel a live cooldown ───────────
//
// Packets run concurrently. A success completing at T+2s was almost certainly
// dispatched BEFORE the 429 at T, so it is not evidence the rate limit is over.
// Unconditionally clearing `cooldown_until` on success let the next invocation
// schedule a full-width wave into a still-throttled pool and restart the
// exponential backoff from its base. (Previously masked by the deleted bucket
// learner, whose poisoned buckets pinned maxSafe=1 regardless.)

test("INV-QD-16: a success does NOT clear a LIVE cooldown, nor reset the 429 streak", async () => {
  await withTempStateDir(async () => {
    await recordWaveOutcome(KEY, { outcome: "rate_limited" });
    await recordWaveOutcome(KEY, { outcome: "rate_limited" });
    const throttled = (await readQuotaState()).entries[KEY];
    expect(throttled.consecutive_429_count).toBe(2);
    const liveCooldown = throttled.cooldown_until;
    expect(new Date(liveCooldown).getTime()).toBeGreaterThan(Date.now());

    // An in-flight packet, dispatched before the 429s, now completes fine.
    await recordWaveOutcome(KEY, { outcome: "success" });

    const after = (await readQuotaState()).entries[KEY];
    expect(after.cooldown_until, "a live cooldown must survive a concurrent success").toBe(
      liveCooldown,
    );
    expect(after.consecutive_429_count, "the 429 streak must survive too — the next 429 escalates").toBe(2);
  });
});

test("INV-QD-16: a success DOES clear an already-expired cooldown", async () => {
  await withTempStateDir(async () => {
    await writeQuotaState({
      version: 2,
      entries: {
        [KEY]: {
          updated_at: new Date().toISOString(),
          cooldown_until: new Date(Date.now() - 60_000).toISOString(),
          last_429_at: new Date(Date.now() - 120_000).toISOString(),
          consecutive_429_count: 3,
        },
      },
    });

    await recordWaveOutcome(KEY, { outcome: "success" });

    const after = (await readQuotaState()).entries[KEY];
    expect(after.cooldown_until, "an expired cooldown is cleared").toBe(null);
    expect(after.consecutive_429_count, "and the streak resets").toBe(0);
  });
});

test("INV-QD-16: an unparseable cooldown_until self-heals on the next success", async () => {
  await withTempStateDir(async () => {
    await writeQuotaState({
      version: 2,
      entries: {
        [KEY]: {
          updated_at: new Date().toISOString(),
          cooldown_until: "not-a-timestamp",
          last_429_at: null,
          consecutive_429_count: 1,
        },
      },
    });
    // NaN > Date.now() is false → treated as expired → cleared, never wedged.
    await recordWaveOutcome(KEY, { outcome: "success" });
    expect((await readQuotaState()).entries[KEY].cooldown_until).toBe(null);
  });
});

// ── INV-QD-15 (migration): writing is the migration ───────────────────────────

test("INV-QD-15: a legacy `buckets` blob is dropped on the next v2 write, not carried forever", async () => {
  await withTempStateDir(async () => {
    // A quota-state.json written by a build that still had the bucket learner.
    await writeFile(
      getQuotaStatePath(),
      JSON.stringify({
        version: 1,
        entries: {
          [KEY]: {
            updated_at: new Date().toISOString(),
            buckets: { 1: { success_weight: 3, failure_weight: 0 } },
            cooldown_until: null,
            last_429_at: null,
            tokens_per_pct: { session: 1234 },
          },
        },
      }),
      "utf8",
    );

    // It reads back fine (no migration break) …
    expect((await readQuotaState()).entries[KEY].buckets).toBeDefined();

    // … and the next write projects it onto the v2 field set.
    await recordWaveOutcome(KEY, { outcome: "rate_limited" });

    const persisted = JSON.parse(await readFile(getQuotaStatePath(), "utf8"));
    expect(persisted.version).toBe(2);
    expect("buckets" in persisted.entries[KEY], "v2 means no bucket learner").toBe(false);
    // Fields that still gate dispatch are preserved verbatim.
    expect(persisted.entries[KEY].tokens_per_pct).toEqual({ session: 1234 });
    expect(persisted.entries[KEY].consecutive_429_count).toBe(1);
  });
});
