import test from "node:test";
import assert from "node:assert/strict";

const { shouldRunInlineExecutor, buildManualReviewBlocker, buildBlockedAuditState } =
  await import("../src/cli/envelope.ts");

// ── shouldRunInlineExecutor ─────────────────────────────────────────────────

test("shouldRunInlineExecutor returns false for null", () => {
  assert.equal(shouldRunInlineExecutor(null), false);
});

test("shouldRunInlineExecutor returns false for 'agent'", () => {
  assert.equal(shouldRunInlineExecutor("agent"), false);
});

test("shouldRunInlineExecutor returns true for non-null non-agent executor", () => {
  assert.equal(shouldRunInlineExecutor("claude-code"), true);
  assert.equal(shouldRunInlineExecutor("local-subprocess"), true);
  assert.equal(shouldRunInlineExecutor("codex"), true);
});

// ── buildManualReviewBlocker ────────────────────────────────────────────────
// local-subprocess = headless/local provider that CANNOT dispatch sub-agents →
// blocked, waiting for manual results. LLM providers (codex, claude-code, etc.)
// CAN dispatch → "Ready for LLM semantic review" fan-out message (COR-dc621e7a).

test("buildManualReviewBlocker returns blocked message for local-subprocess (cannot dispatch)", () => {
  assert.equal(
    buildManualReviewBlocker("local-subprocess"),
    "Audit blocked: waiting for manual audit results or interactive provider configuration.",
  );
});

test("buildManualReviewBlocker returns fan-out instructions for LLM providers", () => {
  for (const provider of ["codex", "claude-code", "opencode"]) {
    const result = buildManualReviewBlocker(provider);
    assert.match(result, /Ready for LLM semantic review/, `${provider}: expected fan-out message`);
    assert.match(result, /fan out packets/, `${provider}: expected fan-out packets mention`);
  }
});

// ── buildBlockedAuditState ──────────────────────────────────────────────────

function makeState(overrides = {}) {
  return {
    status: "active",
    last_executor: "previous-executor",
    last_obligation: "previous-obligation",
    blockers: [],
    obligations: [
      { id: "ob-1", state: "missing" },
      { id: "ob-2", state: "present" },
    ],
    ...overrides,
  };
}

test("buildBlockedAuditState sets status to blocked and updates executor and obligation fields", () => {
  const state = makeState();
  const result = buildBlockedAuditState({
    state,
    obligationId: "ob-1",
    executor: "some-executor",
    blocker: "provider not configured",
  });
  assert.equal(result.status, "blocked");
  assert.equal(result.last_executor, "some-executor");
  assert.equal(result.last_obligation, "ob-1");
});

test("buildBlockedAuditState appends a new blocker to the blockers array", () => {
  const state = makeState({ blockers: ["existing-blocker"] });
  const result = buildBlockedAuditState({
    state,
    obligationId: "ob-1",
    executor: "some-executor",
    blocker: "new-blocker",
  });
  assert.ok(result.blockers.includes("new-blocker"), "new blocker is present");
  assert.ok(result.blockers.includes("existing-blocker"), "pre-existing blocker is preserved");
  assert.equal(result.blockers.length, 2);
});

test("buildBlockedAuditState deduplicates repeated blockers", () => {
  const state = makeState({ blockers: ["duplicate-blocker"] });
  const result = buildBlockedAuditState({
    state,
    obligationId: "ob-1",
    executor: "some-executor",
    blocker: "duplicate-blocker",
  });
  assert.equal(result.blockers.length, 1);
  assert.equal(result.blockers[0], "duplicate-blocker");
});

test("buildBlockedAuditState patches the matching obligation's state and reason", () => {
  const state = makeState();
  const result = buildBlockedAuditState({
    state,
    obligationId: "ob-1",
    executor: "some-executor",
    blocker: "missing provider",
  });
  const matched = result.obligations.find((o) => o.id === "ob-1");
  assert.equal(matched.state, "blocked");
  assert.equal(matched.reason, "missing provider");
});

test("buildBlockedAuditState leaves non-matching obligations unchanged", () => {
  const state = makeState();
  const result = buildBlockedAuditState({
    state,
    obligationId: "ob-1",
    executor: "some-executor",
    blocker: "missing provider",
  });
  const untouched = result.obligations.find((o) => o.id === "ob-2");
  assert.equal(untouched.state, "present");
  assert.equal(untouched.reason, undefined);
});

test("buildBlockedAuditState falls back to state.last_executor when executor param is null", () => {
  const state = makeState({ last_executor: "original-executor" });
  const result = buildBlockedAuditState({
    state,
    obligationId: "ob-1",
    executor: null,
    blocker: "some blocker",
  });
  assert.equal(result.last_executor, "original-executor");
});
