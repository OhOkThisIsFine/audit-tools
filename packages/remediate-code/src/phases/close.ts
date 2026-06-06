import { RemediationState } from "../state/store.js";
import { OrchestratorOptions } from "../types/options.js";
import { extname, join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { writeTextFile, writeJsonFile, stagedAndUntracked } from "@audit-tools/shared";
import type {
  RemediationOutcome,
  RemediationOutcomeStatus,
  RemediationOutcomesReport,
  RunLogger,
} from "@audit-tools/shared";
import { runCommand, runShellCommand } from "../utils/commands.js";
import { FAILURE_OUTPUT_TAIL_CHARS } from "./constants.js";
import type { ClosingAction } from "../state/closingActions.js";

const OUTCOME_BY_STATUS: Record<string, RemediationOutcomeStatus> = {
  resolved: "resolved",
  resolved_no_change: "verified_no_change",
  deemed_inappropriate: "inappropriate",
  ignored: "ignored",
  blocked: "blocked",
};

const OUTCOME_KEYS: RemediationOutcomeStatus[] = [
  "resolved",
  "verified_no_change",
  "inappropriate",
  "ignored",
  "blocked",
];

/**
 * Phase 7B — capture one outcome per finding (lens, affected file types, how it
 * landed, rework count, closing status). Surface only: the auditor does not
 * consume this automatically.
 */
function closingStatusReason(closingResult: ClosingResult): string | undefined {
  if (closingResult.status === "skipped" && closingResult.action === "none") {
    return "closing action is 'none' — no commit/push/publish configured";
  }
  if (closingResult.status === "failed") {
    return `closing action '${closingResult.action}' failed`;
  }
  return undefined;
}

function parseTimestamp(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function durationBetweenMs(
  startedAt: string | undefined,
  completedAt: string | undefined,
): number | undefined {
  const started = parseTimestamp(startedAt);
  const completed = parseTimestamp(completedAt);
  if (started === undefined || completed === undefined || completed < started) {
    return undefined;
  }
  return completed - started;
}

export function buildRemediationOutcomesReport(
  state: RemediationState,
  closingResult: ClosingResult,
): RemediationOutcomesReport {
  const findingsById = new Map(
    (state.plan?.findings ?? []).map((finding) => [finding.id, finding]),
  );
  const outcomes: RemediationOutcome[] = [];
  const closeReason = closingStatusReason(closingResult);
  for (const item of Object.values(state.items ?? {})) {
    const outcome = OUTCOME_BY_STATUS[item.status];
    if (!outcome) continue; // skip non-terminal items (should not occur at close)
    const finding = findingsById.get(item.finding_id);
    const fileExts = [
      ...new Set(
        (finding?.affected_files ?? [])
          .map((file) => extname(file.path).toLowerCase())
          .filter((ext) => ext.length > 0),
      ),
    ].sort();
    const durationMs = durationBetweenMs(item.started_at, item.completed_at);
    outcomes.push({
      finding_id: item.finding_id,
      lens: finding?.lens ?? "unknown",
      file_exts: fileExts,
      outcome,
      rework_count: item.rework_count ?? 0,
      closing_status: closingResult.status,
      ...(closeReason ? { closing_status_reason: closeReason } : {}),
      ...(item.started_at ? { started_at: item.started_at } : {}),
      ...(item.completed_at ? { completed_at: item.completed_at } : {}),
      ...(durationMs !== undefined ? { duration_ms: durationMs } : {}),
    });
  }
  outcomes.sort((a, b) => a.finding_id.localeCompare(b.finding_id));

  const byOutcome = Object.fromEntries(
    OUTCOME_KEYS.map((key) => [key, 0]),
  ) as Record<RemediationOutcomeStatus, number>;
  const byLens: Record<
    string,
    Partial<Record<RemediationOutcomeStatus, number>>
  > = {};
  for (const entry of outcomes) {
    byOutcome[entry.outcome] += 1;
    const lensBucket = (byLens[entry.lens] ??= {});
    lensBucket[entry.outcome] = (lensBucket[entry.outcome] ?? 0) + 1;
  }

  const startedEntries = outcomes
    .map((outcome) => ({
      value: outcome.started_at,
      timestamp: parseTimestamp(outcome.started_at),
    }))
    .filter(
      (entry): entry is { value: string; timestamp: number } =>
        entry.value !== undefined && entry.timestamp !== undefined,
    );
  const completedEntries = outcomes
    .map((outcome) => ({
      value: outcome.completed_at,
      timestamp: parseTimestamp(outcome.completed_at),
    }))
    .filter(
      (entry): entry is { value: string; timestamp: number } =>
        entry.value !== undefined && entry.timestamp !== undefined,
    );
  const aggregateStarted = startedEntries.reduce<
    { value: string; timestamp: number } | undefined
  >(
    (earliest, entry) =>
      !earliest || entry.timestamp < earliest.timestamp ? entry : earliest,
    undefined,
  );
  const aggregateCompleted = completedEntries.reduce<
    { value: string; timestamp: number } | undefined
  >(
    (latest, entry) =>
      !latest || entry.timestamp > latest.timestamp ? entry : latest,
    undefined,
  );
  const aggregateDuration =
    aggregateStarted && aggregateCompleted
      ? durationBetweenMs(aggregateStarted.value, aggregateCompleted.value)
      : undefined;

  return {
    contract_version: "remediate-code-outcomes/v1alpha1",
    total: outcomes.length,
    by_outcome: byOutcome,
    by_lens: byLens,
    ...(aggregateStarted ? { started_at: aggregateStarted.value } : {}),
    ...(aggregateCompleted ? { completed_at: aggregateCompleted.value } : {}),
    ...(aggregateDuration !== undefined ? { duration_ms: aggregateDuration } : {}),
    outcomes,
  };
}

export interface ClosingCommandResult {
  command: string[];
  exit_code: number | null;
  stdout?: string;
  stderr?: string;
}

export interface ClosingResult {
  contract_version: "remediate-code-closing-result/v1alpha1";
  action: ClosingAction;
  status: "success" | "failed" | "skipped";
  commands: ClosingCommandResult[];
}

function trimOutput(value: unknown): string | undefined {
  const text = Buffer.isBuffer(value) ? value.toString() : String(value ?? "");
  const trimmed = text.trim().slice(-FAILURE_OUTPUT_TAIL_CHARS);
  return trimmed.length > 0 ? trimmed : undefined;
}

function commandResult(
  command: string[],
  result: ReturnType<typeof runCommand>,
): ClosingCommandResult {
  return {
    command,
    exit_code: result.status,
    stdout: trimOutput(result.stdout),
    stderr: trimOutput(result.stderr),
  };
}

function runTrackedCommand(
  root: string,
  command: string,
  args: string[],
): ClosingCommandResult {
  const result = runCommand(command, args, {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return commandResult([command, ...args], result);
}

function isSuccess(result: ClosingCommandResult): boolean {
  return result.exit_code === 0;
}

const STAGING_EXCLUDE_PATTERNS = [
  /^\.remediation-artifacts\//,
  // remediate-code runs in repos that also hold the auditor's output; never
  // stage either tool's artifact directory.
  /^\.audit-artifacts\//,
  /^\.env($|\.)/,
];

export function collectStagingFiles(root: string): string[] {
  return stagedAndUntracked(root).filter(
    (f) => !STAGING_EXCLUDE_PATTERNS.some((pattern) => pattern.test(f)),
  );
}

function executeClosingAction(
  state: RemediationState,
  options: OrchestratorOptions,
): ClosingResult {
  const action = state.closing_plan!.action;
  if (action === "none") {
    return {
      contract_version: "remediate-code-closing-result/v1alpha1",
      action,
      status: "skipped",
      commands: [],
    };
  }

  const commands: ClosingCommandResult[] = [];
  const run = (command: string, args: string[]): boolean => {
    const result = runTrackedCommand(options.root, command, args);
    commands.push(result);
    return isSuccess(result);
  };

  if (action === "commit" || action === "push" || action === "open-pr") {
    const files = collectStagingFiles(options.root);
    // Nothing to stage → vacuous success: no commit, push, or PR is attempted,
    // so `commands` stays empty and the status is success.
    if (files.length === 0) {
      console.warn("No modified files to stage — skipping commit.");
      return {
        contract_version: "remediate-code-closing-result/v1alpha1",
        action,
        status: "success",
        commands: [],
      };
    }
    const committed =
      run("git", ["add", "--", ...files]) &&
      run("git", ["commit", "-m", "Auto-remediation complete"]);
    if (committed && action === "push") {
      run("git", ["push"]);
    } else if (committed && action === "open-pr") {
      run("git", ["push"]) && run("gh", ["pr", "create", "--fill"]);
    }
  } else if (action === "publish") {
    run("npm", ["publish"]);
  } else if (action === "tag") {
    run("git", ["tag", "auto-remediation"]);
  } else if (action === "custom" && state.closing_plan!.custom_command?.length) {
    run(state.closing_plan!.custom_command[0], state.closing_plan!.custom_command.slice(1));
  }

  return {
    contract_version: "remediate-code-closing-result/v1alpha1",
    action,
    status: commands.every(isSuccess) ? "success" : "failed",
    commands,
  };
}

interface CombinedTestResult {
  passed: boolean;
  duration_ms: number;
  suite_name?: string;
  /** Tail of combined stdout/stderr captured on failure (empty on pass). */
  output: string;
}

/**
 * Run the plan's combined test suite over the fully merged post-remediation
 * state. Returns pass/fail plus the failure-output tail. No test_command =>
 * vacuously passing.
 */
function runCombinedTestSuite(
  state: RemediationState,
  options: OrchestratorOptions,
): CombinedTestResult {
  console.log("Running full test suite on combined post-remediation state...");
  if (!state.plan?.test_command) {
    return { passed: true, duration_ms: 0, output: "" };
  }
  const suiteName = Array.isArray(state.plan.test_command)
    ? state.plan.test_command.join(" ")
    : state.plan.test_command;
  const startedAt = Date.now();
  const result = runShellCommand(state.plan.test_command, {
    cwd: options.root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const durationMs = Date.now() - startedAt;
  if (result.status === 0) {
    return { passed: true, suite_name: suiteName, duration_ms: durationMs, output: "" };
  }
  const output = (
    (result.stdout?.toString() ?? "") + (result.stderr?.toString() ?? "")
  )
    .trim()
    .slice(-FAILURE_OUTPUT_TAIL_CHARS);
  return { passed: false, suite_name: suiteName, duration_ms: durationMs, output };
}

/**
 * On a combined-test failure, re-block every resolved item (a failure here is
 * typically a cross-block interaction) and report whether anything was blocked
 * — the caller transitions back to triage when so.
 */
function blockResolvedItemsOnCombinedFailure(
  state: RemediationState,
  testOutput: string,
): boolean {
  let anyBlocked = false;
  for (const item of Object.values(state.items ?? {})) {
    if (item.status === "resolved" || item.status === "resolved_no_change") {
      item.status = "blocked";
      item.completed_at = new Date().toISOString();
      item.failure_reason = `Combined test suite failed after remediation (likely a cross-block interaction issue).${testOutput ? `\n\nTest output:\n${testOutput}` : ""}`;
      anyBlocked = true;
    }
  }
  return anyBlocked;
}

/**
 * Run end-to-end tests on the fully merged state. E2e runs once here (not
 * per-block) because interdependent refactors can break e2e flows even when
 * per-item unit tests pass. A failure hard-errors the run: the changes are
 * complete but not shippable until investigated manually. Returns `undefined`
 * when no e2e_command is configured.
 */
function runE2eTests(
  state: RemediationState,
  options: OrchestratorOptions,
): boolean | undefined {
  if (!state.plan?.e2e_command) {
    return undefined;
  }
  console.log("Running end-to-end tests on combined post-remediation state...");
  const e2eResult = runShellCommand(state.plan.e2e_command, {
    cwd: options.root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const e2ePassed = e2eResult.status === 0;
  if (!e2ePassed) {
    const e2eOutput = (
      (e2eResult.stdout?.toString() ?? "") +
      (e2eResult.stderr?.toString() ?? "")
    )
      .trim()
      .slice(-FAILURE_OUTPUT_TAIL_CHARS);
    throw new Error(
      `End-to-end tests failed after full remediation. The code changes are complete but the system does not pass e2e validation. Review the output and investigate before retrying.\n\n${e2eOutput}`,
    );
  }
  console.log("End-to-end tests passed.");
  return e2ePassed;
}

interface ResolvedReportEntry {
  finding_id: string;
  summary: string;
  verification_evidence?: string[];
}
interface RationaleReportEntry {
  finding_id: string;
  rationale: string;
}
interface ReportEntries {
  resolved: ResolvedReportEntry[];
  verifiedNoChange: ResolvedReportEntry[];
  inappropriate: RationaleReportEntry[];
  ignored: RationaleReportEntry[];
  blocked: RationaleReportEntry[];
}

/**
 * Partition the terminal items into the report's resolved / verified-no-change
 * / inappropriate / ignored buckets, pulling each resolved item's verification
 * evidence from its `verify_code_against_documentation` result file when present.
 */
function collectReportEntries(
  state: RemediationState,
  options: OrchestratorOptions,
): ReportEntries {
  const entries: ReportEntries = {
    resolved: [],
    verifiedNoChange: [],
    inappropriate: [],
    ignored: [],
    blocked: [],
  };
  for (const item of Object.values(state.items ?? {})) {
    if (item.status === "resolved" || item.status === "resolved_no_change") {
      const finding = state.plan?.findings.find((f) => f.id === item.finding_id);
      const title = finding?.title ?? "Unknown";
      let verificationEvidence: string[] | undefined;

      const verificationResultPath = join(
        options.artifactsDir,
        `result_${item.finding_id}_verify_code_against_documentation.json`,
      );
      if (existsSync(verificationResultPath)) {
        try {
          const verRes = JSON.parse(readFileSync(verificationResultPath, "utf8"));
          if (Array.isArray(verRes.reason) && verRes.reason.length > 0) {
            verificationEvidence = verRes.reason;
          }
        } catch (error) {
          console.warn(
            `Failed to parse verification result ${verificationResultPath}.`,
            error,
          );
        }
      }

      const entry: ResolvedReportEntry = {
        finding_id: item.finding_id,
        summary: title,
        verification_evidence: verificationEvidence,
      };
      if (item.status === "resolved_no_change") {
        entries.verifiedNoChange.push(entry);
      } else {
        entries.resolved.push(entry);
      }
    } else if (item.status === "deemed_inappropriate") {
      entries.inappropriate.push({
        finding_id: item.finding_id,
        rationale: item.failure_reason ?? "Deemed inappropriate",
      });
    } else if (item.status === "ignored") {
      entries.ignored.push({
        finding_id: item.finding_id,
        rationale: item.failure_reason ?? "Ignored by user",
      });
    } else if (item.status === "blocked") {
      entries.blocked.push({
        finding_id: item.finding_id,
        rationale: item.failure_reason ?? "Blocked",
      });
    }
  }
  return entries;
}

/**
 * Render `remediation-report.md` from the partitioned entries, closing action,
 * e2e result, and per-finding outcomes. Pure string builder (no I/O).
 */
function buildRemediationReportMarkdown(
  state: RemediationState,
  entries: ReportEntries,
  closingResult: ClosingResult,
  e2ePassed: boolean | undefined,
  outcomesReport: RemediationOutcomesReport,
  combinedTest: CombinedTestResult,
): string {
  let reportContent = `# Remediation Report\n\n`;

  reportContent += `## Resolved — Changed Files\n\n`;
  if (entries.resolved.length === 0) {
    reportContent += `None.\n`;
  } else {
    for (const entry of entries.resolved) {
      reportContent += `- **${entry.finding_id}**: ${entry.summary}\n`;
      if (entry.verification_evidence) {
        for (const check of entry.verification_evidence) {
          reportContent += `  - *Verification*: ${check}\n`;
        }
      }
    }
  }

  if (entries.verifiedNoChange.length > 0) {
    reportContent += `\n## Verified Already Correct (no changes made)\n\n`;
    for (const entry of entries.verifiedNoChange) {
      reportContent += `- **${entry.finding_id}**: ${entry.summary}\n`;
      if (entry.verification_evidence) {
        for (const check of entry.verification_evidence) {
          reportContent += `  - *Verification*: ${check}\n`;
        }
      }
    }
  }

  if (entries.inappropriate.length > 0) {
    reportContent += `\n## Deemed Inappropriate\n\n`;
    for (const entry of entries.inappropriate) {
      reportContent += `- **${entry.finding_id}**: ${entry.rationale}\n`;
    }
  }

  if (entries.ignored.length > 0) {
    reportContent += `\n## Ignored\n\n`;
    for (const entry of entries.ignored) {
      reportContent += `- **${entry.finding_id}**: ${entry.rationale}\n`;
    }
  }

  reportContent += `\n## Closing Action\n\nAction: ${state.closing_plan!.action}\n`;
  reportContent += `Status: ${closingResult.status}\n`;
  if (e2ePassed !== undefined) {
    reportContent += `\n## End-to-End Tests\n\nResult: ${e2ePassed ? "passed" : "failed"}\n`;
  }

  const o = outcomesReport.by_outcome;
  reportContent += `\n## Remediation Outcomes\n\n`;
  reportContent += `Of ${outcomesReport.total} finding(s): ${o.resolved} resolved, ${o.verified_no_change} verified already correct, ${o.inappropriate} deemed inappropriate, ${o.ignored} ignored, ${o.blocked} blocked.\n`;
  const lensNames = Object.keys(outcomesReport.by_lens).sort();
  if (lensNames.length > 0) {
    reportContent += `\nBy lens:\n`;
    for (const lens of lensNames) {
      const counts = outcomesReport.by_lens[lens]!;
      const parts = OUTCOME_KEYS.filter((key) => (counts[key] ?? 0) > 0).map(
        (key) => `${key} ${counts[key]}`,
      );
      reportContent += `- ${lens}: ${parts.join(", ")}\n`;
    }
  }

  if (!combinedTest.passed) {
    reportContent += `\n## Combined Test Suite Failure\n\nThe full test suite failed after remediation. No items with a resolved status were available to re-block, so the run completed, but the following failure was recorded:\n\n`;
    if (combinedTest.output) reportContent += `\`\`\`\n${combinedTest.output}\n\`\`\`\n`;
  }

  return reportContent;
}

/**
 * Clean up the remediator's temporary git branches and the artifact directory.
 * Branches first, artifact dir last so a crash mid-cleanup leaves a recoverable
 * state. Failures are non-fatal but recorded via structured RunLogger context
 * (OBS-003) rather than a bare console.warn.
 */
async function cleanupTempBranchesAndArtifacts(
  options: OrchestratorOptions,
  completeState: RemediationState,
  runLogger?: RunLogger,
): Promise<void> {
  try {
    const branchResult = runCommand("git", ["branch"], {
      cwd: options.root,
      encoding: "utf8",
    });
    const branches = (branchResult.stdout?.toString() ?? "").split("\n");
    for (const branch of branches) {
      const b = branch.replace("*", "").trim();
      if (b.startsWith("remediator-block-")) {
        runCommand("git", ["branch", "-D", b], { cwd: options.root });
      }
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn("Failed to clean up temporary git branches.", error);
    runLogger?.event({
      phase: "close",
      kind: "outcome",
      obligation: "closing",
      note: `Failed to clean up temporary git branches: ${reason}`,
    });
  }

  // Write final state before deleting the artifacts directory so the completion
  // is durable even if cleanup partially fails.
  try {
    const { StateStore } = await import("../state/store.js");
    const store = new StateStore(options.artifactsDir);
    await store.saveState(completeState);
  } catch {
    // Non-fatal — we still return complete
  }

  try {
    const { rm } = await import("node:fs/promises");
    await rm(options.artifactsDir, { recursive: true, force: true });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(
      "Failed to clean up artifacts directory — manual removal may be needed.",
    );
    runLogger?.event({
      phase: "close",
      kind: "artifact_write",
      obligation: "closing",
      artifact: options.artifactsDir,
      note: `Failed to clean up artifacts directory (manual removal may be needed): ${reason}`,
    });
  }
}

export async function runClosePhase(
  state: RemediationState,
  options: OrchestratorOptions,
  runLogger?: RunLogger,
): Promise<RemediationState> {
  console.log("Running Close Phase...");

  if (!state.plan || !state.items || !state.closing_plan) {
    throw new Error(
      "Cannot run close phase: missing plan, items, or closing_plan from state.",
    );
  }

  // 1. Run the full test suite; on failure re-block resolved items and triage.
  const combinedTest = runCombinedTestSuite(state, options);
  if (!combinedTest.passed) {
    console.log("Full test suite failed. Transitioning back to triage.");
    if (blockResolvedItemsOnCombinedFailure(state, combinedTest.output)) {
      return { ...state, status: "triage" };
    }
    console.warn(
      "Combined test suite failed but no resolved items to re-block — completing with test failure recorded in report.",
    );
  }

  // 2. Run end-to-end tests on the fully merged post-remediation state.
  const e2ePassed = runE2eTests(state, options);

  // 3. Execute the closing action and record exact command outcomes before
  // reporting success.
  console.log(`Executing closing action: ${state.closing_plan.action}`);
  const closingResult = executeClosingAction(state, options);
  await writeJsonFile(
    join(options.artifactsDir, "remediation-closing-result.json"),
    closingResult,
  );

  // 4. Generate remediation-report.md and remediation-report.json
  const entries = collectReportEntries(state, options);

  // Phase 7B: capture per-finding outcomes (surface only).
  const outcomesReport = buildRemediationOutcomesReport(
    state,
    closingResult,
  );
  // One run-log line per outcome, plus a summary line for the artifact write.
  for (const outcome of outcomesReport.outcomes) {
    runLogger?.event({
      phase: "close",
      kind: "outcome",
      obligation: "closing",
      note: `${outcome.finding_id} [${outcome.lens}] → ${outcome.outcome} (rework ${outcome.rework_count})`,
    });
  }

  const reportContent = buildRemediationReportMarkdown(
    state,
    entries,
    closingResult,
    e2ePassed,
    outcomesReport,
    combinedTest,
  );
  const endedAt = new Date().toISOString();

  const jsonReport = {
    started_at: state.started_at ?? null,
    ended_at: endedAt,
    step_count: state.step_count ?? 0,
    resolved: entries.resolved,
    verified_no_change: entries.verifiedNoChange,
    inappropriate: entries.inappropriate,
    ignored: entries.ignored,
    blocked: entries.blocked,
    combined_test_result: {
      passed: combinedTest.passed,
      ...(combinedTest.suite_name ? { suite_name: combinedTest.suite_name } : {}),
      duration_ms: combinedTest.duration_ms,
      ...(combinedTest.output ? { failure_summary: combinedTest.output } : {}),
    },
    ...(e2ePassed !== undefined ? { e2e_result: { passed: e2ePassed } } : {}),
    closing_result: {
      action: state.closing_plan.action,
      status: closingResult.status,
      commands: closingResult.commands,
    },
  };

  await Promise.all([
    writeTextFile(join(options.root, "remediation-report.md"), reportContent),
    writeJsonFile(join(options.root, "remediation-report.json"), jsonReport),
    writeJsonFile(
      join(options.root, "remediation-outcomes.json"),
      outcomesReport,
    ),
  ]);
  runLogger?.event({
    phase: "close",
    kind: "artifact_write",
    obligation: "closing",
    artifact: "remediation-outcomes.json",
    note: `${outcomesReport.total} outcome(s)`,
  });
  console.log("Remediation report generated.");

  // 5. Clean up temporary branches and artifact directory.
  const completeState: RemediationState = { ...state, status: "complete" };
  await cleanupTempBranchesAndArtifacts(options, completeState, runLogger);

  return completeState;
}
