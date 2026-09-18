// sites-pinned: tests/audit/host-handoff.test.ts
// (the steward-lane verification contract: the lane-aware prompt, the one
// optional envelope key, the refusal of that key on a lane whose contract never
// asked for it, the enforcement of every property the prompt states, and the
// task-bindings version bump whose refusal names the remedy)
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import {
  createMemoizedSourceReader,
  appendSubmissionEvent,
  SUBMISSION_LEDGER_EVENT_CONTRACT_VERSION,
  bindingIdentity,
  compareCodeUnits,
  contentSha256,
  firstDuplicateIdentity,
  hasExactKeys,
  hostHandoffResultPath,
  identityFailureDiagnostic,
  isFileMissingError,
  isRecord,
  isSha256,
  LaneDemandSchema,
  parseAllWorkloadItems,
  parseWorkloadEnvelope,
  promptSha256,
  enrichMissingSubmissionIssues,
  readTrailingSubmissionRefusals,
  readJsonFile,
  repoRelativePath,
  requireNonEmptyString,
  resolveContainedPath,
  resolveHostHandoffPaths,
  resultMapIdentity,
  scanBoundSubmission,
  siblingLockPath,
  sameStrings,
  stableStringify,
  verifyFindingGrounding,
  withFileLock,
  writeBlockedStepContract,
  writeJsonFile,
  type IngestionCheckId,
  type LaneDemand,
  type RunLogger,
  type SubmissionScanMessages,
} from "audit-tools/shared";
import { findingContractPromptLines } from "../../contracts/findingContractPrompt.js";
import {
  WORKER_REFUSED_FINDING_VERDICTS,
  WorkerFindingSchema,
  type WorkerFinding,
} from "../../contracts/workerSchemas.js";
import {
  AuditResultSchema,
  AuditTaskSchema,
  type AuditResult,
  type AuditTask,
} from "../../types.js";
import {
  validateOneAuditResult,
  formatAuditResultIssues,
  // THE ONE CONTAINMENT RULE, shared with the batch door: this boundary and
  // `validateVerification` build their allowed set through the same function, so
  // they cannot disagree about which `file_paths` entries are inside the packet.
  verificationAllowedPaths,
  normalizeCoveragePath,
} from "../../validation/auditResults.js";
import type {
  AuditHostIngestIssue,
  AuditIngestIssueCode,
} from "../../validation/ingestIssueCodes.js";
import { reviewWaveClosedPath } from "../../io/runArtifacts.js";
// The lane token itself is single-sourced where the steward lane is minted:
// `LENS_VERIFICATION_TAG` (`orchestrator/selectiveDeepening/shared.ts`). Every
// reader compiles against that one declaration, so a rename moves them together
// rather than leaving two literals that agree only until one is edited — which
// is what a hand-copied literal here produced, twice (this boundary and the
// audit-results validator).
import {
  LENS_VERIFICATION_TAG,
} from "../../orchestrator/selectiveDeepening/shared.js";

// v1alpha2 (the emitted-lane demand ranking): each work item's `metadata`
// carries the shared `demand` ranking (size / complexity / risk) beside its
// token estimate, in place of the retired `{complexity, risk}` pair whose
// `risk` was the task's coarsely bucketed dispatch PRIORITY rather than a
// likelihood×stakes estimate. A v1alpha1 document refuses closed as stale —
// re-prepare. Same one-cut precedent as the remediation twin's v1alpha2
// (`REMEDIATION_HOST_WORKLOAD_CONTRACT_VERSION`, commit ed033294): the shape
// changed, so the version names the shape that is actually on disk.
//
// v1alpha3 (the lens steward's surface): a `"selective"` work item's `scope`
// carries `file_metrics` beside `files` — one entry per surface file, stating
// its line count and the prior signal against it. The metrics ride the WORKLOAD
// and not the prompt on purpose: a steward's surface is the whole set its lens
// was applied to, which can run to hundreds of files, and inlining that in
// prompt prose would make the prompt digest a function of the surface's size
// while telling the host nothing it could act on. A v1alpha2 document refuses
// closed as stale — the same `next-step` re-prepares it.
const WORKLOAD_CONTRACT_VERSION = "audit-host-workload/v1alpha3" as const;
const RESULT_MAP_CONTRACT_VERSION = "audit-host-result-map/v1alpha1" as const;
const RESULT_CONTRACT_VERSION = "audit-host-result/v1alpha1" as const;

/**
 * The result envelope's REQUIRED key set. Named rather than inlined because the
 * parse and the refusal message both enumerate it, and the one OPTIONAL key
 * (`verification`) is added to the expected set only when the submission
 * actually carries it — so "exactly these keys, plus at most one optional
 * field" is one statement instead of a second hand-maintained list.
 */
const AUDIT_RESULT_ENVELOPE_KEYS = [
  "contract_version",
  "file_coverage",
  "findings",
  "prompt_sha256",
  "result_id",
  "run_id",
  "work_item_id",
] as const;
/**
 * v1alpha2 adds the per-item `tags` lane stamp. The version moves with the shape
 * because a binding set is READ BACK at ingest, after the pause — a binding
 * written by the previous code carries no `tags`, and the lane gate below reads
 * that field, so under one version string the old set would be refused by a
 * generic parse error on a run the host had already executed.
 *
 * Moving the version (rather than defaulting an absent `tags` to `[]`) makes
 * that case FAIL CLOSED with a message that names what happens next:
 * `parseTaskBindings` throws {@link StaleAuditHostTaskBindingsError}, the ingest
 * returns it as a classified issue, and the fold walks on to re-prepare the
 * whole workload under the current version. Defaulting was
 * the other option and was rejected here because it would silently judge an
 * old-shape item against the BASE per-file lane: that happens to be correct today
 * only because the only lane with a divergent contract is the steward lane, which
 * did not exist when the old binding was written — an argument that decays the
 * moment a second lane diverges, and that would leave a mis-laned item reporting
 * success.
 */
/**
 * v1alpha3 adds the per-item `coverage_policy`.
 *
 * It moves the version for exactly the reason `tags` did, and the reasoning
 * above applies unchanged. THIS gate — the coverage-completeness check in
 * {@link parseHostResult} — is the FIRST of the three that judge a submission's
 * coverage, and it judges from the persisted BINDING rather than from the live
 * task. So a `"selective"` item whose binding carries no policy would be judged
 * as `"complete"`, and the steward's own contract (review what you judge worth
 * reviewing) would be refused at the door by the tool that asked for it.
 * Defaulting an absent policy to `"complete"` is what makes that failure silent,
 * so an absent policy is a stale binding set instead.
 */
const TASK_BINDINGS_CONTRACT_VERSION =
  "audit-host-task-bindings/v1alpha3" as const;

/**
 * The remedy a version mismatch carries. The failure is recoverable, and the
 * recoverable move is not guessable from the shape ("unexpected field" reads as
 * a corrupt file, which invites an operator to hand-edit bindings).
 *
 * It names ONLY what the tool then does, because that is now all there is to do:
 * the fold classifies a stale binding set ({@link StaleAuditHostTaskBindingsError})
 * and continues to `prepareAuditHostHandoff`, which rewrites the whole set under
 * the current version in the SAME `next-step` call that read it. So the host is
 * not asked to do anything, and the sentence must not read as an instruction to
 * re-run anything by hand.
 */
const TASK_BINDINGS_VERSION_REMEDY =
  "the same `next-step` re-prepares the workload under the current contract version " +
  "and rewrites this bindings file; results already accepted are not re-ingested";
const REVIEW_WAVE_CLOSED_CONTRACT_VERSION = "audit-review-wave-closed/v1alpha1";

const ACCEPTED_RESULTS_CONTRACT_VERSION =
  "audit-host-accepted-results/v1alpha1" as const;

export interface AuditHostTask {
  readonly task_id: string;
  readonly unit_id: string;
  readonly pass_id: string;
  readonly lens: string;
  readonly file_paths: readonly string[];
  readonly file_line_counts: Readonly<Record<string, number>>;
  readonly rationale: string;
  readonly priority: string;
  /**
   * The task's lane tags, carried so the boundary can tell WHICH CONTRACT this
   * work item is judged against. The steward lane (`lens_verification`) is the
   * only one whose contract asks for `verification` metadata — see
   * {@link buildPrompt} — and without the tag the boundary cannot know that, so
   * the ask was rendered for no item and the envelope admitted it for none.
   * Optional: an untagged task is the base per-file lane.
   */
  readonly tags?: readonly string[];
  /**
   * The lane's demand ranking (size / complexity / risk) — the host-facing
   * statement of what this lane asks for, naming DEMAND only and never a
   * backend, provider, model or tier (see `LaneDemandSchema`).
   */
  readonly demand: LaneDemand;
  readonly token_estimate: number;
  /**
   * How much of `file_paths` this lane must cover — see `coverage_policy` on
   * `AuditTask`. Absent means `"complete"`, which is the base per-file lane.
   */
  readonly coverage_policy?: AuditTask["coverage_policy"];
  /** Per-surface-file metrics, on a `"selective"` lane only. */
  readonly file_metrics?: readonly LensSurfaceFileMetric[];
}

/** One surface file's metrics, exactly as `AuditTask.file_metrics` declares them. */
type LensSurfaceFileMetric = NonNullable<AuditTask["file_metrics"]>[number];

export interface AuditHostWorkItem {
  readonly id: string;
  readonly lens: string;
  readonly metadata: {
    readonly demand: LaneDemand;
    readonly token_estimate: number;
  };
  readonly prompt: {
    readonly sha256: string;
    readonly text: string;
  };
  readonly scope: {
    readonly files: readonly string[];
    readonly unit_ids: readonly string[];
    /**
     * One entry per file in `files`, ordered by prior signal, strongest first —
     * present on a `"selective"` item only, and absent on the base per-file
     * lane, whose reviewer covers every file and so chooses nothing.
     *
     * This is what makes a whole-surface assignment reviewable. The steward is
     * granted every file its lens was applied to, so it needs each file's size
     * and each file's prior signal to decide what to open, and both belong
     * beside the file list rather than in the prompt: the prompt is digested,
     * and a digest that moves with a 137-entry metric table binds the host to a
     * table it cannot act on from prose anyway.
     */
    readonly file_metrics?: readonly LensSurfaceFileMetric[];
  };
  readonly result_path: string;
}

export interface AuditHostWorkload {
  readonly contract_version: typeof WORKLOAD_CONTRACT_VERSION;
  readonly run_id: string;
  readonly work_items: readonly AuditHostWorkItem[];
}

export interface AuditHostResultMapEntry {
  readonly work_item_id: string;
  readonly prompt_sha256: string;
  readonly result_path: string;
}

export interface AuditHostResultMap {
  readonly contract_version: typeof RESULT_MAP_CONTRACT_VERSION;
  readonly run_id: string;
  readonly entries: readonly AuditHostResultMapEntry[];
}

export interface PreparedAuditHostHandoff {
  readonly workload: AuditHostWorkload;
  readonly result_map: AuditHostResultMap;
  readonly workload_path: string;
  readonly result_map_path: string;
}

/**
 * One ADVISORY validation finding on an ACCEPTED result. Deliberately not a
 * {@link AuditHostIngestIssue}: an accepted result was never refused, so it must
 * never ride (or be recorded through) the rejection-classified channel — see
 * {@link AuditHostIngestSummary.validation_warnings}.
 */
export interface AuditHostValidationWarning {
  readonly work_item_id: string;
  readonly result_path: string;
  readonly message: string;
}

export interface AuditHostIngestSummary {
  readonly accepted_count: number;
  readonly accepted_results: readonly AuditResult[];
  readonly accepted_results_path: string;
  readonly completed_work_item_ids: readonly string[];
  /**
   * Every submission this ingest could not accept, classified.
   *
   * The four ways a submission used to fail — absent file, unparseable bytes, a
   * body that violates the result contract, and a conversion that yields
   * nothing — all collapsed into the same bare `null` and the same silent
   * `continue`. A host that never wrote its result and a host that wrote
   * garbage were indistinguishable to every caller, which is exactly the
   * measured drift P25 exists to make visible.
   */
  readonly issues: readonly AuditHostIngestIssue[];
  /** Raw issue observations for the sole recorder; excluded from host rendering. */
  readonly raw_issues: readonly AuditHostIngestIssue[];
  /**
   * Advisory validation findings on results that WERE accepted — a small
   * coverage-stat divergence, verification metadata on a non-verification
   * task. Never a refusal: they ride this separate channel precisely so the
   * rejection list stays rejections only, and no ledger records an acceptance
   * as one.
   */
  readonly validation_warnings: readonly AuditHostValidationWarning[];
}

interface HostCoverage {
  readonly path: string;
  readonly reviewed_lines: number;
  readonly total_lines: number;
}

interface AuditHostResult {
  readonly contract_version: typeof RESULT_CONTRACT_VERSION;
  readonly result_id: string;
  readonly run_id: string;
  readonly work_item_id: string;
  readonly prompt_sha256: string;
  readonly file_coverage: readonly HostCoverage[];
  /** The findings AS THE STRICT PROJECTION PARSED THEM (see {@link parseFindings}). */
  readonly findings: readonly WorkerFinding[];
  /**
   * Steward-lane verification metadata, ADMITTED for a `lens_verification` work
   * item only (see the lane gate in {@link parseHostResult}). Carried through
   * unvalidated here and validated by the ONE validator the batch door also
   * runs, so the two doors judge the same field by the same rules.
   */
  readonly verification?: unknown;
}

interface AcceptedResultEntry {
  readonly work_item_id: string;
  readonly prompt_sha256: string;
  readonly result_path: string;
  readonly result_id: string;
  readonly result_sha256: string;
  readonly result: AuditHostResult;
  readonly audit_result: AuditResult;
}

interface AcceptedResultsLedger {
  readonly contract_version: typeof ACCEPTED_RESULTS_CONTRACT_VERSION;
  readonly run_id: string;
  readonly entries: readonly AcceptedResultEntry[];
}

interface AuditHostTaskBinding {
  readonly work_item_id: string;
  readonly prompt_sha256: string;
  readonly result_path: string;
  readonly unit_id: string;
  readonly pass_id: string;
  readonly lens: string;
  readonly file_line_counts: Readonly<Record<string, number>>;
  /**
   * The task's lane tags, persisted so the INGEST can tell which contract this
   * item's prompt carried without re-reading and re-parsing that prompt's prose.
   * The lane is what decides whether a submitted `verification` object is an
   * answer to a real ask or an unsolicited field, and that decision has to
   * survive the pause between prepare and ingest.
   *
   * THIS COPY IS THE AUTHORITY. The lane fact also rides `AuditHostTask.tags`,
   * but that copy is an INPUT to prepare — it is written into the workload the
   * host holds and can hand back. The gate reads only this one, which was
   * persisted at prepare time under the prepare-time lock and is re-verified
   * against the workload (`validateHandoffBinding`), so a submission cannot
   * choose its own lane by editing the task it echoes. The two are equal by
   * construction at prepare ({@link prepareAuditHostHandoff} writes this from
   * the task), never by the ingest trusting the live task object.
   */
  readonly tags: readonly string[];
  /**
   * How much of the bound file set the submission must cover. REQUIRED, and
   * persisted for the same reason `tags` is: the FIRST coverage-completeness
   * gate ({@link parseHostResult}) runs at ingest, after the pause, and judges
   * from this binding rather than from the live task. `"complete"` is the base
   * per-file lane; `"selective"` is the lens steward, whose bound file set is
   * the whole surface its lens was applied to.
   */
  readonly coverage_policy: NonNullable<AuditTask["coverage_policy"]>;
}

interface AuditHostTaskBindings {
  readonly contract_version: typeof TASK_BINDINGS_CONTRACT_VERSION;
  readonly run_id: string;
  readonly entries: readonly AuditHostTaskBinding[];
}

interface ResolvedBoundaryPaths {
  readonly root: string;
  readonly runId: string;
  readonly artifactsDir: string;
  readonly runDir: string;
  readonly resultDir: string;
  readonly workloadPath: string;
  readonly resultMapPath: string;
  readonly taskBindingsPath: string;
  readonly acceptedLedgerPath: string;
  readonly acceptedResultsPath: string;
  /**
   * The ONE lock serializing every read-modify-write of the ACCEPTED-RESULTS
   * PAIR. Both writers — prepare and ingest — acquire it before touching the
   * ledger, so the read-merge-write race the ledger used to lose is closed for
   * prepare-against-ingest as well as ingest-against-ingest.
   *
   * IT COVERS THE LEDGER ONLY — state the uncovered half rather than let the
   * covered half read as a close. The rest of the run directory is still
   * unsynchronized in both directions:
   *   - `ingestAuditHostResults` reads `host-workload.json`,
   *     `host-result-map.json` and `host-task-bindings.json` BEFORE taking the
   *     lock, so a concurrent prepare can rewrite any of the three underneath a
   *     ledger merge that already parsed them;
   *   - `prepareAuditHostHandoff` writes `host-task-bindings.json` outside the
   *     lock entirely (only the workload and result-map writes are inside it),
   *     so that file has no writer-side serialization at all.
   * Closing the whole prepare/ingest race — the trio under the same acquisition
   * as the ledger — is tracked as backlog work, not done here.
   */
  readonly acceptedLockPath: string;
}

/**
 * The audit draw's boundary paths: the SHARED resolution (run-id grammar,
 * containment, `runs/<id>`), plus the four files this boundary persists beyond
 * the workload — the result map, the trusted task bindings, and the
 * accepted-results pair with its one serializing lock.
 */
function resolveBoundaryPaths(
  params: Parameters<typeof resolveHostHandoffPaths>[0],
): ResolvedBoundaryPaths {
  const core = resolveHostHandoffPaths({
    ...params,
    runDirSegments: [],
    runIdLabel: "audit host run id",
  });
  return {
    root: core.root,
    runId: params.runId,
    artifactsDir: core.artifactsDir,
    runDir: core.runDir,
    resultDir: core.resultDir,
    workloadPath: core.workloadPath,
    resultMapPath: join(core.runDir, "host-result-map.json"),
    taskBindingsPath: join(core.runDir, "host-task-bindings.json"),
    acceptedLedgerPath: join(core.runDir, "host-accepted-results-ledger.json"),
    acceptedResultsPath: join(core.runDir, "host-accepted-results.json"),
    // Named off the pair's own stem, so the lock is visibly the lock FOR those
    // two files rather than an independently-invented name. It is transient
    // infrastructure, not a run artifact anything cites.
    acceptedLockPath: siblingLockPath(join(core.runDir, "host-accepted-results")),
  };
}

/**
 * The accepted-results read-modify-write, SERIALIZED.
 *
 * `host-accepted-results.json` and its ledger are one logical record written as
 * two files, and both prepare and ingest used to load a snapshot, work from it,
 * and write both files back with a plain atomic replace. Atomic-replace makes
 * the loss SILENT rather than corrupt: the later writer's snapshot simply
 * predates the earlier writer's additions, and every duplicate-binding and
 * duplicate-result_id guard downstream derives from that stale snapshot.
 *
 * So the read, the merge and both writes happen inside ONE acquisition of the
 * shared lock substrate. No backoff, retry or stale-lock logic lives here — all
 * of it is `withFileLock`'s, and the caller's RunLogger is threaded straight
 * through so the primitive's heartbeat and stale-lock-reclaim events land in the
 * run log rather than vanishing.
 */
async function withAcceptedResultsLock<T>(
  paths: ResolvedBoundaryPaths,
  logger: RunLogger | undefined,
  mutate: (current: AcceptedResultsLedger) => Promise<T>,
): Promise<T> {
  return withFileLock(
    paths.acceptedLockPath,
    async () =>
      mutate(
        await loadAcceptedResults(paths.acceptedLedgerPath, paths.runId),
      ),
    undefined,
    logger,
  );
}

/**
 * Persist the accepted-results pair. Only ever called under the lock above.
 *
 * ORDER IS LOAD-BEARING — the LEDGER is written FIRST, the results render
 * second. The strict loader (`loadAcceptedResults`) reads the ledger as truth;
 * a throw between the two writes must therefore be able to leave the render
 * STALE, never AHEAD of it: a render naming an entry the ledger has not yet
 * recorded would re-serve that result on every future ingest (the ledger is
 * what dedupes), while a stale render is simply regenerated by the next
 * successful write of this pair.
 */
async function writeAcceptedResults(
  paths: ResolvedBoundaryPaths,
  ledger: AcceptedResultsLedger,
): Promise<void> {
  await writeJsonFile(paths.acceptedLedgerPath, ledger);
  await writeJsonFile(
    paths.acceptedResultsPath,
    ledger.entries.map((entry) => entry.audit_result),
  );
}

/**
 * The bound path for one work item's submission — the SHARED rule, not a local
 * copy of it. This and the remediate twin were byte-equivalent private helpers;
 * a divergence between them would have been silent on both sides.
 */
function resultPathFor(paths: ResolvedBoundaryPaths, workItemId: string): string {
  // `ResolvedBoundaryPaths` is a superset of the core's `HostHandoffPaths`, so
  // the core shape passes through whole — no re-flattening step that could drop
  // a field the shared rule later starts reading.
  return hostHandoffResultPath(paths, workItemId);
}

function normalizeTask(
  task: AuditHostTask,
  root: string,
): AuditHostTask {
  if (!isRecord(task)) {
    throw new Error("Audit host task must be an object");
  }
  const taskId = requireNonEmptyString(task.task_id, "task_id");
  const unitId = requireNonEmptyString(task.unit_id, `${taskId}.unit_id`);
  const passId = requireNonEmptyString(task.pass_id, `${taskId}.pass_id`);
  const lens = requireNonEmptyString(task.lens, `${taskId}.lens`);
  const rationale = requireNonEmptyString(task.rationale, `${taskId}.rationale`);
  const priority = requireNonEmptyString(task.priority, `${taskId}.priority`);
  // The demand ranking is validated by the SHARED schema, so a draw cannot
  // admit a rank the other draw would refuse — and so the closed vocabulary has
  // exactly one author.
  const demand = LaneDemandSchema.parse(task.demand);
  if (
    !Number.isFinite(task.token_estimate) ||
    task.token_estimate < 0 ||
    !Number.isInteger(task.token_estimate)
  ) {
    throw new Error(`${taskId}.token_estimate must be a non-negative integer`);
  }
  if (!Array.isArray(task.file_paths) || !isRecord(task.file_line_counts)) {
    throw new Error(`${taskId} must declare file paths and line counts`);
  }

  const files = [
    ...new Set(
      task.file_paths.map((path) => {
        const raw = requireNonEmptyString(path, `${taskId}.file_paths[]`);
        const absolute = resolveContainedPath(root, raw, `${taskId} file path`);
        return repoRelativePath(root, absolute, `${taskId} file path`);
      }),
    ),
  ].sort(compareCodeUnits);
  const normalizedLineCounts: Record<string, number> = {};
  for (const [path, count] of Object.entries(task.file_line_counts)) {
    const normalizedPath = repoRelativePath(
      root,
      resolveContainedPath(root, path, `${taskId} line-count path`),
      `${taskId} line-count path`,
    );
    if (!Number.isInteger(count) || count < 0) {
      throw new Error(`${taskId} has an invalid line count for ${path}`);
    }
    if (
      Object.hasOwn(normalizedLineCounts, normalizedPath) &&
      normalizedLineCounts[normalizedPath] !== count
    ) {
      throw new Error(`${taskId} has conflicting line counts for ${normalizedPath}`);
    }
    normalizedLineCounts[normalizedPath] = count;
  }
  for (const file of files) {
    if (!Object.hasOwn(normalizedLineCounts, file)) {
      throw new Error(`${taskId} is missing the line count for ${file}`);
    }
  }

  return {
    task_id: taskId,
    unit_id: unitId,
    pass_id: passId,
    lens,
    file_paths: files,
    file_line_counts: Object.fromEntries(
      Object.entries(normalizedLineCounts).sort(([left], [right]) =>
        compareCodeUnits(left, right),
      ),
    ),
    rationale,
    priority,
    demand,
    token_estimate: task.token_estimate,
    // Sorted and deduplicated so two spellings of the same lane cannot produce
    // two work items that differ only in tag order (the prompt digest is a
    // content hash of this shape, and an incidentally-ordered array is a churn
    // source — see the stable-order rule).
    ...(Array.isArray(task.tags)
      ? { tags: [...new Set(task.tags)].sort(compareCodeUnits) }
      : {}),
  };
}

/**
 * The lane tag whose contract asks for `verification` metadata — the shared
 * {@link LENS_VERIFICATION_TAG}, imported rather than spelled again.
 *
 * WHAT THE IMPORT BUYS, exactly: every reader in this package that gates on the
 * lane compiles against ONE declaration, so a rename of the constant moves all
 * of them together at build time. It buys nothing at RUNTIME — no test catches a
 * rename of the constant's VALUE, because a test can only compare the constant
 * to itself. That is the whole claim, and it is enough: the failure the import
 * removes is the one where two spellings drift apart in a source tree, which is
 * what a hand-copied literal produced here.
 */
function isVerificationLane(tags: readonly string[] | undefined): boolean {
  return tags?.includes(LENS_VERIFICATION_TAG) ?? false;
}

function buildPrompt(
  task: AuditHostTask,
  resultPath: string,
  workloadPath: string,
): string {
  // A `"selective"` lane's file list is NOT inlined. Its assignment is the whole
  // surface its lens was applied to, which runs to hundreds of files on a real
  // run, so inlining it would make the prompt mostly a path list and the prompt
  // DIGEST a function of the surface's size. The list and its per-file metrics
  // ride the workload the tool already writes, and the prompt names where.
  const selective = task.coverage_policy === "selective";
  const assignment = stableStringify({
    ...(selective
      ? { surface_file_count: task.file_paths.length }
      : { file_line_counts: task.file_line_counts, files: task.file_paths }),
    lens: task.lens,
    pass_id: task.pass_id,
    rationale: task.rationale,
    task_id: task.task_id,
    unit_id: task.unit_id,
  });
  // LANE-AWARE, because the two lanes' contracts genuinely differ: the steward
  // lane is INSTRUCTED (by its task rationale) to return verification metadata,
  // and the base lane is not. Rendering one envelope sentence for both would
  // either ask the base lane for a field its ingest discards, or tell the
  // steward lane "exactly" a key set that refuses what its own instruction
  // demands. The ask and the envelope are the same fact, so they are stated
  // from the same predicate.
  const verificationLane = isVerificationLane(task.tags);
  return [
    "Perform the bounded semantic audit work item below.",
    // THE DESTINATION FIRST, on its own line. It used to be one field inside a
    // single long JSON blob, which buries the one fact a reader must not have to
    // search for: a result written anywhere else is never ingested.
    `Write one JSON object to this exact path: ${resultPath}`,
    // LANE-AWARE, because "review every listed file" is true of the base lane
    // and false of a steward under selective coverage — whose whole task is to
    // decide what is worth opening.
    selective
      ? `Your assignment is the whole surface this lens was applied to: ${String(task.file_paths.length)} file(s). ` +
        `The file list is not repeated here. Read it from the work item whose id is '${task.task_id}' in ${workloadPath}: ` +
        "scope.files names every file on the surface, and scope.file_metrics states each file's total_lines, its prior-signal " +
        "score, the signals behind that score, and any findings the base pass already recorded against it — ordered strongest " +
        "signal first. YOU choose which of those files to open; the score is a hint, never a boundary. " +
        "Declare file_coverage for the files you opened, not for the whole surface."
      : "Review every listed file.",
    "Assignment:",
    "```json",
    assignment,
    "```",
    verificationLane
      // `verification` is REQUIRED on this lane, and the prompt states ONE rule.
      // It used to say "exactly … and verification" and then call the field
      // optional, which is a contradiction a reader cannot obey both halves of.
      // Required is the honest reading: a steward returns `findings: []`, so a
      // steward with no `verification` carries no answer at all and is
      // indistinguishable from a lane that failed.
      ? "Result contract: audit-host-result/v1alpha1 with exactly result_id, run_id, work_item_id, prompt_sha256, file_coverage, findings, reviewed_clean, and verification in addition to contract_version. On this lane verification is REQUIRED."
      : "Result contract: audit-host-result/v1alpha1 with exactly result_id, run_id, work_item_id, prompt_sha256, file_coverage, and findings in addition to contract_version, plus reviewed_clean when findings is empty.",
    "Each file_coverage entry must contain exactly path, reviewed_lines, and total_lines.",
    // The finding contract is CARRIED, not referenced: it is rendered from the
    // very schema ingestion enforces, so a host never has to remember or fetch it.
    ...findingContractPromptLines(),
    "Do not supply a `grounding` field on any finding — grounding is computed by the tool at ingest by re-reading your cited quoted_text from disk, and a supplied one rejects the whole submission.",
    ...(verificationLane ? verificationContractPromptLines() : []),
  ].join("\n");
}

/**
 * The `verification` contract rendered into a steward-lane work item's prompt.
 *
 * CARRIED for the same reason the finding contract is: the host cannot comply
 * with a contract it is never shown, and this one is three-deep (booleans, three
 * concern arrays, the selection rationale, and an array of AuditTask-shaped
 * follow-up suggestions whose `file_paths` must lie on the assigned surface).
 * Rendered from the schema ingestion enforces, so the prompt cannot describe a
 * shape the parse refuses.
 */
function verificationContractPromptLines(): readonly string[] {
  return [
    "This work item is a LENS STEWARD VERIFICATION task, so it must also carry a `verification` object.",
    `verification must contain exactly ${VERIFICATION_CONTRACT_KEYS.join(", ")} — all ${String(VERIFICATION_CONTRACT_KEYS.length)}, with no extra key: verified and needs_followup are booleans, concerns, coverage_concerns and confidence_concerns are arrays of non-empty strings (a genuine "nothing to report" is an empty array, not an omitted field), selection_rationale is a non-empty string, and followup_tasks is an array of objects.`,
    "verification.selection_rationale states how you chose which surface files to open and which to leave: name the signals you followed and say what you decided was not worth opening. A file you did not open is not a coverage failure, but an unexplained choice is.",
    `Each verification.followup_tasks entry must contain exactly ${VERIFICATION_FOLLOWUP_KEYS.join(", ")} — all ${String(VERIFICATION_FOLLOWUP_KEYS.length)}, with no extra key: file_paths is a non-empty array of non-empty repo-relative strings, each naming a file on THIS work item's assigned surface (scope.files) — a file you did not open is still on the surface and may be named; lens must be the lens of THIS task; task_id, unit_id, pass_id and rationale must be non-empty strings.`,
    "Set needs_followup true only when followup_tasks is non-empty — a follow-up request with no bounded task is refused.",
  ];
}

/**
 * The steward `verification` object's key set and its follow-up entry's key set,
 * declared ONCE. Three statements read them — the prompt lines, the enforcement,
 * and the refusal they share — because a second hand-maintained copy of a key
 * list is exactly how a prompt and a parser drift apart, which is the defect
 * class {@link verificationContractFailure} exists to close.
 */
const VERIFICATION_CONTRACT_KEYS = [
  "verified",
  "needs_followup",
  "concerns",
  "coverage_concerns",
  "confidence_concerns",
  // The steward chooses which of its surface files to open, so the CHOICE is
  // part of its answer. Without this field the selective policy would accept a
  // one-file coverage over a 300-file surface with nothing to review it by; with
  // it, an adversary can check the stated reason against `scope.file_metrics`.
  "selection_rationale",
  "followup_tasks",
] as const;

const VERIFICATION_FOLLOWUP_KEYS = [
  "task_id",
  "unit_id",
  "pass_id",
  "lens",
  "file_paths",
  "rationale",
] as const;

/** The exact-key-set refusal, shared by the object and its entries. */
function exactKeysFailure(
  label: string,
  present: readonly string[],
  expected: readonly string[],
): string | null {
  const extra = present.filter((key) => !expected.includes(key));
  const missing = expected.filter((key) => !present.includes(key));
  if (extra.length === 0 && missing.length === 0) return null;
  const broken = [
    ...missing.map((key) => `missing ${key}`),
    ...extra.map((key) => `unexpected ${key}`),
  ];
  return `${label} must contain exactly ${expected.join(", ")} (received: ${broken.join(", ")})`;
}

function isNonEmptyStringArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === "string" && entry.length > 0)
  );
}

/**
 * This door's inputs to the ONE containment rule
 * ({@link verificationAllowedPaths}, `src/audit/validation/auditResults.ts`):
 * the binding's file set (the work item's own boundary, persisted at prepare)
 * plus the submitted envelope's coverage paths. No packet boundary here — the
 * host door judges a single work item's own coverage, and the batch door is the
 * one that sees siblings. Both build their set through the shared rule anyway,
 * so a change to how a path is normalized or admitted reaches both.
 */
function verificationAllowedPathsForEnvelope(
  binding: AuditHostTaskBinding,
  envelope: Record<string, unknown>,
): Set<string> {
  return verificationAllowedPaths({
    assignedPaths: Object.keys(binding.file_line_counts),
    coveragePaths: Array.isArray(envelope.file_coverage)
      ? envelope.file_coverage.flatMap((entry) =>
          isRecord(entry) && typeof entry.path === "string" ? [entry.path] : [],
        )
      : [],
  });
}

/**
 * Every property the steward prompt CLAIMS about the `verification` object,
 * enforced at the host-result boundary — a claim the prompt makes and the
 * envelope does not back is the exact failure the project rule bans. Returns
 * the first broken property's refusal detail, or `null` when the object
 * satisfies every stated rule.
 *
 * The rules mirror {@link verificationContractPromptLines} one-for-one:
 * 1. `verification` must contain exactly its declared keys — no extra, no missing.
 * 2. `selection_rationale` must be a non-empty string.
 * 3. `needs_followup` true ⇒ `followup_tasks` present and non-empty.
 * 4. each `followup_tasks` entry must contain exactly its six keys, its
 *    `lens` equal to the task's lens, and each `file_paths` string on the
 *    assigned surface.
 *
 * Reused over the shared `AuditVerificationSchema` deliberately: that schema is
 * NON-STRICT (its arrays are optional, it drops unknown keys) because the
 * follow-up builder tolerates a partial object and the follow-up-task shape
 * (`AuditTaskSchema`) is a superset of what the prompt names. The prompt is the
 * stricter claim, so the stricter check lives HERE, at the door that reads the
 * field, rather than tightening a schema other readers lean on.
 */
function verificationContractFailure(
  verification: unknown,
  binding: AuditHostTaskBinding,
  envelope: Record<string, unknown>,
): string | null {
  if (!isRecord(verification)) {
    return `verification must be an object with exactly ${VERIFICATION_CONTRACT_KEYS.join(", ")}`;
  }
  const keysFailure = exactKeysFailure(
    "verification",
    Object.keys(verification),
    VERIFICATION_CONTRACT_KEYS,
  );
  if (keysFailure !== null) return keysFailure;
  if (typeof verification.verified !== "boolean") {
    return "verification.verified must be a boolean";
  }
  if (typeof verification.needs_followup !== "boolean") {
    return "verification.needs_followup must be a boolean";
  }
  for (const field of ["concerns", "coverage_concerns", "confidence_concerns"] as const) {
    if (!isNonEmptyStringArray(verification[field])) {
      return `verification.${field} must be an array of non-empty strings`;
    }
  }
  if (
    typeof verification.selection_rationale !== "string" ||
    verification.selection_rationale.trim().length === 0
  ) {
    return "verification.selection_rationale must be a non-empty string stating how you chose which surface files to open";
  }
  const followup = verification.followup_tasks;
  if (!Array.isArray(followup)) {
    return "verification.followup_tasks must be an array of objects";
  }
  if (verification.needs_followup === true && followup.length === 0) {
    return "needs_followup is true but followup_tasks is empty — a follow-up request with no bounded task is refused";
  }
  const allowed = verificationAllowedPathsForEnvelope(binding, envelope);
  for (let index = 0; index < followup.length; index++) {
    const label = `verification.followup_tasks[${index}]`;
    const entry = followup[index];
    if (!isRecord(entry)) {
      return `${label} must be an object`;
    }
    const entryKeysFailure = exactKeysFailure(
      label,
      Object.keys(entry),
      VERIFICATION_FOLLOWUP_KEYS,
    );
    if (entryKeysFailure !== null) return entryKeysFailure;
    for (const field of ["task_id", "unit_id", "pass_id", "rationale"] as const) {
      if (typeof entry[field] !== "string" || entry[field].length === 0) {
        return `${label}.${field} must be a non-empty string`;
      }
    }
    if (entry.lens !== binding.lens) {
      return `${label}.lens must equal the task's lens ` +
        `(expected '${binding.lens}', got '${String(entry.lens)}')`;
    }
    if (!isNonEmptyStringArray(entry.file_paths) || entry.file_paths.length === 0) {
      return `${label}.file_paths must be a non-empty array of non-empty strings`;
    }
    for (const path of entry.file_paths) {
      if (!allowed.has(normalizeCoveragePath(path))) {
        return `${label}.file_paths references '${path}', ` +
          "which is outside this work item's assigned surface";
      }
    }
  }
  return null;
}

function buildWorkItem(
  paths: ResolvedBoundaryPaths,
  task: AuditHostTask,
): AuditHostWorkItem {
  const resultPath = resultPathFor(paths, task.task_id);
  // The SAME path the caller writes the workload to, so a selective lane is told
  // where its surface actually is rather than where it is expected to be.
  const promptText = buildPrompt(task, resultPath, paths.workloadPath);
  return {
    id: task.task_id,
    lens: task.lens,
    metadata: {
      demand: task.demand,
      token_estimate: task.token_estimate,
    },
    prompt: {
      sha256: promptSha256(promptText),
      text: promptText,
    },
    scope: {
      files: [...task.file_paths],
      unit_ids: [task.unit_id],
      ...(task.file_metrics === undefined
        ? {}
        : { file_metrics: [...task.file_metrics] }),
    },
    result_path: resultPath,
  };
}

function validateAcceptedEntry(
  value: unknown,
): value is AcceptedResultEntry {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "audit_result",
      "prompt_sha256",
      "result",
      "result_id",
      "result_path",
      "result_sha256",
      "work_item_id",
    ])
  ) {
    return false;
  }
  return (
    typeof value.work_item_id === "string" &&
    isSha256(value.prompt_sha256) &&
    typeof value.result_path === "string" &&
    typeof value.result_id === "string" &&
    isSha256(value.result_sha256) &&
    isRecord(value.result) &&
    value.result_sha256 === contentSha256(value.result) &&
    value.result.work_item_id === value.work_item_id &&
    value.result.prompt_sha256 === value.prompt_sha256 &&
    value.result.result_id === value.result_id &&
    AuditResultSchema.safeParse(value.audit_result).success &&
    isRecord(value.audit_result) &&
    value.audit_result.task_id === value.work_item_id
  );
}

async function loadAcceptedResults(
  path: string,
  runId: string,
): Promise<AcceptedResultsLedger> {
  let value: unknown;
  try {
    value = await readJsonFile<unknown>(path);
  } catch (error) {
    if (isFileMissingError(error)) {
      return {
        contract_version: ACCEPTED_RESULTS_CONTRACT_VERSION,
        run_id: runId,
        entries: [],
      };
    }
    throw error;
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["contract_version", "entries", "run_id"]) ||
    value.contract_version !== ACCEPTED_RESULTS_CONTRACT_VERSION ||
    value.run_id !== runId ||
    !Array.isArray(value.entries) ||
    !value.entries.every(validateAcceptedEntry)
  ) {
    throw new Error(`Invalid accepted audit host results ledger: ${path}`);
  }
  const duplicate = firstDuplicateIdentity(value.entries, bindingIdentity);
  if (duplicate !== null) {
    throw new Error(`Duplicate accepted audit host result binding: ${duplicate.work_item_id}`);
  }
  return value as unknown as AcceptedResultsLedger;
}

export async function prepareAuditHostHandoff(params: {
  readonly root: string;
  readonly artifactsDir: string;
  readonly runId: string;
  readonly tasks: readonly AuditHostTask[];
  /**
   * Threaded into the shared lock substrate so its heartbeat, timeout and
   * stale-lock-reclaim events are recorded rather than lost. Optional: a caller
   * with no run log still gets the serialization, just not the telemetry.
   */
  readonly logger?: RunLogger;
}): Promise<PreparedAuditHostHandoff> {
  if (!Array.isArray(params.tasks)) {
    throw new Error("Audit host tasks must be an array");
  }
  const paths = resolveBoundaryPaths(params);
  const taskIds = new Set<string>();
  const tasks = params.tasks
    .map((task) => normalizeTask(task, paths.root))
    .sort((left, right) => compareCodeUnits(left.task_id, right.task_id));
  for (const task of tasks) {
    if (taskIds.has(task.task_id)) {
      throw new Error(`Duplicate audit host task id: ${task.task_id}`);
    }
    taskIds.add(task.task_id);
  }

  const allWorkItems = tasks.map((task) => buildWorkItem(paths, task));
  const taskById = new Map(tasks.map((task) => [task.task_id, task]));
  const taskBindings: AuditHostTaskBindings = {
    contract_version: TASK_BINDINGS_CONTRACT_VERSION,
    run_id: params.runId,
    entries: allWorkItems.map((item) => {
      const task = taskById.get(item.id);
      if (task === undefined) {
        throw new Error(`Missing canonical audit host task: ${item.id}`);
      }
      return {
        work_item_id: item.id,
        prompt_sha256: item.prompt.sha256,
        result_path: item.result_path,
        unit_id: task.unit_id,
        pass_id: task.pass_id,
        lens: task.lens,
        file_line_counts: Object.fromEntries(
          item.scope.files.map((path) => [path, task.file_line_counts[path]]),
        ),
        // Written EXPLICITLY, never left absent: the ingest gate reads this
        // field to decide whether the result must cover every bound file, and a
        // task that states no policy is a COMPLETE lane. Defaulting here (at
        // the write) rather than at the read is what lets `parseTaskBinding`
        // refuse an absent value as a stale binding set.
        coverage_policy: task.coverage_policy ?? "complete",
        tags: [...(task.tags ?? [])],
      };
    }),
  };

  await mkdir(paths.resultDir, { recursive: true });
  await writeJsonFile(paths.taskBindingsPath, taskBindings);

  // Say out loud whether this wave has drained. The caller hands in the run's
  // still-OWED partition, so an EMPTY one is the wave's own statement that every
  // work item it published has been accepted — and that is the only evidence
  // there is: from the review-run resolution, a fully-accepted wave and a wave
  // with one lane still out look identical (both are "fewer pending than
  // published"). The next wave's identity is derived from this, so it is written
  // where the run itself lives and never inferred. A comment stating this does
  // NOT survive; the marker is what does.
  await writeJsonFile(reviewWaveClosedPath(params.artifactsDir, params.runId), {
    contract_version: REVIEW_WAVE_CLOSED_CONTRACT_VERSION,
    run_id: params.runId,
    closed: allWorkItems.length === 0,
  });

  // What is PUBLISHED is every task this caller handed in. This boundary does
  // not suppress work items the accepted ledger names, and deliberately so —
  // the ledger records what ARRIVED, it never decides what is still OWED.
  //
  // A suppression filter used to sit here, keyed on the whole accepted set. It
  // read as "do not re-ask for work already delivered", but the set it consulted
  // was historical: a task that was accepted, re-planned, and is pending again
  // stayed suppressed forever, so a re-opened item was silently invisible to
  // replay — the one failure mode the ingest's own dedupe (fresh, per-binding,
  // `bindingIdentity` over work item × prompt digest) already covers correctly.
  // The ledger read and its paired rewrite still sit inside the one
  // acquisition: a prepare that snapshotted before a concurrent ingest's
  // additions must not replace them with its stale copy.
  return withAcceptedResultsLock(paths, params.logger, async (accepted) => {
    const workload: AuditHostWorkload = {
      contract_version: WORKLOAD_CONTRACT_VERSION,
      run_id: params.runId,
      work_items: allWorkItems,
    };
    const resultMap: AuditHostResultMap = {
      contract_version: RESULT_MAP_CONTRACT_VERSION,
      run_id: params.runId,
      entries: allWorkItems.map((item) => ({
        work_item_id: item.id,
        prompt_sha256: item.prompt.sha256,
        result_path: item.result_path,
      })),
    };

    await writeAcceptedResults(paths, accepted);
    await writeJsonFile(paths.workloadPath, workload);
    await writeJsonFile(paths.resultMapPath, resultMap);
    return {
      workload,
      result_map: resultMap,
      workload_path: paths.workloadPath,
      result_map_path: paths.resultMapPath,
    };
  });
}

/**
 * The persisted surface metrics, re-validated against the CANONICAL shape.
 *
 * It reads `AuditTaskSchema.shape.file_metrics` rather than a hand-written
 * record walk, so the door cannot admit a metric shape the task contract would
 * refuse — and a field added to `file_metrics` is checked here without a second
 * edit. The schema field is `.optional()`, so an absent value parses; the caller
 * decides whether absence is allowed by whether it asks at all.
 */
function isSurfaceFileMetrics(value: unknown): boolean {
  return AuditTaskSchema.shape.file_metrics.safeParse(value).success;
}

function parseWorkItem(value: unknown): AuditHostWorkItem | null {
  // `file_metrics` is the ONE optional scope key: a selective (steward) lane
  // carries it, every complete lane omits it. It is added to the expected set
  // only when the document supplies it, exactly as the result envelope treats
  // `verification` — so "these keys, plus at most one optional field" stays one
  // statement and the scope still admits nothing a host invents.
  const hasScopeMetrics =
    isRecord(value) &&
    isRecord(value.scope) &&
    Object.hasOwn(value.scope, "file_metrics");
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "id",
      "lens",
      "metadata",
      "prompt",
      "result_path",
      "scope",
    ]) ||
    typeof value.id !== "string" ||
    typeof value.lens !== "string" ||
    typeof value.result_path !== "string" ||
    !isRecord(value.metadata) ||
    !hasExactKeys(value.metadata, ["demand", "token_estimate"]) ||
    !LaneDemandSchema.safeParse(value.metadata.demand).success ||
    !Number.isInteger(value.metadata.token_estimate) ||
    !isRecord(value.prompt) ||
    !hasExactKeys(value.prompt, ["sha256", "text"]) ||
    !isSha256(value.prompt.sha256) ||
    typeof value.prompt.text !== "string" ||
    promptSha256(value.prompt.text) !== value.prompt.sha256 ||
    !isRecord(value.scope) ||
    !hasExactKeys(value.scope, [
      "files",
      "unit_ids",
      ...(hasScopeMetrics ? ["file_metrics"] : []),
    ]) ||
    !Array.isArray(value.scope.files) ||
    !value.scope.files.every((entry) => typeof entry === "string") ||
    !Array.isArray(value.scope.unit_ids) ||
    !value.scope.unit_ids.every((entry) => typeof entry === "string") ||
    (hasScopeMetrics && !isSurfaceFileMetrics(value.scope.file_metrics))
  ) {
    return null;
  }
  return value as unknown as AuditHostWorkItem;
}

/**
 * A persisted workload this draw refuses as STALE — issued under a contract
 * version this build no longer mints.
 *
 * A contract-version bump changes the work item's SHAPE (v1alpha1's
 * `{complexity, risk}` metadata became v1alpha2's shared `demand` ranking), so
 * the document on disk cannot be re-derived against the current builder and no
 * submission can be accepted against it. The class is worth its own type
 * because it has exactly ONE repair — re-prepare, which publishes a current
 * workload — and a host holding a bound result path from the stale document
 * must be told that rather than told its bytes are the wrong shape.
 *
 * Without this the whole class escaped as a bare `Invalid audit host work item`
 * throw out of the fold: a message that named neither the version found, nor
 * the version expected, nor the repair. The remediate twin took the same cut at
 * its own v1alpha2 (`REMEDIATION_HOST_WORKLOAD_CONTRACT_VERSION`, ed033294),
 * where a v1alpha1 document refuses closed the same way.
 */
class StaleAuditHostWorkloadError extends Error {
  /** The registered ingestion check the refusal is attributable to. */
  readonly check: IngestionCheckId = "workload_binding";
  /** The audit issue vocabulary's name for this class of refusal. */
  readonly code: AuditIngestIssueCode = "workload_stale";

  constructor(
    readonly found_contract_version: unknown,
    readonly expected_contract_version: string,
  ) {
    super(
      "the persisted audit host workload is STALE: it was issued under contract " +
        `version ${JSON.stringify(found_contract_version)}, but this build mints ` +
        `${expected_contract_version}. A version bump changes the work item shape, so the ` +
        "document cannot be re-derived and no submission can be accepted against it — " +
        "re-prepare the handoff to publish a current workload.",
    );
    this.name = "StaleAuditHostWorkloadError";
  }
}

/**
 * A persisted binding set this build no longer mints — the task-binding twin of
 * {@link StaleAuditHostWorkloadError}, and classified by the same rule.
 *
 * It exists as a CLASS and not as a plain throw because of what the fold does
 * with an uncaught error: `runHostDelegationObligation` rethrows everything that
 * is not ENOENT, and it ingests BEFORE the one path that re-prepares
 * (`ensureSemanticReviewRunUnlocked` → `renderSemanticReviewStep` →
 * `prepareAuditHostHandoff`, the ONLY writer of this file). A bare throw
 * therefore aborted the fold before the re-prepare, the blocked-step backstop
 * wrote a blocked step, and every later `next-step` failed identically with the
 * bindings file still at the old version — a wedge produced by a file the tool
 * had written itself.
 *
 * Classified, the ingest returns it as an ISSUE and the fold walks on to the
 * re-prepare in the SAME call, which rewrites the whole set at the current
 * version. The stale file is then read by nothing.
 */
class StaleAuditHostTaskBindingsError extends Error {
  /** The registered ingestion check the refusal is attributable to. */
  readonly check: IngestionCheckId = "workload_binding";
  /** The audit issue vocabulary's name for this class of refusal. */
  readonly code: AuditIngestIssueCode = "workload_stale";

  constructor(
    readonly found_contract_version: unknown,
    readonly expected_contract_version: string,
  ) {
    super(
      "the persisted audit host task bindings are STALE: they were issued under " +
        `contract version ${JSON.stringify(found_contract_version)}, but this build ` +
        `mints ${expected_contract_version}. A version bump changes the binding SHAPE, ` +
        "so the set cannot be re-derived and no submission bound against it can be " +
        `accepted — ${TASK_BINDINGS_VERSION_REMEDY}.`,
    );
    this.name = "StaleAuditHostTaskBindingsError";
  }
}

function parseWorkload(value: unknown, runId: string): AuditHostWorkload {
  // Envelope + all-items parsing is the CORE's scaffolding; the audit draw
  // selects only its own contract version and item parser.
  const envelope = parseWorkloadEnvelope(value, {
    contractVersion: WORKLOAD_CONTRACT_VERSION,
    runId,
  });
  if (!envelope.ok) {
    // The core's envelope check is a conjunction, so it reports "wrong version",
    // "wrong run" and "not a workload at all" identically. The STALE case is the
    // one that must be separated — it is the one with a named repair — so the
    // raw document's own version is read here, before the generic refusal, and
    // any DIFFERENT version (present, but not ours) is classified as stale.
    if (
      isRecord(value) &&
      "contract_version" in value &&
      value.contract_version !== WORKLOAD_CONTRACT_VERSION
    ) {
      throw new StaleAuditHostWorkloadError(
        value.contract_version,
        WORKLOAD_CONTRACT_VERSION,
      );
    }
    throw bindingFailure("workload_binding", "Invalid audit host workload");
  }
  const workItems = parseAllWorkloadItems(envelope.rawItems, parseWorkItem);
  if (workItems === null) {
    throw bindingFailure("workload_binding", "Invalid audit host work item");
  }
  return value as unknown as AuditHostWorkload;
}

function parseResultMap(value: unknown, runId: string): AuditHostResultMap {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["contract_version", "entries", "run_id"]) ||
    value.contract_version !== RESULT_MAP_CONTRACT_VERSION ||
    value.run_id !== runId ||
    !Array.isArray(value.entries) ||
    !value.entries.every(
      (entry) =>
        isRecord(entry) &&
        hasExactKeys(entry, [
          "prompt_sha256",
          "result_path",
          "work_item_id",
        ]) &&
        typeof entry.work_item_id === "string" &&
        isSha256(entry.prompt_sha256) &&
        typeof entry.result_path === "string",
    )
  ) {
    throw new Error("Invalid audit host result map");
  }
  return value as unknown as AuditHostResultMap;
}

function parseTaskBinding(value: unknown): AuditHostTaskBinding | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "coverage_policy",
      "file_line_counts",
      "lens",
      "pass_id",
      "prompt_sha256",
      "result_path",
      "tags",
      "unit_id",
      "work_item_id",
    ]) ||
    typeof value.work_item_id !== "string" ||
    !isSha256(value.prompt_sha256) ||
    typeof value.result_path !== "string" ||
    typeof value.unit_id !== "string" ||
    typeof value.pass_id !== "string" ||
    typeof value.lens !== "string" ||
    // REQUIRED for the same reason `tags` is, and checked against the closed
    // vocabulary the task contract owns: the coverage gate below reads this
    // field to decide whether the result must cover every bound file, so an
    // absent value is not a field to default — it is an item whose coverage
    // contract is unknown, and `parseTaskBindings` refuses the whole set as
    // stale.
    !AuditTaskSchema.shape.coverage_policy.unwrap().safeParse(
      value.coverage_policy,
    ).success ||
    // REQUIRED, and refused as a VERSION problem rather than a shape problem —
    // see parseTaskBindings. A binding without the lane stamp cannot be judged:
    // the lane decides which result contract this item's prompt carried, so an
    // absent stamp is not a field to default, it is an item whose contract is
    // unknown.
    !Array.isArray(value.tags) ||
    !value.tags.every((entry) => typeof entry === "string") ||
    !isRecord(value.file_line_counts) ||
    !Object.values(value.file_line_counts).every(
      (count) => Number.isInteger(count) && (count as number) >= 0,
    )
  ) {
    return null;
  }
  return value as unknown as AuditHostTaskBinding;
}

function parseTaskBindings(
  value: unknown,
  runId: string,
): Map<string, AuditHostTaskBinding> {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["contract_version", "entries", "run_id"]) ||
    value.run_id !== runId ||
    !Array.isArray(value.entries)
  ) {
    throw new Error("Invalid audit host task bindings");
  }
  // The VERSION is checked on its OWN, before the shape walk, so a binding set
  // written under an older version is refused for THAT reason and carries the
  // remedy. Folded into the predicate below it would be one more way to produce
  // "Invalid audit host task bindings", which tells an operator nothing about
  // what to do and reads as a corrupt file rather than a stale one. The class
  // is what the ingest CLASSIFIES on (see `ingestAuditHostResults`) instead of
  // letting the throw abort the fold before it re-prepares.
  if (value.contract_version !== TASK_BINDINGS_CONTRACT_VERSION) {
    throw new StaleAuditHostTaskBindingsError(
      value.contract_version,
      TASK_BINDINGS_CONTRACT_VERSION,
    );
  }
  const bindings = new Map<string, AuditHostTaskBinding>();
  for (const rawEntry of value.entries) {
    const entry = parseTaskBinding(rawEntry);
    if (entry === null || bindings.has(entry.work_item_id)) {
      throw new Error("Invalid or duplicate audit host task binding");
    }
    bindings.set(entry.work_item_id, entry);
  }
  return bindings;
}

function validateHandoffBinding(
  paths: ResolvedBoundaryPaths,
  workload: AuditHostWorkload,
  resultMap: AuditHostResultMap,
  taskBindings: ReadonlyMap<string, AuditHostTaskBinding>,
): Map<string, AuditHostWorkItem> {
  const items = new Map<string, AuditHostWorkItem>();
  for (const item of workload.work_items) {
    if (items.has(item.id)) {
      throw bindingFailure("workload_binding", `Duplicate audit host work item: ${item.id}`);
    }
    if (item.result_path !== resultPathFor(paths, item.id)) {
      throw bindingFailure("workload_binding", `Unbound audit host result path: ${item.id}`);
    }
    const binding = taskBindings.get(item.id);
    if (
      binding === undefined ||
      binding.prompt_sha256 !== item.prompt.sha256 ||
      binding.result_path !== item.result_path ||
      binding.lens !== item.lens ||
      item.scope.unit_ids.length !== 1 ||
      binding.unit_id !== item.scope.unit_ids[0] ||
      !sameStrings(
        Object.keys(binding.file_line_counts).sort(compareCodeUnits),
        [...item.scope.files].sort(compareCodeUnits),
      )
    ) {
      throw bindingFailure("workload_binding", `Invalid audit host task binding: ${item.id}`);
    }
    items.set(item.id, item);
  }
  // The result-map identity half is the CORE's check, with its failure
  // CLASSIFIED: a coverage miss says the MAP is wrong; an identity miss names
  // the entry whose prompt digest or bound path broke. Both of the audit
  // draw's original refusals survive — they are not collapsed into one.
  const identity = resultMapIdentity([...items.values()], resultMap.entries);
  if (!identity.ok) {
    throw bindingFailure(
      "workload_binding",
      identity.reason === "coverage"
        ? "Audit host result map does not cover the workload exactly"
        : `Invalid audit host result binding: ${identity.workItemId ?? "unknown"}`,
    );
  }
  return items;
}

/**
 * A persisted-binding failure is a THROW, not an issue: nothing about a host
 * result can be judged until the tool's own workload, result map and task
 * bindings re-derive. The check id is what the throw cites, so the failure is
 * still attributable to a registered ingestion check.
 */
function bindingFailure(check: IngestionCheckId, message: string): Error {
  return new Error(`${message} [${check}]`);
}

/**
 * A parsed submission, or the NAMED reason it was refused.
 *
 * `detail` opens with the category that failed — envelope, identity binding,
 * findings, file coverage — because the categories are not interchangeable to
 * the host that has to repair the result. A live lap lost four submissions whose
 * identity, prompt binding and file coverage were all byte-correct and whose
 * FINDINGS failed the finding schema; the single collapsed message sent the host
 * to re-check the three things that were already right.
 */
type HostResultParse =
  | { readonly ok: true; readonly result: AuditHostResult }
  | { readonly ok: false; readonly check: IngestionCheckId; readonly detail: string };

/** `check` names the registered ingestion check that failed; `detail` is its prose. */
function refuse(check: IngestionCheckId, detail: string): HostResultParse {
  return { ok: false, check, detail };
}

/** `findings[2].affected_files.0.path` — a zod issue path, host-readable. */
function issueLocation(
  prefix: string,
  path: readonly (string | number)[],
): string {
  return [prefix, ...path.map((segment) => String(segment))].join(".");
}

function parseFindings(
  findings: readonly unknown[],
):
  | { readonly ok: true; readonly findings: readonly WorkerFinding[] }
  | { readonly ok: false; readonly detail: string } {
  const parsedFindings: WorkerFinding[] = [];
  for (const [index, finding] of findings.entries()) {
    // The TOOL-owned verdicts are REFUSED, never silently overwritten: the host
    // must see that the field is not its to send, and a value the worker
    // supplied for one of these is by construction a self-certification of the
    // bit ingestion exists to compute. Stated ahead of the schema check because
    // this message names the field as the WORKER's mistake; the strict schema
    // would report it only as an unrecognized key.
    //
    // The list is the schema's own omit set (`WORKER_REFUSED_FINDING_VERDICTS`
    // feeds both), so a verdict cannot be refused here and advertised there, or
    // the reverse. `evidence_lane` is the load-bearing one: synthesis reads it
    // to decide whether a `critical` was ever asked for an `evidence` array, so
    // a supplied lane is a finding exempting ITSELF from the bar.
    if (isRecord(finding)) {
      for (const [verdict, reason] of Object.entries(
        WORKER_REFUSED_FINDING_VERDICTS,
      )) {
        if (verdict in finding) {
          return {
            ok: false,
            detail: `findings[${index}].${verdict}: ${reason}`,
          };
        }
      }
    }
    // The STRICT WORKER PROJECTION — the same contract the dispatch prompt
    // renders (`findingContractPromptLines`). Parsing the lenient base schema
    // here accepted a prompt-obedient submission that downstream validation
    // then failed (evidence missing), which is exactly the two-sources defect.
    const parsed = WorkerFindingSchema.safeParse(finding);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const location =
        issue === undefined
          ? `findings[${index}]`
          : issueLocation(`findings[${index}]`, issue.path);
      const reason = issue === undefined ? "invalid" : issue.message;
      return {
        ok: false,
        detail: `findings failed the audit finding contract at ${location}: ${reason}`,
      };
    }
    parsedFindings.push(parsed.data);
  }
  return { ok: true, findings: parsedFindings };
}

function parseHostResult(
  value: unknown,
  runId: string,
  item: AuditHostWorkItem,
  binding: AuditHostTaskBinding,
): HostResultParse {
  const hasVerification = isRecord(value) && Object.hasOwn(value, "verification");
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      ...AUDIT_RESULT_ENVELOPE_KEYS,
      // `verification` is the ONE lane-conditional key: REQUIRED of the steward
      // lane, and refused when supplied to a lane whose contract never mentions
      // it (both checked below, where the binding's lane stamp is in hand).
      // It is admitted conditionally HERE rather than required here, so a
      // base-lane submission carrying one is refused by the lane gate — which
      // names the ask that was never made — instead of by a generic key-set
      // message. Every other key stays exact, so the envelope still admits
      // nothing a host invents.
      ...(hasVerification ? ["verification"] : []),
    ]) ||
    value.contract_version !== RESULT_CONTRACT_VERSION ||
    typeof value.result_id !== "string" ||
    value.result_id.length === 0
  ) {
    return refuse(
      "result_envelope",
      `result envelope is not ${RESULT_CONTRACT_VERSION} with exactly contract_version, ` +
        `result_id, run_id, work_item_id, prompt_sha256, file_coverage and findings` +
        `${hasVerification ? ", and at most one verification object" : ""}`,
    );
  }
  // The identity walk is the CORE's, in the core's order AND in the core's
  // words, so both draws report the same first-broken component, described the
  // same way, for the same submission. Only the framing around it is this
  // draw's. The per-component branches this replaced were a second vocabulary
  // for the one classification — and they could not cover `result_id` at all,
  // because the envelope check above already requires a non-empty one, so that
  // component's failure had no branch and read as fully bound.
  const identityFailure = identityFailureDiagnostic(value, {
    runId,
    workItemId: item.id,
    promptSha256: item.prompt.sha256,
  });
  if (identityFailure !== null) {
    return refuse("identity_binding", `identity binding: ${identityFailure}`);
  }
  // The lane gate. `verification` is admitted by the envelope so the steward
  // lane can deliver what its own instruction asks for — but a base-lane work
  // item's prompt never mentions it, so a submission carrying one is answering
  // an ask that was never made. Refusing it HERE (rather than ignoring it) is
  // what keeps the field from becoming a way to smuggle unattested metadata
  // past a contract that does not describe it: `validateVerification` would
  // merely WARN, and a warning on an accepted result is not a gate.
  if (hasVerification && !isVerificationLane(binding.tags)) {
    return refuse(
      "result_envelope",
      "verification metadata was supplied for a work item whose contract does not request it; " +
        "remove the field or submit it through a lens_verification work item",
    );
  }
  // The other half of the same lane gate. The steward prompt states one rule —
  // `verification` is REQUIRED on this lane — so the door enforces exactly
  // that. A steward writes no findings of its own, so a steward submission
  // without `verification` carries no answer at all and is indistinguishable
  // from a lane that ran and failed.
  if (!hasVerification && isVerificationLane(binding.tags)) {
    return refuse(
      "result_envelope",
      "this work item is a lens steward verification task, whose contract REQUIRES a verification " +
        "object; a steward result without one reports no verdict at all",
    );
  }
  if (hasVerification) {
    const verificationFailure = verificationContractFailure(
      value.verification,
      binding,
      value,
    );
    if (verificationFailure !== null) {
      return refuse("result_envelope", verificationFailure);
    }
  }
  if (!Array.isArray(value.file_coverage)) {
    return refuse("file_coverage", "file coverage: file_coverage must be an array");
  }
  if (!Array.isArray(value.findings)) {
    return refuse(
      "findings_contract",
      "findings failed the audit finding contract: findings must be an array",
    );
  }
  // The parsed findings ride ON the result, so `toAuditResult` never has to
  // re-parse them (one parse, one door).
  const findingsParse = parseFindings(value.findings);
  if (!findingsParse.ok) return refuse("findings_contract", findingsParse.detail);
  const { findings } = findingsParse;
  const coveragePaths = new Set<string>();
  for (const coverage of value.file_coverage) {
    if (
      !isRecord(coverage) ||
      !hasExactKeys(coverage, ["path", "reviewed_lines", "total_lines"]) ||
      typeof coverage.path !== "string"
    ) {
      return refuse(
        "file_coverage",
        "file coverage: every entry must contain exactly path, reviewed_lines and total_lines",
      );
    }
    if (coveragePaths.has(coverage.path)) {
      return refuse("file_coverage", `file coverage: '${coverage.path}' is covered twice`);
    }
    if (
      !Number.isInteger(coverage.reviewed_lines) ||
      !Number.isInteger(coverage.total_lines) ||
      (coverage.reviewed_lines as number) < 0 ||
      coverage.reviewed_lines !== coverage.total_lines
    ) {
      return refuse(
        "file_coverage",
        `file coverage: '${coverage.path}' must report reviewed_lines equal to total_lines`,
      );
    }
    const boundLines: number | undefined = binding.file_line_counts[coverage.path];
    if (coverage.total_lines !== boundLines) {
      return refuse(
        "file_coverage",
        boundLines === undefined
          ? `file coverage: '${coverage.path}' is not one of this work item's bound files`
          : `file coverage: '${coverage.path}' reports ${String(coverage.total_lines)} ` +
            `total_lines, not the bound ${String(boundLines)}`,
      );
    }
    coveragePaths.add(coverage.path);
  }
  // COMPLETENESS is per-policy; CONTAINMENT is not. Every entry has already
  // been checked against `binding.file_line_counts` above, so a path outside
  // the bound set is refused on both policies and only the "cover them all"
  // half branches here.
  //
  // `"selective"` is the lens steward: its bound set is the whole surface its
  // lens was applied to, and CHOOSING which of those files to open is the work
  // the lane exists to do — so an unopened surface file is not a coverage
  // failure. What the policy still refuses is a result that opened nothing.
  if (binding.coverage_policy === "selective") {
    if (coveragePaths.size === 0) {
      return refuse(
        "file_coverage",
        "file coverage: a selective work item must report at least one file it actually reviewed",
      );
    }
  } else {
    const uncovered = item.scope.files.filter((path) => !coveragePaths.has(path));
    if (uncovered.length > 0 || coveragePaths.size !== item.scope.files.length) {
      return refuse(
        "file_coverage",
        uncovered.length > 0
          ? `file coverage: the assigned scope is not fully covered (missing ${uncovered.join(", ")})`
          : "file coverage: entries do not match the assigned scope exactly",
      );
    }
  }
  const result = JSON.parse(
    stableStringify({
      ...value,
      findings,
    }),
  ) as AuditHostResult;
  return { ok: true, result };
}

/** The conversion to the persisted `AuditResult`, or the field that refused it. */
type AuditResultConversion =
  | { readonly ok: true; readonly auditResult: AuditResult }
  | { readonly ok: false; readonly detail: string };

function toAuditResult(
  result: AuditHostResult,
  binding: AuditHostTaskBinding,
): AuditResultConversion {
  // Findings arrive already parsed against the strict worker projection
  // (`parseFindings`, threaded through `AuditHostResult.findings`) — this is a
  // mapping, not a second validation. `lens` defaults from the enclosing
  // AuditResult — the binding's lens, which IS this result's lens — exactly as
  // the projection's `.describe()` states.
  const findings = result.findings.map((finding) => ({
    ...finding,
    lens: finding.lens ?? binding.lens,
    // The LANE stamp, at the ingest that knows which contract the finding
    // arrived on — the per-file worker contract, since that is the only door
    // this module parses. Stamped rather than left absent so a reader never has
    // to decide whether an absent value is the per-file default or a finding
    // that predates the field (see `FindingEvidenceLaneSchema`).
    evidence_lane: "per-file-lane" as const,
  }));
  const parsed = AuditResultSchema.safeParse({
    task_id: binding.work_item_id,
    unit_id: binding.unit_id,
    pass_id: binding.pass_id,
    lens: binding.lens,
    file_coverage: result.file_coverage
      // construction-site: CoverageFileRecord
      .map((coverage) => ({
        path: coverage.path,
        total_lines: coverage.total_lines,
      }))
      .sort((left, right) => compareCodeUnits(left.path, right.path)),
    findings,
    reviewed_clean: result.findings.length === 0,
    run_id: result.run_id,
    // Threaded through, not re-validated: `AuditResultSchema` declares
    // `verification` and the ONE validator (`validateVerification`, reached from
    // `validateAuditResults` at the caller) judges its interior. Validating it a
    // second time here would be a second rule that can drift from the first.
    ...(result.verification === undefined
      ? {}
      : { verification: result.verification }),
  });
  if (parsed.success) return { ok: true, auditResult: parsed.data };
  const issue = parsed.error.issues[0];
  return {
    ok: false,
    detail:
      issue === undefined
        ? "the converted AuditResult is invalid"
        : `${issueLocation("audit_result", issue.path)}: ${issue.message}`,
  };
}

/**
 * This draw's refusal vocabulary for {@link scanBoundSubmission}. The scan owns
 * the sequence (containment, read, classify, duplicate check); the words are
 * this lane's, because they address a host repairing a bound audit result.
 */
function auditScanMessages(workItemId: string): SubmissionScanMessages {
  return {
    missing: () => `work item '${workItemId}' submitted nothing at its bound path`,
    malformed: (detail) =>
      `work item '${workItemId}' submitted bytes that are not JSON: ${detail}`,
    // The detail NAMES its own category. The message must never enumerate
    // categories the submission satisfied — that is how four correct-identity
    // results read as an identity problem for a whole lap.
    contractInvalid: (detail) =>
      `work item '${workItemId}' submitted JSON that does not satisfy the audit host ` +
      `result contract: ${detail}`,
    duplicate: (resultId) =>
      `work item '${workItemId}' submitted result id '${resultId}', ` +
      `which this run has already accepted`,
  };
}

export async function ingestAuditHostResults(params: {
  readonly root: string;
  readonly artifactsDir: string;
  readonly runId: string;
  /**
   * The active audit-task manifest, REQUIRED: every task-known result is put
   * through the SAME per-result rules `validateAuditResults` applies to the
   * batch BEFORE it is written to the accepted pair; a task-unknown (orphan)
   * result passes through unvalidated, mirroring the batch gate's retention of
   * orphans. Requiring it here means no caller can silently regain
   * accept-without-validation by forgetting to pass the manifest.
   */
  readonly auditTasks: readonly AuditTask[];
  /**
   * Normalized path → actual line count, built from the repo manifest exactly as
   * {@link runAuditStep} builds it. Threads the line-count rules of the batch
   * gate into the accept decision; absent means those checks degrade to skips,
   * never to errors.
   */
  readonly lineIndex?: Record<string, number>;
  /** See {@link prepareAuditHostHandoff}'s `logger`. */
  readonly logger?: RunLogger;
}): Promise<AuditHostIngestSummary> {
  const paths = resolveBoundaryPaths(params);
  const accepted = await loadAcceptedResults(
    paths.acceptedLedgerPath,
    params.runId,
  );
  // A STALE persisted document is refused as a CLASSIFIED ISSUE, never as a
  // throw. These are the refusals with a named repair — re-prepare, which this
  // fold performs on its way to the next emission — so they must reach the host
  // as rendered diagnostics rather than as unclassified stacks out of the fold.
  // Nothing is accepted: a document this build did not mint cannot be
  // re-derived, so no submission has a binding to be judged against.
  //
  // The BINDING SET is in this class for one more reason than the workload is:
  // on the fold, a throw here lands BEFORE the one path that re-prepares, so it
  // wedges the run rather than surfacing anything (see
  // {@link StaleAuditHostTaskBindingsError}). A result the host already wrote
  // under the old bindings is therefore REFUSED as stale — it is never accepted
  // against the new contract, because the new contract's binding is what the
  // re-prepare mints, and the item is re-published under it.
  const stale = (error: {
    code: AuditIngestIssueCode;
    check: IngestionCheckId;
    message: string;
  }): AuditHostIngestSummary => ({
    accepted_count: 0,
    accepted_results: accepted.entries.map((entry) => entry.audit_result),
    accepted_results_path: paths.acceptedResultsPath,
    completed_work_item_ids: [
      ...new Set(accepted.entries.map((entry) => entry.work_item_id)),
    ].sort(compareCodeUnits),
    issues: [error],
    raw_issues: [error],
    validation_warnings: [],
  });
  let workload: AuditHostWorkload;
  try {
    workload = parseWorkload(
      await readJsonFile<unknown>(paths.workloadPath),
      params.runId,
    );
  } catch (error) {
    if (!(error instanceof StaleAuditHostWorkloadError)) throw error;
    return stale(error);
  }
  const resultMap = parseResultMap(
    await readJsonFile<unknown>(paths.resultMapPath),
    params.runId,
  );
  let taskBindings: Map<string, AuditHostTaskBinding>;
  try {
    taskBindings = parseTaskBindings(
      await readJsonFile<unknown>(paths.taskBindingsPath),
      params.runId,
    );
  } catch (error) {
    if (!(error instanceof StaleAuditHostTaskBindingsError)) throw error;
    return stale(error);
  }
  const items = validateHandoffBinding(
    paths,
    workload,
    resultMap,
    taskBindings,
  );
  const acceptedBindings = new Set(accepted.entries.map(bindingIdentity));
  const resultIds = new Set(accepted.entries.map((entry) => entry.result_id));
  const additions: AcceptedResultEntry[] = [];
  const issues: AuditHostIngestIssue[] = [];
  const validation_warnings: AuditHostValidationWarning[] = [];
  // One memoized reader for the whole ingest: N findings citing one file read it once.
  const readSource = createMemoizedSourceReader();
  const activeTaskIds = new Set(params.auditTasks.map((task) => task.task_id));

  for (const entry of resultMap.entries) {
    if (acceptedBindings.has(bindingIdentity(entry))) continue;
    const item = items.get(entry.work_item_id);
    const binding = taskBindings.get(entry.work_item_id);
    if (item === undefined || binding === undefined) continue;
    const outcome = await scanBoundSubmission<AuditHostResult>({
      root: paths.root,
      artifactsDir: paths.artifactsDir,
      workItemId: entry.work_item_id,
      resultPath: entry.result_path,
      parse: (value) => {
        const parsed = parseHostResult(value, params.runId, item, binding);
        return parsed.ok ? { ok: true, parsed: parsed.result } : parsed;
      },
      resultId: (result) => result.result_id,
      // CHECK only. The id is consumed further down, after conversion,
      // validation and grounding — a result refused there must stay re-submittable.
      seen: (resultId) => resultIds.has(resultId),
      messages: auditScanMessages(entry.work_item_id),
    });
    if (!outcome.ok) {
      issues.push(outcome.issue);
      continue;
    }
    const result = outcome.parsed;
    const converted = toAuditResult(result, binding);
    if (!converted.ok) {
      issues.push({
        code: "submission_contract_invalid",
        check: "result_schema",
        message:
          `work item '${entry.work_item_id}' submitted a result that does not convert to ` +
          `an AuditResult: ${converted.detail}`,
        work_item_id: entry.work_item_id,
        result_path: entry.result_path,
      });
      continue;
    }

    // VALIDATE BEFORE ACCEPT. The conversion above proves only the envelope
    // contract (`FindingSchema` admits an evidence-less finding); these are the
    // per-result rules the downstream batch gate applies, applied HERE so an
    // error-severity issue never reaches the accepted pair. A rejected item is
    // simply never in the ledger, so the corrected file at the same bound path
    // is re-read on the next fold — acceptance used to be terminal instead, and
    // a failed batch gate then wedged the run permanently.
    //
    // Orphans (task pruned by a re-plan) pass through UNVALIDATED with the same
    // stderr notice the batch gate uses — never newly rejected: refusing one
    // here would strand it outside the append-only ledger entirely.
    if (!activeTaskIds.has(entry.work_item_id)) {
      process.stderr.write(
        `audit host-handoff ingest: result for '${entry.work_item_id}' is not in the ` +
          `active task manifest (orphaned by re-planning); retained in the accepted pair ` +
          `but skipped at the validation gate\n`,
      );
    } else {
      const validationIssues = validateOneAuditResult(converted.auditResult, [
        ...params.auditTasks,
      ], {
        lineIndex: params.lineIndex,
      });
      const errors = validationIssues.filter((issue) => issue.severity === "error");
      if (errors.length > 0) {
        issues.push({
          code: "result_validation_failed",
          check: "result_validation",
          message:
            `work item '${entry.work_item_id}' failed audit-results validation ` +
            `(${errors.length} error(s)); fix the result file at its bound path and call next-step again: ` +
            formatAuditResultIssues(errors),
          work_item_id: entry.work_item_id,
          result_path: entry.result_path,
        });
        continue;
      }
      // Warnings are NOT rejections: an accepted result never refused anything,
      // so a warning must never reach the rejection-classified issue list — the
      // ONE ledger recorder would otherwise record kind:'rejected' for a result
      // that was accepted, manufacturing a repair story that never happened.
      // They ride the separate advisory channel instead (rendered for the
      // operator; never counted as a submission that could not be accepted).
      validation_warnings.push(
        ...validationIssues
          .filter((issue) => issue.severity === "warning")
          .map(
            (warning): AuditHostValidationWarning => ({
              work_item_id: entry.work_item_id,
              result_path: entry.result_path,
              message: `${warning.message} (${warning.field})`,
            }),
          ),
      );
    }

    // S7 quote-and-verify: the tool re-reads each cited span from disk and
    // stamps the verdict. It NEVER rejects — a quote that does not re-verify
    // rides through as `ungrounded` and synthesis surfaces it under "Ungrounded
    // Findings (not confirmed)"; refusing here would discard the whole
    // submission over one bad citation.
    for (const finding of converted.auditResult.findings) {
      finding.grounding = await verifyFindingGrounding(
        paths.root,
        finding,
        readSource,
      );
    }
    resultIds.add(result.result_id);
    // construction-site: AuditResult
    // construction-site: Finding (the `findings` array; `lens` defaults from the enclosing contract, already spread in)
    additions.push({
      work_item_id: entry.work_item_id,
      prompt_sha256: entry.prompt_sha256,
      result_path: entry.result_path,
      result_id: result.result_id,
      result_sha256: contentSha256(result),
      result,
      audit_result: converted.auditResult,
    });
  }

  // The submission reading, contract checking and grounding re-verification
  // above run UNLOCKED — they only read. The read-modify-write does not: the
  // ledger is re-read under the lock and the additions are re-filtered against
  // that fresh copy, so a concurrent writer's entries are merged rather than
  // replaced, and a binding or result id it accepted in the meantime is not
  // accepted a second time here.
  let landed: AcceptedResultEntry[] = [];
  const ledger = await withAcceptedResultsLock(
    paths,
    params.logger,
    async (current) => {
      const currentBindings = new Set(current.entries.map(bindingIdentity));
      const currentResultIds = new Set(
        current.entries.map((entry) => entry.result_id),
      );
      landed = additions.filter(
        (addition) =>
          !currentBindings.has(bindingIdentity(addition)) &&
          !currentResultIds.has(addition.result_id),
      );
      if (landed.length === 0) return current;
      const next: AcceptedResultsLedger = {
        contract_version: ACCEPTED_RESULTS_CONTRACT_VERSION,
        run_id: params.runId,
        entries: [...current.entries, ...landed].sort((left, right) => {
          const item = compareCodeUnits(left.work_item_id, right.work_item_id);
          return item !== 0
            ? item
            : compareCodeUnits(left.prompt_sha256, right.prompt_sha256);
        }),
      };
      await writeAcceptedResults(paths, next);
      return next;
    },
  );
  for (const addition of additions) {
    if (landed.includes(addition)) continue;
    issues.push({
      code: "duplicate_submission_id",
      message:
        `work item '${addition.work_item_id}' was already accepted by a concurrent ` +
        `ingest of this run, so this submission was not accepted a second time`,
      work_item_id: addition.work_item_id,
      result_path: addition.result_path,
    });
  }

  // Ledger recording is NOT done here. The shared submission ledger is written
  // by the ONE recorder, `recordHostResultOutcomes`, at this ingest's only
  // production caller — fed these very `issues` and `completed_work_item_ids` —
  // so every rejection below already lands there in arrival order. A second
  // writer inside the boundary would double-record the same fact.

  const raw_issues = [...issues];
  const refusals = await readTrailingSubmissionRefusals(
    paths.artifactsDir,
    raw_issues
      .map((issue) => issue.work_item_id ?? issue.submission_id)
      .filter((id): id is string => id !== undefined),
  );
  const reportedIssues = enrichMissingSubmissionIssues(
    raw_issues,
    refusals,
    "submission_rejected",
  );

  return {
    accepted_count: landed.length,
    accepted_results: ledger.entries.map((entry) => entry.audit_result),
    accepted_results_path: paths.acceptedResultsPath,
    validation_warnings,
    completed_work_item_ids: [
      ...new Set(ledger.entries.map((entry) => entry.work_item_id)),
    ].sort(compareCodeUnits),
    issues: reportedIssues,
    raw_issues,
  };
}

/**
 * Remove accepted entries — the supported way back out of an acceptance.
 *
 * An accepted binding is skipped forever by {@link ingestAuditHostResults}, so
 * before this verb existed the only exit from a poisoned acceptance was editing
 * both files of the pair by hand. This runs under the SAME lock the writers use,
 * rewrites BOTH files together (they are one logical record), refuses a ledger
 * that fails the strict loader rather than truncating what it cannot validate,
 * records each removal on the shared submission ledger so a repaired run stays
 * distinguishable from a clean one, and invalidates the persisted step contract
 * — a stale live instruction may not survive a verb that mutates run state.
 */
export async function dropAcceptedResults(params: {
  readonly root: string;
  readonly artifactsDir: string;
  readonly runId: string;
  /** Work items to drop. Required unless {@link dropAcceptedResults.all}. */
  readonly workItemIds?: readonly string[];
  /** Drop EVERY entry. */
  readonly all?: boolean;
  /** See {@link prepareAuditHostHandoff}'s `logger`. */
  readonly logger?: RunLogger;
}): Promise<{ readonly dropped_work_item_ids: readonly string[] }> {
  if (params.all !== true && (params.workItemIds ?? []).length === 0) {
    throw new Error(
      "unaccept-results requires --work-item <id> (repeatable) or --all",
    );
  }
  const paths = resolveBoundaryPaths(params);
  const targets =
    params.all === true ? undefined : new Set(params.workItemIds ?? []);
  let droppedWorkItemIds: string[] = [];

  await withAcceptedResultsLock(paths, params.logger, async (current) => {
    if (current.entries.length === 0) return current;
    const isTarget = (workItemId: string) =>
      params.all === true ? true : (targets?.has(workItemId) ?? false);
    const kept = current.entries.filter(
      (entry) => !isTarget(entry.work_item_id),
    );
    droppedWorkItemIds = current.entries
      .filter((entry) => isTarget(entry.work_item_id))
      .map((entry) => entry.work_item_id);
    if (droppedWorkItemIds.length === 0) return current;
    await writeAcceptedResults(paths, {
      contract_version: ACCEPTED_RESULTS_CONTRACT_VERSION,
      run_id: params.runId,
      entries: kept,
    });
    return { ...current, entries: kept };
  });

  // Record each removal AFTER the pair is rewritten: the withdrawal must be on
  // the record even though the accepted pair no longer mentions the item.
  // Best-effort, like every other ledger write.
  try {
    for (const workItemId of droppedWorkItemIds) {
      await appendSubmissionEvent(paths.artifactsDir, {
        contract_version: SUBMISSION_LEDGER_EVENT_CONTRACT_VERSION,
        run_id: params.runId,
        submission_id: workItemId,
        lane: workItemId,
        kind: "removed_by_operator",
        message: "removed from the accepted results pair by unaccept-results",
        recorded_at: new Date().toISOString(),
      });
    }
  } catch (error) {
    params.logger?.event?.({
      phase: "advance",
      kind: "error",
      note: `submission-ledger removal record failed (non-fatal): ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
  }

  // Refresh-or-invalidate the persisted step contract: after mutating run state
  // there must be no stale live instruction left on disk. The next `next-step`
  // derives the real step fresh; until then the contract says blocked — through
  // the ONE shared blocked-step assembly, never a hand-built writer here.
  const reason =
    droppedWorkItemIds.length > 0
      ? `unaccept-results removed ${droppedWorkItemIds.length} accepted result(s) (${[...droppedWorkItemIds].sort().join(", ")}); run next-step to re-dispatch or re-ingest them`
      : "unaccept-results ran but no accepted entry matched; run next-step to continue";
  await writeBlockedStepContract({
    tool: "audit-code",
    contractVersion: "audit-code-step/v1alpha1",
    artifactsDir: paths.artifactsDir,
    repoRoot: paths.root,
    runId: null,
    reason,
  });

  return { dropped_work_item_ids: droppedWorkItemIds };
}
