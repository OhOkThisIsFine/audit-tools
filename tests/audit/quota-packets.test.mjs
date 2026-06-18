import test from "node:test";
import assert from "node:assert/strict";

const { buildReviewPackets } = await import("../../src/audit/orchestrator/reviewPackets.ts");

// Packet sizing is in estimated content tokens (Phase 2). When no sizeIndex is
// supplied the estimate falls back to lines: ESTIMATED_TOKENS_PER_LINE = 4,
// ESTIMATED_PACKET_PROMPT_TOKENS = 900. targetPacketTokens is capped at
// (maxContextTokens - 900) so a packet's estimated tokens never exceed the budget.

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
  //   targetPacketTokens = min(32000, 5000 - 900) = 4100
  //   the file is ~5000 lines → 20000 content tokens (line fallback) > 4100,
  //   so each single-file task becomes an isolated large-file packet.
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
  // targetPacketTokens = 4100 → 20000 > 4100 → each task isolated → 2 packets
  assert.ok(
    packetsBounded.length > packetsUnbounded.length,
    `bounded (${packetsBounded.length}) should produce more packets than unbounded (${packetsUnbounded.length})`,
  );
});

test("buildReviewPackets with maxContextTokens never exceeds the budget per packet", () => {
  const maxContextTokens = 8_000; // targetPacketTokens = 7100
  const tasks = [
    makeTask("a", 800),
    makeTask("b", 800),
    makeTask("c", 800),
    makeTask("d", 800),
  ];

  const packets = buildReviewPackets(tasks, { maxContextTokens });
  for (const packet of packets) {
    assert.ok(
      packet.estimated_tokens <= maxContextTokens,
      `Packet ${packet.packet_id} estimated tokens (${packet.estimated_tokens}) exceed budget (${maxContextTokens})`,
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
  // maxContextTokens = 2000 → targetPacketTokens = 1100
  // Each task is 300 lines → 1200 content tokens > 1100, so no two can share a packet
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

test("estimated_tokens derives from size_bytes when a sizeIndex is supplied", () => {
  // Tiny line counts but a large byte count: the estimate must follow the bytes.
  const file = "src/big.ts";
  const sizeIndex = { [file]: 40_000 }; // ceil(40000 / 4) = 10000 content tokens
  const tasks = [
    makeTask("big", 5, {
      unit_id: "unit-big",
      file_paths: [file],
      file_line_counts: { [file]: 5 },
    }),
  ];

  const [withBytes] = buildReviewPackets(tasks, { sizeIndex });
  assert.equal(withBytes.estimated_tokens, 900 + 10_000);

  // Without a sizeIndex it falls back to the line-based estimate.
  const [withLines] = buildReviewPackets(tasks);
  assert.equal(withLines.estimated_tokens, 900 + 5 * 4);
});

test("byte-driven packet budget splits graph-linked files to honor maxContextTokens", () => {
  // Five distinct files, each ~4000 bytes (1000 content tokens), chained by
  // high-confidence imports so they merge into one group. A 4000-token context
  // budget (targetPacketTokens = 3100) forces the group to split into packets
  // that each stay within budget.
  const files = Array.from({ length: 5 }, (_, i) => `src/f${i}.ts`);
  const sizeIndex = Object.fromEntries(files.map((f) => [f, 4_000]));
  const tasks = files.map((file, i) =>
    makeTask(`f${i}`, 1, {
      unit_id: `unit-f${i}`,
      file_paths: [file],
      file_line_counts: { [file]: 1 },
    }),
  );
  const graphBundle = {
    graphs: {
      imports: files.slice(0, -1).map((from, i) => ({
        from,
        to: files[i + 1],
        kind: "esm",
        confidence: 0.95,
      })),
    },
  };

  const maxContextTokens = 4_000;
  const packets = buildReviewPackets(tasks, {
    graphBundle,
    sizeIndex,
    maxContextTokens,
  });

  // The five files do not all fit in one budgeted packet.
  assert.ok(packets.length >= 2, `expected a split, got ${packets.length} packet(s)`);
  for (const packet of packets) {
    assert.ok(
      packet.estimated_tokens <= maxContextTokens,
      `Packet ${packet.packet_id} estimated tokens (${packet.estimated_tokens}) exceed budget (${maxContextTokens})`,
    );
  }
  // Every task is still covered exactly once.
  const coveredTaskIds = packets.flatMap((p) => p.task_ids).sort();
  assert.deepEqual(coveredTaskIds, tasks.map((t) => t.task_id).sort());
});
