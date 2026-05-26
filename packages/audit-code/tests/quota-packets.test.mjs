import test from "node:test";
import assert from "node:assert/strict";

const { buildReviewPackets } = await import("../dist/orchestrator/reviewPackets.js");

// ESTIMATED_TOKENS_PER_LINE = 4, ESTIMATED_PACKET_PROMPT_TOKENS = 900

function makeTask(id, lines, overrides = {}) {
  return {
    task_id: id,
    unit_id: `unit-${id}`,
    pass_id: `pass:${id}`,
    lens: "correctness",
    file_paths: [`src/${id}.ts`],
    file_line_counts: { [`src/${id}.ts`]: lines },
    rationale: `Review ${id}.`,
    priority: "medium",
    ...overrides,
  };
}

test("buildReviewPackets respects maxContextTokens by reducing targetPacketLines", () => {
  // Setup: two tasks share the same single file (5000 lines) and the same unit_id,
  // so they form one group. With the default target (8000 lines) the file is
  // 5000 < 8000 → not isolated → both tasks land in one packet.
  //
  // With maxContextTokens=5000:
  //   effectiveTargetLines = floor((5000 - 900) / 4) = 1025
  //   5000 > 1025 → each single-file task becomes an isolated large-file packet.
  //   Result: 2 packets.

  const sharedFile = "src/large.ts";
  const tasks = [
    {
      task_id: "t-a", unit_id: "unit-large", pass_id: "pass:correctness",
      lens: "correctness", file_paths: [sharedFile],
      file_line_counts: { [sharedFile]: 5_000 }, rationale: "a", priority: "medium",
    },
    {
      task_id: "t-b", unit_id: "unit-large", pass_id: "pass:security",
      lens: "security", file_paths: [sharedFile],
      file_line_counts: { [sharedFile]: 5_000 }, rationale: "b", priority: "medium",
    },
  ];

  const packetsUnbounded = buildReviewPackets(tasks);
  // 5000 lines < 8000 default target → not isolated → both tasks in one packet
  assert.equal(packetsUnbounded.length, 1, "unbounded: both tasks should share one packet");

  const packetsBounded = buildReviewPackets(tasks, { maxContextTokens: 5_000 });
  // effectiveTargetLines = 1025 → 5000 > 1025 → each task isolated → 2 packets
  assert.ok(
    packetsBounded.length > packetsUnbounded.length,
    `bounded (${packetsBounded.length}) should produce more packets than unbounded (${packetsUnbounded.length})`,
  );
});

test("buildReviewPackets with maxContextTokens never exceeds the budget per packet", () => {
  const maxContextTokens = 8_000; // → ~1775 effective lines
  const tasks = [
    makeTask("a", 800),
    makeTask("b", 800),
    makeTask("c", 800),
    makeTask("d", 800),
  ];

  const packets = buildReviewPackets(tasks, { maxContextTokens });
  for (const packet of packets) {
    const estimatedTokens = packet.total_lines * 4 + 900;
    assert.ok(
      estimatedTokens <= maxContextTokens,
      `Packet ${packet.packet_id} estimated tokens (${estimatedTokens}) exceed budget (${maxContextTokens})`,
    );
  }
});

test("buildReviewPackets without maxContextTokens behaves identically to before", () => {
  const tasks = [makeTask("x", 100), makeTask("y", 100)];
  const withoutOpt = buildReviewPackets(tasks);
  const withNull = buildReviewPackets(tasks, { maxContextTokens: undefined });
  assert.equal(withoutOpt.length, withNull.length);
  assert.deepEqual(
    withoutOpt.map((p) => p.packet_id),
    withNull.map((p) => p.packet_id),
  );
});

test("buildReviewPackets with very tight maxContextTokens puts each task in its own packet", () => {
  // maxContextTokens = 2000 → effectiveLines = floor((2000 - 900) / 4) = 275
  // Each task has 300 lines, so a+b can't share a packet
  const tasks = [
    makeTask("p", 300),
    makeTask("q", 300),
    makeTask("r", 300),
  ];
  const packets = buildReviewPackets(tasks, { maxContextTokens: 2_000 });
  assert.equal(packets.length, tasks.length);
});

test("buildReviewPackets with huge maxContextTokens behaves like unbounded", () => {
  const tasks = [makeTask("a", 100), makeTask("b", 100), makeTask("c", 100)];
  const bounded = buildReviewPackets(tasks, { maxContextTokens: 1_000_000 });
  const unbounded = buildReviewPackets(tasks);
  assert.equal(bounded.length, unbounded.length);
});
