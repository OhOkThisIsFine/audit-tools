import { readFile } from "node:fs/promises";
import type { FreshSessionProvider, LaunchFreshSessionInput } from "./types.js";
import type { OpenCodeConfig } from "../types/sessionConfig.js";
import { spawnLoggedCommand } from "./spawnLoggedCommand.js";
import { readJsonFile } from "../io/json.js";
import type { WorkerTask } from "../types/workerSession.js";
import { applyWorkerTaskLaunchSettings } from "./workerTaskLaunch.js";

export class OpenCodeProvider implements FreshSessionProvider {
  name = "opencode";
  private readonly config: OpenCodeConfig;
  private readonly launchCommand: typeof spawnLoggedCommand;

  constructor(
    config: OpenCodeConfig = {},
    launchCommand: typeof spawnLoggedCommand = spawnLoggedCommand,
  ) {
    this.config = config;
    this.launchCommand = launchCommand;
  }

  async launch(input: LaunchFreshSessionInput) {
    const prompt = await readFile(input.promptPath, "utf8");
    const task = await readJsonFile<WorkerTask>(input.taskPath);
    const command = this.config.command ?? "opencode";
    const args = ["run", ...(this.config.extra_args ?? [])];
    return await this.launchCommand(command, args, {
      ...applyWorkerTaskLaunchSettings(input, task),
      stdinText: prompt,
    });
  }
}
