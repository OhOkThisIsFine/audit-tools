import { readFile } from "node:fs/promises";
import type { FreshSessionProvider, LaunchFreshSessionInput, ClaudeCodeConfig, OpenTokenConfig, WorkerTaskWithCommand } from "@audit-tools/shared";
import { readJsonFile, spawnLoggedCommand, applyWorkerTaskLaunchSettings } from "@audit-tools/shared";

export const ACTIVE_CLAUDE_CODE_SESSION_MESSAGE =
  "claude-code provider cannot be used inside an active Claude Code session. " +
  'Set provider to "local-subprocess" in .audit-artifacts/session-config.json, ' +
  "then run /audit-code conversationally and follow the dispatch prompts manually.";

export class ClaudeCodeProvider implements FreshSessionProvider {
  name = "claude-code";
  private readonly config: ClaudeCodeConfig;
  private readonly opentoken: OpenTokenConfig;
  private readonly launchCommand: typeof spawnLoggedCommand;

  constructor(
    config: ClaudeCodeConfig = {},
    launchCommand: typeof spawnLoggedCommand = spawnLoggedCommand,
    opentoken: OpenTokenConfig = {},
  ) {
    this.config = config;
    this.launchCommand = launchCommand;
    this.opentoken = opentoken;
  }

  async launch(input: LaunchFreshSessionInput) {
    if (process.env.CLAUDECODE) {
      throw new Error(ACTIVE_CLAUDE_CODE_SESSION_MESSAGE);
    }
    const prompt = await readFile(input.promptPath, "utf8");
    const task = await readJsonFile<WorkerTaskWithCommand>(input.taskPath);
    const command = this.config.command ?? "claude";
    const promptFlag = this.config.prompt_flag ?? "-p";
    const args = [
      promptFlag,
      prompt,
      ...(this.config.extra_args ?? []),
      ...(this.config.dangerously_skip_permissions
        ? ["--dangerously-skip-permissions"]
        : []),
    ];
    return await this.launchCommand(
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
