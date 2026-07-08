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
} = await import("../../src/shared/quota/state.ts");

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
  const updated = foldTokensPerPctObservation(undefined, "session", 0.5, 0.45, 5000);
  expect(Math.abs(updated.session - 1000) < 1, `expected ~1000, got ${updated.session}`).toBeTruthy();
});

test("foldTokensPerPctObservation blends into the prior EWMA and learns per label", () => {
  const prior = { session: 1000, weekly: 40 };
  // New session sample: 3000 tokens over 0.10 → 0.05 (5 percent) → 600/pct sample.
  const updated = foldTokensPerPctObservation(prior, "session", 0.1, 0.05, 3000);
  // EWMA(alpha 0.3): 1000*0.7 + 600*0.3 = 880. weekly untouched.
  expect(Math.abs(updated.session - 880) < 1, `expected ~880, got ${updated.session}`).toBeTruthy();
  expect(updated.weekly).toBe(40);
});

test("foldTokensPerPctObservation ignores a below-threshold or non-positive delta (degrade-safe)", () => {
  const prior = { session: 1000 };
  // Δpercent = 0.3 (< 0.5 floor) → unchanged.
  expect(foldTokensPerPctObservation(prior, "session", 0.5, 0.497, 5000)).toEqual(prior);
  // Non-positive tokens → unchanged.
  expect(foldTokensPerPctObservation(prior, "session", 0.5, 0.4, 0)).toEqual(prior);
  // Percent went UP (no consumption) → unchanged.
  expect(foldTokensPerPctObservation(prior, "session", 0.4, 0.5, 5000)).toEqual(prior);
});

test("recordTokensPerPctObservation persists a per-window slope to quota-state", async () => {
  await withTempStateDir(async () => {
    await recordTokensPerPctObservation("prov/model", "weekly", 0.2, 0.1, 2000);
    const state = await readQuotaState();
    const entry = state.entries["prov/model"];
    expect(entry, "entry created").toBeTruthy();
    // 2000 tokens / (0.2-0.1)*100 = 10 percent → 200 tokens/pct.
    expect(Math.abs(entry.tokens_per_pct.weekly - 200) < 1e-9).toBeTruthy();
  });
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
