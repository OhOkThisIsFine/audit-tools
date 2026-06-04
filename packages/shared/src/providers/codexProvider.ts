import { readFile } from "node:fs/promises";
import { readJsonFile } from "../io/json.js";
import type {
  FreshSessionProvider,
  LaunchFreshSessionInput,
  ProviderRateLimits,
} from "./types.js";
import type { CodexConfig, OpenTokenConfig } from "../types/sessionConfig.js";
import { spawnLoggedCommand } from "./spawnLoggedCommand.js";
import {
  applyWorkerTaskLaunchSettings,
  type WorkerTaskWithCommand,
} from "./workerTaskLaunch.js";

// TODO(verify): the real Codex non-interactive / headless invocation. This is an
// unverified assumption — Codex's exec/non-interactive subcommand and the flag
// (or stdin convention) it reads the rendered prompt from must be confirmed
// against the actual `codex` CLI. Until then we assume `codex exec --prompt
// <text>` shape via `prompt_flag`; correct the binary name + flag once verified.
const DEFAULT_CODEX_PROMPT_FLAG = "--prompt";

/**
 * Codex CLI backend. Codex is a headless coding CLI in the same family as
 * claude-code: a binary that is handed the rendered prompt on the command line
 * (or via a flag) and runs to completion. It is therefore driven the same way as
 * ClaudeCodeProvider — read the rendered prompt, build argv, spawn, and stream
 * stdout/stderr to the worker log paths — rather than through a command template.
 */
export class CodexProvider implements FreshSessionProvider {
  name = "codex";
  private readonly config: CodexConfig;
  private readonly opentoken: OpenTokenConfig;
  private readonly launchCommand: typeof spawnLoggedCommand;

  constructor(
    config: CodexConfig | undefined,
    launchCommand: typeof spawnLoggedCommand = spawnLoggedCommand,
    opentoken: OpenTokenConfig = {},
  ) {
    this.config = config ?? {};
    this.launchCommand = launchCommand;
    this.opentoken = opentoken;
  }

  async launch(input: LaunchFreshSessionInput) {
    const prompt = await readFile(input.promptPath, "utf8");
    const task = await readJsonFile<WorkerTaskWithCommand>(input.taskPath);
    const command = this.config.command ?? "codex";
    const promptFlag = this.config.prompt_flag ?? DEFAULT_CODEX_PROMPT_FLAG;
    // TODO(verify): confirm whether Codex reads the rendered prompt from this
    // flag/arg or from stdin (input.stdinText). If it is stdin-driven, deliver
    // the prompt via the spawn stdin path instead of an argv flag.
    const args = [...(this.config.extra_args ?? []), promptFlag, prompt];
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

  /**
   * Best-effort, never-throwing. Codex is a hosted backend whose 429/RPM/TPM
   * ceilings are not introspectable from a CLI, so this returns null today.
   * When Codex begins surfacing rate-limit HTTP response headers (e.g.
   * x-ratelimit-* / retry-after), parse them here and map to
   * ProviderRateLimits { requests_per_minute, input_tokens_per_minute,
   * output_tokens_per_minute }. Until then resolution falls back to
   * classifyProvider("codex")=hosted defaults plus the learned-limits subsystem.
   */
  async queryLimits(_model: string | null): Promise<ProviderRateLimits | null> {
    return null;
  }
}
