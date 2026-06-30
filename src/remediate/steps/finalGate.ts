// ---------------------------------------------------------------------------
// Tool-owned final completion gate (INV-RS-10) + coarse re-block (INV-RS-09)
// ---------------------------------------------------------------------------
//
// Behaviour-preserving extraction from `nextStep.ts` (CP-NODE-1): this is the
// tool-owned final-gate cluster (the gate runner, its bounded coarse-reblock
// backstop, and the sidecar counter I/O) lifted into a sibling leaf module so
// the orchestrator god-module no longer owns it inline. `nextStep.ts` imports
// and re-exports these symbols, so the public surface and existing test imports
// are unchanged.
//
// INV-RS-10: the final completion gate is a TOOL-OWNED, NON-VACUOUS suite that
// is INDEPENDENT of any `plan.test_command`. A run can only land green when this
// suite passes; a vacuous/unset `plan.test_command` can never substitute for it.
// The suite is executed through the env-scrubbing `runTracked` path
// (`runCommand`), which strips CLAUDECODE / CLAUDE_CODE_* so the gate runs in a
// clean environment regardless of the host session.
//
// Hard floor (always run, in order — single package, single-flight build — CE-001):
//   1. npm run build                          (one tsc build for the whole package)
//   2. npm run check                          (typecheck, no emit)
//   3. BUILD-FREE unit suites at the repo root, each invoked directly so dist is
//      never rebuilt or raced:
//        - shared+audit:  node --import tsx/esm --test tests/shared/*.test.mjs tests/audit/*.test.mjs
//        - remediate-code: npx vitest run
//
// CE-002: the hard floor is scoped to build + typecheck + unit. The
// runtime/packaged-bin smoke surface (the `verify:release` smokes) is recorded
// as a DECLARED RESIDUAL the floor does not gate, rather than run inline — the
// packaged-bin smokes are the known Windows-flaky / EPERM surface and an in-loop
// gate must converge deterministically, so they are surfaced for a separate
// pass instead of being able to strand the run.

import { join } from "node:path";
import { readOptionalJsonFile, writeJsonFile } from "audit-tools/shared";
import type { RemediationState } from "../state/store.js";
import { isSkipStatus } from "../state/itemStatus.js";
import { runCommand } from "../utils/commands.js";
import {
  isAuditToolsMonorepo,
  toolOwnedFinalGateCommands,
  type FinalGateCommandSpec,
} from "./gateCommands.js";

// `FinalGateCommandSpec`, `isAuditToolsMonorepo`, and `toolOwnedFinalGateCommands`
// are single-sourced in the leaf module `gateCommands.ts` (so `dispatch.ts` can
// derive the same pinned merged-base check without an import cycle). Imported
// here for local use and re-exported to preserve the public surface + test imports.
export { isAuditToolsMonorepo, toolOwnedFinalGateCommands };
export type { FinalGateCommandSpec };

/** A command's recorded outcome within a gate run. */
export interface FinalGateCommandResult {
  argv: string[];
  layer: FinalGateCommandSpec["layer"];
  package_dir?: string;
  exit_code: number | null;
  passed: boolean;
}

export interface ToolOwnedFinalGateResult {
  passed: boolean;
  results: FinalGateCommandResult[];
  /**
   * True when the audit-tools-specific suite did not apply (target is not the
   * audit-tools monorepo). The gate then does not block; it is a declared scope,
   * not a vacuous pass.
   */
  scoped_out: boolean;
  /**
   * The runtime/packaging surface the hard floor does NOT gate, declared as a
   * residual for a separate pass (CE-002). Always present (the floor is scoped
   * to build+check+unit by design).
   */
  runtime_residual: { surface: string; commands: string[] };
}

/** Injectable runner so the gate is unit-testable without spawning a real build. */
export type GateRunner = (
  argv: string[],
  cwd: string,
  packageDir?: string,
) => { status: number | null };

/**
 * Run the tool-owned final gate (INV-RS-10). Each command runs through
 * `runCommand` → shared `runTracked`, which scrubs CLAUDECODE / CLAUDE_CODE_*.
 * The first failing command short-circuits the floor (a broken build makes the
 * later layers meaningless). A `runner` may be injected for tests. When the
 * audit-tools suite does not apply (non-monorepo target), the gate is
 * `scoped_out` (does not block) rather than vacuously passing.
 */
export async function runToolOwnedFinalGate(
  root: string,
  opts: { runner?: GateRunner } = {},
): Promise<ToolOwnedFinalGateResult> {
  const runtime_residual = {
    surface: "runtime/packaged-bin smokes (verify:release)",
    commands: [
      "npm run smoke:packaged-audit-code",
      "npm run smoke:packaged-remediate-code",
    ],
  };

  const commands = toolOwnedFinalGateCommands(root);
  if (commands.length === 0) {
    // Audit-tools-specific suite does not apply here — declared scope, not a
    // vacuous pass (it never substitutes for a real gate on the audit-tools repo).
    return { passed: true, results: [], scoped_out: true, runtime_residual };
  }

  const runner: GateRunner =
    opts.runner ??
    ((argv, cwd, packageDir) => {
      const [command, ...args] = argv;
      // Package-scoped unit suites run with cwd at the package (no `npm -w`); the
      // monorepo-root build/check commands run at the repo root.
      const effectiveCwd = packageDir ? join(root, packageDir) : cwd;
      // runCommand → runTracked strips CLAUDECODE / CLAUDE_CODE_* (INV-RS-10).
      const result = runCommand(command, args, {
        cwd: effectiveCwd,
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { status: result.status };
    });

  const results: FinalGateCommandResult[] = [];
  let passed = true;
  for (const spec of commands) {
    const { status } = runner(spec.argv, root, spec.package_dir);
    const cmdPassed = status === 0;
    results.push({
      argv: spec.argv,
      layer: spec.layer,
      ...(spec.package_dir ? { package_dir: spec.package_dir } : {}),
      exit_code: status,
      passed: cmdPassed,
    });
    if (!cmdPassed) {
      passed = false;
      break; // short-circuit: later layers are meaningless on a broken floor
    }
  }

  return { passed, results, scoped_out: false, runtime_residual };
}

/**
 * The bound on coarse re-block iterations before the run converges to a terminal
 * `blocked` close (CE-003). Two re-block attempts give a flaky-but-recoverable
 * suite a chance to settle; the third unattributable red terminates
 * deterministically rather than livelocking.
 */
export const COARSE_REBLOCK_BOUND = 2;

const FINAL_GATE_STATE_FILENAME = "final-gate.json";

interface FinalGateSidecar {
  coarse_reblock_count: number;
  /** Set once the bounded backstop terminated; the gate is never re-run after. */
  terminated?: boolean;
}

export async function readFinalGateSidecar(
  artifactsDir: string,
): Promise<{ count: number; terminated: boolean }> {
  const sidecar = await readOptionalJsonFile<FinalGateSidecar>(
    join(artifactsDir, FINAL_GATE_STATE_FILENAME),
  );
  const n = sidecar?.coarse_reblock_count;
  return {
    count: typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : 0,
    terminated: sidecar?.terminated === true,
  };
}

export async function writeFinalGateSidecar(
  artifactsDir: string,
  count: number,
  terminated: boolean,
): Promise<void> {
  await writeJsonFile(join(artifactsDir, FINAL_GATE_STATE_FILENAME), {
    schema_version: "remediate-code-final-gate/v1alpha1",
    coarse_reblock_count: count,
    terminated,
  });
}

export type CoarseReblockAction = "reattempt_all" | "terminal_blocked";

export interface CoarseReblockDecision {
  state: RemediationState;
  action: CoarseReblockAction;
  next_count: number;
}

/**
 * Coarse re-block-ALL-non-terminal on an unattributable final-gate red
 * (INV-RS-09) with a bounded, monotonic auto-terminate (CE-003).
 *
 * The tool-owned gate is whole-repo, so a red is inherently unattributable to a
 * single node. Below the bound, EVERY non-skip item (including `resolved` ones —
 * a resolved item's own change may have caused the red) is re-opened to `pending`
 * and the run re-attempts the whole repo through the rolling scheduler
 * (`reattempt_all` → `implementing`). At or above the bound, the run STOPS
 * re-attempting and converges DETERMINISTICALLY: every non-skip item becomes
 * terminal `blocked` and the run advances to `closing`.
 *
 * CE-003 no-human-host guarantee: the loop is owned entirely by the gate + the
 * rolling scheduler — it NEVER routes through the human triage prompt
 * (`waiting_for_triage`) and is bounded by `bound`, so a permanently-red sibling
 * converges to a terminal `blocked` close deterministically: never livelocking,
 * never stranding on a human prompt, and never force-closed to green (a RED gate
 * always leaves `blocked` items, so close.ts's `!anyBlocked` guard keeps the run
 * out of the fully-green path). User SKIP dispositions (ignored /
 * deemed_inappropriate) are settled decisions and are left alone. Pure (the
 * counter is supplied / returned).
 */
export function applyCoarseReblock(
  state: RemediationState,
  currentCount: number,
  gateSummary: string,
  bound: number = COARSE_REBLOCK_BOUND,
): CoarseReblockDecision {
  const now = new Date().toISOString();

  if (currentCount >= bound) {
    // Bounded auto-terminate: converge DETERMINISTICALLY to a terminal `blocked`
    // close for a no-human host — never livelock, never a triage prompt, never green.
    for (const it of Object.values(state.items ?? {})) {
      if (isSkipStatus(it.status)) continue; // settled user decision — never overturn
      it.status = "blocked";
      it.started_at ??= now;
      it.completed_at = now;
      it.failure_reason =
        `Tool-owned final gate failed and the coarse re-block backstop reached its ` +
        `bound (${bound}); converging to a terminal blocked close (no-human host). ${gateSummary}`;
    }
    return { state, action: "terminal_blocked", next_count: currentCount };
  }

  // Below the bound: re-open every non-skip item to `pending` and re-attempt the
  // whole repo via the rolling scheduler (NOT the human triage prompt).
  for (const it of Object.values(state.items ?? {})) {
    if (isSkipStatus(it.status)) continue;
    it.status = "pending";
    it.failure_context =
      `Re-attempted by the coarse final-gate backstop (unattributable whole-repo red). ${gateSummary}`;
    delete it.completed_at;
  }
  return { state, action: "reattempt_all", next_count: currentCount + 1 };
}
