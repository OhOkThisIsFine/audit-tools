import { readFile } from "node:fs/promises";
import type { FreshSessionProvider, LaunchFreshSessionInput, OpenCodeConfig, WorkerTaskWithCommand } from "@audit-tools/shared";
import {
  readJsonFile,
  spawnLoggedCommand,
  resolveOpenCodeSpawnCommand,
  applyWorkerTaskLaunchSettings,
} from "@audit-tools/shared";

export class OpenCodeProvider implements FreshSessionProvider {
  name = "opencode";
  private readonly config: OpenCodeConfig;

  constructor(config: OpenCodeConfig = {}) {
    this.config = config;
  }

  async launch(input: LaunchFreshSessionInput) {
    const prompt = await readFile(input.promptPath, "utf8");
    const task = await readJsonFile<WorkerTaskWithCommand>(input.taskPath);
    const baseCommand = this.config.command ?? "opencode";
    const baseArgs = ["run", prompt, ...(this.config.extra_args ?? [])];
    // On Windows the `opencode` launcher is a `.cmd` shim that `spawn` cannot
    // run without a shell; resolve it through cmd.exe (no-op on other OSes).
    const { command, args } = resolveOpenCodeSpawnCommand(baseCommand, baseArgs);
    process.stderr.write(JSON.stringify({ event: "provider_launch", provider: this.name, runId: input.runId, obligationId: input.obligationId, promptPath: input.promptPath, taskPath: input.taskPath }) + "\n");
    const result = await spawnLoggedCommand(
      command,
      args,
      applyWorkerTaskLaunchSettings(input, task),
    );
    process.stderr.write(JSON.stringify({ event: "provider_done", provider: this.name, runId: input.runId, obligationId: input.obligationId, accepted: result.accepted, exitCode: result.exitCode ?? null }) + "\n");
    return result;
  }
}
