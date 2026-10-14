import { test, expect } from "vitest";
import type { AuditTask } from "../../src/audit/types.js";

// reviewPacketSizing re-exports ESTIMATED_TOKENS_PER_LINE from audit-tools/shared
// and aliases ESTIMATED_PROMPT_OVERHEAD_TOKENS as ESTIMATED_PACKET_PROMPT_TOKENS.
// Import from TypeScript source (via tsx) so tests are never poisoned by stale dist/.
const {
  ESTIMATED_TOKENS_PER_LINE,
  ESTIMATED_PACKET_PROMPT_TOKENS,
  taskContentTokens,
  fileGroupContentTokens,
  estimateTaskGroupTokens,
} = await import("../../src/audit/orchestrator/reviewPacketSizing.js");

// Shared constants for cross-check — import from source, not compiled dist/
const { ESTIMATED_TOKENS_PER_LINE: sharedETPL } = await import("audit-tools/shared");

test("reviewPacketSizing uses shared ESTIMATED_TOKENS_PER_LINE (no local duplicate)", () => {
  // The value sourced from reviewPacketSizing must equal the shared one.
  expect(ESTIMATED_TOKENS_PER_LINE).toBe(sharedETPL);
  expect(ESTIMATED_TOKENS_PER_LINE).toBe(4);
});

test("ESTIMATED_PACKET_PROMPT_TOKENS aliases the shared ESTIMATED_PROMPT_OVERHEAD_TOKENS (900)", () => {
  expect(ESTIMATED_PACKET_PROMPT_TOKENS).toBe(900);
});

test("taskContentTokens with sizeIndex uses estimateTokensFromBytes (bytes/4 ceiling)", () => {
  // A task with a file of 400 bytes -> ceil(400/4) = 100 tokens
  const sizeIndex: Record<string, number> = { "src/foo.ts": 400 };
  const task: AuditTask = {
    task_id: "t1",
    unit_id: "u1",
    pass_id: "p1",
    lens: "correctness",
    priority: "medium",
    file_paths: ["src/foo.ts"],
    rationale: "test",
    file_line_counts: {},
  };
  expect(taskContentTokens(task, sizeIndex)).toBe(100);
});

test("taskContentTokens without sizeIndex falls back to lines * ESTIMATED_TOKENS_PER_LINE from shared", () => {
  // No sizeIndex, 50 lines -> 50 * 4 = 200 tokens
  const task: AuditTask = {
    task_id: "t2",
    unit_id: "u1",
    pass_id: "p1",
    lens: "correctness",
    priority: "low",
    file_paths: ["src/bar.ts"],
    rationale: "test",
    file_line_counts: { "src/bar.ts": 50 },
  };
  expect(taskContentTokens(task, undefined, undefined)).toBe(50 * ESTIMATED_TOKENS_PER_LINE);
  expect(taskContentTokens(task, undefined, undefined)).toBe(200);
});

function owner(counts: Record<string, number> = {}): AuditTask {
  return { task_id: "owner", unit_id: "unit", pass_id: "pass", lens: "correctness",
    file_paths: ["p"], file_line_counts: counts, rationale: "fixture" };
}

test("fileGroupContentTokens consumes each iterable occurrence without scanning owner memberships", () => {
  const task = owner({ p: 2 });
  Object.defineProperty(task, "file_paths", { get() { throw new Error("membership scan"); } });
  const owners = new Map([["p", task]]);
  expect(fileGroupContentTokens(["p", "p", "unknown"], owners, undefined, { unknown: 3 })).toBe(28);
  function* paths() { yield "p"; yield "p"; yield "unknown"; }
  const once = paths();
  expect(fileGroupContentTokens(once, owners, undefined, { unknown: 3 })).toBe(28);
  expect(fileGroupContentTokens(once, owners)).toBe(0);
  expect(fileGroupContentTokens([], owners)).toBe(0);
});

test("fileGroupContentTokens preserves owner, bytes, and no-owner fallback precedence", () => {
  const owners = new Map([["p", owner({ p: 0 })], ["missing", owner()]]);
  expect(fileGroupContentTokens(["p", "missing", "unknown", "absent"], owners, undefined,
    { p: 99, missing: 2.5, unknown: 3 })).toBe(22);
  for (const bytes of [0, -1, Number.NaN]) {
    expect(fileGroupContentTokens(["missing"], owners, { missing: bytes }, { missing: 2.5 })).toBe(10);
  }
  for (const [bytes, tokens] of [[1, 1], [5, 2], [Number.POSITIVE_INFINITY, 0]]) {
    expect(fileGroupContentTokens(["unknown"], owners, { unknown: bytes! }, { unknown: 99 })).toBe(tokens);
  }
});

test("task-group estimates still charge repeated paths within and across tasks", () => {
  const repeated = { ...owner({ p: 2 }), file_paths: ["p", "p"] };
  expect(taskContentTokens(repeated)).toBe(16);
  expect(estimateTaskGroupTokens([repeated, repeated])).toBe(932);
  expect(estimateTaskGroupTokens([repeated, repeated], { p: 5 })).toBe(908);
});
