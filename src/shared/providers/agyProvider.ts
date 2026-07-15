import { readFile } from "node:fs/promises";
import type { FreshSessionProvider, LaunchFreshSessionInput } from "./types.js";
import type { AgyConfig } from "../types/sessionConfig.js";
import { readJsonFile } from "../io/json.js";
import { spawnLoggedCommand } from "./spawnLoggedCommand.js";
import {
  applyWorkerTaskLaunchSettings,
  type WorkerTaskWithCommand,
} from "./workerTaskLaunch.js";
import {
  emitProviderLaunchDiagnostic,
  emitProviderDoneDiagnostic,
} from "./providerDiagnostics.js";
import { resolveWindowsShimSpawnCommand } from "./opencodeLaunch.js";
import { commandExists } from "./providerPathGuard.js";

export const AGY_PROVIDER_NAME = "agy" as const;

export interface AgyProviderOptions {
  skipPermissionsDefault?: boolean;
  activeSessionMessage?: string;
}

export function buildActiveAgySessionMessage(args: {
  sessionConfigPath: string;
  slashCommand: string;
}): string {
  return (
    "agy provider cannot be used inside an active Agy/Antigravity CLI session. " +
    `Set provider to "worker-command" in ${args.sessionConfigPath}, ` +
    `then run ${args.slashCommand} conversationally and follow the dispatch prompts manually.`
  );
}

const DEFAULT_ACTIVE_SESSION_MESSAGE =
  "agy provider cannot be used inside an active Agy/Antigravity CLI session. " +
  'Set provider to "worker-command" in the session-config.json, then run ' +
  "the orchestrator conversationally and follow the dispatch prompts manually.";

export class AgyProvider implements FreshSessionProvider {
  name = AGY_PROVIDER_NAME;
  private readonly config: AgyConfig;
  private readonly launchCommand: typeof spawnLoggedCommand;
  private readonly skipPermissionsDefault: boolean;
  private readonly activeSessionMessage: string;

  constructor(
    config: AgyConfig = {},
    options: AgyProviderOptions = {},
    launchCommand: typeof spawnLoggedCommand = spawnLoggedCommand,
  ) {
    this.config = config;
    this.launchCommand = launchCommand;
    this.skipPermissionsDefault = options.skipPermissionsDefault ?? false;
    this.activeSessionMessage = options.activeSessionMessage ?? DEFAULT_ACTIVE_SESSION_MESSAGE;
  }

  async launch(input: LaunchFreshSessionInput) {
    const env = process.env;
    if (env.AGY_CLI || env.ANTIGRAVITY_CLI || env.GEMINI_CLI) {
      throw new Error(this.activeSessionMessage);
    }
    const prompt = await readFile(input.promptPath, "utf8");
    const task = await readJsonFile<WorkerTaskWithCommand>(input.taskPath);

    // Resolve command: explicit config first, then try agy on path, default to gemini fallback
    let command = this.config.command;
    if (!command) {
      command = commandExists("agy") ? "agy" : "gemini";
    }

    // Determine if we are using the modern agy command or fallback gemini command
    const isAgy = command.toLowerCase().includes("agy");
    const skipPermissions = this.config.dangerously_skip_permissions ?? this.skipPermissionsDefault;

    const baseArgs: string[] = [];

    // Gated for July 18, 2026 sunset cleanup: fallback to legacy gemini flags (-m and -y)
    if (isAgy) {
      if (this.config.model) {
        baseArgs.push("--model", this.config.model);
      }
      if (skipPermissions) {
        baseArgs.push("--dangerously-skip-permissions");
      }
    } else {
      if (this.config.model) {
        baseArgs.push("-m", this.config.model);
      }
      if (skipPermissions) {
        baseArgs.push("-y");
      }
    }

    baseArgs.push(...(this.config.extra_args ?? []));

    // Support Windows wrapper (.cmd/.ps1) resolution
    const { command: spawnCmd, args } = resolveWindowsShimSpawnCommand(
      command,
      baseArgs,
      ["gemini", "agy"],
    );

    emitProviderLaunchDiagnostic(this.name, input);
    const result = await this.launchCommand(spawnCmd, args, {
      ...applyWorkerTaskLaunchSettings(input, task),
      stdinText: prompt, // Pipe prompt directly via stdin to bypass OS limits
    });
    emitProviderDoneDiagnostic(this.name, input, result);
    return result;
  }

  async queryLimits(_model: string | null) {
    return null; // fall back to reactive and learned limits
  }
}
