import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
  absoluteSubmissionPath,
  readJsonFile,
  readSubmissionLedger,
  resolveWithinRoot,
} from "audit-tools/shared";
import { verificationReportPath } from "../../shared/io/auditToolsPaths.js";
import type { RemediationState } from "../state/store.js";
import { StateStore } from "../state/store.js";
import { isInProgressStatus } from "../state/itemStatus.js";
import {
  validateClarificationRequest,
  validateRemediationPlan,
  validateTriageResolution,
} from "./remediationState.js";
import {
  type ValidationIssue,
  formatValidationIssues,
  isRecord,
  pushValidationIssue,
} from "audit-tools/shared";
import {
  REMEDIATION_CLOSING_RESULT_CONTRACT_VERSION,
  REMEDIATION_HOST_DECISION_CONTRACT_VERSION,
  REMEDIATION_HOST_RESULT_CONTRACT_VERSION,
  REMEDIATION_STEP_CONTRACT_VERSION,
} from "../steps/types.js";
import {
  CONTRACT_PIPELINE_VALIDATORS,
  validateVerificationReport,
} from "./contractPipeline.js";
// The OUTCOMES variant, imported from the gate module directly (the same import
// the next-step gates use): it reports which gates actually ran, so an empty
// issues array from a gate whose input was absent is not read as proof-of-clean.
import { evaluateContractPipelineCrossGateOutcomes } from "./contractPipelineGates.js";
import {
  CP_ARTIFACT_NAMES,
  type ContractPipelineArtifactName,
  contractPipelineDir,
} from "../contractPipeline/artifactStore.js";
import { intakePaths } from "../intake.js";

export interface ArtifactValidationResult {
  status: "ok" | "error";
  issue_count: number;
  issues: string[];
  /**
   * What the DISCOVERY-based scans actually examined.
   *
   * An empty `issues` array is not evidence of a clean run — it is equally the
   * signature of a scan that matched nothing. Both dispatch discovery filters
   * matched zero files a live run produces (one scanned a retired artifact name,
   * the other a result filename no producer mints), so `status: "ok"` was
   * returned for runs whose entire submission surface went unchecked. Reporting
   * the counts makes "clean" and "never looked" different answers.
   */
  scan: {
    /** Host submissions found under runs/ at the filenames the tool mints. */
    submissions_discovered: number;
    /** Of those, the ones whose payload was read and contract-checked. */
    submissions_validated: number;
    /** Cross-artifact contract-pipeline gates that actually ran. */
    gates_evaluated: number;
    /** Gates that could not run because their input was absent or malformed. */
    gates_skipped: number;
  };
}

/**
 * Funnel a validator's ValidationIssue[] into the human issue log (MNT-19ac220e):
 * keep only `error`-severity issues and, when any remain, push one formatted line
 * (optionally prefixed, e.g. with the source path). Replaces the read-validate-
 * filter-push idiom that was copy-pasted per artifact in validateArtifacts.
 */
function pushErrorIssues(
  issues: string[],
  validatorIssues: ValidationIssue[],
  prefix?: string,
): void {
  const errors = validatorIssues.filter((issue) => issue.severity === "error");
  if (errors.length === 0) return;
  const formatted = formatValidationIssues(errors);
  issues.push(prefix ? `${prefix}\n${formatted}` : formatted);
}

async function readJsonForValidation(
  path: string,
  issues: string[],
): Promise<unknown | undefined> {
  if (!existsSync(path)) return undefined;
  try {
    return await readJsonFile<unknown>(path);
  } catch (error) {
    issues.push(`Invalid JSON at ${path}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

async function collectFiles(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(path)));
    } else {
      files.push(path);
    }
  }
  return files;
}

function validateStringArray(
  value: unknown,
  label: string,
  issues: ValidationIssue[],
): void {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    pushValidationIssue(issues, label, `${label} must be an array of strings.`);
  }
}

function validateCurrentStep(value: unknown, path: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!isRecord(value)) {
    pushValidationIssue(issues, path, `${path} must be an object.`);
    return issues;
  }
  if (value.contract_version !== REMEDIATION_STEP_CONTRACT_VERSION) {
    pushValidationIssue(issues, `${path}.contract_version`, `${path} has unsupported contract_version.`);
  }
  for (const key of [
    "step_kind",
    "status",
    "prompt_path",
    "run_id",
    "repo_root",
    "artifacts_dir",
    "stop_condition",
  ]) {
    if (typeof value[key] !== "string") {
      pushValidationIssue(issues, `${path}.${key}`, `${path}.${key} must be a string.`);
    }
  }
  validateStringArray(value.allowed_commands, `${path}.allowed_commands`, issues);
  if (!isRecord(value.artifact_paths)) {
    pushValidationIssue(issues, `${path}.artifact_paths`, `${path}.artifact_paths must be an object.`);
  }
  if (typeof value.prompt_path === "string" && !existsSync(value.prompt_path)) {
    pushValidationIssue(issues, `${path}.prompt_path`, `${path}.prompt_path points to a missing file: ${value.prompt_path}.`);
  }
  return issues;
}

function validateClosingResult(value: unknown, path: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!isRecord(value)) {
    pushValidationIssue(issues, path, `${path} must be an object.`);
    return issues;
  }
  if (value.contract_version !== REMEDIATION_CLOSING_RESULT_CONTRACT_VERSION) {
    pushValidationIssue(issues, `${path}.contract_version`, `${path}.contract_version is unsupported.`);
  }
  if (typeof value.action !== "string") {
    pushValidationIssue(issues, `${path}.action`, `${path}.action must be a string.`);
  }
  if (!["success", "failed", "skipped"].includes(String(value.status))) {
    pushValidationIssue(issues, `${path}.status`, `${path}.status must be success, failed, or skipped.`);
  }
  if (!Array.isArray(value.commands)) {
    pushValidationIssue(issues, `${path}.commands`, `${path}.commands must be an array.`);
    return issues;
  }
  for (const [index, command] of value.commands.entries()) {
    const commandPath = `${path}.commands[${index}]`;
    if (!isRecord(command)) {
      pushValidationIssue(issues, commandPath, `${commandPath} must be an object.`);
      continue;
    }
    validateStringArray(command.command, `${commandPath}.command`, issues);
    if (
      command.exit_code !== null &&
      (typeof command.exit_code !== "number" || !Number.isInteger(command.exit_code))
    ) {
      pushValidationIssue(issues, `${commandPath}.exit_code`, `${commandPath}.exit_code must be an integer or null.`);
    }
  }
  return issues;
}

/**
 * The ONE filename rule a host submission lands under: the sha256 of the
 * submission id. This is the join the discovery scan needs.
 */
const HOST_SUBMISSION_FILENAME = /^[0-9a-f]{64}\.json$/u;

/** OS-agnostic identity for two absolute paths derived in the same process. */
function pathKey(path: string): string {
  return resolve(path).replaceAll("\\", "/");
}

/**
 * The run id owning a file beneath `runs/` — its first path segment, which is
 * the run directory the boundary mints. Undefined for anything not actually
 * under `runs/`, so a caller filtering on it excludes rather than guesses.
 */
function runDirectoryOf(runsDir: string, file: string): string | undefined {
  const contained = resolveWithinRoot(runsDir, file, { allowRoot: false });
  if (contained === null) return undefined;
  const rel = relative(resolve(runsDir), contained);
  return rel.split(/[\\/]/u)[0];
}

function validateHostSubmission(value: unknown, path: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!isRecord(value)) {
    pushValidationIssue(issues, path, `${path} host submission must be an object.`);
    return issues;
  }
  const version = value.contract_version;
  const isDecision = version === REMEDIATION_HOST_DECISION_CONTRACT_VERSION;
  if (version !== REMEDIATION_HOST_RESULT_CONTRACT_VERSION && !isDecision) {
    pushValidationIssue(
      issues,
      `${path}.contract_version`,
      `${path} host submission has unsupported contract_version.`,
    );
    return issues;
  }
  for (const key of ["result_id", "run_id", "work_item_id", "prompt_sha256"]) {
    if (typeof value[key] !== "string" || (value[key] as string).length === 0) {
      pushValidationIssue(
        issues,
        `${path}.${key}`,
        `${path}.${key} must be a non-empty string.`,
      );
    }
  }
  if (isDecision) {
    if (!isRecord(value.outcome) || typeof value.outcome.status !== "string") {
      pushValidationIssue(
        issues,
        `${path}.outcome`,
        `${path}.outcome must be an object carrying a status string.`,
      );
    }
    return issues;
  }
  validateStringArray(value.changed_files, `${path}.changed_files`, issues);
  if (Array.isArray(value.changed_files) && value.changed_files.length === 0) {
    pushValidationIssue(
      issues,
      `${path}.changed_files`,
      `${path}.changed_files must be non-empty for a landed result.`,
    );
  }
  for (const key of ["commit_evidence", "worktree_evidence", "acceptance", "merge"]) {
    if (!isRecord(value[key])) {
      pushValidationIssue(issues, `${path}.${key}`, `${path}.${key} must be an object.`);
    }
  }
  if (!Array.isArray(value.test_evidence)) {
    pushValidationIssue(
      issues,
      `${path}.test_evidence`,
      `${path}.test_evidence must be an array.`,
    );
  }
  return issues;
}

/**
 * Work-item (block) ids this run has ALREADY recorded a submission for, read
 * from the records the acceptance path persists — never from the live workload,
 * which is rewritten frontier-by-frontier and therefore remembers nothing.
 *
 * Two sources, both artifactsDir-scoped:
 *   - state.json item records, via `!isInProgressStatus`.
 *   - the submission ledger, whose events name the submission they accepted.
 *
 * `!isInProgressStatus` DELIBERATELY OVER-APPROXIMATES. It is not "a submission
 * was ingested for this block" — `ignored`, `deemed_inappropriate` and
 * `abandoned` are all reachable with no submission at all (the planning review
 * gate's batched decline; the force-close backstop). The over-approximation is
 * the point, in both directions: it errs toward never flagging accepted-or-
 * adjacent work, and it is also what keeps a `blocked` or `needs_clarification`
 * item's DECISION document — a real host submission that resolved nothing — from
 * being reported as stale. The cost of admitting a block that never submitted is
 * one path that matches no file on disk; the cost of missing one is a false
 * "stale" against real work, so the bias is chosen, not accidental.
 *
 * A malformed or absent ledger contributes nothing rather than failing the scan:
 * this set only ever WIDENS what counts as referenced, so an empty answer is the
 * strict one.
 */
async function recordedSubmissionIds(
  artifactsDir: string,
  state: RemediationState | null,
): Promise<ReadonlySet<string>> {
  const recorded = new Set<string>();
  for (const item of Object.values(state?.items ?? {})) {
    if (item.block_id && !isInProgressStatus(item.status)) {
      recorded.add(item.block_id);
    }
  }
  try {
    for (const event of await readSubmissionLedger(artifactsDir)) {
      if (event.submission_id) recorded.add(event.submission_id);
    }
  } catch {
    // See above: an unreadable ledger narrows the set, never breaks the scan.
  }
  return recorded;
}

/**
 * Scan the dispatch/result surface: the host workloads the boundary writes and
 * the submissions it reads back, joined on the filenames the tool actually
 * mints. Returns what it examined, so a caller can tell a clean run from an
 * unscanned one.
 *
 * The join is the live frontier UNION THE RUN'S RECORDED HISTORY. `prepare`
 * REWRITES host-workload.json with the current dependency frontier alone, and an
 * accepted block leaves that frontier — so a join against the live workload by
 * itself reported every accepted submission of the run as stale, which is the
 * whole result surface of any run that got past its first level. Recorded
 * submissions are re-minted through the SAME shared identity rule the boundary
 * writes with, so this is the producer's join, not a second copy of it.
 *
 * Scoped to ONE run. `runs/` accumulates: nothing deletes a finished run's
 * directory, and the records a stale check joins against — state.json, the
 * ledger — describe the CURRENT run only. Scanning every run directory therefore
 * reported the previous run's accepted submissions as stale from run 2 onward,
 * permanently. A run directory that is not this run's is skipped whole: its
 * result surface was validated while it WAS the current run, and this call has
 * nothing left to say about it.
 */
async function validateHostSubmissions(
  artifactsDir: string,
  root: string,
  issues: string[],
  /**
   * Work-item ids the persisted records say this run already has a submission
   * for — see {@link recordedSubmissionIds}. Empty when there is no state and no
   * ledger, which leaves the join exactly as strict as the live workload alone.
   */
  recordedIds: ReadonlySet<string>,
  /**
   * The run whose directory is in scope — the plan id, which IS the host run id
   * (`stateRunId`). Undefined when there is no persisted plan to name a current
   * run, and then every run directory is scanned, exactly as before.
   */
  currentRunId: string | undefined,
): Promise<{ discovered: number; validated: number }> {
  const runsDir = join(artifactsDir, "runs");
  const files = (await collectFiles(runsDir)).filter(
    (file) =>
      currentRunId === undefined ||
      runDirectoryOf(runsDir, file) === currentRunId,
  );
  const submissions = files.filter((file) =>
    HOST_SUBMISSION_FILENAME.test(basename(file)),
  );

  const bound = new Set<string>();
  const submissionDirs = new Set<string>();
  for (const file of files.filter(
    (candidate) => basename(candidate) === "host-workload.json",
  )) {
    const workload = await readJsonForValidation(file, issues);
    if (workload === undefined) continue;
    if (!isRecord(workload) || !Array.isArray(workload.work_items)) {
      issues.push(`${file} is not a host workload with a work_items array.`);
      continue;
    }
    for (const item of workload.work_items) {
      if (isRecord(item) && typeof item.result_path === "string") {
        const absolute = join(root, item.result_path);
        bound.add(pathKey(absolute));
        // Derived from the workload's own bound paths rather than by rebuilding
        // the run directory here: the boundary owns where submissions land, and
        // a second copy of that layout would drift.
        submissionDirs.add(dirname(absolute));
      }
    }
  }

  for (const submissionDir of submissionDirs) {
    for (const workItemId of recordedIds) {
      try {
        bound.add(pathKey(absoluteSubmissionPath({ root, submissionDir }, workItemId)));
      } catch {
        // An id the shared rule refuses to mint a path for cannot have produced
        // a submission, so it contributes nothing to the join.
      }
    }
  }

  // AN EMPTY SCAN IS NOT A PASS. If a live workload's bound submissions exist on
  // disk and the discovery filter matched none of them, the join is broken —
  // which is exactly the state that returned `ok` with issue_count 0 for a run
  // whose whole result surface went unchecked. Report it rather than pass.
  const boundOnDisk = [...bound.keys()].filter((path) => existsSync(path));
  if (boundOnDisk.length > 0 && submissions.length === 0) {
    issues.push(
      `No host submissions were discovered under ${join(artifactsDir, "runs")}, yet ` +
        `${String(boundOnDisk.length)} bound submission file(s) exist on disk — the validator's ` +
        "filename join no longer matches what the host handoff mints.",
    );
  }

  let validated = 0;
  for (const submission of submissions) {
    const payload = await readJsonForValidation(submission, issues);
    if (payload === undefined) continue;
    validated += 1;
    pushErrorIssues(issues, validateHostSubmission(payload, submission));
    if (bound.size > 0 && !bound.has(pathKey(submission))) {
      issues.push(
        `Stale host submission is not referenced by any host workload: ${submission}.`,
      );
    }
  }
  return { discovered: submissions.length, validated };
}

export async function validateArtifacts(
  artifactsDir: string,
  root = ".",
): Promise<ArtifactValidationResult> {
  const issues: string[] = [];
  const store = new StateStore(artifactsDir);
  const state = await store.loadState();

  if (!state) {
    issues.push(`Missing remediation state at ${join(artifactsDir, "state.json")}.`);
  }

  if (state?.plan) {
    pushErrorIssues(issues, validateRemediationPlan(state.plan));
  }

  const planPath = join(artifactsDir, "remediation_plan.json");
  const persistedPlan = await readJsonForValidation(planPath, issues);
  if (persistedPlan) {
    pushErrorIssues(issues, validateRemediationPlan(persistedPlan));
  }

  const clarificationRequest = await readJsonForValidation(
    join(artifactsDir, "clarification_request.json"),
    issues,
  );
  if (clarificationRequest) {
    if (!Array.isArray(clarificationRequest)) {
      issues.push("clarification_request.json must be an array.");
    } else {
      for (const [index, request] of clarificationRequest.entries()) {
        pushErrorIssues(
          issues,
          validateClarificationRequest(request, `clarification_request[${index}]`),
        );
      }
    }
  }

  const triageBatch = await readJsonForValidation(
    join(artifactsDir, "triage_batch.json"),
    issues,
  );
  if (triageBatch) {
    if (!isRecord(triageBatch) || !Array.isArray(triageBatch.items)) {
      issues.push("triage_batch.json must be an object with an items array.");
    }
  }

  const triageResolution = await readJsonForValidation(
    join(artifactsDir, "triage_resolution.json"),
    issues,
  );
  if (triageResolution) {
    pushErrorIssues(issues, validateTriageResolution(triageResolution));
  }

  const currentStep = await readJsonForValidation(
    join(artifactsDir, "steps", "current-step.json"),
    issues,
  );
  if (currentStep) {
    pushErrorIssues(issues, validateCurrentStep(currentStep, "current-step.json"));
  }

  const submissionScan = await validateHostSubmissions(
    artifactsDir,
    root,
    issues,
    await recordedSubmissionIds(artifactsDir, state),
    state?.plan?.plan_id,
  );

  const closingResultPath = join(artifactsDir, "remediation-closing-result.json");
  const closingResult = await readJsonForValidation(closingResultPath, issues);
  if (closingResult) {
    pushErrorIssues(
      issues,
      validateClosingResult(closingResult, "remediation-closing-result.json"),
    );
  }

  // Contract-pipeline artifact validation (optional — only checked when present).
  // Run the SAME full gate set next-step runs, accumulating EVERY failure across
  // all present artifacts + gates into ONE result (B1 #3 — no per-invocation
  // partial report that would force a fix→re-run→new-failure thrash). Per-artifact
  // structural validators run first; the cross-artifact + decomposition gates run
  // after so an authoring agent's `validate-artifact` reproduces exactly what
  // next-step would reject.
  const cpDir = contractPipelineDir(artifactsDir);
  const cpPayloads = new Map<ContractPipelineArtifactName, unknown>();
  for (const name of CP_ARTIFACT_NAMES) {
    const cpPath = join(cpDir, `${name}.json`);
    const cpRaw = await readJsonForValidation(cpPath, issues);
    if (!cpRaw) continue;
    // The envelope wraps the payload — validate the payload field.
    const payload = isRecord(cpRaw) && "payload" in cpRaw ? cpRaw.payload : cpRaw;
    cpPayloads.set(name, payload);
    pushErrorIssues(issues, CONTRACT_PIPELINE_VALIDATORS[name](payload, name), `${cpPath}:`);
  }

  // Cross-artifact + decomposition gates. Each gate is individually tolerant of
  // an absent input (returns [] when its primary payload is missing/malformed),
  // so an incomplete pipeline never fabricates errors — only present artifacts
  // are gated.
  //
  // The plural sweep and the singular `validate-artifact --name X` self-check
  // both call `evaluateContractPipelineCrossGateOutcomes`, the single entry
  // point that couples each gate's issues with its evaluated/skipped metadata.
  let gatesEvaluated = 0;
  let gatesSkipped = 0;
  if (cpPayloads.size > 0) {
    const findingEnumeration = await readJsonForValidation(
      intakePaths(artifactsDir).findingEnumeration,
      issues,
    );

    for (const outcome of evaluateContractPipelineCrossGateOutcomes({
      payloads: cpPayloads,
      findingEnumeration,
      root,
    })) {
      if (outcome.evaluated) gatesEvaluated += 1;
      else gatesSkipped += 1;
      pushErrorIssues(issues, outcome.issues);
    }
  }

  // Verification report at the root artifacts dir (from FINDING-027).
  const verificationReportFilePath = verificationReportPath(root);
  const verificationReport = await readJsonForValidation(verificationReportFilePath, issues);
  if (verificationReport) {
    pushErrorIssues(
      issues,
      validateVerificationReport(verificationReport, "verification_report.json"),
    );
  }

  return {
    status: issues.length > 0 ? "error" : "ok",
    issue_count: issues.length,
    issues,
    scan: {
      submissions_discovered: submissionScan.discovered,
      submissions_validated: submissionScan.validated,
      gates_evaluated: gatesEvaluated,
      gates_skipped: gatesSkipped,
    },
  };
}
