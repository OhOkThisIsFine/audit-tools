import { readFile, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isFileMissingError, mapWithConcurrency, readJsonFile, writeJsonFile, ClaimRegistry, taskClaimsPath, reconcileAdmissionLeasesFromQuotaFile, type ClaimRecord } from "audit-tools/shared";
import type { AuditResult, AuditTask } from "../types.js";
import type { WorkerTask } from "../types/workerSession.js";
import { validateAuditResults, defaultFindingLensFromResult, emitCoverageLineCountFriction } from "../validation/auditResults.js";
import { verifyFindingGrounding } from "../validation/quoteGrounding.js";
import {
  ANCHOR_GROUNDING_CONCURRENCY,
  anchorEvidenceLine,
  combineGroundingWithAnchor,
  verifyFindingAnchor,
} from "../validation/anchorGrounding.js";
import { runAuditStep } from "./auditStep.js";
import {
  type ActiveDispatchState,
  DISPATCH_RESULT_MAP_FILENAME,
  ACTIVE_DISPATCH_FILENAME,
  AUDIT_TASK_CLAIM_LEASE_MS,
  loadDispatchResultMap,
  entriesByTaskId,
  buildPendingAuditTasks,
} from "./dispatch.js";
import { addFileLineCountHints } from "./lineIndex.js";
import { artifactNameForId, isCanonicalResultFilename, getArtifactsDir, getFlag } from "./args.js";
import { buildWorkerResult } from "./workerResult.js";
import { PACKET_SCHEMA_FILENAMES } from "../io/runArtifacts.js";
import { readOwnerTokens } from "./ownerTokens.js";
import { readAttemptedPackets } from "./dispatchAttempted.js";
import { recordHostTokenUsageObservation } from "./dispatch/tokenUsageObservation.js";

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
 * `preferredResultPaths` — canonical inline-result files derived from the
 * dispatch plan's packet_ids. When a task_id appears in BOTH a preferred file
 * and an incidental packet file, the preferred file wins regardless of
 * alphabetical sort order. This prevents a packet that incidentally covers a
 * task_id from shadowing the authoritative result for that task.
 *
 * Returns both the fallback map and the list of spurious filenames.
 */
async function scanTaskResults(
  taskResultsDir: string,
  expectedPaths: Set<string>,
  preferredResultPaths: Set<string>,
): Promise<{ fallbackByTaskId: Map<string, unknown>; spuriousFiles: string[] }> {
  let files: string[];
  try {
    files = (await readdir(taskResultsDir)).filter(f => f.endsWith(".json")).sort();
  } catch {
    files = [];
  }

  // Two-pass scan: preferred files (derived from this round's packet_ids) first,
  // then all other non-expected files. A task_id claimed by a preferred file is
  // never overwritten by an incidental file from a different packet.
  const fallbackByTaskId = new Map<string, unknown>();
  const spuriousFiles: string[] = [];

  const addCandidates = (raw: string, overwrite: boolean) => {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return; }
    const candidates: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
    for (const item of candidates) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const tid = typeof (item as Record<string, unknown>).task_id === "string"
        ? String((item as Record<string, unknown>).task_id) : undefined;
      if (tid && (overwrite || !fallbackByTaskId.has(tid))) {
        fallbackByTaskId.set(tid, item);
      }
    }
  };

  for (const pass of [true, false] as const) {
    // pass=true → preferred files; pass=false → incidental files
    for (const filename of files) {
      if (PACKET_SCHEMA_FILENAME_SET.has(filename)) continue;
      const filePath = resolve(join(taskResultsDir, filename));
      if (expectedPaths.has(filePath)) continue;
      const isPreferred = preferredResultPaths.has(filePath);
      if (isPreferred !== pass) continue;

      try {
        const raw = await readFile(filePath, "utf8");
        // Both passes use overwrite=false: preferred files insert first so
        // incidental files cannot claim the same task_id; within each pass,
        // first alphabetical match wins.
        addCandidates(raw, false);
      } catch { /* not parseable — skip */ }

      // Only genuinely stray files are "spurious". Canonical per-task result files
      // (<stem>_<digest>.json) left by prior deepening rounds in the same
      // task-results/ dir are legitimate and must not inflate the count or bury
      // the real stray-file signal (3 -> 191 over a run before this fix).
      if (!isCanonicalResultFilename(filename)) {
        spuriousFiles.push(filename);
      }
    }
  }

  return { fallbackByTaskId, spuriousFiles };
}

/**
 * Validate each pending task's result, classifying into passing/failing/notDispatched.
 * Reads results from the result-map paths or falls back to the task_id lookup table
 * for tasks recovered from non-canonical files.
 */
/**
 * Build, per dispatched packet_id, the list of member task_ids assigned to it
 * (excluding the synthetic `__prior_dispatch__` sentinel, which is not a real
 * packet). Used to rebind a worker result mistakenly keyed under the packet_id
 * onto its sole OUTSTANDING member.
 */
export function packetMembersByPacketId(
  entries: Array<{ task_id: string; packet_id: string }>,
): Map<string, string[]> {
  const byPacket = new Map<string, string[]>();
  for (const entry of entries) {
    if (entry.packet_id === "__prior_dispatch__") continue;
    const members = byPacket.get(entry.packet_id) ?? [];
    members.push(entry.task_id);
    byPacket.set(entry.packet_id, members);
  }
  return byPacket;
}

/** A terminal task excluded from ingest by the ownership gate (`partitionByOwnership`). */
export interface UnownedTask {
  task_id: string;
  reason: string;
}

/**
 * OD3 merge-time ownership gate (D-66/67 slice-1, Part A). Splits a terminal
 * (passing or failing) result set into `owned` (proceeds to ingest/claim-clear
 * as today) and `unowned` (excluded — a LIVE peer claim under a DIFFERENT
 * token was observed for a task whose token WE persisted at dispatch time).
 *
 * A task with NO persisted token (`ownerTokens[task_id] === undefined` —
 * recovery paths, results recovered from disk, pre-slice manifests) fails
 * OPEN: it is treated as owned, exactly the pre-gate behavior.
 *
 * Deliberately checks `listLiveClaims()` rather than `heartbeat(task_id,
 * token)`: an ABSENT-OR-STALE claim is NOT treated as peer possession, only a
 * LIVE claim held under a DIFFERENT token is. `heartbeat` collapses
 * "unclaimed" and "claimed by someone else" into the same `false` — but
 * "unclaimed" is exactly what a terminal task looks like the round AFTER we
 * ourselves ingested it and cleared its claim (the merge-complete self-heal
 * path re-lists an already-answered task_id as pending with its ORIGINAL
 * round's now-orphaned sidecar token still on record). And a STALE
 * different-token claim is an abandoned one — the next `claim()` would grant
 * over it — so treating it as a live peer would drop OUR valid result for a
 * crashed peer's ghost (e.g. A crashes past the lease, B reclaims then also
 * crashes past the lease, A resurrects and merges: A's result is still the
 * only live work). Only a claim actively held (non-stale, per the SAME
 * 20-min task lease the dispatch side claims under) beneath a token that is
 * NOT ours is unambiguous evidence of a peer's reclaim.
 *
 * Takes the live-claim map rather than the registry so ONE snapshot serves
 * every claim-lifecycle decision in a merge (this gate and the in-flight
 * deferral below). Two reads could observe a peer reclaim landing between them
 * and partition the same round inconsistently.
 */
export function partitionByOwnership<T extends { task_id: string }>(
  items: readonly T[],
  ownerTokens: Readonly<Record<string, string>>,
  claims: Readonly<Record<string, ClaimRecord>>,
): { owned: T[]; unowned: UnownedTask[] } {
  const owned: T[] = [];
  const unowned: UnownedTask[] = [];
  for (const item of items) {
    const token = ownerTokens[item.task_id];
    if (token === undefined) {
      owned.push(item);
      continue;
    }
    const current = claims[item.task_id];
    if (current === undefined || current.ownerToken === token) {
      owned.push(item);
    } else {
      unowned.push({
        task_id: item.task_id,
        reason: "claim lease reclaimed by a peer since dispatch",
      });
    }
  }
  return { owned, unowned };
}

/**
 * A dispatched task that did not reach `passing` this round.
 *
 * `kind` is the discriminator the in-flight deferral below turns on, and it is
 * carried explicitly rather than sniffed from the error text: `"invalid"` means
 * a result ARRIVED and failed parse/contract validation (a real, terminal
 * failure), while `"missing"` means no result file exists yet for a task we
 * dispatched — which is a failure only if nobody is still working on it.
 */
export interface FailingTask {
  task_id: string;
  errors: string[];
  kind: "missing" | "invalid";
}

/**
 * Split the `missing` failures into work that was never attempted this round
 * (`deferred`) and work that was attempted and produced nothing (`failing`) —
 * the partial-wave fix (2026-07-23).
 *
 * The exit-code lie came from a mismatch between two sets that look alike on
 * disk. `prepareDispatchArtifacts` writes the dispatch result-map for the WHOLE
 * packetized plan, but admission then grants only an affordable prefix and the
 * host is told to dispatch EXACTLY the granted set. Every non-granted task
 * therefore carries a result-map entry — the marker `validateAndCollectResults`
 * reads as "dispatched" — while nobody was ever asked to run it. In the live
 * 2026-07-21 run that was 3 packets granted against 430 tasks planned: the merge
 * ingested the 3 real results, called the other 427 "missing", exited 2, and on
 * the immediate re-run threw "All 430 assigned task result(s) were missing or
 * invalid" (exit 1) — a successful partial wave presented as total failure.
 *
 * `attemptedPacketIds` is the authority for "was this actually handed to a
 * worker this round", written by whichever side dispatched (see
 * `recordAttemptedPackets`). A missing result for a packet nobody attempted is
 * deferred work; a missing result for a packet that WAS attempted is a genuine
 * failure and stays one.
 *
 * A `null` attempted set means the dispatching side recorded nothing, so there
 * is no evidence either way — defer nothing and preserve the pre-fix
 * classification rather than silently swallowing failures.
 *
 * `"invalid"` never defers: a result that ARRIVED and failed validation is
 * terminal no matter who dispatched it.
 */
export function partitionUnattemptedMissing(
  failingTasks: readonly FailingTask[],
  packetIdByTaskId: ReadonlyMap<string, string>,
  attemptedPacketIds: ReadonlySet<string> | null,
): { failing: FailingTask[]; deferred: string[] } {
  if (attemptedPacketIds === null) return { failing: [...failingTasks], deferred: [] };
  const failing: FailingTask[] = [];
  const deferred: string[] = [];
  for (const item of failingTasks) {
    const packetId = packetIdByTaskId.get(item.task_id);
    if (item.kind === "missing" && packetId !== undefined && !attemptedPacketIds.has(packetId)) {
      deferred.push(item.task_id);
    } else {
      failing.push(item);
    }
  }
  return { failing, deferred };
}


export async function validateAndCollectResults(
  allTasks: AuditTask[],
  entryByTaskId: Map<string, { result_path: string; task_id: string; packet_id: string }>,
  fallbackByTaskId: Map<string, unknown>,
  packetMembers: Map<string, string[]>,
  frictionContext?: { runId: string; artifactsDir: string },
): Promise<{
  passing: AuditResult[];
  failing: FailingTask[];
  notDispatched: string[];
  recoveredCount: number;
}> {
  const passing: AuditResult[] = [];
  const failing: FailingTask[] = [];
  // Pending tasks that were NOT dispatched this round. Not failures — they
  // re-enter dispatch on the next round.
  const notDispatched: string[] = [];
  const seenTaskIds = new Set<string>();
  // Results recovered by task_id from packet result files. The host writes one
  // array file per packet, so this is the normal collection path, not an error.
  let recoveredCount = 0;

  // OUTSTANDING (still-pending) members keyed by their dispatched packet_id.
  // A multi-member packet that was partially answered then re-queued keeps only
  // its still-pending members here, so a result keyed under the packet_id is
  // rebound to the SOLE outstanding member (never to an already-answered one,
  // and never when >1 member is still outstanding — that would be ambiguous).
  const outstandingIds = new Set(allTasks.map((t) => t.task_id));
  const outstandingMembersByPacketId = new Map<string, string[]>();
  for (const [packetId, members] of packetMembers) {
    const stillOutstanding = members.filter((id) => outstandingIds.has(id));
    if (stillOutstanding.length > 0) {
      outstandingMembersByPacketId.set(packetId, stillOutstanding);
    }
  }

  /**
   * A worker that keyed its result under the synthetic packet_id (not the
   * assigned member task_id — the deepening non-convergence leak) leaves the
   * member's own result missing. Recover it by binding the packet-id-keyed
   * result to the packet's SOLE outstanding member, then rewrite its task_id to
   * the member id so the identity gates pass. Returns the rebound object or null.
   */
  function rebindPacketIdKeyedResult(member: AuditTask): unknown {
    const entry = entryByTaskId.get(member.task_id);
    const packetId = entry?.packet_id;
    if (!packetId || packetId === "__prior_dispatch__") return null;
    const stillOutstanding = outstandingMembersByPacketId.get(packetId) ?? [];
    if (stillOutstanding.length !== 1 || stillOutstanding[0] !== member.task_id) {
      return null; // ambiguous (≠1 outstanding member) — never guess.
    }
    const keyed = fallbackByTaskId.get(packetId);
    if (!keyed || typeof keyed !== "object" || Array.isArray(keyed)) return null;
    // The worker stamped EVERY identity field from the packet (task_id, unit_id,
    // pass_id, lens), not just task_id — so rebinding only task_id leaves the
    // pass_id/unit_id/lens mismatching the member and the result still rejects.
    // Identity is the tool's authority (not the worker's), so force all four from
    // the assigned member's metadata. The findings/coverage payload is untouched.
    return {
      ...(keyed as Record<string, unknown>),
      task_id: member.task_id,
      unit_id: member.unit_id,
      pass_id: member.pass_id,
      lens: member.lens,
    };
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
          const fallback = fallbackByTaskId.get(task.task_id) ?? rebindPacketIdKeyedResult(task);
          if (fallback) {
            recoveredCount++;
            obj = fallback;
          } else {
            failing.push({
              task_id: task.task_id,
              errors: ["Missing audit result for assigned task."],
              kind: "missing",
            });
            continue;
          }
        } else {
          failing.push({
            task_id: task.task_id,
            errors: [`Invalid JSON: ${(e as Error).message}`],
            kind: "invalid",
          });
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
      const fallback = fallbackByTaskId.get(task.task_id) ?? rebindPacketIdKeyedResult(task);
      if (!fallback) {
        notDispatched.push(task.task_id);
        continue;
      }
      recoveredCount++;
      obj = fallback;
    }

    // Force-default findings[].lens from the AuditResult lens before validation
    // (weaker/deepening workers set only the top-level lens; the validator
    // requires a non-empty per-finding lens). Mutates the recovered object.
    defaultFindingLensFromResult([obj]);
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
    // Lens backfill: if AuditResult.lens is a non-empty string, propagate it to
    // any finding where lens is absent or empty. This repairs auditor output that
    // correctly sets the top-level lens but omits it on individual findings — which
    // would otherwise trigger REQUIRED_FINDING_FIELDS validation errors. If
    // AuditResult.lens is itself absent/empty, pass through so validation rejects it.
    if (record && typeof record.lens === "string" && record.lens.trim() !== "" &&
        Array.isArray(record.findings)) {
      for (const finding of record.findings) {
        if (finding && typeof finding === "object" && !Array.isArray(finding)) {
          const f = finding as Record<string, unknown>;
          if (typeof f.lens !== "string" || f.lens.trim() === "") {
            f.lens = record.lens;
          }
        }
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
    // Surface the deliberately-downgraded total_lines!=actual mismatch as
    // step-boundary friction at the ingest locus (the validator stays pure and
    // only RETURNS the 'warning'; it never emits). The warning does not gate
    // ingest — route it through the single shared chokepoint so the policy
    // matches the worker-run locus exactly and cannot drift.
    if (frictionContext) {
      await emitCoverageLineCountFriction(
        frictionContext.artifactsDir,
        frictionContext.runId,
        issues,
      );
    }
    if (resultErrors.length === 0) {
      passing.push(obj as AuditResult);
    } else {
      // A result ARRIVED (from disk or a recovery fallback) and failed
      // validation — terminal regardless of claim state.
      failing.push({ task_id: taskId ?? task.task_id, errors: resultErrors, kind: "invalid" });
    }
  }

  return { passing, failing, notDispatched, recoveredCount };
}

/**
 * Grounding pass (S7): re-verify each finding against disk before it is admitted
 * as fact. Tier-1 (quote-and-verify) re-reads the cited verbatim span and
 * content-matches it; tier-2 (executable anchor) runs the finding's read-only
 * behavior-check command. The combined verdict annotates `finding.grounding`: a
 * finding that does not re-verify is `ungrounded` (surfaced, not confirmed), and
 * one a tool-anchor actively DISPROVED is `refuted` (a distinct status that
 * synthesis quarantines-EXCLUDES from the admitted contract — B4). Neither is
 * silently dropped here nor silently admitted as confirmed. The confirmed bit is always the tool's
 * re-check, never the model's word. Advisory metadata: this does not fail a
 * result, so a weaker auditor's confident-but-fake finding is flagged for review
 * rather than merged as fact. Mutates the findings in place and returns the
 * ungrounded references.
 */
export async function groundPassingFindings(
  repoRoot: string,
  passing: AuditResult[],
): Promise<Array<{ task_id: string; finding_id: string; path: string }>> {
  // Flatten to a stable-ordered work list (one entry per finding, carrying its
  // owning result for the task_id).
  const work: Array<{ result: AuditResult; finding: AuditResult["findings"][number] }> = [];
  for (const result of passing) {
    for (const finding of result.findings) {
      work.push({ result, finding });
    }
  }

  // Ground each finding under a bounded concurrency pool: tier-2 anchors spawn
  // child processes, so a serial pass costs the SUM of their runtimes (noticeably
  // slow with many anchored findings); the pool turns that into ~N/cap batches.
  // Each unit mutates only its own finding (no shared state), and
  // mapWithConcurrency preserves input order, so the ungrounded list is
  // deterministic regardless of which command finished first.
  const perFinding = await mapWithConcurrency(
    work,
    ANCHOR_GROUNDING_CONCURRENCY,
    async ({ result, finding }) => {
      const tier1 = await verifyFindingGrounding(repoRoot, finding);
      const anchor = await verifyFindingAnchor(repoRoot, finding);
      // Record the run (confirmed/refuted/inconclusive) as evidence; a skipped
      // anchor (off-allowlist / disabled) was not run, so add no noise.
      if (anchor && anchor.status !== "skipped") {
        finding.evidence = [
          ...new Set([...(finding.evidence ?? []), anchorEvidenceLine(anchor)]),
        ];
      }
      finding.grounding = combineGroundingWithAnchor(tier1, anchor);
      return finding.grounding.status === "ungrounded"
        ? {
            task_id: result.task_id,
            finding_id: finding.id,
            path: finding.affected_files?.[0]?.path ?? "?",
          }
        : null;
    },
  );
  return perFinding.filter(
    (entry): entry is { task_id: string; finding_id: string; path: string } =>
      entry !== null,
  );
}

/** Outcome of an in-process merge-and-ingest, mirroring the CLI's stdout payload. */
export interface MergeAndIngestResult {
  /** The summary object the CLI prints as its sole stdout JSON payload. */
  summary: Record<string, unknown>;
  /** True when at least one dispatched task result was missing or invalid. */
  has_failures: boolean;
}

/**
 * Ingest a dispatched run's per-packet AuditResult files into the cumulative
 * audit store. The callable core of `cmdMergeAndIngest` (the CLI is a thin argv →
 * call → stdout/exit-code wrapper). The in-process audit rolling driver
 * (A8(a) `driveRollingAuditDispatch`) calls this directly once it has driven every
 * packet through the configured provider, the symmetric counterpart of remediate's
 * callable `mergeImplementResults`. Resolves with the summary payload + a failure
 * flag; never writes stdout or mutates `process.exitCode` itself.
 */
export async function mergeAndIngest(params: {
  runId: string;
  artifactsDir: string;
}): Promise<MergeAndIngestResult> {
  const { runId, artifactsDir } = params;

  const runDir = join(artifactsDir, "runs", runId);
  const taskResultsDir = join(runDir, "task-results");
  const auditResultsPath = join(runDir, "run-results.json");
  const taskPath = join(runDir, "task.json");
  const tasksPath = join(runDir, "pending-audit-tasks.json");
  const mergeCompletePath = join(runDir, "merge-complete.json");

  // Reconcile the grant's reservation-ledger leases now that the host has reported
  // the granted set's results — frees the reserved budget for the next grant.
  await reconcileAdmissionLeasesFromQuotaFile(join(runDir, "dispatch-quota.json"));

  // Phase 1: idempotency — replay a completed run or discard a stale marker.
  const priorSummary = await checkIdempotencyReplay(runId, mergeCompletePath, tasksPath, taskResultsDir);
  if (priorSummary) {
    return {
      summary: { ...priorSummary, idempotent_replay: true },
      has_failures: false,
    };
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
  // Canonical inline-result paths derived from each packet's packet_id. A host
  // that writes an AuditResult[] array to the packet inline-result file instead
  // of the per-task file lands here; these are authoritative for their packet's
  // tasks and must win over incidental same-task_id mentions in other files.
  const preferredResultPaths = new Set(
    [...new Set(resultMap.entries.map(e => e.packet_id))]
      .map(packetId => resolve(join(taskResultsDir, artifactNameForId(packetId, "inline-result.json")))),
  );

  // Phase 2: scan task-results/ to build the fallback-by-task_id recovery table.
  const { fallbackByTaskId, spuriousFiles } = await scanTaskResults(taskResultsDir, expectedPaths, preferredResultPaths);

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
  const { passing: allPassing, failing: allFailing, notDispatched, recoveredCount } = await validateAndCollectResults(
    allTasks,
    entryByTaskId,
    fallbackByTaskId,
    packetMembersByPacketId(resultMap.entries),
    { runId, artifactsDir },
  );
  if (recoveredCount > 0) {
    process.stderr.write(
      `[merge-and-ingest] Recovered ${recoveredCount} result(s) by task_id from packet result files.\n`,
    );
  }

  // Phase 3-gate: OD3 merge-time ownership gate (D-66/67 slice-1, Part A). A
  // terminal task (passing or failing) whose claim is LIVE under a peer's
  // token since OUR dispatch persisted ours must not be ingested or have its
  // claim cleared below — it is the peer's now. Runs BEFORE
  // grounding/duplicate-warn/ingest so excluded results never reach any of
  // that downstream work. See `partitionByOwnership` for the fail-open (no
  // persisted token, or claim absent-or-stale) rule. The registry MUST carry
  // the same 20-min task lease the dispatch side claims under — the default
  // 30s window would judge liveness against the wrong horizon.
  const ownerTokens = await readOwnerTokens(runDir);
  const claimRegistry = new ClaimRegistry(taskClaimsPath(artifactsDir), undefined, AUDIT_TASK_CLAIM_LEASE_MS);
  // ONE claim snapshot for every claim-lifecycle decision below (ownership gate +
  // in-flight deferral). Read lazily, preserving the pre-gate behavior that a
  // round with no persisted owner tokens never consults the registry at all.
  const anyTokenPersisted = [...allPassing, ...allFailing].some(
    (item) => ownerTokens[item.task_id] !== undefined,
  );
  const liveClaims = anyTokenPersisted ? await claimRegistry.listLiveClaims() : {};
  const passingOwnership = partitionByOwnership(allPassing, ownerTokens, liveClaims);
  const failingOwnership = partitionByOwnership(allFailing, ownerTokens, liveClaims);
  const passing = passingOwnership.owned;
  // Partial-wave deferral: of the failures we own, the ones whose packet was
  // never attempted this round (admission granted a prefix; the rest are planned,
  // not dispatched) are deferred work, not failures. They keep their claims, keep
  // the run "partial", and exit 0.
  const { failing, deferred } = partitionUnattemptedMissing(
    failingOwnership.owned,
    new Map([...entryByTaskId].map(([taskId, entry]) => [taskId, entry.packet_id])),
    await readAttemptedPackets(runDir),
  );
  const unowned = [...passingOwnership.unowned, ...failingOwnership.unowned].sort(
    (a, b) => a.task_id.localeCompare(b.task_id),
  );
  if (deferred.length > 0) {
    process.stderr.write(
      `[merge-and-ingest] ${deferred.length} planned task(s) were not dispatched this round ` +
        `(their packet was not in the attempted set) — deferred to a later round, not failures: ` +
        `${deferred.join(", ")}\n`,
    );
  }
  const unownedTasksPath = join(runDir, "unowned-tasks.json");
  if (unowned.length > 0) {
    await writeJsonFile(unownedTasksPath, unowned);
    process.stderr.write(
      `[merge-and-ingest] Warning: ${unowned.length} task(s) excluded from ingest — claim ` +
        `reclaimed by a peer since dispatch: ${unowned.map((u) => u.task_id).join(", ")}\n`,
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

  // Phase 4.5 (Slice B, KEYSTONE, backlog 2026-07-11 "Host pools calibrate
  // FOREVER"): fold this wave's host-reported token_usage into the host pool's
  // learned tokens_per_pct slope, so admission can graduate off the cold-start
  // calibration batch and size grants against real headroom. Best-effort and
  // fully independent of ingestion outcome — never gates or fails the merge.
  try {
    const observation = await recordHostTokenUsageObservation({ runDir, passing });
    if (observation.recorded) {
      process.stderr.write(
        `[merge-and-ingest] Recorded ${observation.tokens} token(s) of usage against pool ` +
          `'${observation.poolId}' (tokens_per_pct slope updated).\n`,
      );
    } else if (observation.reason === "implausible_token_sum") {
      // C4: never fold a sum this far outside plausibility — surface it loudly
      // so an operator can spot a host tool stamping cumulative totals instead
      // of per-dispatch usage, rather than silently dropping the sample.
      process.stderr.write(
        `[merge-and-ingest] Warning: rejected implausible host token_usage sum ` +
          `(${observation.tokens} tokens against pool '${observation.poolId}') — ` +
          `grossly exceeds the pool's per-dispatch context window × result count. ` +
          `Not folded into tokens_per_pct. Check whether the host is stamping a ` +
          `cumulative session total instead of per-dispatch usage.\n`,
      );
    } else if (observation.reason === "probe_timeout") {
      process.stderr.write(
        `[merge-and-ingest] Warning: host token-usage post-wave quota probe timed out ` +
          `(pool '${observation.poolId}') — skipped, non-fatal.\n`,
      );
    }
  } catch (error) {
    process.stderr.write(
      `[merge-and-ingest] Warning: host token-usage quota recording failed (non-fatal): ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
  }

  // FND-OBS-48c05a13 (+ 2026-07-11 dogfooding): log notDispatched task IDs early
  // (before ingestion) so operators can trace them and re-enter dispatch next
  // round, even if ingestion later throws. Report the REAL hold reason from the
  // persisted admission `explains` (per packet, already in dispatch-quota.json)
  // instead of a blanket "(budget-capped)" — that mislabel sent a live
  // investigation toward a nonexistent budget coupling when the true cause was a
  // planning deferral. Tasks with NO admission explain were never submitted to
  // admission (top-K / peer-claim / pool-split deferral), NOT quota-capped.
  if (notDispatched.length > 0) {
    let reasonSuffix = " (re-enter dispatch next round)";
    try {
      const dq = await readJsonFile<{
        admission?: { explains?: Array<{ reason?: string; admitted?: boolean }> };
      }>(join(runDir, "dispatch-quota.json"));
      const blocked = (dq.admission?.explains ?? []).filter((e) => e.admitted === false);
      if (blocked.length > 0) {
        const byReason = new Map<string, number>();
        for (const e of blocked) {
          const r = e.reason ?? "unknown";
          byReason.set(r, (byReason.get(r) ?? 0) + 1);
        }
        const summary = [...byReason.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([r, n]) => `${n} ${r}`)
          .join(", ");
        reasonSuffix =
          ` — admission blocked ${blocked.length} packet(s) this round (${summary}); any task` +
          ` absent from the admission set was deferred by planning (top-K / peer-claim / pool-split), not quota-capped`;
      }
    } catch {
      // No dispatch-quota.json (e.g. a host-only round) → no admission decision to
      // attribute; do not assert a quota reason.
    }
    process.stderr.write(
      `[merge-and-ingest] ${notDispatched.length} task(s) not dispatched this round${reasonSuffix}: ${notDispatched.join(", ")}\n`,
    );
  }

  // Cooperative multi-agent (slice 2): release the task claims for every task
  // that reached a TERMINAL outcome this round. The two halves are released
  // SEPARATELY because they become terminal at different moments.
  //
  // `failing` is terminal the instant it is classified: it will be
  // re-dispatched, and nothing downstream can change that. So its claim is
  // freed HERE, before anything else can throw — that is FLW-COR-003, the HOST
  // half. Merge is the only claim release for the two host claimers
  // (`cmdPrepareDispatch`, `renderSemanticReviewStep`); the rolling driver
  // sweeps itself and they cannot, because the lease must span their
  // out-of-process workers (see AUDIT_TASK_CLAIM_LEASE_MS in dispatch.ts). That
  // release used to sit AFTER the blocked-no-op throw below, so a round whose
  // workers all died held its claims for the whole lease while every
  // interleaved next-step — each a NEW runId — saw the tasks peer-claimed,
  // planned nothing, and spun the drain to maxTransitions. Releasing at
  // classification makes that hold unreachable from EVERY later exit, not only
  // the one throw that was observed live (the failed-tasks write, grounding,
  // `runAuditStep`, the line-count hints and the pending-task write can each
  // throw too).
  //
  // `passing` is terminal only once its results are ingested AND the pending
  // set has been rewritten without them; it is released after that, below.
  // Freeing it here would let a peer re-run tasks whose results are on disk but
  // not yet ingested.
  //
  // `notDispatched` (budget-capped) is deliberately left claimed/unclaimed
  // as-is: it may be a live peer's in-flight work, never ours to clear here.
  // `deferred` is likewise absent from both sets BY CONSTRUCTION
  // (`partitionUnattemptedMissing` lifted it out of `failing`): a task nobody
  // attempted has reached no outcome at all, so marking it terminal — and
  // writing it into retry-dispatch — asserted a failure that never happened.
  // Cleared unconditionally (no token) since a terminal result is
  // authoritative. `passing`/`failing` are already the OWNERSHIP-GATED (owned +
  // tokenless) sets — an `unowned` task's claim is deliberately excluded: it is
  // the peer's claim now, not ours to clear (Part A, D-66/67 slice-1).
  if (failing.length > 0) {
    await claimRegistry.clear(failing.map((f) => f.task_id));
  }

  const failedTasksPath = join(runDir, "failed-tasks.json");
  if (failing.length > 0) {
    await writeJsonFile(failedTasksPath, failing);
  }

  if (passing.length === 0 && failing.length > 0 && deferred.length === 0) {
    // Nothing merged, at least one failure, and NOTHING still in flight: a
    // blocked no-op. Do NOT write the transient results file here — truncating
    // it to [] reads as catastrophic data loss on a re-run when the cumulative
    // audit_results.jsonl store is in fact intact and the first merge had simply
    // already succeeded.
    //
    // `deferred.length === 0` is load-bearing: with work still claimed and in
    // flight this round is progressing, not blocked, and throwing here is the
    // exit-1 half of the partial-wave lie (the straggler merge that follows
    // would have landed those results).
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

  // `passing` is terminal only now: its results are ingested and the pending set
  // has been rewritten without them (see the split-release note above).
  if (passing.length > 0) {
    await claimRegistry.clear(passing.map((r) => r.task_id));
  }

  const activeDispatchPath = join(artifactsDir, ACTIVE_DISPATCH_FILENAME);
  try {
    const dispatch = await readJsonFile<ActiveDispatchState>(activeDispatchPath);
    if (dispatch.run_id === runId) {
      // "merged" only when this round is fully drained: every dispatched task
      // accepted AND nothing held back (budget-capped notDispatched > 0,
      // still-in-flight deferred > 0, or peer-reclaimed unowned > 0, stay
      // "active" — a follow-up round on the same run-id still has to merge the
      // rest).
      dispatch.status =
        failing.length > 0 || notDispatched.length > 0 || unowned.length > 0 ||
        deferred.length > 0
          ? "active"
          : "merged";
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
  // failures (failing), tasks held back this round (notDispatched), tasks still
  // in flight under our own live claim (deferred), or tasks a peer reclaimed
  // since our dispatch (unowned). The exit code below distinguishes the two:
  // only genuine failures exit non-zero, so a budget-capped, ownership-gated or
  // partial-wave round reports status "partial" but exits 0 (progressing, not
  // an error).
  const status = failing.length > 0 || notDispatched.length > 0 || unowned.length > 0 ||
    deferred.length > 0
    ? "partial"
    : (result?.progress_made ? "completed" : "no_progress");
  // WorkerResultStatus does not have "partial"; use "blocked" when tasks failed
  // (or were reclaimed by a peer) but progress was also made (passing.length >
  // 0), else "no_progress" for all failures (COR-48c05a13: was always
  // "no_progress" even when passing.length > 0 and result.progress_made is true).
  const workerResultStatus: import("../types/workerResult.js").WorkerResultStatus =
    failing.length === 0 && unowned.length === 0
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
    deferred_count: deferred.length,
    unowned_count: unowned.length,
    spurious_file_count: spuriousFiles.length,
    finding_count: findingCount,
    audit_results_path: auditResultsPath,
    ...(retryDispatchPath ? { retry_dispatch_path: retryDispatchPath } : {}),
    ...(unowned.length > 0 ? { unowned_tasks_path: unownedTasksPath } : {}),
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
  // failures stay replayable for retry, budget-capped rounds (notDispatched > 0),
  // partial waves with work still in flight (deferred > 0) and ownership-gated
  // rounds (unowned > 0) must NOT be marked complete or a follow-up merge on the
  // same run-id would short-circuit to an idempotent replay and silently drop
  // the straggler (or peer-reclaimed) results.
  //
  // Selective deepening appends new pending tasks to the SAME run-id; this marker
  // can therefore go stale once those tasks are later dispatched and answered. The
  // replay guard at the top detects that (a pending task with an on-disk result)
  // and re-processes, so a premature marker self-heals instead of stranding the
  // deepening answers behind an idempotent replay (the no-progress loop).
  if (
    failing.length === 0 && notDispatched.length === 0 && unowned.length === 0 &&
    deferred.length === 0
  ) {
    await writeJsonFile(mergeCompletePath, summaryPayload);
  }

  return { summary: summaryPayload, has_failures: failing.length > 0 };
}

/**
 * CLI wrapper for `merge-and-ingest`: parse argv, run the callable core, emit the
 * summary as the sole stdout JSON payload, and set the exit code on failure.
 */
export async function cmdMergeAndIngest(argv: string[]): Promise<void> {
  const runId = getFlag(argv, "--run-id");
  if (!runId) throw new Error("merge-and-ingest requires --run-id <run_id>");
  const artifactsDir = getArtifactsDir(argv);

  const { summary, has_failures } = await mergeAndIngest({ runId, artifactsDir });
  console.log(JSON.stringify(summary, null, 2));
  if (has_failures) {
    process.exitCode = 2;
  }
}
