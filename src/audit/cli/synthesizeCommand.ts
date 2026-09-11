import { runStepCommand } from "./stepScaffold.js";

export async function cmdSynthesize(argv: string[]): Promise<void> {
  await runStepCommand(argv, {
    mode: "executor",
    preferredExecutor: "synthesis_executor",
  });
}
