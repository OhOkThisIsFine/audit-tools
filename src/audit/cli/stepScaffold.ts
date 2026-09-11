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
import { runAuditStep } from "./auditStep.js";
import { getArtifactsDir, getRootDir, warnIfNotGitRepo } from "./args.js";
import { outputJson } from "./cliHelpers.js";

/**
 * The execution MODE a step command selects — the field that makes the choice
 * a stated one rather than an implied one.
 *
 * `preferredExecutor` is not a runner preference; it is a mode switch. A forced
 * executor runs exactly ONE step and bypasses the shared obligation engine
 * entirely, while the absence of one runs the PRIORITY scan and drains the
 * deterministic frontier (`advanceAudit`'s own doc comment). The two modes are
 * different DRAWS over the same registry, so a command that serves one cannot
 * be made to serve the other by filling in a field.
 *
 * It is spelled as a string-literal union rather than a constant because
 * `runAuditStep` already takes `preferredExecutor?: string`, so a constant
 * could be widened silently at the call site. An `executor` mode carries the
 * id; a `drain` mode has no id to carry; a future mode names itself.
 */
export type StepCommandMode = "drain" | "executor";

/**
 * The mode THIS scaffold implements, stated once.
 *
 * The scaffold hard-codes `executor`: a spec that asks for any other mode is
 * refused at the boundary. That refusal is the point. `cmdPlan` is the drain
 * draw — it takes no `preferredExecutor` precisely because supplying one would
 * silently convert the plan draw into a single forced dispatch — and the way it
 * stays out is that adopting this scaffold would require writing
 * `mode: "drain"`, which throws here naming the command's real shape. Before
 * this field existed, `cmdPlan` could not adopt the scaffold at all (the
 * required `preferredExecutor` was the only obstacle), and the day someone
 * relaxed that field to optional is the day the plan draw would have become a
 * forced dispatch with nothing red: the CLI suites pin only that each module
 * exports a function of that name.
 */
export const STEP_SCAFFOLD_MODE: StepCommandMode = "executor";

export interface StepCommandSpec {
  /**
   * The execution mode this command runs in. Must match
   * {@link STEP_SCAFFOLD_MODE}; anything else is refused with a message naming
   * the mode's real home.
   */
  mode: StepCommandMode;
  /**
   * The executor to force — the id half of `mode: "executor"`. Required, and
   * not an oversight to relax casually: a defaulted id would run a step the
   * command never asked for, in the mode that makes such a step look
   * intentional.
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
  if (spec.mode !== STEP_SCAFFOLD_MODE) {
    throw new Error(
      `The step-command scaffold serves mode "${STEP_SCAFFOLD_MODE}" only, but this ` +
        `command asked for "${spec.mode}". A "${spec.mode}" draw is NOT a single forced ` +
        `dispatch: it runs the PRIORITY scan and drains the deterministic frontier, ` +
        `stopping at the first boundary that needs host work. Express that mode in the ` +
        `command's own contract or leave the command bespoke — never reach it by ` +
        `supplying an executor id it does not have.`,
    );
  }
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
