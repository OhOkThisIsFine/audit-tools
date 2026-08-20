import { test, expect } from "vitest";
import { claimFlowReviewBlocks } from "../../src/audit/orchestrator/flowPlanning.js";
import { ALL_LENSES } from "../../src/audit/types.js";
import type { CriticalFlowManifest } from "audit-tools/shared";

// The lens set flow planning admits — DERIVED from the one lens registry
// (`ALL_LENSES`, itself derived from `LENS_REGISTRY` in src/audit/types.ts),
// never hand-copied here. This file previously carried a seven-entry copy named
// after a `lensSetForFlow` helper that no longer exists: the very hand-copied
// list whose divergence from `isLens` was the defect `selectFlowLenses` was
// written to close. A copy here could only re-open it — adding a lens to the
// registry would leave this suite asserting the OLD set and reporting green.
const FLOW_LENSES: readonly string[] = ALL_LENSES;

test("flow planning admits every canonical lens in the registry, and schedules nothing the flow did not declare", async () => {
  // Verify by exercising claimFlowReviewBlocks with every canonical lens as a
  // concern: if any lens were absent from the membership draw (`selectFlowLenses`)
  // or the ordering map (`FLOW_LENS_ORDER`), it would be silently filtered out
  // and no block would be returned for it.
  //
  // The fixture declares one NON-canonical concern alongside them, which is what
  // keeps the second assertion meaningful: checking the scheduled set against
  // `FLOW_LENSES` would be tautological (they are the same list), so the
  // containment is asserted against the FIXTURE'S OWN declared concerns, and the
  // non-lens concern must be dropped rather than scheduled.
  const NON_CANONICAL_CONCERN = "definitely-not-a-lens";
  const declaredConcerns = [...FLOW_LENSES, NON_CANONICAL_CONCERN];
  const pendingByLens = new Map<string, Set<string>>(
    declaredConcerns.map((lens) => [lens, new Set(["src/a.ts"])]),
  );
  const criticalFlows: CriticalFlowManifest = {
    flows: [
      {
        id: "flow-all",
        name: "All Lenses Flow",
        paths: ["src/a.ts"],
        entrypoints: ["src/a.ts"],
        concerns: declaredConcerns,
        confidence: "high",
      },
    ],
    fallback_required: false,
  };

  const blocks = claimFlowReviewBlocks(criticalFlows, pendingByLens, new Set<string>());
  const scheduledLenses = new Set(blocks.map((b) => b.lens));

  for (const lens of FLOW_LENSES) {
    expect(scheduledLenses.has(lens), `lens '${lens}' should be scheduled by claimFlowReviewBlocks but was absent`).toBeTruthy();
  }
  // Nothing outside what this flow declared was scheduled...
  for (const lens of scheduledLenses) {
    expect(
      declaredConcerns.includes(lens),
      `scheduled lens '${lens}' was never declared as a concern by the fixture flow`,
    ).toBeTruthy();
  }
  // ...and a declared concern that is not a canonical lens is SKIPPED, not
  // scheduled — one stray concern must neither abort the flow nor invent a lens.
  expect(
    scheduledLenses.has(NON_CANONICAL_CONCERN),
    `'${NON_CANONICAL_CONCERN}' is not a canonical lens and must not be scheduled`,
  ).toBe(false);
});

test("claimFlowReviewBlocks schedules blocks for every declared concern lens on the initial call", () => {
  // Flow has 5 concerns including the 4 new ones; each has a pending path.
  const concerns = [
    "security",
    "data_integrity",
    "operability",
    "performance",
    "observability",
  ];
  const pendingByLens = new Map<string, Set<string>>(
    concerns.map((lens) => [lens, new Set(["src/b.ts"])]),
  );
  const criticalFlows: CriticalFlowManifest = {
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

  const blocks = claimFlowReviewBlocks(criticalFlows, pendingByLens, new Set<string>());
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
    new Map<string, Set<string>>(),
    new Set<string>(),
  );
  expect(blocks).toEqual([]);
});

test("returns a block with matching file_paths, flow_id, and lens", () => {
  const criticalFlows: CriticalFlowManifest = {
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
  const pendingByLens = new Map<string, Set<string>>([["security", new Set(["src/a.ts"])]]);
  const assigned = new Set<string>();

  const result = claimFlowReviewBlocks(criticalFlows, pendingByLens, assigned);

  expect(result.length).toBe(1);
  expect(result[0].flow_id).toBe("flow-1");
  expect(result[0].lens).toBe("security");
  expect(result[0].file_paths).toEqual(["src/a.ts"]);
  // The claim is reported on the RETURNED contract, not written back into the
  // caller's set (see the no-mutation test below).
  expect(result.assigned.has("security:src/a.ts"), "returned claim contract should carry security:src/a.ts").toBeTruthy();
  expect(assigned.size, "the caller's assigned set must be left untouched").toBe(0);
});

test("filters out paths not present in pendingByLens for the lens", () => {
  const criticalFlows: CriticalFlowManifest = {
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
  const pendingByLens = new Map<string, Set<string>>([["security", new Set(["src/a.ts"])]]);

  const blocks = claimFlowReviewBlocks(criticalFlows, pendingByLens, new Set<string>());

  expect(blocks.length).toBe(1);
  expect(blocks[0].file_paths).toEqual(["src/a.ts"]);
});

test("skips flows whose lens has no pending paths", () => {
  const criticalFlows: CriticalFlowManifest = {
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
  const pendingByLens = new Map<string, Set<string>>();

  const blocks = claimFlowReviewBlocks(criticalFlows, pendingByLens, new Set<string>());

  expect(blocks).toEqual([]);
});

// TST-a8ea07db: pendingByLens HAS an entry for the lens but the intersection
// with the flow's paths is empty — the flow must be skipped, not emitted empty.
test("skips flow when pendingByLens entry exists but no flow path is pending", () => {
  const criticalFlows: CriticalFlowManifest = {
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
  const pendingByLens = new Map<string, Set<string>>([["security", new Set(["src/a.ts", "src/b.ts"])]]);

  const blocks = claimFlowReviewBlocks(criticalFlows, pendingByLens, new Set<string>());

  expect(blocks, "flow with zero matching paths after filtering must be skipped").toEqual([]);
});

test("ignores concerns that are not in the DEFAULT_FLOW_LENS_PRIORITY list", () => {
  const criticalFlows: CriticalFlowManifest = {
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
  const pendingByLens = new Map<string, Set<string>>([
    ["unknown_concern", new Set(["src/a.ts"])],
    ["security", new Set(["src/a.ts"])],
  ]);

  const blocks = claimFlowReviewBlocks(criticalFlows, pendingByLens, new Set<string>());

  // Only security block should be returned; unknown_concern is filtered
  expect(blocks.length).toBe(1);
  expect(blocks[0].lens).toBe("security");
});

test("sorts candidates by file_paths count descending before deduplication", () => {
  const criticalFlows: CriticalFlowManifest = {
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
  const pendingByLens = new Map<string, Set<string>>([
    ["security", new Set(["src/a.ts", "src/b.ts", "src/c.ts"])],
  ]);

  const blocks = claimFlowReviewBlocks(criticalFlows, pendingByLens, new Set<string>());

  // flow-A has 2 paths; flow-B has 1; flow-A should come first
  expect(blocks[0].flow_id).toBe("flow-A");
});

test("breaks file_paths count ties by lens priority (security beats reliability)", () => {
  const criticalFlows: CriticalFlowManifest = {
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
  const pendingByLens = new Map<string, Set<string>>([
    ["security", new Set(["src/a.ts", "src/b.ts"])],
    ["reliability", new Set(["src/a.ts", "src/b.ts"])],
  ]);

  const blocks = claimFlowReviewBlocks(criticalFlows, pendingByLens, new Set<string>());

  // Both have 2 file_paths; security has higher priority than reliability
  expect(blocks[0].lens).toBe("security");
});

test("breaks lens+size ties by flow_id alphabetical order", () => {
  const criticalFlows: CriticalFlowManifest = {
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
  const pendingByLens = new Map<string, Set<string>>([
    ["security", new Set(["src/a.ts", "src/b.ts"])],
  ]);

  const blocks = claimFlowReviewBlocks(criticalFlows, pendingByLens, new Set<string>());

  // Same lens and same number of pending paths (1 each); alpha < beta alphabetically
  expect(blocks[0].flow_id).toBe("flow-alpha");
});

test("deduplicates: paths already in assigned are excluded from returned blocks", () => {
  const criticalFlows: CriticalFlowManifest = {
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
  const pendingByLens = new Map<string, Set<string>>([
    ["security", new Set(["src/a.ts", "src/b.ts"])],
  ]);
  const assigned = new Set<string>(["security:src/a.ts"]);

  const blocks = claimFlowReviewBlocks(criticalFlows, pendingByLens, assigned);

  expect(blocks.length).toBe(1);
  expect(blocks[0].file_paths).toEqual(["src/b.ts"]);
});

test("drops candidate entirely when all its paths are already assigned", () => {
  const criticalFlows: CriticalFlowManifest = {
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
  const pendingByLens = new Map<string, Set<string>>([
    ["security", new Set(["src/a.ts"])],
  ]);
  const assigned = new Set<string>(["security:src/a.ts"]);

  const blocks = claimFlowReviewBlocks(criticalFlows, pendingByLens, assigned);

  expect(blocks).toEqual([]);
});

// INVERTED (CP-NODE-9 cutover): this test previously pinned the by-reference
// mutation of the caller's `assigned` set. The claim contract is now the ONLY
// channel — `claimFlowReviewBlocks` reports post-claim state on its return value
// and writes nothing back through its arguments, so a caller cannot read claim
// state it never asked for and the two channels cannot drift. The parameter
// types are `ReadonlySet`/`ReadonlyMap`, which makes reintroducing the write a
// compile error; this test is the runtime half of that guarantee (a cast would
// defeat the types but not this assertion).
test("does NOT mutate the caller's assigned set or pending map; the returned claim contract carries the keys", () => {
  const criticalFlows: CriticalFlowManifest = {
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
  const pendingByLens = new Map<string, Set<string>>([
    ["security", new Set(["src/a.ts", "src/b.ts"])],
  ]);
  const assigned = new Set<string>();

  const result = claimFlowReviewBlocks(criticalFlows, pendingByLens, assigned);

  // The caller's inputs are untouched.
  expect([...assigned], "the caller's assigned set must not be written to").toEqual([]);
  expect(
    [...(pendingByLens.get("security") ?? [])].sort(),
    "the caller's pending map must not be written to",
  ).toEqual(["src/a.ts", "src/b.ts"]);

  // The returned contract carries the post-claim state instead.
  expect(result.assigned.has("security:src/a.ts"), "returned assigned should contain security:src/a.ts").toBeTruthy();
  expect(result.assigned.has("security:src/b.ts"), "returned assigned should contain security:src/b.ts").toBeTruthy();
  expect(
    [...(result.pending.get("security") ?? [])],
    "returned pending should have every claimed path removed",
  ).toEqual([]);
});

test("a single flow with multiple matching lenses produces one block per lens", () => {
  const criticalFlows: CriticalFlowManifest = {
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
  const pendingByLens = new Map<string, Set<string>>([
    ["security", new Set(["src/a.ts"])],
    ["reliability", new Set(["src/a.ts"])],
  ]);

  const blocks = claimFlowReviewBlocks(criticalFlows, pendingByLens, new Set<string>());

  expect(blocks.length).toBe(2);
  // security has higher priority and should appear first
  expect(blocks[0].lens).toBe("security");
  expect(blocks[1].lens).toBe("reliability");
});
