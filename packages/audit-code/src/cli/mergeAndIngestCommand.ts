import { readFile, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isFileMissingError, readJsonFile, writeJsonFile } from "@audit-tools/shared";
import type { AuditResult, AuditTask } from "../types.js";
import type { WorkerTask } from "../types/workerSession.js";
import { validateAuditResults } from "../validation/auditResults.js";
import { verifyFindingGrounding } from "../validation/quoteGrounding.js";
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
import { isCanonicalResultFilename, getArtifactsDir, getFlag } from "./args.js";
import { buildWorkerResult } from "./workerResult.js";
import { PACKET_SCHEMA_FILENAMES } from "../io/runArtifacts.js";

// Schema pointer files prepare-dispatch copies into task-results/ for optional
// worker self-validation. They are expected, not stray — skip them when
// scanning for spurious files.
const PACKET_SCHEMA_FILENAME_SET = new Set<string>(PACKET_SCHEMA_FILENAMES);

/**
 * Canonical key for a finding used to detect cross-packet duplicates.
 * Stable across result ordering: lens + category + title + first affected file.
 */
function findingKey(f: { lens?: string; category?: string; title?: string; affected_files?: Array<{ path: string }> }): string {
  return [
    (f.lens ?? "").trim().toLowerCase(),
    (f.category ?? "").trim().toLowerCase(),
    (f.title ?? "").trim().toLowerCase(),
    f.affected_files?.[0]?.path ?? "",
  ].join("|");
}

/**
 * Scan the accepted results and warn when findings share the same canonical key
 * across different packets. All results are in memory at merge time, so this
 * check is more accurate than the per-packet early-warning that previously lived
 * in submit-packet.
 */
function warnOnDuplicateFindings(passing: AuditResult[]): void {
  const seenKeys = new Map<string, string>(); // key → task_id
  let dupCount = 0;
  for (const result of passing) {
    for (const f of result.findings ?? []) {
      const key = findingKey(f);
      const prior = seenKeys.get(key);
      if (prior) {
        dupCount++;
      } else {
        seenKeys.set(key, result.task_id);
      }
    }
  }
  if (dupCount > 0) {
    process.stderr.write(
      `[merge-and-ingest] Warning: ${dupCount} finding(s) appear to duplicate findings across packets in this run.\n`,
    );
  }
}

/**
 * Index every task_id that has an on-disk result in task-results/, regardless of
 * filename convention — packet `.inline-result.json` arrays, canonical per-task
 * files, or a stray name. The host writes one array file per packet, so a per-
 * task canonical-name probe never finds these; recovering by task_id matches how
 * the main ingest path collects results.
 */
async function taskIdsWithOnDiskResults(taskResultsDir: string): Promise<Set<string>> {
  let files: string[];
  try {
    files = (await readdir(taskResultsDir)).filter((f) => f.endsWith(".json"));
  } catch {
    return new Set();
  }
  const ids = new Set<string>();
  for (const filename of files) {
    if (PACKET_SCHEMA_FILENAME_SET.has(filename)) continue;
    try {
      const parsed = JSON.parse(await readFile(join(taskResultsDir, filename), "utf8"));
      for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
        if (item && typeof item === "object" && !Array.isArray(item)) {
          const tid = (item as Record<string, unknown>).task_id;
          if (typeof tid === "string") ids.add(tid);
        }
      }
    } catch {
      /* not parseable — skip */
    }
  }
  return ids;
}

/**
 * Check for a completed-run marker and either replay its summary (no-op) or
 * invalidate a stale marker and signal to re-process.
 *
 * Returns the prior summary object when the run is definitively terminal
 * (caller should replay and return), or null when processing must continue.
 */
async function checkIdempotencyReplay(
  runId: string,
  mergeCompletePath: string,
  tasksPath: string,
  taskResultsDir: string,
): Promise<Record<string, unknown> | null> {
  let priorSummary: Record<string, unknown> | null = null;
  try {
    priorSummary = await readJsonFile<Record<string, unknown>>(mergeCompletePath);
  } catch (e) {
    if (!isFileMissingError(e)) throw e;
  }
  if (!priorSummary) return null;

  // A completion marker can go stale. Selective deepening appends new pending
  // tasks to the SAME run-id, and their answers then land on disk (in this
  // round's packet result files) while the marker still says the run is done.
  // If any pending task has a recoverable on-disk result — matched by task_id,
  // the same way the main ingest path recovers them — the marker no longer
  // reflects reality: discard it and re-process so those answers ingest instead
  // of replaying a no-op forever. A genuinely terminal run (no pending tasks, or
  // pending tasks not yet answered) still replays cleanly.
  let pendingWithResults = 0;
  try {
    const pending = await readJsonFile<AuditTask[]>(tasksPath);
    const answered = await taskIdsWithOnDiskResults(taskResultsDir);
    for (const task of pending) {
      if (answered.has(task.task_id)) {
        pendingWithResults++;
      }
    }
  } catch { /* no pending-tasks file — treat as terminal and replay */ }

  if (pendingWithResults === 0) {
    return priorSummary;
  }

  process.stderr.write(
    `[merge-and-ingest] completion marker for ${runId} is stale: ` +
      `${pendingWithResults} pending task(s) have un-ingested on-disk results; re-processing.\n`,
  );
  await rm(mergeCompletePath, { force: true });
  return null;
}

/**
 * Scan the task-results/ directory to build a fallback lookup table keyed by
 * task_id from files that are NOT in the expected result-path set for this
 * round. Also tracks spurious (non-canonical) filenames for warning output.
 *
 * Returns both the fallback map and the list of spurious filenames.
 */
async function scanTaskResults(
  taskResultsDir: string,
  expectedPaths: Set<string>,
): Promise<{ fallbackByTaskId: Map<string, unknown>; spuriousFiles: string[] }> {
  let files: string[];
  try {
    files = (await readdir(taskResultsDir)).filter(f => f.endsWith(".json")).sort();
  } catch {
    files = [];
  }

  const fallbackByTaskId = new Map<string, unknown>();
  const spuriousFiles: string[] = [];

  for (const filename of files) {
    // Schema pointer files (audit_result/finding/audit_task .schema.json) are
    // copied into task-results/ by prepare-dispatch for optional worker
    // self-validation; they are expected, not stray.
    if (PACKET_SCHEMA_FILENAME_SET.has(filename)) continue;
    const filePath = resolve(join(taskResultsDir, filename));
    if (expectedPaths.has(filePath)) continue;

    // Not part of this round's plan. Still read it so a current task can be
    // recovered by task_id (e.g. a subagent wrote a valid result under a
    // non-assigned name, or wrote an inline AuditResult[] array to a packet
    // result file). Expand top-level arrays element-by-element so a worker
    // that emits an AuditResult[] payload can be recovered by task_id (INV-01).
    try {
      const raw = await readFile(filePath, "utf8");
      const parsed = JSON.parse(raw);
      const candidates: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of candidates) {
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        const tid = typeof (item as Record<string, unknown>).task_id === "string"
          ? String((item as Record<string, unknown>).task_id) : undefined;
        if (tid && !fallbackByTaskId.has(tid)) {
          fallbackByTaskId.set(tid, item);
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

  return { fallbackByTaskId, spuriousFiles };
}

/**
 * Validate each pending task's result, classifying into passing/failing/notDispatched.
 * Reads results from the result-map paths or falls back to the task_id lookup table
 * for tasks recovered from non-canonical files.
 */
async function validateAndCollectResults(
  allTasks: AuditTask[],
  entryByTaskId: Map<string, { result_path: string; task_id: string; packet_id: string }>,
  fallbackByTaskId: Map<string, unknown>,
): Promise<{
  passing: AuditResult[];
  failing: Array<{ task_id: string; errors: string[] }>;
  notDispatched: string[];
  recoveredCount: number;
}> {
  const passing: AuditResult[] = [];
  const failing: Array<{ task_id: string; errors: string[] }> = [];
  // Pending tasks that were NOT dispatched this round. Not failures — they
  // re-enter dispatch on the next round.
  const notDispatched: string[] = [];
  const seenTaskIds = new Set<string>();
  // Results recovered by task_id from packet result files. The host writes one
  // array file per packet, so this is the normal collection path, not an error.
  let recoveredCount = 0;

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
            recoveredCount++;
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
      recoveredCount++;
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

  return { passing, failing, notDispatched, recoveredCount };
}

/**
 * Quote-and-verify grounding pass (S7): re-read each finding's cited verbatim
 * span from disk and content-match it, annotating `finding.grounding`. A
 * finding whose quote does not re-verify (or that carries no quote) is marked
 * `ungrounded` and surfaced — never silently dropped, never silently admitted as
 * confirmed. Advisory metadata: this does not fail a result, so a weaker
 * auditor's confident-but-fake finding is flagged for review rather than merged
 * as fact. Mutates the findings in place and returns the ungrounded references.
 */
async function groundPassingFindings(
  repoRoot: string,
  passing: AuditResult[],
): Promise<Array<{ task_id: string; finding_id: string; path: string }>> {
  const ungrounded: Array<{ task_id: string; finding_id: string; path: string }> = [];
  for (const result of passing) {
    for (const finding of result.findings) {
      const grounding = await verifyFindingGrounding(repoRoot, finding);
      finding.grounding = grounding;
      if (grounding.status === "ungrounded") {
        ungrounded.push({
          task_id: result.task_id,
          finding_id: finding.id,
          path: finding.affected_files?.[0]?.path ?? "?",
        });
      }
    }
  }
  return ungrounded;
}

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

  // Phase 1: idempotency — replay a completed run or discard a stale marker.
  const priorSummary = await checkIdempotencyReplay(runId, mergeCompletePath, tasksPath, taskResultsDir);
  if (priorSummary) {
    console.log(JSON.stringify({ ...priorSummary, idempotent_replay: true }, null, 2));
    return;
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

  // Phase 2: scan task-results/ to build the fallback-by-task_id recovery table.
  const { fallbackByTaskId, spuriousFiles } = await scanTaskResults(taskResultsDir, expectedPaths);

  // Collapse stray-file warnings into a single stderr line so the real summary
  // (emitted as the sole stdout JSON payload) is never buried under a wall of
  // per-file warnings.
  if (spuriousFiles.length > 0) {
    process.stderr.write(
      `[merge-and-ingest] Warning: ${spuriousFiles.length} unexpected file(s) in ` +
        `task-results/ ignored: ${spuriousFiles.join(", ")}\n`,
    );
  }

  // Phase 3: validate each task's result and classify into passing/failing/notDispatched.
  const { passing, failing, notDispatched, recoveredCount } = await validateAndCollectResults(
    allTasks,
    entryByTaskId,
    fallbackByTaskId,
  );
  if (recoveredCount > 0) {
    process.stderr.write(
      `[merge-and-ingest] Recovered ${recoveredCount} result(s) by task_id from packet result files.\n`,
    );
  }

  // Phase 3.5: quote-and-verify grounding (S7). Re-read each finding's cited
  // verbatim span from disk and content-match it; annotate the finding and
  // surface ungrounded findings (hallucinated or stale quotes) without dropping
  // them. The grounding marker travels with the finding into the merged store.
  const ungrounded = await groundPassingFindings(workerTask.repo_root, passing);
  if (ungrounded.length > 0) {
    process.stderr.write(
      `[merge-and-ingest] ${ungrounded.length} finding(s) could not be grounded against disk (marked ungrounded): ${ungrounded
        .map((u) => `${u.finding_id} (${u.path})`)
        .join(", ")}\n`,
    );
  }

  // Phase 4: warn on cross-packet duplicate findings (all results in memory here —
  // more accurate than per-packet early-warning at submit time).
  warnOnDuplicateFindings(passing);

  // FND-OBS-48c05a13: log notDispatched task IDs early (before ingestion) so
  // operators can trace which tasks were budget-capped and re-enter dispatch on
  // the next round, even if ingestion later throws.
  if (notDispatched.length > 0) {
    process.stderr.write(
      `[merge-and-ingest] ${notDispatched.length} task(s) not dispatched this round (budget-capped): ${notDispatched.join(", ")}\n`,
    );
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
  // WorkerResultStatus does not have "partial"; use "blocked" when tasks failed
  // but progress was also made (passing.length > 0), else "no_progress" for all
  // failures (COR-48c05a13: was always "no_progress" even when passing.length > 0
  // and result.progress_made is true).
  const workerResultStatus: import("../types/workerResult.js").WorkerResultStatus =
    failing.length === 0
      ? (result?.progress_made ? "completed" : "no_progress")
      : passing.length > 0 || result?.progress_made
        ? "blocked"
        : "no_progress";
  const workerResult = buildWorkerResult({
    runId,
    obligationId: workerTask.obligation_id,
    status: workerResultStatus,
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
