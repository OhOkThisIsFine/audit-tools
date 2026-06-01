import { readFile } from "node:fs/promises";
import type { FreshSessionProvider, LaunchFreshSessionInput, OpenCodeConfig, OpenTokenConfig } from "@audit-tools/shared";
import {
  readJsonFile,
  spawnLoggedCommand,
  resolveOpenCodeSpawnCommand,
  applyWorkerTaskLaunchSettings,
} from "@audit-tools/shared";
import type { WorkerTask } from "../types/workerSession.js";

export class OpenCodeProvider implements FreshSessionProvider {
  name = "opencode";
  private readonly config: OpenCodeConfig;
  private readonly opentoken: OpenTokenConfig;

  constructor(config: OpenCodeConfig = {}, opentoken: OpenTokenConfig = {}) {
    this.config = config;
    this.opentoken = opentoken;
  }

  async launch(input: LaunchFreshSessionInput) {
    const prompt = await readFile(input.promptPath, "utf8");
    const task = await readJsonFile<WorkerTask>(input.taskPath);
    const baseCommand = this.config.command ?? "opencode";
    const baseArgs = ["run", prompt, ...(this.config.extra_args ?? [])];
    // On Windows the `opencode` launcher is a `.cmd` shim that `spawn` cannot
    // run without a shell; resolve it through cmd.exe (no-op on other OSes).
    const { command, args } = resolveOpenCodeSpawnCommand(baseCommand, baseArgs);
    return await spawnLoggedCommand(
      command,
      args,
      applyWorkerTaskLaunchSettings(input, task),
      undefined,
      {
        opentoken: this.opentoken.enabled,
        opentokenCommand: this.opentoken.command,
      },
    );
  }
}
