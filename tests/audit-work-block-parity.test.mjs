import assert from "node:assert/strict";
import test from "node:test";
import { buildWorkBlockPartition } from "../dist/audit/reporting/workBlocks.js";

test("findings-only partitions keep their ordered blocks and shared-write seam", () => {
  const findings = [
    { id: "finding-z", lens: "architecture", affected_files: [{ path: "src/shared.ts" }] },
    { id: "finding-a", lens: "reliability", affected_files: [{ path: "src/shared.ts" }] },
    { id: "finding-m", lens: "architecture", affected_files: [{ path: "src/solo.ts" }] },
  ];
  const { coherence_trace, blocks, seams } = JSON.parse(
    JSON.stringify(buildWorkBlockPartition({ findings })),
  );
  assert.deepEqual(coherence_trace.components, [["finding-a"], ["finding-m"], ["finding-z"]]);

  const block = (id, finding, file) => ({
    id,
    finding_ids: [finding],
    unit_ids: [],
    owned_files: [file],
    role: "implementation",
    rationale: "Canonical coherence component with 1 finding(s).",
    depends_on: [],
    token_estimate: 1500,
  });
  assert.deepEqual(blocks, [
    block("block-1", "finding-a", "src/shared.ts"),
    block("block-2", "finding-m", "src/solo.ts"),
    block("block-3", "finding-z", "src/shared.ts"),
  ]);
  assert.deepEqual(seams, [{
    id: "seam-3cc490302b79",
    file: "src/shared.ts",
    block_ids: ["block-1", "block-3"],
    kind: "predicted_write_conflict",
    requires_preparation: true,
    rationale: "2 components cite the same predicted write path src/shared.ts.",
  }]);
});
