import test from "node:test";
import assert from "node:assert/strict";

// reviewPacketSizing re-exports ESTIMATED_TOKENS_PER_LINE from @audit-tools/shared
// and aliases ESTIMATED_PROMPT_OVERHEAD_TOKENS as ESTIMATED_PACKET_PROMPT_TOKENS.
// Import from TypeScript source (via tsx) so tests are never poisoned by stale dist/.
const {
  ESTIMATED_TOKENS_PER_LINE,
  ESTIMATED_PACKET_PROMPT_TOKENS,
  DEFAULT_TARGET_PACKET_TOKENS,
  taskContentTokens,
  sizeIndexFromManifest,
} = await import("../src/orchestrator/reviewPacketSizing.ts");

// Shared constants for cross-check — import from source, not compiled dist/
const { ESTIMATED_TOKENS_PER_LINE: sharedETPL } = await import("@audit-tools/shared");

test("reviewPacketSizing uses shared ESTIMATED_TOKENS_PER_LINE (no local duplicate)", () => {
  // The value sourced from reviewPacketSizing must equal the shared one.
  assert.equal(ESTIMATED_TOKENS_PER_LINE, sharedETPL);
  assert.equal(ESTIMATED_TOKENS_PER_LINE, 4);
});

test("DEFAULT_TARGET_PACKET_TOKENS equals 8000 * sharedESTIMATED_TOKENS_PER_LINE (32000)", () => {
  assert.equal(DEFAULT_TARGET_PACKET_TOKENS, 8000 * sharedETPL);
  assert.equal(DEFAULT_TARGET_PACKET_TOKENS, 32000);
});

test("ESTIMATED_PACKET_PROMPT_TOKENS aliases the shared ESTIMATED_PROMPT_OVERHEAD_TOKENS (900)", () => {
  assert.equal(ESTIMATED_PACKET_PROMPT_TOKENS, 900);
});

test("taskContentTokens with sizeIndex uses estimateTokensFromBytes (bytes/4 ceiling)", () => {
  // A task with a file of 400 bytes -> ceil(400/4) = 100 tokens
  const sizeIndex = { "src/foo.ts": 400 };
  const task = {
    task_id: "t1",
    unit_id: "u1",
    pass_id: "p1",
    lens: "correctness",
    priority: "medium",
    file_paths: ["src/foo.ts"],
    rationale: "test",
    file_line_counts: {},
  };
  assert.equal(taskContentTokens(task, sizeIndex), 100);
});

test("taskContentTokens without sizeIndex falls back to lines * ESTIMATED_TOKENS_PER_LINE from shared", () => {
  // No sizeIndex, 50 lines -> 50 * 4 = 200 tokens
  const task = {
    task_id: "t2",
    unit_id: "u1",
    pass_id: "p1",
    lens: "correctness",
    priority: "low",
    file_paths: ["src/bar.ts"],
    rationale: "test",
    file_line_counts: { "src/bar.ts": 50 },
  };
  assert.equal(taskContentTokens(task, undefined, undefined), 50 * ESTIMATED_TOKENS_PER_LINE);
  assert.equal(taskContentTokens(task, undefined, undefined), 200);
});
