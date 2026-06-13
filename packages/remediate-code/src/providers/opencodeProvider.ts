import { readFile } from "node:fs/promises";
import type { FreshSessionProvider, LaunchFreshSessionInput, OpenCodeConfig, WorkerTaskWithCommand } from "@audit-tools/shared";
import { readJsonFile, spawnLoggedCommand, resolveOpenCodeSpawnCommand, applyWorkerTaskLaunchSettings } from "@audit-tools/shared";

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
    const task = await readJsonFile<WorkerTaskWithCommand>(input.taskPath);
    const baseCommand = this.config.command ?? "opencode";
    const baseArgs = ["run", ...(this.config.extra_args ?? [])];
    // On Windows the `opencode` launcher is a `.cmd` shim that `spawn` cannot
    // run without a shell; resolve it through cmd.exe (no-op on other OSes).
    const { command, args } = resolveOpenCodeSpawnCommand(baseCommand, baseArgs);
    return await this.launchCommand(command, args, {
      ...applyWorkerTaskLaunchSettings(input, task),
      stdinText: prompt,
    });
  }
}
