// The shared body of every audit CLI subcommand that forces ONE executor and
// prints the step envelope: resolve the root, optionally warn when it is not a
// git repository, resolve the artifacts directory, run the step, print the
// result as JSON.
//
// Each such command hand-rolled that sequence, and the copies had already
// drifted: two printed through `outputJson`, one through an inline
// `console.log(JSON.stringify(..., null, 2))` — the same bytes by luck, not by
// construction, and nothing tested the envelope.
//
// NOT NAMED `stepCommand.ts`. Every `*Command.ts` module in this directory is a
// CLI VERB in the dispatch table. This is the scaffold those verbs are built
// from, and it is not dispatchable, so naming it to match that convention would
// misdescribe it.
//
// ⚠ `preferredExecutor` is REQUIRED here, and that is not an oversight to relax
// casually. It is a MODE SWITCH, not a choice of runner: a forced executor makes
// `advanceAudit` run exactly one step and bypass the shared engine entirely,
// while its absence runs the PRIORITY scan and drains the deterministic
// frontier. So this scaffold serves single-action commands ONLY. `cmdPlan` takes
// no `preferredExecutor` and therefore CANNOT adopt this as written — giving it
// one to satisfy the field would silently convert the plan draw into a single
// forced dispatch. Making the field optional is a real option, but it widens
// this contract to two modes and belongs in its own change.
import { runAuditStep } from "./auditStep.js";
import { getArtifactsDir, getRootDir, warnIfNotGitRepo } from "./args.js";
import { outputJson } from "./cliHelpers.js";

export interface StepCommandSpec {
  /**
   * The executor to force. Required — see the module header: absence is a
   * different execution mode, not a defaulted value.
   */
  preferredExecutor: string;
  /**
   * Warn on stderr when the resolved root is not a git repository. Per-command
   * policy, not a default: only the intake command warns today, because it is
   * the one that reads repository history.
   */
  warnIfNotGit?: boolean;
}

/**
 * Run one forced-executor audit step and print its envelope.
 *
 * The envelope is `{artifacts_dir, selected_executor, progress_summary}` for
 * every adopter — the shape all three hand-rolled copies already emitted.
 */
export async function runStepCommand(
  argv: string[],
  spec: StepCommandSpec,
): Promise<void> {
  const root = getRootDir(argv);
  if (spec.warnIfNotGit) warnIfNotGitRepo(root);
  const artifactsDir = getArtifactsDir(argv);
  const result = await runAuditStep({
    root,
    artifactsDir,
    preferredExecutor: spec.preferredExecutor,
  });
  outputJson({
    artifacts_dir: artifactsDir,
    selected_executor: result.selected_executor,
    progress_summary: result.progress_summary,
  });
}
