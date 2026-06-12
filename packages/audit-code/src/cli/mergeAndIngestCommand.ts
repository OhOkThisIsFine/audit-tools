import { readFile, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { isFileMissingError, readJsonFile, writeJsonFile } from "@audit-tools/shared";
import type { AuditResult, AuditTask } from "../types.js";
import type { WorkerTask } from "../types/workerSession.js";
import { validateAuditResults } from "../validation/auditResults.js";
import { runAuditStep } from "./auditStep.js";
import {
  type ActiveDispatchState,
  DISPATCH_RESULT_MAP_FILENAME,
  ACTIVE_DISPATCH_FILENAME,
  loadDispatchResultMap,
  entriesByTaskId,
  buildPendingAuditTasks,
} from "./dispatch.js";
import { addFileLineCountHints } from "./lineIndex.js";
import { isCanonicalResultFilename, taskResultPath, getArtifactsDir, getFlag } from "./args.js";
import { buildWorkerResult } from "./workerResult.js";
import { PACKET_SCHEMA_FILENAMES } from "../io/runArtifacts.js";

// Schema pointer files prepare-dispatch copies into task-results/ for optional
// worker self-validation. They are expected, not stray — skip them when
// scanning for spurious files.
const PACKET_SCHEMA_FILENAME_SET = new Set<string>(PACKET_SCHEMA_FILENAMES);

export async function cmdMergeAndIngest(argv: string[]): Promise<void> {
  const runId = getFlag(argv, "--run-id");
  if (!runId) throw new Error("merge-and-ingest requires --run-id <run_id>");
  const artifactsDir = getArtifactsDir(argv);

  const runDir = join(artifactsDir, "runs", runId);
  const taskResultsDir = join(runDir, "task-results");
  const auditResultsPath = join(runDir, "run-results.json");
  const taskPath = join(runDir, "task.json");
  const tasksPath = join(runDir, "pending-audit-tasks.json");
  const mergeCompletePath = join(runDir, "merge-complete.json");

  // Idempotency: a fully-merged run is terminal. A stray re-invocation for the
  // same run-id (e.g. after the run already advanced to the next deepening
  // round, which rewrites this run dir's pending-audit-tasks.json to the *next*
  // round's tasks) must be a clean no-op — not a spurious "all results missing"
  // hard failure that also truncates the transient results file. Replay the
  // recorded summary and exit 0.
  let priorSummary: Record<string, unknown> | null = null;
  try {
    priorSummary = await readJsonFile<Record<string, unknown>>(mergeCompletePath);
  } catch (e) {
    if (!isFileMissingError(e)) throw e;
  }
  if (priorSummary) {
    // A completion marker can go stale. Selective deepening appends new pending
    // tasks to the SAME run-id, and — in the no-progress-loop bug — their answers
    // already sit on disk under canonical per-task names while the marker says the
    // run is done. If any pending task has a recoverable on-disk result, the marker
    // no longer reflects reality: discard it and re-process so those answers ingest
    // instead of replaying a no-op forever. A genuinely terminal run (no pending
    // tasks, or pending tasks not yet answered — e.g. a new round handled under a
    // different run-id) still replays cleanly.
    let pendingWithResults = 0;
    try {
      const pending = await readJsonFile<AuditTask[]>(tasksPath);
      for (const task of pending) {
        if (existsSync(taskResultPath(taskResultsDir, task.task_id))) {
          pendingWithResults++;
        }
      }
    } catch { /* no pending-tasks file — treat as terminal and replay */ }
    if (pendingWithResults === 0) {
      console.log(
        JSON.stringify({ ...priorSummary, idempotent_replay: true }, null, 2),
      );
      return;
    }
    process.stderr.write(
      `[merge-and-ingest] completion marker for ${runId} is stale: ` +
        `${pendingWithResults} pending task(s) have un-ingested on-disk results; re-processing.\n`,
    );
    await rm(mergeCompletePath, { force: true });
  }

  const workerTask = await readJsonFile<WorkerTask>(taskPath);
  const resultMap = await loadDispatchResultMap(runDir);
  if (!resultMap) {
    throw new Error(
      `No ${DISPATCH_RESULT_MAP_FILENAME} found for run ${runId}; run prepare-dispatch first.`,
    );
  }

  let allTasks: AuditTask[] = [];
  try { allTasks = await readJsonFile<AuditTask[]>(tasksPath); } catch { /* may not exist */ }
  const entryByTaskId = entriesByTaskId(resultMap.entries);
  if (entryByTaskId.size !== resultMap.entries.length) {
    throw new Error(`Dispatch result map for run ${runId} contains duplicate task entries.`);
  }
  const expectedPaths = new Set(
    resultMap.entries.map((entry) => resolve(entry.result_path)),
  );

  let files: string[];
  try {
    files = (await readdir(taskResultsDir)).filter(f => f.endsWith(".json")).sort();
  } catch {
    files = [];
  }

  const passing: AuditResult[] = [];
  const failing: Array<{ task_id: string; errors: string[] }> = [];
  // Pending tasks that were NOT dispatched this round (a budget cap deferred
  // packets). They are not failures — they re-enter dispatch on the next round —
  // so they are tracked separately and must never inflate rejected_count, force a
  // non-zero exit, or gate the completion marker.
  const notDispatched: string[] = [];
  const seenTaskIds = new Set<string>();
  const spuriousFiles: string[] = [];

  const fallbackByTaskId = new Map<string, unknown>();
  for (const filename of files) {
    // Schema pointer files (audit_result/finding/audit_task .schema.json) are
    // copied into task-results/ by prepare-dispatch for optional worker
    // self-validation; they are expected, not stray.
    if (PACKET_SCHEMA_FILENAME_SET.has(filename)) continue;
    const filePath = resolve(join(taskResultsDir, filename));
    if (expectedPaths.has(filePath)) continue;

    // Not part of this round's plan. Still read it so a current task can be
    // recovered by task_id (e.g. a subagent wrote a valid result under a
    // non-assigned name).
    try {
      const raw = await readFile(filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const tid = typeof (parsed as Record<string, unknown>).task_id === "string"
          ? String((parsed as Record<string, unknown>).task_id) : undefined;
        if (tid && !fallbackByTaskId.has(tid)) {
          fallbackByTaskId.set(tid, parsed);
        }
      }
    } catch { /* not parseable — skip */ }

    // Only genuinely stray files are "spurious". Canonical per-task result files
    // (<stem>_<digest>.json) left by prior deepening rounds in the same
    // task-results/ dir are legitimate and must not inflate the count or bury
    // the real stray-file signal (3 -> 191 over a run before this fix).
    if (!isCanonicalResultFilename(filename)) {
      spuriousFiles.push(filename);
    }
  }

  // Collapse stray-file warnings into a single stderr line so the real summary
  // (emitted as the sole stdout JSON payload) is never buried under a wall of
  // per-file warnings.
  if (spuriousFiles.length > 0) {
    process.stderr.write(
      `[merge-and-ingest] Warning: ${spuriousFiles.length} unexpected file(s) in ` +
        `task-results/ ignored: ${spuriousFiles.join(", ")}\n`,
    );
  }

  for (const task of allTasks) {
    const entry = entryByTaskId.get(task.task_id);
    let obj: unknown;
    if (entry) {
      const filePath = entry.result_path;
      try {
        obj = JSON.parse(await readFile(filePath, "utf8"));
      } catch (e) {
        if (isFileMissingError(e)) {
          const fallback = fallbackByTaskId.get(task.task_id);
          if (fallback) {
            process.stderr.write(
              `[merge-and-ingest] Recovered result for '${task.task_id}' from unexpected file (matched by task_id)\n`,
            );
            obj = fallback;
          } else {
            failing.push({
              task_id: task.task_id,
              errors: ["Missing audit result for assigned task."],
            });
            continue;
          }
        } else {
          failing.push({ task_id: task.task_id, errors: [`Invalid JSON: ${(e as Error).message}`] });
          continue;
        }
      }
    } else {
      // No result-map entry => this pending task was not dispatched this round.
      // But its answer may already exist on disk under a canonical per-task name
      // (e.g. a selective-deepening task answered in a prior round whose dispatch
      // manifest was later regenerated empty — the no-progress loop this guards
      // against). Recover it by task_id so it ingests instead of looping forever
      // as "pending"; only when no such file exists is the task genuinely held
      // back for the next dispatch (not a failure).
      const fallback = fallbackByTaskId.get(task.task_id);
      if (!fallback) {
        notDispatched.push(task.task_id);
        continue;
      }
      process.stderr.write(
        `[merge-and-ingest] Recovered un-dispatched task '${task.task_id}' from on-disk result file (matched by task_id)\n`,
      );
      obj = fallback;
    }
    const record = obj && typeof obj === "object" && !Array.isArray(obj)
      ? obj as Record<string, unknown>
      : undefined;
    const taskId = typeof record?.task_id === "string"
      ? String(record.task_id) : undefined;
    const resultErrors: string[] = [];
    if (taskId) {
      if (seenTaskIds.has(taskId)) {
        resultErrors.push(`Duplicate audit result for assigned task '${taskId}'.`);
      } else {
        seenTaskIds.add(taskId);
      }
      if (taskId !== task.task_id) {
        resultErrors.push(
          `Result file is assigned to '${task.task_id}' but contains task_id '${taskId}'.`,
        );
      }
    }
    const issues = validateAuditResults(
      [obj],
      [task],
      { lineIndex: task.file_line_counts ?? {} },
    );
    resultErrors.push(
      ...issues
        .filter(i => i.severity === "error")
        .map(i => i.message),
    );
    if (resultErrors.length === 0) {
      passing.push(obj as AuditResult);
    } else {
      failing.push({ task_id: taskId ?? task.task_id, errors: resultErrors });
    }
  }

  const failedTasksPath = join(runDir, "failed-tasks.json");
  if (failing.length > 0) {
    await writeJsonFile(failedTasksPath, failing);
  }

  if (passing.length === 0 && failing.length > 0) {
    // Nothing merged and at least one failure: a blocked no-op. Do NOT write the
    // transient results file here — truncating it to [] reads as catastrophic
    // data loss on a re-run when the cumulative audit_results.jsonl store is in
    // fact intact and the first merge had simply already succeeded.
    throw new Error(
      `All ${failing.length} assigned task result(s) were missing or invalid; blocked before ingestion. See ${failedTasksPath}`,
    );
  }

  const findingCount = passing.reduce(
    (sum, result) => sum + result.findings.length,
    0,
  );

  let result: Awaited<ReturnType<typeof runAuditStep>> | null = null;
  if (passing.length > 0) {
    // Write the transient results file only when there is something to ingest.
    // Writing [] unconditionally would, on a stray re-invocation where every
    // accepted task was already pruned from the pending set (passing=0,
    // notDispatched>0), truncate a prior run-results.json — the same data loss
    // the failing>0 guard above prevents but a notDispatched-only merge bypasses.
    await writeJsonFile(auditResultsPath, passing);
    result = await runAuditStep({
      root: workerTask.repo_root,
      artifactsDir,
      preferredExecutor: "result_ingestion_executor",
      auditResultsPath,
    });
    const updatedPendingTasks = await addFileLineCountHints(
      workerTask.repo_root,
      buildPendingAuditTasks(result.updated_bundle),
    );
    await writeJsonFile(tasksPath, updatedPendingTasks);
  }

  const activeDispatchPath = join(artifactsDir, ACTIVE_DISPATCH_FILENAME);
  try {
    const dispatch = await readJsonFile<ActiveDispatchState>(activeDispatchPath);
    if (dispatch.run_id === runId) {
      // "merged" only when this round is fully drained: every dispatched task
      // accepted AND nothing held back (budget-capped notDispatched > 0 stays
      // "active" because a follow-up round on the same run-id still has to merge).
      dispatch.status =
        failing.length > 0 || notDispatched.length > 0 ? "active" : "merged";
      await writeJsonFile(activeDispatchPath, dispatch);
    }
  } catch { /* no active dispatch file — skip */ }

  let retryDispatchPath: string | null = null;
  if (failing.length > 0) {
    const failedTaskIds = new Set(failing.map((f) => f.task_id));
    const failedPacketIds = [
      ...new Set(
        resultMap.entries
          .filter((e) => failedTaskIds.has(e.task_id))
          .map((e) => e.packet_id),
      ),
    ];
    const retryDispatch = {
      run_id: runId,
      retry_packet_ids: failedPacketIds,
      failed_task_count: failing.length,
      accepted_task_count: passing.length,
    };
    retryDispatchPath = join(runDir, "retry-dispatch.json");
    await writeJsonFile(retryDispatchPath, retryDispatch);
    process.stderr.write(
      `[merge-and-ingest] ${passing.length} accepted, ${failing.length} failed. ` +
      `Retry packets: ${failedPacketIds.join(", ")}\n`,
    );
  }

  // "partial" whenever work remains for this run — either genuine dispatched
  // failures (failing) or tasks held back this round (notDispatched). The exit
  // code below distinguishes the two: only genuine failures exit non-zero, so a
  // budget-capped round reports status "partial" but exits 0 (progressing, not an error).
  const status = failing.length > 0 || notDispatched.length > 0
    ? "partial"
    : (result?.progress_made ? "completed" : "no_progress");
  const workerResult = buildWorkerResult({
    runId,
    obligationId: workerTask.obligation_id,
    status: failing.length > 0 ? "no_progress" : (result?.progress_made ? "completed" : "no_progress"),
    progressMade: result?.progress_made ?? false,
    selectedExecutor: result?.selected_executor ?? null,
    artifactsWritten: result?.artifacts_written ?? [],
    summary: result?.progress_summary ?? `${failing.length} task(s) failed`,
    nextLikelyStep: result?.next_likely_step ?? null,
    errors: [],
  });
  await writeJsonFile(workerTask.result_path, workerResult);
  const summaryPayload = {
    run_id: runId,
    status,
    accepted_count: passing.length,
    rejected_count: failing.length,
    not_dispatched_count: notDispatched.length,
    spurious_file_count: spuriousFiles.length,
    finding_count: findingCount,
    audit_results_path: auditResultsPath,
    ...(retryDispatchPath ? { retry_dispatch_path: retryDispatchPath } : {}),
    ...(result ? {
      selected_executor: workerResult.selected_executor,
      progress_made: workerResult.progress_made,
      progress_summary: workerResult.summary,
      next_likely_step: workerResult.next_likely_step,
    } : {}),
  };

  // Record a completion marker for a fully-merged run so a stray re-invocation
  // replays this summary (above) instead of re-processing — and possibly
  // clobbering — terminal state. Only when this round is fully drained: genuine
  // failures stay replayable for retry, and budget-capped rounds (notDispatched > 0)
  // must NOT be marked complete or a follow-up merge on the same run-id would
  // short-circuit to an idempotent replay and silently drop deferred results.
  //
  // Selective deepening appends new pending tasks to the SAME run-id; this marker
  // can therefore go stale once those tasks are later dispatched and answered. The
  // replay guard at the top detects that (a pending task with an on-disk result)
  // and re-processes, so a premature marker self-heals instead of stranding the
  // deepening answers behind an idempotent replay (the no-progress loop).
  if (failing.length === 0 && notDispatched.length === 0) {
    await writeJsonFile(mergeCompletePath, summaryPayload);
  }

  console.log(JSON.stringify(summaryPayload, null, 2));

  if (failing.length > 0) {
    process.exitCode = 2;
  }
}
