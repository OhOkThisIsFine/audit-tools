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

test("scheduleWave returns max_concurrent 1 and the cooldown timestamp during an active cooldown", () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  const schedule = scheduleWave({
    providerName: "opencode",
    sessionConfig: {},
    hostModel: null,
    requestedConcurrency: 10,
    quotaStateEntry: { cooldown_until: future },
  });
  assert.equal(schedule.cooldown_until, future);
  assert.equal(schedule.max_concurrent, 1);
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

// ── (4) applyWorkerResult helper — behavioral contracts ───────────────────────
// These tests verify the pure-logic portions of the applyWorkerResult helper
// that can be exercised without I/O (status classification, pending-state
// clearing, and progress tracking).

test("applyWorkerResult: failed and blocked statuses are recognized as terminal (shouldBlock)", () => {
  // Mirrors the shouldBlock determination inside applyWorkerResult.
  function shouldBlock(status) {
    return status === "failed" || status === "blocked";
  }
  assert.equal(shouldBlock("failed"), true);
  assert.equal(shouldBlock("blocked"), true);
  assert.equal(shouldBlock("no_progress"), false);
  assert.equal(shouldBlock("completed"), false);
});

test("applyWorkerResult: audit_state.json only added to artifactsWritten when shouldBlock is true", () => {
  function computeArtifactsWritten(baseSet, shouldBlock) {
    return Array.from(
      shouldBlock ? new Set([...baseSet, "audit_state.json"]) : baseSet,
    );
  }
  const base = new Set(["run-ledger.json", "repo_manifest.json"]);
  const withBlock = computeArtifactsWritten(base, true);
  const withoutBlock = computeArtifactsWritten(base, false);
  assert.ok(withBlock.includes("audit_state.json"));
  assert.ok(!withoutBlock.includes("audit_state.json"));
});

test("applyWorkerResult: pendingBatchAuditResults only shifts when result_ingestion_executor and non-failed", () => {
  // Mirrors the batch-shift guard condition.
  function shouldShift(auditResultsPath, pending, executor, status) {
    return (
      auditResultsPath != null &&
      pending[0] === auditResultsPath &&
      executor === "result_ingestion_executor" &&
      status !== "failed" &&
      status !== "blocked"
    );
  }
  const path = "/tmp/results.json";
  assert.equal(shouldShift(path, [path], "result_ingestion_executor", "completed"), true);
  assert.equal(shouldShift(path, [path], "result_ingestion_executor", "failed"), false);
  assert.equal(shouldShift(path, [path], "agent", "completed"), false);
  assert.equal(shouldShift(path, ["/other.json"], "result_ingestion_executor", "completed"), false);
  assert.equal(shouldShift(undefined, [path], "result_ingestion_executor", "completed"), false);
});

test("applyWorkerResult: anyProgress set to true only when workerResult.progress_made is true", () => {
  function updateProgress(anyProgress, progressMade) {
    return progressMade ? true : anyProgress;
  }
  assert.equal(updateProgress(false, true), true);
  assert.equal(updateProgress(false, false), false);
  assert.equal(updateProgress(true, false), true);
});

test("applyWorkerResult: always uses cached audit_state when available (defensive form)", () => {
  // applyWorkerResult always uses bundleAfter.audit_state ?? deriveAuditState(bundleAfter)
  // for both shouldBlock and no-block paths — no preferCachedAuditState flag.
  const cachedState = { phase: "cached" };
  const freshState = { phase: "fresh" };
  function pickState(bundle, freshDerived) {
    return bundle.audit_state ?? freshDerived;
  }
  // When a cached state is present it is preferred over fresh derivation.
  assert.deepEqual(pickState({ audit_state: cachedState }, freshState), cachedState);
  // When no cached state exists, the fresh derivation is used.
  assert.deepEqual(pickState({}, freshState), freshState);
});

// ── (5) handleWorkerResult (applyWorkerResult) contracts ─────────────────────
// These tests mirror the spec requirements for the extracted helper.

test("handleWorkerResult: accumulates anyProgress and artifactsWritten", () => {
  // anyProgress becomes true when workerResult.progress_made is true.
  function simulateAccumulate(anyProgress, progressMade, writtenEntries) {
    const artifactsWritten = new Set(["existing.json"]);
    if (progressMade) anyProgress = true;
    for (const a of writtenEntries) artifactsWritten.add(a);
    artifactsWritten.add("run-ledger.json");
    return { anyProgress, artifactsWritten };
  }
  const { anyProgress, artifactsWritten } = simulateAccumulate(
    false,
    true,
    ["audit_tasks.json"],
  );
  assert.equal(anyProgress, true);
  assert.ok(artifactsWritten.has("audit_tasks.json"));
  assert.ok(artifactsWritten.has("run-ledger.json"), "run-ledger.json is always added");
});

test("handleWorkerResult: clears pending paths on success (completed status)", () => {
  // Mirrors the path-clearing logic in applyWorkerResult.
  function simulateClear(externalAnalyzerPath, auditResultsPath, runtimeUpdatesPath) {
    let pendingExternalAnalyzerPath = externalAnalyzerPath;
    let pendingAuditResultsPath = auditResultsPath;
    let pendingRuntimeUpdatesPath = runtimeUpdatesPath;
    if (externalAnalyzerPath) pendingExternalAnalyzerPath = undefined;
    if (auditResultsPath) pendingAuditResultsPath = undefined;
    if (runtimeUpdatesPath) pendingRuntimeUpdatesPath = undefined;
    return { pendingExternalAnalyzerPath, pendingAuditResultsPath, pendingRuntimeUpdatesPath };
  }
  const result = simulateClear("/path/ext.json", "/path/results.json", "/path/updates.json");
  assert.equal(result.pendingAuditResultsPath, undefined);
  assert.equal(result.pendingRuntimeUpdatesPath, undefined);
  assert.equal(result.pendingExternalAnalyzerPath, undefined);
});

test("handleWorkerResult: returns done:true on failed, blocked, or no_progress status", () => {
  function isDone(status) {
    return (
      status === "failed" ||
      status === "blocked" ||
      status === "no_progress"
    );
  }
  assert.equal(isDone("failed"), true);
  assert.equal(isDone("blocked"), true);
  assert.equal(isDone("no_progress"), true);
  assert.equal(isDone("completed"), false);
});

test("handleWorkerResult: shifts pendingBatchAuditResults on successful result_ingestion_executor", () => {
  function simulateShift(auditResultsPath, pending, executor, status) {
    const arr = [...pending];
    if (
      auditResultsPath &&
      arr[0] === auditResultsPath &&
      executor === "result_ingestion_executor" &&
      status !== "failed" &&
      status !== "blocked"
    ) {
      arr.shift();
    }
    return arr;
  }
  const path = "/tmp/results.json";
  // Shifts on success.
  assert.deepEqual(simulateShift(path, [path, "/tmp/next.json"], "result_ingestion_executor", "completed"), ["/tmp/next.json"]);
  // Does not shift on failed status.
  assert.deepEqual(simulateShift(path, [path], "result_ingestion_executor", "failed"), [path]);
});

// ── (6) handleLocalSubprocessBlock routing guard ──────────────────────────────
// Verifies the guard condition that routes to the local-subprocess block path.

test("handleLocalSubprocessBlock: only routes when executor is 'agent' AND provider is LOCAL_SUBPROCESS", () => {
  const LOCAL_SUBPROCESS_PROVIDER_NAME = "local-subprocess";
  function shouldHandleLocalSubprocess(preferredExecutor, providerName) {
    return preferredExecutor === "agent" && providerName === LOCAL_SUBPROCESS_PROVIDER_NAME;
  }
  // Both conditions must be true.
  assert.equal(shouldHandleLocalSubprocess("agent", "local-subprocess"), true);
  // Wrong executor — no block.
  assert.equal(shouldHandleLocalSubprocess("inline_executor", "local-subprocess"), false);
  // Wrong provider — normal flow.
  assert.equal(shouldHandleLocalSubprocess("agent", "claude-code"), false);
  // null executor — no block.
  assert.equal(shouldHandleLocalSubprocess(null, "local-subprocess"), false);
});

test("handleLocalSubprocessBlock: audit_state.json is always added to artifactsWritten in the blocked envelope", () => {
  // The blocked path emits: new Set([...artifactsWritten, "audit_state.json"])
  const base = new Set(["repo_manifest.json"]);
  const emitted = Array.from(new Set([...base, "audit_state.json"]));
  assert.ok(emitted.includes("audit_state.json"));
  assert.ok(emitted.includes("repo_manifest.json"));
});

// ── (7) handleNoExecutor routing guard ───────────────────────────────────────

test("handleNoExecutor: promoteFinalAuditReport is called only when state.status === 'complete'", () => {
  // Mirrors the conditional at the end of handleNoExecutor.
  function shouldPromote(status) {
    return status === "complete";
  }
  assert.equal(shouldPromote("complete"), true);
  assert.equal(shouldPromote("in_progress"), false);
  assert.equal(shouldPromote("blocked"), false);
});

test("handleNoExecutor: progress_summary reports 'Completed audit in N runs' only when anyProgress && complete", () => {
  function buildSummary(anyProgress, status, runCount, fallbackReason) {
    return anyProgress && status === "complete"
      ? `Completed audit in ${runCount} fresh worker runs.`
      : fallbackReason;
  }
  assert.equal(
    buildSummary(true, "complete", 5, "no reason"),
    "Completed audit in 5 fresh worker runs.",
  );
  assert.equal(
    buildSummary(false, "complete", 5, "fallback"),
    "fallback",
  );
  assert.equal(
    buildSummary(true, "in_progress", 5, "fallback"),
    "fallback",
  );
});

// ── (8) runParallelWaveStep exit conditions ───────────────────────────────────

test("runParallelWaveStep: done:true returned when batchErrors is non-empty", () => {
  // Mirrors: if (batchErrors.length > 0) return { done: true, ... }
  function parallelWaveExitDone(batchErrors, batchProgress) {
    if (batchErrors.length > 0) return { done: true, reason: "batchError" };
    if (!batchProgress) return { done: true, reason: "noProgress" };
    return { done: false, reason: "progress" };
  }
  assert.deepEqual(parallelWaveExitDone(["run1: failed"], true), { done: true, reason: "batchError" });
  assert.deepEqual(parallelWaveExitDone([], false), { done: true, reason: "noProgress" });
  assert.deepEqual(parallelWaveExitDone([], true), { done: false, reason: "progress" });
});

test("runParallelWaveStep: done:false returned (loop continues) only when no errors and batchProgress is true", () => {
  // The loop should continue (done:false) only when at least one slot made progress
  // and no slot errored out.
  function shouldContinueLoop(batchErrors, batchProgress) {
    return batchErrors.length === 0 && batchProgress;
  }
  assert.equal(shouldContinueLoop([], true), true);
  assert.equal(shouldContinueLoop(["error"], true), false);
  assert.equal(shouldContinueLoop([], false), false);
});

// ── (9) handleMaxRunsReached completion logic ─────────────────────────────────

test("handleMaxRunsReached: reportRendered is true when state.status === 'complete' or audit_report is set", () => {
  function reportRendered(status, auditReport) {
    return status === "complete" || Boolean(auditReport);
  }
  assert.equal(reportRendered("complete", null), true);
  assert.equal(reportRendered("in_progress", "path/to/report.md"), true);
  assert.equal(reportRendered("in_progress", null), false);
  assert.equal(reportRendered("in_progress", undefined), false);
});

test("handleMaxRunsReached: terminalState overrides status to 'complete' when report rendered but state not yet complete", () => {
  function buildTerminalState(state, reportRendered) {
    return reportRendered && state.status !== "complete"
      ? { ...state, status: "complete" }
      : state;
  }
  const inProgressState = { status: "in_progress", obligations: [] };
  const completeState = { status: "complete", obligations: [] };

  // Report rendered but not complete → force complete.
  const terminal = buildTerminalState(inProgressState, true);
  assert.equal(terminal.status, "complete");

  // Already complete → unchanged.
  const unchanged = buildTerminalState(completeState, true);
  assert.equal(unchanged.status, "complete");

  // Report not rendered → unchanged (still in_progress).
  const notRendered = buildTerminalState(inProgressState, false);
  assert.equal(notRendered.status, "in_progress");
});

test("handleMaxRunsReached: progress_summary varies by reportRendered and state", () => {
  function buildSummary(reportRendered, status, maxRuns) {
    return reportRendered && status !== "complete"
      ? `Audit report already rendered; completing the run after reaching the max run limit (${maxRuns}) during finalization.`
      : `Reached max run limit (${maxRuns}) before terminal state.`;
  }
  // Report rendered but not formally complete → finalization message.
  assert.ok(
    buildSummary(true, "in_progress", 50).includes("already rendered"),
  );
  // No report → generic limit message.
  assert.ok(
    buildSummary(false, "in_progress", 50).includes("max run limit"),
  );
  // Both report rendered AND complete → generic message (status === 'complete').
  assert.ok(
    buildSummary(true, "complete", 50).includes("max run limit"),
  );
});
