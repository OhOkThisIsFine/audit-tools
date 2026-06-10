import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Importing the helper module directly must be safe: it is side-effect free,
// unlike scripts/release-and-publish.mjs which executes `await main()` at
// module top level.
import {
  POLL_LOG_EVERY_N_ATTEMPTS,
  shouldLogPollAttempt,
} from "../scripts/poll-log-throttle.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const moduleSourcePath = join(here, "..", "scripts", "poll-log-throttle.mjs");

// Mirror of how the release scripts derive the normalized status key from a
// poll response: only the status/conclusion enum participates — never volatile
// fields like timestamps, elapsed ms, attempt counters, or URLs.
function normalizeStatusKey(response) {
  return `${response.status ?? "unknown"}/${response.conclusion ?? "pending"}`;
}

// Synthetic poll response whose volatile fields differ on every poll.
function makeResponse(status, conclusion, attempt) {
  return {
    status,
    conclusion,
    attempt_counter: attempt,
    elapsed_ms: 1_000 + attempt * 137,
    updated_at: new Date(1_700_000_000_000 + attempt * 5_017).toISOString(),
    html_url: `https://github.com/example/repo/actions/runs/${9_000_000 + attempt}`,
  };
}

// Stateful driver mirroring the release scripts' poll loops: each loop tracks
// its own attempt counter and lastLoggedStatusKey, asks the pure helper for a
// log decision on progress polls, and logs the terminal/outcome poll
// unconditionally (outside the throttle).
function createThrottleDriver() {
  let attempt = 0;
  let lastLoggedStatusKey = null;
  return {
    poll(response, { terminal = false } = {}) {
      attempt += 1;
      if (terminal) {
        return { attempt, logged: true, kind: "outcome" };
      }
      const statusKey = normalizeStatusKey(response);
      const logged = shouldLogPollAttempt(attempt, statusKey, lastLoggedStatusKey);
      if (logged) {
        lastLoggedStatusKey = statusKey;
      }
      return { attempt, logged, kind: "progress", statusKey };
    },
  };
}

test("constant-status churn logs only first attempt, every-Nth heartbeat, and final outcome", () => {
  const totalPolls = 25;
  const driver = createThrottleDriver();
  const loggedAttempts = [];

  for (let attempt = 1; attempt <= totalPolls; attempt += 1) {
    // Every volatile field changes on every poll; the normalized enum does not.
    const response = makeResponse("in_progress", null, attempt);
    const terminal = attempt === totalPolls;
    const result = driver.poll(response, { terminal });
    if (result.logged) {
      loggedAttempts.push(attempt);
    }
  }

  const expected = [1];
  for (let n = POLL_LOG_EVERY_N_ATTEMPTS; n < totalPolls; n += POLL_LOG_EVERY_N_ATTEMPTS) {
    expected.push(n);
  }
  expected.push(totalPolls);

  // Exactly: first attempt, every-Nth heartbeat, final outcome. Everything
  // else in the sequence is suppressed (deepEqual covers both directions).
  assert.deepEqual(loggedAttempts, expected);

  // The heartbeat is driven by the attempt counter, not volatile-field churn:
  // identical decisions for the same attempt/enum, regardless of volatile data.
  for (let attempt = 2; attempt < POLL_LOG_EVERY_N_ATTEMPTS; attempt += 1) {
    const a = normalizeStatusKey(makeResponse("in_progress", null, attempt));
    const b = normalizeStatusKey(makeResponse("in_progress", null, attempt + 1000));
    assert.equal(a, b, "normalized key must ignore volatile fields");
    assert.equal(shouldLogPollAttempt(attempt, a, a), false);
  }
});

test("genuine status transitions log exactly once each, immediately", () => {
  const driver = createThrottleDriver();
  const logged = [];

  const sequence = [];
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    sequence.push(makeResponse("queued", null, attempt));
  }
  for (let attempt = 6; attempt <= 16; attempt += 1) {
    sequence.push(makeResponse("in_progress", null, attempt));
  }
  for (let attempt = 17; attempt <= 25; attempt += 1) {
    sequence.push(makeResponse("completed", "success", attempt));
  }

  sequence.forEach((response, index) => {
    const result = driver.poll(response);
    if (result.logged) {
      logged.push({ attempt: index + 1, statusKey: result.statusKey });
    }
  });

  // Attempt 1 (first), 6 (queued -> in_progress, off-heartbeat), 12
  // (heartbeat), 17 (in_progress -> completed/success, off-heartbeat), 24
  // (heartbeat). Repeated polls of the same enum after each transition are
  // suppressed until the next heartbeat.
  assert.deepEqual(logged, [
    { attempt: 1, statusKey: "queued/pending" },
    { attempt: 6, statusKey: "in_progress/pending" },
    { attempt: 12, statusKey: "in_progress/pending" },
    { attempt: 17, statusKey: "completed/success" },
    { attempt: 24, statusKey: "completed/success" },
  ]);

  // Each genuine transition logged exactly once even though every poll also
  // carried volatile-field churn (one decision per poll, never two).
  const transitionLogs = logged.filter(
    (entry, index) => index > 0 && entry.statusKey !== logged[index - 1].statusKey,
  );
  assert.equal(transitionLogs.length, 2);
});

test("volatile-field churn alone never triggers a log", () => {
  // Same attempt + same normalized enum: the decision cannot observe volatile
  // fields at all (they are not inputs), so churn alone never logs.
  const key = normalizeStatusKey(makeResponse("in_progress", null, 1));
  for (let attempt = 2; attempt <= POLL_LOG_EVERY_N_ATTEMPTS * 2; attempt += 1) {
    if (attempt % POLL_LOG_EVERY_N_ATTEMPTS === 0) continue;
    assert.equal(shouldLogPollAttempt(attempt, key, key), false);
  }
});

test("final outcome always logs, even off-heartbeat with an unchanged enum", () => {
  const totalPolls = POLL_LOG_EVERY_N_ATTEMPTS + 2; // 14 with N = 12: not a heartbeat attempt
  assert.notEqual(totalPolls % POLL_LOG_EVERY_N_ATTEMPTS, 0);

  const driver = createThrottleDriver();
  const loggedAttempts = [];
  for (let attempt = 1; attempt <= totalPolls; attempt += 1) {
    const response = makeResponse("in_progress", null, attempt);
    const result = driver.poll(response, { terminal: attempt === totalPolls });
    if (result.logged) {
      loggedAttempts.push(attempt);
    }
  }

  assert.deepEqual(loggedAttempts, [1, POLL_LOG_EVERY_N_ATTEMPTS, totalPolls]);
});

test("helper module is pure and instances do not share state", async () => {
  // The import at the top of this file completed synchronously with no main()
  // execution; the module surface is exactly the pure helper and its constant.
  assert.equal(typeof shouldLogPollAttempt, "function");
  assert.ok(Number.isInteger(POLL_LOG_EVERY_N_ATTEMPTS));
  assert.ok(POLL_LOG_EVERY_N_ATTEMPTS > 1);

  // Source-level guard: no process spawns, timers, or release-script imports.
  const source = await readFile(moduleSourcePath, "utf8");
  assert.doesNotMatch(source, /child_process|spawnSync|setTimeout|setInterval/);
  assert.doesNotMatch(source, /import .*release-and-publish/);

  // Two independently created throttle loops do not share state: advancing one
  // deep into its sequence does not change a fresh instance's decisions.
  const driverA = createThrottleDriver();
  for (let attempt = 1; attempt <= POLL_LOG_EVERY_N_ATTEMPTS + 1; attempt += 1) {
    driverA.poll(makeResponse("in_progress", null, attempt));
  }

  const driverB = createThrottleDriver();
  const first = driverB.poll(makeResponse("in_progress", null, 1));
  assert.equal(first.logged, true, "fresh instance still logs its first attempt");
  const second = driverB.poll(makeResponse("in_progress", null, 2));
  assert.equal(second.logged, false, "fresh instance suppresses its second attempt");

  // And the pure function itself is deterministic for fixed arguments.
  for (let repeat = 0; repeat < 3; repeat += 1) {
    assert.equal(shouldLogPollAttempt(5, "pending", "pending"), false);
    assert.equal(
      shouldLogPollAttempt(POLL_LOG_EVERY_N_ATTEMPTS, "pending", "pending"),
      true,
    );
  }
});
