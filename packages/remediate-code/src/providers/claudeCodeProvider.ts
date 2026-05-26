import { readFile } from "node:fs/promises";
import type { FreshSessionProvider, LaunchFreshSessionInput } from "./types.js";
import type { ClaudeCodeConfig } from "../types/sessionConfig.js";
import { spawnLoggedCommand } from "./spawnLoggedCommand.js";
import { readJsonFile } from "../io/json.js";
import type { WorkerTask } from "../types/workerSession.js";
import { applyWorkerTaskLaunchSettings } from "./workerTaskLaunch.js";

export const ACTIVE_CLAUDE_CODE_SESSION_MESSAGE =
  "claude-code provider cannot be used inside an active Claude Code session. " +
  'Set provider to "local-subprocess" in .remediation-artifacts/session-config.json, ' +
  "then run /remediate-code conversationally and follow the dispatch prompts manually.";

export class ClaudeCodeProvider implements FreshSessionProvider {
  name = "claude-code";
  private readonly config: ClaudeCodeConfig;
  private readonly launchCommand: typeof spawnLoggedCommand;

  constructor(
    config: ClaudeCodeConfig = {},
    launchCommand: typeof spawnLoggedCommand = spawnLoggedCommand,
  ) {
    this.config = config;
    this.launchCommand = launchCommand;
  }

  async launch(input: LaunchFreshSessionInput) {
    if (process.env.CLAUDECODE) {
      throw new Error(ACTIVE_CLAUDE_CODE_SESSION_MESSAGE);
    }
    const prompt = await readFile(input.promptPath, "utf8");
    const task = await readJsonFile<WorkerTask>(input.taskPath);
    const command = this.config.command ?? "claude";
    const args = [
      "-p",
      ...(this.config.extra_args ?? []),
      "--dangerously-skip-permissions",
    ];
    return await this.launchCommand(command, args, {
      ...applyWorkerTaskLaunchSettings(input, task),
      stdinText: prompt,
    });
  }
}
