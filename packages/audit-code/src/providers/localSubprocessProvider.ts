import { readJsonFile } from "@audit-tools/shared";
import type { WorkerTask } from "../types/workerSession.js";
import type { FreshSessionProvider, LaunchFreshSessionInput } from "@audit-tools/shared";
import { spawnLoggedCommand } from "@audit-tools/shared";

export const MISSING_WORKER_COMMAND_MESSAGE =
  "local-subprocess provider requires task.worker_command.";

export class LocalSubprocessProvider implements FreshSessionProvider {
  name = "local-subprocess";
  private readonly launchCommand: typeof spawnLoggedCommand;

  constructor(
    launchCommand: typeof spawnLoggedCommand = spawnLoggedCommand,
  ) {
    this.launchCommand = launchCommand;
  }

  async launch(input: LaunchFreshSessionInput) {
    const task = await readJsonFile<WorkerTask>(input.taskPath);
    if (!task.worker_command.length) {
      throw new Error(MISSING_WORKER_COMMAND_MESSAGE);
    }
    const [command, ...args] = task.worker_command;
    return await this.launchCommand(command, args, input);
  }
}
