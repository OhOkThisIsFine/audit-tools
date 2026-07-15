import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { advanceHostDispatchPause } = await import(
  "../../src/audit/cli/dispatch/pausePersist.ts"
);
const { ACTIVE_DISPATCH_FILENAME } = await import(
  "../../src/audit/types/activeDispatch.ts"
);

const RUN_ID = "run-hostpause";

async function seed() {
  const dir = await mkdtemp(join(tmpdir(), "hostpause-"));
  await writeFile(
    join(dir, ACTIVE_DISPATCH_FILENAME),
    JSON.stringify({
      run_id: RUN_ID,
      created_at: "2026-07-10T00:00:00Z",
      packet_count: 3,
      task_count: 3,
      status: "active",
    }),
    "utf8",
  );
  return dir;
}
async function readAD(dir) {
  return JSON.parse(await readFile(join(dir, ACTIVE_DISPATCH_FILENAME), "utf8"));
}

describe("advanceHostDispatchPause (host-path quota wall)", () => {
  // Packet ids (paused_state display) vs their constituent task ids (terminal routing).
  const PACKETS = ["u1:sec:packet-1", "u1:cor:packet-2"];
  const TASKS = ["T-a", "T-b", "T-c"];
  const wallOpts = (dir) => ({
    artifactsDir: dir,
    runId: RUN_ID,
    atWall: true,
    strandedPacketIds: PACKETS,
    strandedTaskIds: TASKS,
  });

  it("first wall enters waiting_for_provider at pause_count 0 with the whole declined frontier (packet ids)", async () => {
    const dir = await seed();
    const r = await advanceHostDispatchPause(wallOpts(dir));
    expect(r).toEqual({ paused: true, livelocked: false });
    const ad = await readAD(dir);
    expect(ad.paused_state.lifecycle.kind).toBe("waiting_for_provider");
    expect(ad.paused_state.lifecycle.pause_count).toBe(0);
    expect(ad.paused_state.lifecycle.stranded_node_ids).toEqual(PACKETS);
    expect(ad.partial_completion_terminal).toBeUndefined();
  });

  it("subsequent walls bump pause_count, then livelock → terminal carries TASK ids (routes synthesis), pause cleared", async () => {
    const dir = await seed();
    await advanceHostDispatchPause(wallOpts(dir)); // pause_count 0
    await advanceHostDispatchPause(wallOpts(dir)); // 1
    expect((await readAD(dir)).paused_state.lifecycle.pause_count).toBe(1);
    await advanceHostDispatchPause(wallOpts(dir)); // 2
    expect((await readAD(dir)).paused_state.lifecycle.pause_count).toBe(2);
    const r = await advanceHostDispatchPause(wallOpts(dir)); // nextPauseCount 3 = LIVELOCK_PAUSE_LIMIT
    expect(r).toEqual({ paused: true, livelocked: true });
    const ad = await readAD(dir);
    expect(ad.paused_state, "paused_state cleared on livelock (XOR invariant)").toBeUndefined();
    expect(ad.partial_completion_terminal.reason).toBe("livelock_guard");
    // MUST be task ids — deriveAuditState routes synthesis by matching task_id.
    expect(ad.partial_completion_terminal.stranded_ids).toEqual(TASKS);
  });

  it("preserves paused_at across bumps (the original pause timestamp)", async () => {
    const dir = await seed();
    await advanceHostDispatchPause(wallOpts(dir));
    const firstAt = (await readAD(dir)).paused_state.lifecycle.paused_at;
    await advanceHostDispatchPause(wallOpts(dir));
    expect((await readAD(dir)).paused_state.lifecycle.paused_at).toBe(firstAt);
  });

  it("wall cleared drops a carried pause (resume) and records no terminal", async () => {
    const dir = await seed();
    await advanceHostDispatchPause(wallOpts(dir));
    expect((await readAD(dir)).paused_state).toBeTruthy();
    const r = await advanceHostDispatchPause({ artifactsDir: dir, runId: RUN_ID, atWall: false, strandedPacketIds: [], strandedTaskIds: [] });
    expect(r).toEqual({ paused: false, livelocked: false });
    const ad = await readAD(dir);
    expect(ad.paused_state).toBeUndefined();
    expect(ad.partial_completion_terminal).toBeUndefined();
  });

  it("not at wall with no prior pause is a no-op", async () => {
    const dir = await seed();
    const r = await advanceHostDispatchPause({ artifactsDir: dir, runId: RUN_ID, atWall: false, strandedPacketIds: [], strandedTaskIds: [] });
    expect(r).toEqual({ paused: false, livelocked: false });
    expect((await readAD(dir)).paused_state).toBeUndefined();
  });

  // D2 — a pass where the in-process (NIM) partition ingested results is progress, not
  // a stall, so it resets the wall-pass counter and never trips the livelock.
  it("madeProgress resets pause_count and never livelocks (steady in-process progress)", async () => {
    const dir = await seed();
    // Drive well past LIVELOCK_PAUSE_LIMIT — every pass is still walled for the host
    // complement, but the in-process partition ingested each time.
    for (let i = 0; i < 6; i++) {
      const r = await advanceHostDispatchPause({ ...wallOpts(dir), madeProgress: true });
      expect(r).toEqual({ paused: true, livelocked: false });
      expect((await readAD(dir)).paused_state.lifecycle.pause_count).toBe(0);
    }
    // No terminal — the run kept covering ground via the in-process partition.
    expect((await readAD(dir)).partial_completion_terminal).toBeUndefined();
  });

  it("a stall AFTER progress starts counting from 0 (progress reset the counter)", async () => {
    const dir = await seed();
    // Two stalls (count → 0, 1), then a progress pass resets…
    await advanceHostDispatchPause(wallOpts(dir));
    await advanceHostDispatchPause(wallOpts(dir));
    expect((await readAD(dir)).paused_state.lifecycle.pause_count).toBe(1);
    await advanceHostDispatchPause({ ...wallOpts(dir), madeProgress: true });
    expect((await readAD(dir)).paused_state.lifecycle.pause_count).toBe(0);
    // …so it now takes the full 3 more consecutive stalls to livelock, not 1.
    await advanceHostDispatchPause(wallOpts(dir)); // 1
    await advanceHostDispatchPause(wallOpts(dir)); // 2
    const r = await advanceHostDispatchPause(wallOpts(dir)); // nextCount 3 → livelock
    expect(r.livelocked).toBe(true);
  });
});
