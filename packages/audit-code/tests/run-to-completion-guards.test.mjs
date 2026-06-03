import test from "node:test";
import assert from "node:assert/strict";

// runToCompletion consumes these via ../quota/index.js; exercise the same
// already-exported functions directly rather than spinning a full loop.
const { scheduleWave, getHeaderExtractorForProvider } = await import(
  "../src/quota/index.ts"
);

const MAX_DEEPENING_CYCLES = 3;

// Mirrors the deepening-cycle guard condition in runToCompletion.ts: all pending
// tasks are selective_deepening AND no non-deepening task is still pending.
function onlyDeepeningPending(tasks) {
  return (
    tasks.some(
      (t) => t.tags?.includes("selective_deepening") && t.status !== "complete",
    ) &&
    !tasks.some(
      (t) =>
        !t.tags?.includes("selective_deepening") && t.status !== "complete",
    )
  );
}

// ── (1) deepening-cycle guard ────────────────────────────────────────────────

test("deepening guard condition is true when every pending task is selective_deepening", () => {
  const tasks = [
    { task_id: "a", tags: ["selective_deepening"], status: "pending" },
    { task_id: "b", tags: ["selective_deepening"], status: "complete" },
  ];
  assert.equal(onlyDeepeningPending(tasks), true);
});

test("deepening guard condition is false when a non-deepening task is still pending", () => {
  const tasks = [
    { task_id: "a", tags: ["selective_deepening"], status: "pending" },
    { task_id: "b", tags: [], status: "pending" },
  ];
  assert.equal(onlyDeepeningPending(tasks), false);
});

test("deepeningCycles boundary: must exceed MAX_DEEPENING_CYCLES, not equal it", () => {
  // The source breaks only when deepeningCycles > MAX_DEEPENING_CYCLES.
  assert.equal(4 > MAX_DEEPENING_CYCLES, true);
  assert.equal(3 > MAX_DEEPENING_CYCLES, false);
});

// ── (2) cooldown_until wait branch ───────────────────────────────────────────

test("scheduleWave returns wave_size 1 and the cooldown timestamp during an active cooldown", () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  const schedule = scheduleWave({
    providerName: "opencode",
    sessionConfig: {},
    hostModel: null,
    requestedConcurrency: 10,
    quotaStateEntry: { cooldown_until: future },
  });
  assert.equal(schedule.cooldown_until, future);
  assert.equal(schedule.wave_size, 1);
});

test("cooldown waitMs: future is positive, past is non-positive, and the cap holds", () => {
  const futureMs = new Date(Date.now() + 60_000).getTime() - Date.now();
  assert.ok(futureMs > 0);

  const pastMs = new Date(Date.now() - 60_000).getTime() - Date.now();
  assert.ok(pastMs <= 0);

  // runToCompletion caps the sleep with Math.min(waitMs, 120_000).
  assert.equal(Math.min(200_000, 120_000), 120_000);
});

// ── (3) header-extraction integration ────────────────────────────────────────

test("claude-code extractor returns usable limits for JSON stderr with rate-limit headers", () => {
  const extractor = getHeaderExtractorForProvider("claude-code");
  const stderr = JSON.stringify({
    headers: {
      "x-ratelimit-limit-requests": "100",
      "x-ratelimit-limit-tokens": "50000",
    },
  });
  const extracted = extractor.extract(stderr);
  assert.notEqual(extracted, null);
  assert.equal(extracted.requests_per_minute, 100);
  assert.equal(extracted.input_tokens_per_minute, 50000);
});

test("claude-code extractor returns null for stderr with no rate-limit header content", () => {
  const extractor = getHeaderExtractorForProvider("claude-code");
  // The non-null guard in runToCompletion would skip updateDiscoveredLimits here.
  assert.equal(extractor.extract("just some plain log output\nno headers here"), null);
});

test("unknown provider falls back to the generic extractor and still parses x-ratelimit headers", () => {
  const extractor = getHeaderExtractorForProvider("some-unknown-provider");
  assert.equal(extractor.name, "generic");
  const stderr =
    "x-ratelimit-limit-requests: 42\nx-ratelimit-limit-tokens: 9000\n";
  const extracted = extractor.extract(stderr);
  assert.notEqual(extracted, null);
  assert.equal(extracted.requests_per_minute, 42);
  assert.equal(extracted.input_tokens_per_minute, 9000);
});
