import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readJsonFile, isFileMissingError, RunLogger } from "audit-tools/shared";
import { type ActiveDispatchState, ACTIVE_DISPATCH_FILENAME, loadDispatchResultMap } from "./dispatch.js";
import { getArtifactsDir } from "./args.js";

export async function cmdDispatchStatus(argv: string[]): Promise<void> {
  const artifactsDir = getArtifactsDir(argv);
  const activeDispatchPath = join(artifactsDir, ACTIVE_DISPATCH_FILENAME);
  let activeDispatch: ActiveDispatchState | null = null;
  try {
    activeDispatch = await readJsonFile<ActiveDispatchState>(activeDispatchPath);
  } catch (e) {
    if (!isFileMissingError(e)) throw e;
  }
  if (!activeDispatch) {
    console.log(JSON.stringify({ status: "no_active_dispatch" }, null, 2));
    return;
  }

  const runDir = join(artifactsDir, "runs", activeDispatch.run_id);
  const resultMap = await loadDispatchResultMap(runDir);
  if (!resultMap) {
    console.log(JSON.stringify({
      status: "missing_result_map",
      run_id: activeDispatch.run_id,
    }, null, 2));
    return;
  }

  const packetIds = [...new Set(resultMap.entries.map((e) => e.packet_id))];
  const packetStatus: Array<{
    packet_id: string;
    task_count: number;
    completed_count: number;
    missing_task_ids: string[];
  }> = [];

  for (const pid of packetIds) {
    if (pid === "__prior_dispatch__") continue;
    const entries = resultMap.entries.filter((e) => e.packet_id === pid);
    let completed = 0;
    const missing: string[] = [];
    for (const entry of entries) {
      try {
        await readFile(entry.result_path, "utf8");
        completed++;
      } catch (e) {
        // Re-throw permission / IO errors so they surface as real failures rather
        // than silently appearing as "missing results" (COR-6e84f23c).
        if (!isFileMissingError(e)) throw e;
        missing.push(entry.task_id);
      }
    }
    packetStatus.push({
      packet_id: pid,
      task_count: entries.length,
      completed_count: completed,
      missing_task_ids: missing,
    });
  }

  const totalTasks = packetStatus.reduce((s, p) => s + p.task_count, 0);
  const completedTasks = packetStatus.reduce((s, p) => s + p.completed_count, 0);
  const completedPackets = packetStatus.filter((p) => p.missing_task_ids.length === 0).length;

  // FND-OBS-6e84f23c: record dispatch-status checks in run log so operators have
  // a history of polling events for long-running dispatch sessions.
  const runLogger = new RunLogger(join(artifactsDir, "run.log.jsonl"));
  runLogger.event({
    kind: "step",
    obligation: "dispatch_status_check",
    note: `run_id=${activeDispatch.run_id} completed=${completedTasks}/${totalTasks} packets=${completedPackets}/${packetStatus.length}`,
  });

  console.log(JSON.stringify({
    run_id: activeDispatch.run_id,
    dispatch_status: activeDispatch.status,
    created_at: activeDispatch.created_at,
    total_packets: packetStatus.length,
    completed_packets: completedPackets,
    total_tasks: totalTasks,
    completed_tasks: completedTasks,
    missing_tasks: totalTasks - completedTasks,
    packets: packetStatus,
  }, null, 2));
}
