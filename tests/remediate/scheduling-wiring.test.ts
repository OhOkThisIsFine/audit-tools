/**
 * MODULE A5 — scheduling wiring: nextStep threads `cofile_parallel_safe` from
 * each RemediationBlock into the OwnershipSchedulerNode it produces, through the
 * SAME `scopeForBlock`-style seam that carries `write_paths`.
 *
 * The seam under test lives inside `driveRollingDispatch`, where each level is
 * mapped to `{ block_id, write_paths: scopeForBlock(b), cofile_parallel_safe }`
 * before being handed to `ownershipSubWaves`. We spy on `ownershipSubWaves` to
 * capture exactly the nodes nextStep hands it, and assert:
 *   1. a block that SETS the flag → its node carries `cofile_parallel_safe`;
 *   2. a block that DOESN'T set it → the node omits it (byte-identical to today);
 *   3. the flag flows through the same seam that carries `write_paths` (both are
 *      present on the same captured node, derived from the same block).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CapacityPool, SessionConfig } from "audit-tools/shared";
import type { RemediationBlock } from "../../src/remediate/state/types.js";
import * as scheduler from "../../src/shared/dispatch/ownershipScheduler.js";
import { driveRollingDispatch } from "../../src/remediate/steps/nextStep.js";

const pool: CapacityPool = {
  id: "stub/*",
  providerName: "claude-code",
  hostModel: null,
  hostConcurrencyLimit: { active_subagents: 8, source: "session_config" },
};
const session: SessionConfig = { quota: { enabled: false } };

function block(
  id: string,
  files: string[],
  cofile?: boolean,
): RemediationBlock {
  const b: RemediationBlock = {
    block_id: id,
    items: [id],
    parallel_safe: true,
    touched_files: files,
  };
  if (cofile !== undefined) b.cofile_parallel_safe = cofile;
  return b;
}

/** Drive one level and return the nodes captured on the spied ownershipSubWaves. */
async function capture(level: RemediationBlock[]): Promise<scheduler.OwnershipSchedulerNode[]> {
  const spy = vi.spyOn(scheduler, "ownershipSubWaves");
  await driveRollingDispatch([level], {
    confirmedPools: [pool],
    sessionConfig: session,
    rebuildSharedBetweenLevels: async () => {},
    root: process.cwd(),
    // Distinct scope so we can prove write_paths + cofile_parallel_safe ride the
    // SAME seam (both derived from the same block on the same captured node).
    scopeForBlock: (b) => b.touched_files ?? [],
    dispatchNode: async (b) => ({
      packet: { id: b.block_id, payload: { block_id: b.block_id }, estimatedTokens: 0, complexity: 0.5 },
      outcome: "success" as const,
    }),
  });
  // ownershipSubWaves is called once per level; grab the first-arg node list.
  const call = spy.mock.calls[0];
  expect(call).toBeTruthy();
  return call![0];
}

describe("A5 scheduling wiring: cofile_parallel_safe threads into the scheduler node", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("carries cofile_parallel_safe=true when the block sets it", async () => {
    const nodes = await capture([block("B-1", ["src/a.ts"], true)]);
    const n = nodes.find((x) => x.block_id === "B-1")!;
    expect(n.cofile_parallel_safe).toBe(true);
  });

  it("carries cofile_parallel_safe=false when the block sets it false", async () => {
    const nodes = await capture([block("B-1", ["src/a.ts"], false)]);
    const n = nodes.find((x) => x.block_id === "B-1")!;
    expect(n.cofile_parallel_safe).toBe(false);
  });

  it("omits cofile_parallel_safe (byte-identical to today) when the block doesn't set it", async () => {
    const nodes = await capture([block("B-1", ["src/a.ts"])]);
    const n = nodes.find((x) => x.block_id === "B-1")!;
    expect("cofile_parallel_safe" in n).toBe(false);
    // Behavior for the no-flag case is exactly the pre-change node shape.
    expect(n).toEqual({ block_id: "B-1", write_paths: ["src/a.ts"] });
  });

  it("the flag flows through the SAME scopeForBlock seam as write_paths", async () => {
    const nodes = await capture([
      block("B-1", ["src/a.ts"], true),
      block("B-2", ["src/b.ts"]),
    ]);
    const b1 = nodes.find((x) => x.block_id === "B-1")!;
    const b2 = nodes.find((x) => x.block_id === "B-2")!;
    // Same captured node carries BOTH — proving one seam, not a second lookup.
    expect(b1).toEqual({
      block_id: "B-1",
      write_paths: ["src/a.ts"],
      cofile_parallel_safe: true,
    });
    // The unflagged peer keeps the pre-change shape.
    expect(b2).toEqual({ block_id: "B-2", write_paths: ["src/b.ts"] });
  });
});
