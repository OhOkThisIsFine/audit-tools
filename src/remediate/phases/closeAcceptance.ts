// sites-pinned: tests/remediate/final-acceptance-window.test.ts
import { parseCommandString, type RunLogger } from "audit-tools/shared";
import type { RemediationState } from "../state/store.js";
import type { OrchestratorOptions } from "../types/options.js";
import { isVerifiedCompleteStatus } from "../state/itemStatus.js";
import {
  finalGateDisabledReason,
  runToolOwnedFinalGate,
  recordFinalGateOutcome,
  writeFinalGateRedRecord,
  type ToolOwnedFinalGateResult,
} from "../steps/finalGate.js";

export interface CombinedTestResult {
  /**
   * Whether a suite actually ran. `false` means `plan.test_command` was never
   * configured — a NEVER-RAN outcome, structurally distinct from `passed`, so
   * a caller can no longer mistake "nothing ran" for "a real pass" (the
   * vacuous-pass defect: previously `passed:true` alone claimed a real result
   * even for an unrun, unconfigured suite).
   */
  ran: boolean;
  passed: boolean;
  duration_ms: number;
  suite_name?: string;
  /** Tail of combined stdout/stderr captured on failure (empty on pass). */
  output: string;
  /** Observed child status, retained when this operation also supplies the floor. */
  exit_code?: number | null;
}

/**
 * A close owns ONE final acceptance window, after every host-input pause.
 * The floor and combined suite are requirements, not independent reasons to
 * spawn the same terminal unit operation. That operation runs through the
 * suite's stricter shape/admission path, with the same root, scrubbed host
 * environment and one-hour bound as the floor. No earlier result is consumed.
 *
 * Per-item, phase-boundary, analyzer, e2e and landing checks are different
 * operations. In particular this is not a command cache, even within a call:
 * only the explicitly planned terminal floor slot can discharge both labels.
 */
export async function runCloseAcceptance(params: {
  state: RemediationState;
  options: OrchestratorOptions;
  runCombined: () => Promise<CombinedTestResult>;
  runLogger?: RunLogger;
}): Promise<{ gate?: ToolOwnedFinalGateResult; combinedTest?: CombinedTestResult }> {
  const { state, options, runCombined, runLogger } = params;
  const scope = "all-terminal final gate";
  const disabledReason = finalGateDisabledReason(options) ??
    (Object.values(state.items ?? {}).some(item => isVerifiedCompleteStatus(item.status))
      ? null : "no verified-complete items to validate (nothing resolved)");
  if (disabledReason !== null) {
    await recordFinalGateOutcome({
      artifactsDir: options.artifactsDir, state, scope, gateKey: "tool_owned_final_gate", logPhase: "close", runLogger,
      outcome: "disabled", passed: false, commandsRun: 0, reason: disabledReason,
    });
    return {};
  }

  const testCommand = state.plan?.test_command;
  const combinedArgv = testCommand ? parseCommandString(testCommand) : undefined;
  const startedAt = Date.now();
  let combinedTest: CombinedTestResult | undefined;
  runLogger?.event({ phase: "close", kind: "executor_start", obligation: state.status, note: "tool_owned_final_gate" });
  const gate = await runToolOwnedFinalGate(options.root, {
    runner: options.finalGateRunner,
    testCommand: state.plan?.test_command_source !== "project_facts" ? combinedArgv : undefined,
    ...(combinedArgv ? {
      terminalUnit: {
        argv: combinedArgv,
        execute: async () => {
          // Admission is evaluated HERE, after builds/checks that can mutate
          // declarations. A refusal is a floor failure, never an enabled pass.
          combinedTest = await runCombined();
          return {
            // Admission/timeouts may refuse a nominal zero. Never turn that
            // into green, and never replace a real nonzero exit with a guess.
            status: combinedTest.passed ? 0 : combinedTest.exit_code === 0 ? null : combinedTest.exit_code ?? null,
            stderr: combinedTest.output, ran: combinedTest.ran,
          };
        },
      },
    } : {}),
  });
  const commandsRun = gate.results.filter(result => result.ran !== false).length;
  await recordFinalGateOutcome({
    artifactsDir: options.artifactsDir, state, scope, gateKey: "tool_owned_final_gate", logPhase: "close", runLogger,
    outcome: gate.outcome, passed: gate.passed, commandsRun,
    durationMs: Date.now() - startedAt,
    ...(gate.scoped_out ? { reason: "no executable verification command declared; operator command required" } : {}),
  });
  if (!gate.passed) {
    await writeFinalGateRedRecord(options.artifactsDir, scope, gate.results.find(result => !result.passed), { root: options.root, state });
  }
  return { gate, ...(combinedTest ? { combinedTest } : {}) };
}
