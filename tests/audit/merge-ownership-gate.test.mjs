/**
 * merge-ownership-gate.test.mjs (D-66/67 slice-1, Part A) — full file-backed
 * round-trip for the OD3 merge-time ownership gate: `dispatch.ts` persists
 * `claimMany`'s owner tokens (`ownerTokens.ts`), and `mergeAndIngest` gates on
 * them before ingest/claim-clear. Pure-logic coverage of the partitioning
 * itself lives in merge-ownership-gate-unit.test.mjs; this file exercises the
 * real `ClaimRegistry` + sidecar + `mergeAndIngest` together.
 */
import { test, expect } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFixtureRepo, advanceFixtureToPlanning, buildSyntheticResults } from "./helpers/fixture.mjs";

const { writeCoreArtifacts, loadArtifactBundle } = await import("../../src/audit/io/artifacts.ts");
const { mergeAndIngest } = await import("../../src/audit/cli/mergeAndIngestCommand.ts");
const { taskResultPath } = await import("../../src/audit/cli/args.ts");
const { mergeOwnerTokens } = await import("../../src/audit/cli/ownerTokens.ts");
const { ClaimRegistry, taskClaimsPath } = await import("audit-tools/shared");

const RUN_ID = "run-ownership-gate";

/**
 * Scaffold a run directory with two dispatched (result-bearing) tasks, mimicking
 * what `prepareDispatchArtifacts` + a completed host round would have left on
 * disk: task.json, pending-audit-tasks.json, dispatch-result-map.json, and the
 * per-task result files.
 */
async function scaffoldRun(artifactsDir, root, tasksAndResults) {
  const runDir = join(artifactsDir, "runs", RUN_ID);
  const taskResultsDir = join(runDir, "task-results");
  await mkdir(taskResultsDir, { recursive: true });

  await writeFile(
    join(runDir, "task.json"),
    JSON.stringify({
      contract_version: "audit-code-worker/v1alpha1",
      run_id: RUN_ID,
      repo_root: root,
      artifacts_dir: artifactsDir,
      obligation_id: "audit_tasks_completed",
      preferred_executor: "claude-code",
      result_path: join(runDir, "worker-result.json"),
      worker_command: [],
    }),
    "utf8",
  );

  const tasks = tasksAndResults.map(([t]) => t);
  await writeFile(join(runDir, "pending-audit-tasks.json"), JSON.stringify(tasks), "utf8");

  const entries = [];
  for (const [t, result] of tasksAndResults) {
    const resultPath = taskResultPath(taskResultsDir, t.task_id);
    await writeFile(resultPath, JSON.stringify(result), "utf8");
    entries.push({ packet_id: `pkt-${t.task_id}`, task_id: t.task_id, result_path: resultPath });
  }
  await writeFile(
    join(runDir, "dispatch-result-map.json"),
    JSON.stringify({
      contract_version: "audit-code-dispatch-results/v1alpha1",
      run_id: RUN_ID,
      entries,
    }),
    "utf8",
  );

  return { runDir, taskResultsDir };
}

test("mergeAndIngest ownership gate: a task reclaimed by a peer since dispatch is excluded from ingest, its claim left alone, and surfaced", async () => {
  const root = await mkdtemp(join(tmpdir(), "merge-ownership-"));
  try {
    await writeFixtureRepo(root);
    const { planning, lineIndex } = await advanceFixtureToPlanning(root);
    const artifactsDir = join(root, ".audit-tools", "audit");
    await mkdir(artifactsDir, { recursive: true });
    await writeCoreArtifacts(artifactsDir, planning.updated_bundle);

    const tasks = planning.updated_bundle.audit_tasks;
    expect(tasks.length >= 2, "fixture must produce at least 2 audit tasks").toBeTruthy();
    const [ownedTask, reclaimedTask] = tasks;
    const [ownedResult, reclaimedResult] = buildSyntheticResults([ownedTask, reclaimedTask], lineIndex);

    const { runDir } = await scaffoldRun(artifactsDir, root, [
      [ownedTask, ownedResult],
      [reclaimedTask, reclaimedResult],
    ]);

    // Mimic dispatch.ts: claim both tasks (poolId=runId) and persist their
    // tokens into the run-scoped sidecar.
    const registry = new ClaimRegistry(taskClaimsPath(artifactsDir));
    const { ownerTokenByNode } = await registry.claimMany(
      [ownedTask.task_id, reclaimedTask.task_id],
      RUN_ID,
    );
    await mergeOwnerTokens(runDir, ownerTokenByNode);

    // Simulate a PEER reclaiming reclaimedTask's lease after our dispatch
    // persisted its token: release-then-reclaim under a DIFFERENT poolId rotates
    // the token exactly like a real stale-reclaim would (same observable effect
    // on heartbeat() — see claim-lease.test.mjs's own use of this trick).
    await registry.release(reclaimedTask.task_id, ownerTokenByNode[reclaimedTask.task_id]);
    await registry.claim(reclaimedTask.task_id, "peer-run");

    const { summary } = await mergeAndIngest({ runId: RUN_ID, artifactsDir });

    expect(summary.accepted_count, "only the owned task ingests").toBe(1);
    expect(summary.unowned_count, "the reclaimed task is excluded, not ingested").toBe(1);
    expect(summary.status).toBe("partial");
    expect(summary.unowned_tasks_path, "sidecar path surfaced in the summary").toBeTruthy();

    const unowned = JSON.parse(await readFile(join(runDir, "unowned-tasks.json"), "utf8"));
    expect(unowned.map((u) => u.task_id)).toEqual([reclaimedTask.task_id]);
    expect(unowned[0].reason).toMatch(/reclaimed by a peer/i);

    // The reclaimed task's claim was NOT cleared (it's the peer's now); the
    // owned+ingested task's claim WAS cleared (terminal + ours).
    const claims = await registry.listClaims();
    expect(claims[reclaimedTask.task_id], "peer's claim on the reclaimed task survives").toBeTruthy();
    expect(claims[ownedTask.task_id], "the owned+ingested task's claim is cleared").toBeUndefined();

    // The ingested bundle contains only the owned task's result.
    const bundle = await loadArtifactBundle(artifactsDir);
    expect(bundle.audit_results.map((r) => r.task_id)).toEqual([ownedTask.task_id]);

    // No merge-complete marker: the run is not fully drained (a peer still owns
    // the reclaimed task), so a stray re-invocation must not idempotent-replay.
    const mergeCompleteRaw = await readFile(join(runDir, "merge-complete.json"), "utf8").catch(() => null);
    expect(mergeCompleteRaw, "no completion marker while a task remains unowned").toBeNull();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("mergeAndIngest ownership gate: a task with no persisted token ingests normally (fail-open, today's behavior)", async () => {
  const root = await mkdtemp(join(tmpdir(), "merge-ownership-tokenless-"));
  try {
    await writeFixtureRepo(root);
    const { planning, lineIndex } = await advanceFixtureToPlanning(root);
    const artifactsDir = join(root, ".audit-tools", "audit");
    await mkdir(artifactsDir, { recursive: true });
    await writeCoreArtifacts(artifactsDir, planning.updated_bundle);

    const [onlyTask] = planning.updated_bundle.audit_tasks;
    const [onlyResult] = buildSyntheticResults([onlyTask], lineIndex);
    const { runDir } = await scaffoldRun(artifactsDir, root, [[onlyTask, onlyResult]]);

    // No owner-tokens.json written at all — a recovery/pre-slice-manifest path.
    const { summary } = await mergeAndIngest({ runId: RUN_ID, artifactsDir });

    expect(summary.accepted_count).toBe(1);
    expect(summary.unowned_count).toBe(0);
    expect(summary.status).toBe("completed");

    const bundle = await loadArtifactBundle(artifactsDir);
    expect(bundle.audit_results.map((r) => r.task_id)).toEqual([onlyTask.task_id]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("mergeAndIngest ownership gate: a task whose claim WE already cleared (prior successful ingest) is NOT mistaken for a peer reclaim on self-heal re-ingestion", async () => {
  const root = await mkdtemp(join(tmpdir(), "merge-ownership-selfheal-"));
  try {
    await writeFixtureRepo(root);
    const { planning, lineIndex } = await advanceFixtureToPlanning(root);
    const artifactsDir = join(root, ".audit-tools", "audit");
    await mkdir(artifactsDir, { recursive: true });
    await writeCoreArtifacts(artifactsDir, planning.updated_bundle);

    const [victim] = planning.updated_bundle.audit_tasks;
    const [victimResult] = buildSyntheticResults([victim], lineIndex);
    const { runDir, taskResultsDir } = await scaffoldRun(artifactsDir, root, [[victim, victimResult]]);

    // Round 1 dispatch: claim + persist the token, then ingest normally.
    const registry = new ClaimRegistry(taskClaimsPath(artifactsDir));
    const { ownerTokenByNode } = await registry.claimMany([victim.task_id], RUN_ID);
    await mergeOwnerTokens(runDir, ownerTokenByNode);

    const round1 = await mergeAndIngest({ runId: RUN_ID, artifactsDir });
    expect(round1.summary.accepted_count).toBe(1);
    expect(round1.summary.status).toBe("completed");
    // Round 1's terminal clear removed the claim — nobody holds it now.
    expect((await registry.listClaims())[victim.task_id]).toBeUndefined();

    // Reproduce the no-progress-loop self-heal precondition (mirrors the
    // wrapper-level "self-heals a stale completion marker" regression test):
    // the SAME task_id is re-listed as pending (selective deepening / a stale
    // completion marker) while the round-1 sidecar STILL carries its now-
    // orphaned token (nobody cleans the sidecar entry on claim-clear).
    await rm(join(runDir, "merge-complete.json"), { force: true });
    await writeFile(join(runDir, "pending-audit-tasks.json"), JSON.stringify([victim]), "utf8");
    const resultPath = taskResultPath(taskResultsDir, victim.task_id);
    await writeFile(
      join(runDir, "dispatch-result-map.json"),
      JSON.stringify({
        contract_version: "audit-code-dispatch-results/v1alpha1",
        run_id: RUN_ID,
        entries: [{ packet_id: `pkt-${victim.task_id}`, task_id: victim.task_id, result_path: resultPath }],
      }),
      "utf8",
    );

    const round2 = await mergeAndIngest({ runId: RUN_ID, artifactsDir });
    expect(round2.summary.accepted_count, "an orphaned (absent, not peer-held) claim must not gate the self-heal").toBe(1);
    expect(round2.summary.unowned_count).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("mergeAndIngest ownership gate: a STALE different-token claim (crashed peer's ghost, older than the 20-min task lease) does NOT gate the merge", async () => {
  const root = await mkdtemp(join(tmpdir(), "merge-ownership-ghost-"));
  try {
    await writeFixtureRepo(root);
    const { planning, lineIndex } = await advanceFixtureToPlanning(root);
    const artifactsDir = join(root, ".audit-tools", "audit");
    await mkdir(artifactsDir, { recursive: true });
    await writeCoreArtifacts(artifactsDir, planning.updated_bundle);

    const [victim] = planning.updated_bundle.audit_tasks;
    const [victimResult] = buildSyntheticResults([victim], lineIndex);
    const { runDir } = await scaffoldRun(artifactsDir, root, [[victim, victimResult]]);

    // Our dispatch persisted a token...
    await mergeOwnerTokens(runDir, { [victim.task_id]: "tok-run-A-original" });
    // ...and a peer later reclaimed (different token) but then CRASHED: write
    // the claims file directly with a heartbeat older than the 20-min task
    // lease, so the record is a ghost against the merge-side registry's
    // AUDIT_TASK_CLAIM_LEASE_MS window (this also pins that the merge side is
    // constructed with the LONG lease, not the 30s default — under 30s the
    // same fixture would be equally stale, so make it stale for BOTH windows;
    // liveness under the long lease is pinned by the sibling live-claim test).
    await writeFile(
      taskClaimsPath(artifactsDir),
      JSON.stringify({
        [victim.task_id]: {
          ownerToken: "tok-run-B-ghost",
          poolId: "peer-run-B",
          heartbeatAt: Date.now() - 21 * 60_000,
        },
      }),
      "utf8",
    );

    const { summary } = await mergeAndIngest({ runId: RUN_ID, artifactsDir });
    expect(summary.accepted_count, "a stale ghost claim must not drop our valid result").toBe(1);
    expect(summary.unowned_count).toBe(0);
    expect(summary.status).toBe("completed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("mergeAndIngest ownership gate: a fresh different-token claim is judged LIVE under the 20-min task lease even when older than the 30s default window", async () => {
  const root = await mkdtemp(join(tmpdir(), "merge-ownership-lease-"));
  try {
    await writeFixtureRepo(root);
    const { planning, lineIndex } = await advanceFixtureToPlanning(root);
    const artifactsDir = join(root, ".audit-tools", "audit");
    await mkdir(artifactsDir, { recursive: true });
    await writeCoreArtifacts(artifactsDir, planning.updated_bundle);

    const [victim] = planning.updated_bundle.audit_tasks;
    const [victimResult] = buildSyntheticResults([victim], lineIndex);
    const { runDir } = await scaffoldRun(artifactsDir, root, [[victim, victimResult]]);

    await mergeOwnerTokens(runDir, { [victim.task_id]: "tok-run-A-original" });
    // Peer's claim heartbeat is 5 minutes old: stale under the 30s DEFAULT
    // window but comfortably live under the 20-min task lease the merge-side
    // registry must be constructed with. A defaulted registry would read this
    // as a ghost and wrongly ingest; the correct long-lease registry excludes.
    await writeFile(
      taskClaimsPath(artifactsDir),
      JSON.stringify({
        [victim.task_id]: {
          ownerToken: "tok-run-B-live",
          poolId: "peer-run-B",
          heartbeatAt: Date.now() - 5 * 60_000,
        },
      }),
      "utf8",
    );

    const { summary } = await mergeAndIngest({ runId: RUN_ID, artifactsDir });
    expect(summary.accepted_count, "a live peer claim (within the task lease) must gate the merge").toBe(0);
    expect(summary.unowned_count).toBe(1);
    const unowned = JSON.parse(await readFile(join(runDir, "unowned-tasks.json"), "utf8"));
    expect(unowned.map((u) => u.task_id)).toEqual([victim.task_id]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
