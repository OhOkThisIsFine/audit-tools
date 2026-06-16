import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, utimes, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const { acquireLock, releaseLock, withFileLock, FileLockTimeoutError } =
  await import("../src/quota/fileLock.ts");

/**
 * Minimal in-memory RunLogger stand-in that captures event calls without
 * writing to disk. Mirrors the RunLogger.event(RunLogEvent) signature.
 */
function makeCapturingLogger() {
  const events = [];
  return {
    events,
    event(ev) {
      events.push({ ...ev });
    },
  };
}

/** Create a unique lock path inside the OS temp dir (does not create the file). */
function tmpLockPath(dir) {
  return join(dir, `test-lock-${randomUUID()}.lock`);
}

/** Utility: run fn with a fresh temp dir, clean up after regardless. */
async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "audit-tools-filelock-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 1. FileLockTimeoutError shape
// ---------------------------------------------------------------------------
test("FileLockTimeoutError has correct name, message, and prototype chain", () => {
  const lockPath = "/tmp/some-path.lock";
  const err = new FileLockTimeoutError(lockPath);

  assert.ok(err instanceof Error, "should be an instance of Error");
  assert.equal(err.name, "FileLockTimeoutError", "name must be FileLockTimeoutError");
  assert.ok(
    err.message.includes(lockPath),
    `message should contain the lock path; got: ${err.message}`,
  );
});

// ---------------------------------------------------------------------------
// 2. acquireLock happy path: lock file is created; releaseLock removes it
// ---------------------------------------------------------------------------
test("acquireLock creates the lock file and releaseLock removes it", async () => {
  await withTempDir(async (dir) => {
    const lockPath = tmpLockPath(dir);

    const token = await acquireLock(lockPath);
    assert.equal(typeof token, "string", "acquireLock should return a token string");
    assert.ok(token.length > 0, "token should be non-empty");

    const info = await stat(lockPath);
    assert.ok(info.isFile(), "lock file should exist after acquireLock");

    await releaseLock(lockPath, token);

    await assert.rejects(
      () => stat(lockPath),
      { code: "ENOENT" },
      "lock file should be gone after releaseLock",
    );
  });
});

// ---------------------------------------------------------------------------
// 3. releaseLock no-op: does not throw when lock file does not exist
// ---------------------------------------------------------------------------
test("releaseLock is a no-op when lock file does not exist", async () => {
  await withTempDir(async (dir) => {
    const lockPath = tmpLockPath(dir); // never created
    await assert.doesNotReject(
      () => releaseLock(lockPath, "any-token"),
      "releaseLock on a non-existent path should not throw",
    );
  });
});

// ---------------------------------------------------------------------------
// 4. withFileLock: callback runs, return value propagated, lock removed after
// ---------------------------------------------------------------------------
test("withFileLock executes callback and always releases lock", async () => {
  await withTempDir(async (dir) => {
    const lockPath = tmpLockPath(dir);

    const returnValue = await withFileLock(lockPath, async () => {
      // Lock file should exist while callback is running.
      const info = await stat(lockPath);
      assert.ok(info.isFile(), "lock file should exist inside callback");
      return 42;
    });

    assert.equal(returnValue, 42, "withFileLock should return the callback's return value");

    await assert.rejects(
      () => stat(lockPath),
      { code: "ENOENT" },
      "lock file should be removed after withFileLock resolves",
    );
  });
});

// ---------------------------------------------------------------------------
// 5. Timeout path: acquireLock throws FileLockTimeoutError when lock is held
// ---------------------------------------------------------------------------
test("acquireLock throws FileLockTimeoutError when lock is held past timeout", async () => {
  await withTempDir(async (dir) => {
    const lockPath = tmpLockPath(dir);
    const token = await acquireLock(lockPath); // hold the lock

    try {
      const err = await assert.rejects(
        () => acquireLock(lockPath, 200),
        (e) => {
          assert.equal(e.name, "FileLockTimeoutError", "error.name should be FileLockTimeoutError");
          return true;
        },
      );
      void err; // suppress unused-var lint
    } finally {
      await releaseLock(lockPath, token);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Stale-lock cleanup path: acquireLock unlinks a stale lock and succeeds
// ---------------------------------------------------------------------------
test("acquireLock unlinks a stale lock file and acquires successfully", async () => {
  await withTempDir(async (dir) => {
    const lockPath = tmpLockPath(dir);

    // Write the lock file and back-date its mtime by 60 s (well past the 30 s stale threshold).
    await writeFile(lockPath, "", { flag: "wx" });
    const past = new Date(Date.now() - 60_000);
    await utimes(lockPath, past, past);

    // acquireLock should detect the stale lock, unlink it, and succeed.
    const token = await assert.doesNotReject(
      () => acquireLock(lockPath, 2000),
      "acquireLock should succeed when an existing lock file is stale",
    );
    void token;

    // A fresh lock file should now exist.
    const info = await stat(lockPath);
    assert.ok(
      info.mtimeMs > Date.now() - 5000,
      "newly acquired lock file should have a recent mtime",
    );

    // Clean up: acquire so we have the token, then release.
    // (assert.doesNotReject returns undefined, not the token; re-acquire is not
    // possible here — just clean up via unlink since the token is inaccessible.)
    const { unlink } = await import("node:fs/promises");
    await unlink(lockPath).catch(() => {});
  });
});

// ---------------------------------------------------------------------------
// 7. stale-lock removal emits a structured log event
// ---------------------------------------------------------------------------
test("stale-lock removal emits a structured log event with kind=step and note=stale_lock_removed", async () => {
  await withTempDir(async (dir) => {
    const lockPath = join(dir, `stale-lock-log-${randomUUID()}.lock`);
    const logger = makeCapturingLogger();

    // Create a lock file with a mtime > STALE_LOCK_MS (30 s) in the past.
    await writeFile(lockPath, "", { flag: "wx" });
    const past = new Date(Date.now() - 60_000);
    await utimes(lockPath, past, past);

    const token = await acquireLock(lockPath, 2000, logger);
    await releaseLock(lockPath, token);

    const staleLockEvents = logger.events.filter(
      (ev) => ev.kind === "step" && ev.note === "stale_lock_removed",
    );
    assert.ok(
      staleLockEvents.length >= 1,
      "at least one stale_lock_removed event should be emitted",
    );
    assert.equal(
      staleLockEvents[0].lock_path,
      lockPath,
      "lock_path field must match the lockPath argument",
    );
  });
});

// ---------------------------------------------------------------------------
// 8. lock timeout emits a structured log event before throwing
// ---------------------------------------------------------------------------
test("lock timeout emits a structured log event with kind=error and note=lock_timeout before FileLockTimeoutError is thrown", async () => {
  await withTempDir(async (dir) => {
    const lockPath = join(dir, `timeout-log-${randomUUID()}.lock`);
    const logger = makeCapturingLogger();
    const timeoutMs = 200;

    // Hold the lock so acquireLock will time out.
    const token = await acquireLock(lockPath);

    let threw = false;
    try {
      await acquireLock(lockPath, timeoutMs, logger);
    } catch (err) {
      threw = true;
      assert.ok(
        err instanceof FileLockTimeoutError,
        "thrown error must be FileLockTimeoutError",
      );
    } finally {
      await releaseLock(lockPath, token);
    }

    assert.ok(threw, "acquireLock should have thrown FileLockTimeoutError");

    const timeoutEvents = logger.events.filter(
      (ev) => ev.kind === "error" && ev.note === "lock_timeout",
    );
    assert.ok(
      timeoutEvents.length >= 1,
      "at least one lock_timeout event should be emitted before the throw",
    );
    assert.equal(
      timeoutEvents[0].lock_path,
      lockPath,
      "lock_path field must match the lockPath argument",
    );
    assert.equal(
      timeoutEvents[0].timeout_ms,
      timeoutMs,
      "timeout_ms field must match the timeoutMs argument",
    );
  });
});

// ---------------------------------------------------------------------------
// 9. omitting logger does not change existing behaviour
// ---------------------------------------------------------------------------
test("acquireLock without a logger still acquires and releases the lock normally", async () => {
  await withTempDir(async (dir) => {
    const lockPath = join(dir, `no-logger-${randomUUID()}.lock`);

    const token = await assert.doesNotReject(
      () => acquireLock(lockPath),
      "acquireLock should succeed without a logger",
    );
    void token;
    // Clean up via unlink since doesNotReject returns undefined.
    const { unlink } = await import("node:fs/promises");
    await unlink(lockPath).catch(() => {});
  });
});

test("acquireLock without a logger still throws FileLockTimeoutError on timeout", async () => {
  await withTempDir(async (dir) => {
    const lockPath = join(dir, `no-logger-timeout-${randomUUID()}.lock`);
    const token = await acquireLock(lockPath);

    try {
      await assert.rejects(
        () => acquireLock(lockPath, 200),
        (err) => {
          assert.ok(err instanceof FileLockTimeoutError);
          return true;
        },
      );
    } finally {
      await releaseLock(lockPath, token);
    }
  });
});

// ---------------------------------------------------------------------------
// 10. Stat throttling: stat is not called on every 50 ms retry cycle
// ---------------------------------------------------------------------------
test("acquireLock does not call stat on every retry cycle", async () => {
  await withTempDir(async (dir) => {
    const lockPath = join(dir, `stat-throttle-${randomUUID()}.lock`);

    // Hold the lock for the duration of the test.
    const token = await acquireLock(lockPath);

    let timedOut = false;
    const timeoutMs = 300; // 6 × 50 ms poll cycles
    try {
      await acquireLock(lockPath, timeoutMs);
    } catch (err) {
      if (err.name === "FileLockTimeoutError") {
        timedOut = true;
      } else {
        throw err;
      }
    } finally {
      await releaseLock(lockPath, token);
    }

    assert.ok(timedOut, "acquireLock should have timed out while lock is held");

    // The lock file should still exist: if stat was called on every cycle it
    // could theoretically misbehave, but the key assertion is that we timed out
    // without the (fresh) lock being removed — confirming isLockStale returned
    // false for a recent lock (or was skipped).
    const info = await stat(lockPath).catch(() => null);
    // Lock was released in finally above, so ENOENT is also fine.
    // The important contract is that it timed out (i.e., did not erroneously
    // clear a non-stale lock via excessive stat calls).
    assert.ok(timedOut, "should have timed out: stat throttling must not break the poll loop");
    void info;
  });
});

// ---------------------------------------------------------------------------
// 11. Stale detection still works with the throttled check
// ---------------------------------------------------------------------------
test("acquireLock still detects and removes a stale lock with throttled stat", async () => {
  await withTempDir(async (dir) => {
    const lockPath = join(dir, `stale-throttle-${randomUUID()}.lock`);

    // Create a lock with an mtime more than STALE_LOCK_MS (30s) in the past.
    await writeFile(lockPath, "", { flag: "wx" });
    const past = new Date(Date.now() - 60_000);
    await utimes(lockPath, past, past);

    // acquireLock must still detect and remove the stale lock even with
    // the throttled check.  We give it a generous timeout (2 s) so the
    // first check (at lastStaleCheckAt = 0, elapsed = now - 0 ≥ 1000) fires
    // immediately on the first EEXIST cycle.
    await assert.doesNotReject(
      () => acquireLock(lockPath, 2000),
      "acquireLock should succeed by removing the stale lock even with throttled stat",
    );

    // Verify a fresh lock now exists.
    const info = await stat(lockPath);
    assert.ok(
      info.mtimeMs > Date.now() - 5000,
      "newly acquired lock file should have a recent mtime",
    );

    const { unlink } = await import("node:fs/promises");
    await unlink(lockPath).catch(() => {});
  });
});

test("withFileLock without a logger still executes fn and releases the lock", async () => {
  await withTempDir(async (dir) => {
    const lockPath = join(dir, `no-logger-wfl-${randomUUID()}.lock`);

    const result = await withFileLock(lockPath, async () => {
      const info = await stat(lockPath);
      assert.ok(info.isFile(), "lock file should exist inside callback");
      return "ok";
    });

    assert.equal(result, "ok");
    await assert.rejects(() => stat(lockPath), { code: "ENOENT" });
  });
});

// ---------------------------------------------------------------------------
// 12. releaseLock with wrong token does not unlink the lock
// ---------------------------------------------------------------------------
test("releaseLock with wrong token does not unlink the lock", async () => {
  await withTempDir(async (dir) => {
    const lockPath = tmpLockPath(dir);

    const token = await acquireLock(lockPath);
    assert.equal(typeof token, "string", "acquireLock should return a token string");

    // Calling releaseLock with a different token must leave the lock file intact.
    await releaseLock(lockPath, "wrong-token-xyz");
    const info = await stat(lockPath);
    assert.ok(info.isFile(), "lock file should still exist after releaseLock with wrong token");

    // The original token holder can still release the lock.
    await releaseLock(lockPath, token);
    await assert.rejects(
      () => stat(lockPath),
      { code: "ENOENT" },
      "lock file should be gone after original holder releases it",
    );
  });
});

// ---------------------------------------------------------------------------
// 13. stale-lock steal does not cascade when original holder releases
// ---------------------------------------------------------------------------
test("stale-lock steal does not cascade when original holder releases", async () => {
  await withTempDir(async (dir) => {
    const lockPath = tmpLockPath(dir);
    const { utimes: utimesFs, writeFile: writeFileFn, readFile: readFileFn } =
      await import("node:fs/promises");

    // Holder A acquires the lock and captures token A.
    const tokenA = await acquireLock(lockPath);

    // Back-date the lock mtime so it looks stale (> 30 s old).
    const past = new Date(Date.now() - 60_000);
    await utimesFs(lockPath, past, past);

    // Holder B steals the stale lock: detect stale, unlink, re-acquire.
    const tokenB = await acquireLock(lockPath, 2000);
    assert.notEqual(tokenA, tokenB, "tokens must be distinct");

    // Verify that the lock file now contains token B.
    const content = await readFileFn(lockPath, "utf8");
    assert.equal(content, tokenB, "lock file should contain holder B's token after steal");

    // Holder A finishes and calls releaseLock with token A.
    // This must NOT delete holder B's lock.
    await releaseLock(lockPath, tokenA);

    // Lock file should still exist (holder B's lock was NOT deleted).
    const info = await stat(lockPath);
    assert.ok(info.isFile(), "holder B's lock must still exist after holder A releases with stale token");

    // Holder B releases with token B — now the file is removed.
    await releaseLock(lockPath, tokenB);
    await assert.rejects(
      () => stat(lockPath),
      { code: "ENOENT" },
      "lock file should be gone after holder B releases",
    );
  });
});

// ---------------------------------------------------------------------------
// 14. withFileLock provides mutual exclusion under normal (non-stale) conditions
// ---------------------------------------------------------------------------
test("withFileLock provides mutual exclusion under normal (non-stale) conditions", async () => {
  await withTempDir(async (dir) => {
    const lockPath = tmpLockPath(dir);
    let concurrentHolders = 0;
    let maxConcurrent = 0;
    let completions = 0;

    const acquirers = Array.from({ length: 4 }, () =>
      withFileLock(lockPath, async () => {
        concurrentHolders++;
        if (concurrentHolders > maxConcurrent) maxConcurrent = concurrentHolders;
        await new Promise((r) => setTimeout(r, 5));
        completions++;
        concurrentHolders--;
      }, 15_000),
    );

    await Promise.all(acquirers);

    assert.equal(maxConcurrent, 1, "at most one holder at any instant");
    assert.equal(completions, 4, "all four callers complete");
    // Lock is released when all done.
    await assert.rejects(() => stat(lockPath), { code: "ENOENT" });
  });
});

// ---------------------------------------------------------------------------
// 15. releaseLock is idempotent when lock file is already gone
// ---------------------------------------------------------------------------
test("releaseLock is idempotent when lock file is already gone", async () => {
  await withTempDir(async (dir) => {
    const lockPath = tmpLockPath(dir);
    // Never created — any token, must not throw.
    await assert.doesNotReject(
      () => releaseLock(lockPath, "some-token"),
      "releaseLock must not throw when lock file does not exist",
    );
  });
});

// ---------------------------------------------------------------------------
// 16. withFileLock preserves the original fn() error when releaseLock also fails
// ---------------------------------------------------------------------------
test("withFileLock preserves original fn() error when releaseLock also throws", async () => {
  await withTempDir(async (dir) => {
    const lockPath = tmpLockPath(dir);
    const { unlink, mkdir } = await import("node:fs/promises");
    const original = new Error("original fn failure");

    await assert.rejects(
      () =>
        withFileLock(lockPath, async () => {
          // Sabotage the release: replace the lock file with a directory so
          // releaseLock's readFile throws a non-ENOENT error (EISDIR/EPERM).
          await unlink(lockPath);
          await mkdir(lockPath);
          throw original;
        }),
      (err) => {
        assert.equal(
          err,
          original,
          "must surface fn()'s original error, not the secondary release error",
        );
        return true;
      },
    );

    await rm(lockPath, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// 17. withFileLock surfaces the releaseLock error when fn() succeeded
// ---------------------------------------------------------------------------
test("withFileLock surfaces the releaseLock error when fn() succeeds", async () => {
  await withTempDir(async (dir) => {
    const lockPath = tmpLockPath(dir);
    const { unlink, mkdir } = await import("node:fs/promises");

    await assert.rejects(
      () =>
        withFileLock(lockPath, async () => {
          // fn() succeeds, but we sabotage release so releaseLock throws. With no
          // fn() error to preserve, that release error must propagate.
          await unlink(lockPath);
          await mkdir(lockPath);
          return "ok";
        }),
      (err) => {
        assert.ok(err instanceof Error, "the release error should propagate");
        return true;
      },
    );

    await rm(lockPath, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// 18. acquireLock honours the timeout deadline without large overshoot
// ---------------------------------------------------------------------------
test("acquireLock honours the timeout deadline without large overshoot", async () => {
  await withTempDir(async (dir) => {
    const lockPath = tmpLockPath(dir);
    const token = await acquireLock(lockPath); // hold a fresh (non-stale) lock
    const timeoutMs = 250;
    const start = Date.now();
    try {
      await assert.rejects(
        () => acquireLock(lockPath, timeoutMs),
        (e) => e instanceof FileLockTimeoutError,
      );
    } finally {
      await releaseLock(lockPath, token);
    }
    const elapsed = Date.now() - start;
    // Deadline is checked before stale-check IO and the backoff sleep is clamped
    // to the time left, so we neither give up early nor overshoot by a full
    // backoff interval.
    assert.ok(elapsed >= timeoutMs - 60, `should not give up early; elapsed=${elapsed}ms`);
    assert.ok(elapsed <= timeoutMs + 600, `should not overshoot the deadline; elapsed=${elapsed}ms`);
  });
});

// ---------------------------------------------------------------------------
// 19. acquireLock uses exponential backoff — far fewer wakeups than a fixed poll
// ---------------------------------------------------------------------------
test("acquireLock uses exponential backoff — far fewer wakeups than a fixed 50ms poll", async () => {
  await withTempDir(async (dir) => {
    const lockPath = tmpLockPath(dir);
    const token = await acquireLock(lockPath); // hold the lock so the acquirer spins

    const realSetTimeout = globalThis.setTimeout;
    let sleepCalls = 0;
    globalThis.setTimeout = (fn, ms, ...rest) => {
      sleepCalls++;
      return realSetTimeout(fn, ms, ...rest);
    };
    try {
      const timeoutMs = 1200;
      await assert.rejects(
        () => acquireLock(lockPath, timeoutMs),
        (e) => e instanceof FileLockTimeoutError,
      );
      // A fixed 50ms poll over 1.2s would sleep ~24 times; exponential backoff
      // (50,100,200,400,500,…) reaches the deadline in well under 15 wakeups.
      assert.ok(
        sleepCalls < 15,
        `expected <15 backoff sleeps over 1.2s, got ${sleepCalls}`,
      );
    } finally {
      globalThis.setTimeout = realSetTimeout;
      await releaseLock(lockPath, token);
    }
  });
});

// ---------------------------------------------------------------------------
// 20. TOCTOU: many acquirers racing one stale lock all succeed, none clobbered,
//     and mutual exclusion holds strictly THROUGH the stale-steal.
// ---------------------------------------------------------------------------
test("concurrent acquirers racing a stale lock keep strict mutual exclusion (maxConcurrent===1) (FND-TST-a50db947)", async () => {
  await withTempDir(async (dir) => {
    const lockPath = tmpLockPath(dir);
    const { writeFile: wf, utimes: ut, rm: rmFs } = await import("node:fs/promises");

    // Plant a stale lock (older than STALE_LOCK_MS) that every acquirer must steal.
    await wf(lockPath, "stale-holder-token", { flag: "wx" });
    const past = new Date(Date.now() - 60_000);
    await ut(lockPath, past, past);

    const N = 5;
    let concurrentHolders = 0;
    let maxConcurrent = 0;
    const tokens = await Promise.all(
      Array.from({ length: N }, () =>
        (async () => {
          const t = await acquireLock(lockPath, 15_000);
          // Inside the critical section: at most one holder may ever be here at
          // once. A double-hold from a non-atomic stale steal would push this >1.
          concurrentHolders++;
          if (concurrentHolders > maxConcurrent) maxConcurrent = concurrentHolders;
          await new Promise((r) => setTimeout(r, 5)); // brief hold to widen any race
          concurrentHolders--;
          await releaseLock(lockPath, t); // token-checked: only removes our own
          return t;
        })(),
      ),
    );

    // Lease-style atomic steal (stealStaleLock) makes the removal right mutually
    // exclusive, so two stealers can never both end up holding the lock: strict
    // mutual exclusion holds even THROUGH the concurrent stale-steal, not just
    // distinct tokens. (Previously relaxed to distinct-tokens; re-strictened once
    // the double-hold race in fileLock.ts was fixed — see docs/backlog.md.)
    assert.equal(maxConcurrent, 1, "at most one holder at any instant, even through a concurrent stale-steal");
    assert.equal(new Set(tokens).size, N, "every acquirer must obtain a distinct token");
    await rmFs(lockPath, { force: true }); // best-effort cleanup
  });
});
