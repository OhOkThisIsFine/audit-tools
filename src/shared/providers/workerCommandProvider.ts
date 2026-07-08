import { readJsonFile } from "../io/json.js";
import type {
  FreshSessionProvider,
  LaunchFreshSessionInput,
} from "./types.js";
import { spawnLoggedCommand } from "./spawnLoggedCommand.js";
import {
  applyWorkerTaskLaunchSettings,
  type WorkerTaskWithCommand,
} from "./workerTaskLaunch.js";

export const MISSING_WORKER_COMMAND_MESSAGE =
  "worker-command provider requires task.worker_command.";

export class WorkerCommandProvider implements FreshSessionProvider {
  name = "worker-command";
  private readonly launchCommand: typeof spawnLoggedCommand;

  constructor(launchCommand: typeof spawnLoggedCommand = spawnLoggedCommand) {
    this.launchCommand = launchCommand;
  }

  async launch(input: LaunchFreshSessionInput) {
    const task = await readJsonFile<WorkerTaskWithCommand>(input.taskPath);
    if (!task.worker_command?.length) {
      throw new Error(MISSING_WORKER_COMMAND_MESSAGE);
    }
    const [command, ...args] = task.worker_command;
    return await this.launchCommand(
      command,
      args,
      applyWorkerTaskLaunchSettings(input, task),
    );
  }
}
