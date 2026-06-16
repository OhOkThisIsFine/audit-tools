import { readFile } from "node:fs/promises";
import type {
  FreshSessionProvider,
  LaunchFreshSessionInput,
} from "./types.js";
import type { OpenCodeConfig } from "../types/sessionConfig.js";
import { readJsonFile } from "../io/json.js";
import { spawnLoggedCommand } from "./spawnLoggedCommand.js";
import { resolveOpenCodeSpawnCommand } from "./opencodeLaunch.js";
import {
  applyWorkerTaskLaunchSettings,
  type WorkerTaskWithCommand,
} from "./workerTaskLaunch.js";
import {
  emitProviderLaunchDiagnostic,
  emitProviderDoneDiagnostic,
} from "./providerDiagnostics.js";

export const OPENCODE_PROVIDER_NAME = "opencode" as const;

/**
 * opencode backend. Like claude-code, opencode is handed the rendered prompt via
 * stdin and runs to completion; the same launch/done diagnostics are emitted.
 * opencode takes no skip-permissions flag, so it has no per-orchestrator delta —
 * the class is fully shared (drift-plan E4) and the injectable `launchCommand`
 * supports unit testing.
 */
export class OpenCodeProvider implements FreshSessionProvider {
  name = OPENCODE_PROVIDER_NAME;
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
    // The prompt is delivered via stdin, so it is not appended to argv.
    const baseArgs = ["run", ...(this.config.extra_args ?? [])];
    // On Windows the `opencode` launcher is a `.cmd` shim that `spawn` cannot
    // run without a shell; resolve it through cmd.exe (no-op on other OSes).
    const { command, args } = resolveOpenCodeSpawnCommand(baseCommand, baseArgs);
    emitProviderLaunchDiagnostic(this.name, input);
    const result = await this.launchCommand(command, args, {
      ...applyWorkerTaskLaunchSettings(input, task),
      stdinText: prompt,
    });
    emitProviderDoneDiagnostic(this.name, input, result);
    return result;
  }
}
