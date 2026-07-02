import { test, expect } from "vitest";

const { claimFlowReviewBlocks } = await import("../../src/audit/orchestrator/flowPlanning.ts");

// The full set of lenses that lensSetForFlow allows.
const LENS_SET_FOR_FLOW = [
  "security",
  "reliability",
  "correctness",
  "data_integrity",
  "operability",
  "performance",
  "observability",
];

test("DEFAULT_FLOW_LENS_PRIORITY matches the lensSetForFlow allowed set", async () => {
  // Verify by exercising claimFlowReviewBlocks with all 7 lenses as concerns:
  // if any lens were absent from DEFAULT_FLOW_LENS_PRIORITY, it would be
  // silently filtered out and no block would be returned for it.
  const pendingByLens = new Map(
    LENS_SET_FOR_FLOW.map((lens) => [lens, new Set(["src/a.ts"])]),
  );
  const criticalFlows = {
    flows: [
      {
        id: "flow-all",
        name: "All Lenses Flow",
        paths: ["src/a.ts"],
        entrypoints: ["src/a.ts"],
        concerns: LENS_SET_FOR_FLOW,
        confidence: "high",
      },
    ],
    fallback_required: false,
  };

  const blocks = claimFlowReviewBlocks(criticalFlows, pendingByLens, new Set());
  const scheduledLenses = new Set(blocks.map((b) => b.lens));

  for (const lens of LENS_SET_FOR_FLOW) {
    expect(scheduledLenses.has(lens), `lens '${lens}' should be scheduled by claimFlowReviewBlocks but was absent`).toBeTruthy();
  }
  // No extra phantom lenses were scheduled.
  for (const lens of scheduledLenses) {
    expect(LENS_SET_FOR_FLOW.includes(lens), `scheduled lens '${lens}' is not in the lensSetForFlow allowed set`).toBeTruthy();
  }
});

test("claimFlowReviewBlocks schedules blocks for all 7 flow lenses on initial call", () => {
  // Flow has 5 concerns including the 4 new ones; each has a pending path.
  const concerns = [
    "security",
    "data_integrity",
    "operability",
    "performance",
    "observability",
  ];
  const pendingByLens = new Map(
    concerns.map((lens) => [lens, new Set(["src/b.ts"])]),
  );
  const criticalFlows = {
    flows: [
      {
        id: "flow-new",
        name: "New Lenses Flow",
        paths: ["src/b.ts"],
        entrypoints: ["src/b.ts"],
        concerns,
        confidence: "high",
      },
    ],
    fallback_required: false,
  };

  const blocks = claimFlowReviewBlocks(criticalFlows, pendingByLens, new Set());
  const scheduledLenses = new Set(blocks.map((b) => b.lens));

  for (const lens of concerns) {
    expect(scheduledLenses.has(lens), `lens '${lens}' should be scheduled without a requeue step`).toBeTruthy();
  }
  // Verify priority ordering: security < data_integrity < observability by index.
  const lensOrder = blocks.map((b) => b.lens);
  const secIdx = lensOrder.indexOf("security");
  const diIdx = lensOrder.indexOf("data_integrity");
  const obsIdx = lensOrder.indexOf("observability");
  expect(secIdx < diIdx, `security (${secIdx}) should rank before data_integrity (${diIdx})`).toBeTruthy();
  expect(diIdx < obsIdx, `data_integrity (${diIdx}) should rank before observability (${obsIdx})`).toBeTruthy();
});

test("returns empty array when criticalFlows has no flows", () => {
  const blocks = claimFlowReviewBlocks(
    { flows: [], fallback_required: false },
    new Map(),
    new Set(),
  );
  expect(blocks).toEqual([]);
});

test("returns a block with matching file_paths, flow_id, and lens", () => {
  const criticalFlows = {
    flows: [
      {
        id: "flow-1",
        name: "Flow 1",
        paths: ["src/a.ts"],
        entrypoints: ["src/a.ts"],
        concerns: ["security"],
        confidence: "high",
      },
    ],
    fallback_required: false,
  };
  const pendingByLens = new Map([["security", new Set(["src/a.ts"])]]);
  const assigned = new Set();

  const blocks = claimFlowReviewBlocks(criticalFlows, pendingByLens, assigned);

  expect(blocks.length).toBe(1);
  expect(blocks[0].flow_id).toBe("flow-1");
  expect(blocks[0].lens).toBe("security");
  expect(blocks[0].file_paths).toEqual(["src/a.ts"]);
  expect(assigned.has("security:src/a.ts"), "assigned set should contain security:src/a.ts").toBeTruthy();
});

test("filters out paths not present in pendingByLens for the lens", () => {
  const criticalFlows = {
    flows: [
      {
        id: "flow-1",
        name: "Flow 1",
        paths: ["src/a.ts", "src/b.ts"],
        entrypoints: ["src/a.ts"],
        concerns: ["security"],
        confidence: "high",
      },
    ],
    fallback_required: false,
  };
  // Only src/a.ts is pending for security
  const pendingByLens = new Map([["security", new Set(["src/a.ts"])]]);

  const blocks = claimFlowReviewBlocks(criticalFlows, pendingByLens, new Set());

  expect(blocks.length).toBe(1);
  expect(blocks[0].file_paths).toEqual(["src/a.ts"]);
});

test("skips flows whose lens has no pending paths", () => {
  const criticalFlows = {
    flows: [
      {
        id: "flow-1",
        name: "Flow 1",
        paths: ["src/a.ts"],
        entrypoints: ["src/a.ts"],
        concerns: ["security"],
        confidence: "high",
      },
    ],
    fallback_required: false,
  };
  // No entry for security in pendingByLens
  const pendingByLens = new Map();

  const blocks = claimFlowReviewBlocks(criticalFlows, pendingByLens, new Set());

  expect(blocks).toEqual([]);
});

// TST-a8ea07db: pendingByLens HAS an entry for the lens but the intersection
// with the flow's paths is empty — the flow must be skipped, not emitted empty.
test("skips flow when pendingByLens entry exists but no flow path is pending", () => {
  const criticalFlows = {
    flows: [
      {
        id: "flow-disjoint",
        name: "Disjoint Flow",
        paths: ["src/x.ts", "src/y.ts"],
        entrypoints: ["src/x.ts"],
        concerns: ["security"],
        confidence: "high",
      },
    ],
    fallback_required: false,
  };
  // pendingByLens has a security entry, but it contains completely different paths.
  const pendingByLens = new Map([["security", new Set(["src/a.ts", "src/b.ts"])]]);

  const blocks = claimFlowReviewBlocks(criticalFlows, pendingByLens, new Set());

  expect(blocks, "flow with zero matching paths after filtering must be skipped").toEqual([]);
});

test("ignores concerns that are not in the DEFAULT_FLOW_LENS_PRIORITY list", () => {
  const criticalFlows = {
    flows: [
      {
        id: "flow-1",
        name: "Flow 1",
        paths: ["src/a.ts"],
        entrypoints: ["src/a.ts"],
        concerns: ["performance", "security"],
        confidence: "high",
      },
    ],
    fallback_required: false,
  };
  // Both performance and security have pending paths; but performance IS in
  // DEFAULT_FLOW_LENS_PRIORITY so the real test here is that an unknown concern
  // (not in the list) is filtered and only valid ones produce blocks.
  // Use a made-up concern that is definitely not in the list:
  criticalFlows.flows[0].concerns = ["unknown_concern", "security"];
  const pendingByLens = new Map([
    ["unknown_concern", new Set(["src/a.ts"])],
    ["security", new Set(["src/a.ts"])],
  ]);

  const blocks = claimFlowReviewBlocks(criticalFlows, pendingByLens, new Set());

  // Only security block should be returned; unknown_concern is filtered
  expect(blocks.length).toBe(1);
  expect(blocks[0].lens).toBe("security");
});

test("sorts candidates by file_paths count descending before deduplication", () => {
  const criticalFlows = {
    flows: [
      {
        id: "flow-A",
        name: "Flow A",
        paths: ["src/a.ts", "src/b.ts"],
        entrypoints: ["src/a.ts"],
        concerns: ["security"],
        confidence: "high",
      },
      {
        id: "flow-B",
        name: "Flow B",
        paths: ["src/c.ts"],
        entrypoints: ["src/c.ts"],
        concerns: ["security"],
        confidence: "high",
      },
    ],
    fallback_required: false,
  };
  const pendingByLens = new Map([
    ["security", new Set(["src/a.ts", "src/b.ts", "src/c.ts"])],
  ]);

  const blocks = claimFlowReviewBlocks(criticalFlows, pendingByLens, new Set());

  // flow-A has 2 paths; flow-B has 1; flow-A should come first
  expect(blocks[0].flow_id).toBe("flow-A");
});

test("breaks file_paths count ties by lens priority (security beats reliability)", () => {
  const criticalFlows = {
    flows: [
      {
        id: "flow-A",
        name: "Flow A",
        paths: ["src/a.ts", "src/b.ts"],
        entrypoints: ["src/a.ts"],
        concerns: ["reliability"],
        confidence: "high",
      },
      {
        id: "flow-B",
        name: "Flow B",
        paths: ["src/a.ts", "src/b.ts"],
        entrypoints: ["src/a.ts"],
        concerns: ["security"],
        confidence: "high",
      },
    ],
    fallback_required: false,
  };
  const pendingByLens = new Map([
    ["security", new Set(["src/a.ts", "src/b.ts"])],
    ["reliability", new Set(["src/a.ts", "src/b.ts"])],
  ]);

  const blocks = claimFlowReviewBlocks(criticalFlows, pendingByLens, new Set());

  // Both have 2 file_paths; security has higher priority than reliability
  expect(blocks[0].lens).toBe("security");
});

test("breaks lens+size ties by flow_id alphabetical order", () => {
  const criticalFlows = {
    flows: [
      {
        id: "flow-beta",
        name: "Flow Beta",
        paths: ["src/a.ts"],
        entrypoints: ["src/a.ts"],
        concerns: ["security"],
        confidence: "high",
      },
      {
        id: "flow-alpha",
        name: "Flow Alpha",
        paths: ["src/b.ts"],
        entrypoints: ["src/b.ts"],
        concerns: ["security"],
        confidence: "high",
      },
    ],
    fallback_required: false,
  };
  const pendingByLens = new Map([
    ["security", new Set(["src/a.ts", "src/b.ts"])],
  ]);

  const blocks = claimFlowReviewBlocks(criticalFlows, pendingByLens, new Set());

  // Same lens and same number of pending paths (1 each); alpha < beta alphabetically
  expect(blocks[0].flow_id).toBe("flow-alpha");
});

test("deduplicates: paths already in assigned are excluded from returned blocks", () => {
  const criticalFlows = {
    flows: [
      {
        id: "flow-1",
        name: "Flow 1",
        paths: ["src/a.ts", "src/b.ts"],
        entrypoints: ["src/a.ts"],
        concerns: ["security"],
        confidence: "high",
      },
    ],
    fallback_required: false,
  };
  const pendingByLens = new Map([
    ["security", new Set(["src/a.ts", "src/b.ts"])],
  ]);
  const assigned = new Set(["security:src/a.ts"]);

  const blocks = claimFlowReviewBlocks(criticalFlows, pendingByLens, assigned);

  expect(blocks.length).toBe(1);
  expect(blocks[0].file_paths).toEqual(["src/b.ts"]);
});

test("drops candidate entirely when all its paths are already assigned", () => {
  const criticalFlows = {
    flows: [
      {
        id: "flow-1",
        name: "Flow 1",
        paths: ["src/a.ts"],
        entrypoints: ["src/a.ts"],
        concerns: ["security"],
        confidence: "high",
      },
    ],
    fallback_required: false,
  };
  const pendingByLens = new Map([
    ["security", new Set(["src/a.ts"])],
  ]);
  const assigned = new Set(["security:src/a.ts"]);

  const blocks = claimFlowReviewBlocks(criticalFlows, pendingByLens, assigned);

  expect(blocks).toEqual([]);
});

test("mutates the assigned set with all returned lens:path keys", () => {
  const criticalFlows = {
    flows: [
      {
        id: "flow-1",
        name: "Flow 1",
        paths: ["src/a.ts", "src/b.ts"],
        entrypoints: ["src/a.ts"],
        concerns: ["security"],
        confidence: "high",
      },
    ],
    fallback_required: false,
  };
  const pendingByLens = new Map([
    ["security", new Set(["src/a.ts", "src/b.ts"])],
  ]);
  const assigned = new Set();

  claimFlowReviewBlocks(criticalFlows, pendingByLens, assigned);

  expect(assigned.has("security:src/a.ts"), "assigned should contain security:src/a.ts").toBeTruthy();
  expect(assigned.has("security:src/b.ts"), "assigned should contain security:src/b.ts").toBeTruthy();
});

test("a single flow with multiple matching lenses produces one block per lens", () => {
  const criticalFlows = {
    flows: [
      {
        id: "flow-1",
        name: "Flow 1",
        paths: ["src/a.ts"],
        entrypoints: ["src/a.ts"],
        concerns: ["security", "reliability"],
        confidence: "high",
      },
    ],
    fallback_required: false,
  };
  const pendingByLens = new Map([
    ["security", new Set(["src/a.ts"])],
    ["reliability", new Set(["src/a.ts"])],
  ]);

  const blocks = claimFlowReviewBlocks(criticalFlows, pendingByLens, new Set());

  expect(blocks.length).toBe(2);
  // security has higher priority and should appear first
  expect(blocks[0].lens).toBe("security");
  expect(blocks[1].lens).toBe("reliability");
});
