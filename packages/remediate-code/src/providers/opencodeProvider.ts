import { readFile } from "node:fs/promises";
import type { FreshSessionProvider, LaunchFreshSessionInput, OpenCodeConfig, OpenTokenConfig } from "@audit-tools/shared";
import { readJsonFile } from "@audit-tools/shared";
import { spawnLoggedCommand, resolveOpenCodeSpawnCommand } from "@audit-tools/shared";
import type { WorkerTask } from "../types/workerSession.js";
import { applyWorkerTaskLaunchSettings } from "./workerTaskLaunch.js";

export class OpenCodeProvider implements FreshSessionProvider {
  name = "opencode";
  private readonly config: OpenCodeConfig;
  private readonly opentoken: OpenTokenConfig;
  private readonly launchCommand: typeof spawnLoggedCommand;

  constructor(
    config: OpenCodeConfig = {},
    launchCommand: typeof spawnLoggedCommand = spawnLoggedCommand,
    opentoken: OpenTokenConfig = {},
  ) {
    this.config = config;
    this.launchCommand = launchCommand;
    this.opentoken = opentoken;
  }

  async launch(input: LaunchFreshSessionInput) {
    const prompt = await readFile(input.promptPath, "utf8");
    const task = await readJsonFile<WorkerTask>(input.taskPath);
    const baseCommand = this.config.command ?? "opencode";
    const baseArgs = ["run", ...(this.config.extra_args ?? [])];
    // On Windows the `opencode` launcher is a `.cmd` shim that `spawn` cannot
    // run without a shell; resolve it through cmd.exe (no-op on other OSes).
    const { command, args } = resolveOpenCodeSpawnCommand(baseCommand, baseArgs);
    return await this.launchCommand(command, args, {
      ...applyWorkerTaskLaunchSettings(input, task),
      stdinText: prompt,
    }, undefined, {
      opentoken: this.opentoken.enabled,
      opentokenCommand: this.opentoken.command,
    });
  }
}
