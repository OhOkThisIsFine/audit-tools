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
export function buildRemediationOutcomesReport(
  state: RemediationState,
  closingStatus: string,
): RemediationOutcomesReport {
  const findingsById = new Map(
    (state.plan?.findings ?? []).map((finding) => [finding.id, finding]),
  );
  const outcomes: RemediationOutcome[] = [];
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
    outcomes.push({
      finding_id: item.finding_id,
      lens: finding?.lens ?? "unknown",
      file_exts: fileExts,
      outcome,
      rework_count: item.rework_count ?? 0,
      closing_status: closingStatus,
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

  return {
    contract_version: "remediate-code-outcomes/v1alpha1",
    total: outcomes.length,
    by_outcome: byOutcome,
    by_lens: byLens,
    outcomes,
  };
}

interface ClosingCommandResult {
  command: string[];
  exit_code: number | null;
  stdout?: string;
  stderr?: string;
}

interface ClosingResult {
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

  const stageAndCommit = (): boolean => {
    const files = collectStagingFiles(options.root);
    if (files.length === 0) {
      console.warn("No modified files to stage — skipping commit.");
      return false;
    }
    return (
      run("git", ["add", "--", ...files]) &&
      run("git", ["commit", "-m", "Auto-remediation complete"])
    );
  };

  if (action === "commit") {
    stageAndCommit();
  } else if (action === "push") {
    stageAndCommit() && run("git", ["push"]);
  } else if (action === "open-pr") {
    stageAndCommit() &&
      run("git", ["push"]) &&
      run("gh", ["pr", "create", "--fill"]);
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
    status: commands.length > 0 && commands.every(isSuccess) ? "success" : "failed",
    commands,
  };
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

  // 1. Run the full test suite
  console.log("Running full test suite on combined post-remediation state...");
  let testsPassed = true;

  let testOutput = "";
  if (state.plan.test_command) {
    const result = runShellCommand(state.plan.test_command, {
      cwd: options.root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status !== 0) {
      testsPassed = false;
      testOutput = (
        (result.stdout?.toString() ?? "") + (result.stderr?.toString() ?? "")
      )
        .trim()
        .slice(-FAILURE_OUTPUT_TAIL_CHARS);
    }
  }

  if (!testsPassed) {
    console.log("Full test suite failed. Transitioning back to triage.");
    let anyBlocked = false;
    for (const item of Object.values(state.items)) {
      if (item.status === "resolved" || item.status === "resolved_no_change") {
        item.status = "blocked";
        item.failure_reason = `Combined test suite failed after remediation (likely a cross-block interaction issue).${testOutput ? `\n\nTest output:\n${testOutput}` : ""}`;
        anyBlocked = true;
      }
    }
    if (anyBlocked) {
      return { ...state, status: "triage" };
    }
  }

  // 2. Run end-to-end tests on the fully merged post-remediation state.
  // E2e tests run once here rather than per-block because individual refactors
  // may be interdependent: a partial remediation can break e2e flows even when
  // per-item unit tests pass. A failure here hard-errors the run — the changes
  // are complete but not shippable until the e2e issue is investigated manually.
  let e2ePassed: boolean | undefined;
  if (state.plan.e2e_command) {
    console.log(
      "Running end-to-end tests on combined post-remediation state...",
    );
    const e2eResult = runShellCommand(state.plan.e2e_command, {
      cwd: options.root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    e2ePassed = e2eResult.status === 0;
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
  }

  // 3. Execute the closing action and record exact command outcomes before
  // reporting success.
  console.log(`Executing closing action: ${state.closing_plan.action}`);
  const closingResult = executeClosingAction(state, options);
  await writeJsonFile(
    join(options.artifactsDir, "remediation-closing-result.json"),
    closingResult,
  );

  // 4. Generate remediation-report.md and remediation-report.json
  let reportContent = `# Remediation Report\n\n`;

  const resolvedEntries: {
    finding_id: string;
    summary: string;
    verification_evidence?: string;
  }[] = [];
  const verifiedNoChangeEntries: {
    finding_id: string;
    summary: string;
    verification_evidence?: string;
  }[] = [];
  const inappropriateEntries: { finding_id: string; rationale: string }[] = [];
  const ignoredEntries: { finding_id: string; rationale: string }[] = [];

  for (const item of Object.values(state.items)) {
    if (item.status === "resolved" || item.status === "resolved_no_change") {
      const finding = state.plan.findings.find((f) => f.id === item.finding_id);
      const title = finding?.title ?? "Unknown";
      let verificationEvidence: string | undefined;

      const verificationResultPath = join(
        options.artifactsDir,
        `result_${item.finding_id}_verify_code_against_documentation.json`,
      );
      if (existsSync(verificationResultPath)) {
        try {
          const verRes = JSON.parse(
            readFileSync(verificationResultPath, "utf8"),
          );
          if (verRes.reason) verificationEvidence = verRes.reason;
        } catch (error) {
          console.warn(
            `Failed to parse verification result ${verificationResultPath}.`,
            error,
          );
        }
      }

      const entry = {
        finding_id: item.finding_id,
        summary: title,
        verification_evidence: verificationEvidence,
      };
      if (item.status === "resolved_no_change") {
        verifiedNoChangeEntries.push(entry);
      } else {
        resolvedEntries.push(entry);
      }
    } else if (item.status === "deemed_inappropriate") {
      const finding = state.plan.findings.find((f) => f.id === item.finding_id);
      const rationale = item.failure_reason ?? "Deemed inappropriate";
      inappropriateEntries.push({ finding_id: item.finding_id, rationale });
    } else if (item.status === "ignored") {
      const finding = state.plan.findings.find((f) => f.id === item.finding_id);
      const rationale = item.failure_reason ?? "Ignored by user";
      ignoredEntries.push({ finding_id: item.finding_id, rationale });
    }
  }

  reportContent += `## Resolved — Changed Files\n\n`;
  if (resolvedEntries.length === 0) {
    reportContent += `None.\n`;
  } else {
    for (const entry of resolvedEntries) {
      reportContent += `- **${entry.finding_id}**: ${entry.summary}\n`;
      if (entry.verification_evidence)
        reportContent += `  - *Verification*: ${entry.verification_evidence}\n`;
    }
  }

  if (verifiedNoChangeEntries.length > 0) {
    reportContent += `\n## Verified Already Correct (no changes made)\n\n`;
    for (const entry of verifiedNoChangeEntries) {
      reportContent += `- **${entry.finding_id}**: ${entry.summary}\n`;
      if (entry.verification_evidence)
        reportContent += `  - *Verification*: ${entry.verification_evidence}\n`;
    }
  }

  if (inappropriateEntries.length > 0) {
    reportContent += `\n## Deemed Inappropriate\n\n`;
    for (const entry of inappropriateEntries) {
      reportContent += `- **${entry.finding_id}**: ${entry.rationale}\n`;
    }
  }

  if (ignoredEntries.length > 0) {
    reportContent += `\n## Ignored\n\n`;
    for (const entry of ignoredEntries) {
      reportContent += `- **${entry.finding_id}**: ${entry.rationale}\n`;
    }
  }

  reportContent += `\n## Closing Action\n\nAction: ${state.closing_plan.action}\n`;
  reportContent += `Status: ${closingResult.status}\n`;
  if (e2ePassed !== undefined) {
    reportContent += `\n## End-to-End Tests\n\nResult: ${e2ePassed ? "passed" : "failed"}\n`;
  }

  // Phase 7B: capture per-finding outcomes (surface only).
  const outcomesReport = buildRemediationOutcomesReport(
    state,
    closingResult.status,
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

  const jsonReport = {
    resolved: resolvedEntries,
    verified_no_change: verifiedNoChangeEntries,
    inappropriate: inappropriateEntries,
    ignored: ignoredEntries,
    combined_test_result: { passed: testsPassed },
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

  // 5. Clean up temporary branches and artifact directory
  // Branches are cleaned first; artifact cleanup is last so a crash here is recoverable.
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
    console.warn("Failed to clean up temporary git branches.", error);
  }

  const completeState: RemediationState = { ...state, status: "complete" };

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
  } catch {
    console.warn(
      "Failed to clean up artifacts directory — manual removal may be needed.",
    );
  }

  return completeState;
}
