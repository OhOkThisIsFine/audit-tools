import { runStepCommand } from "./stepScaffold.js";

export async function cmdIntake(argv: string[]): Promise<void> {
  await runStepCommand(argv, {
    preferredExecutor: "intake_executor",
    warnIfNotGit: true,
  });
}
