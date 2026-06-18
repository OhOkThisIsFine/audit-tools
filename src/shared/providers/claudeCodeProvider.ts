import { readFile } from "node:fs/promises";
import type {
  FreshSessionProvider,
  LaunchFreshSessionInput,
} from "./types.js";
import type { ClaudeCodeConfig } from "../types/sessionConfig.js";
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

export const CLAUDE_CODE_PROVIDER_NAME = "claude-code" as const;

/**
 * Per-orchestrator tuning for the otherwise-identical claude-code provider. The
 * single principled default (prompt via stdin + launch/done diagnostics) is the
 * same for every orchestrator; the only intended delta is the skip-permissions
 * default and the session-config path quoted in the nested-session guard
 * message. Centralizing the class here keeps audit-code and remediate-code from
 * re-implementing — and accidentally drifting — the spawn/argv/diagnostics
 * logic (drift-plan E4).
 */
export interface ClaudeCodeProviderOptions {
  /**
   * Whether to default to `--dangerously-skip-permissions` when the config does
   * not set `dangerously_skip_permissions` explicitly. `false` (the safe
   * default) keeps permission prompts on; the autonomous remediator passes
   * `true` because it applies changes unattended and cannot pause mid-run.
   * Either way an explicit `dangerously_skip_permissions` in the config wins.
   */
  skipPermissionsDefault?: boolean;
  /**
   * The session-config path to quote in the nested-Claude-Code-session guard
   * error so each orchestrator points the operator at its own config file.
   */
  activeSessionMessage?: string;
}

/**
 * Build the nested-session guard message for an orchestrator. claude-code cannot
 * spawn a fresh `claude` from inside an active Claude Code session, so the
 * provider throws this guidance instead.
 */
export function buildActiveClaudeCodeSessionMessage(args: {
  sessionConfigPath: string;
  slashCommand: string;
}): string {
  return (
    "claude-code provider cannot be used inside an active Claude Code session. " +
    `Set provider to "local-subprocess" in ${args.sessionConfigPath}, ` +
    `then run ${args.slashCommand} conversationally and follow the dispatch prompts manually.`
  );
}

const DEFAULT_ACTIVE_SESSION_MESSAGE =
  "claude-code provider cannot be used inside an active Claude Code session. " +
  'Set provider to "local-subprocess" in the session-config.json, then run ' +
  "the orchestrator conversationally and follow the dispatch prompts manually.";

/**
 * claude-code backend. claude is a headless coding CLI: it is handed the
 * rendered prompt (here via stdin) and runs to completion. The prompt is piped
 * through stdin rather than an argv flag so very large prompts never hit the
 * platform command-line length limit, and structured launch/done diagnostics
 * are emitted to stderr for run-correlated observability. Both behaviors are the
 * single principled default shared by every orchestrator; per-orchestrator
 * options carry only the skip-permissions default and the guard message.
 */
export class ClaudeCodeProvider implements FreshSessionProvider {
  name = CLAUDE_CODE_PROVIDER_NAME;
  private readonly config: ClaudeCodeConfig;
  private readonly launchCommand: typeof spawnLoggedCommand;
  private readonly skipPermissionsDefault: boolean;
  private readonly activeSessionMessage: string;

  constructor(
    config: ClaudeCodeConfig = {},
    options: ClaudeCodeProviderOptions = {},
    launchCommand: typeof spawnLoggedCommand = spawnLoggedCommand,
  ) {
    this.config = config;
    this.launchCommand = launchCommand;
    this.skipPermissionsDefault = options.skipPermissionsDefault ?? false;
    this.activeSessionMessage =
      options.activeSessionMessage ?? DEFAULT_ACTIVE_SESSION_MESSAGE;
  }

  async launch(input: LaunchFreshSessionInput) {
    if (process.env.CLAUDECODE) {
      throw new Error(this.activeSessionMessage);
    }
    const prompt = await readFile(input.promptPath, "utf8");
    const task = await readJsonFile<WorkerTaskWithCommand>(input.taskPath);
    const command = this.config.command ?? "claude";
    const promptFlag = this.config.prompt_flag ?? "-p";
    // The prompt is delivered via stdin (see below), so `promptFlag` is passed
    // as a bare flag with no inline prompt value.
    const skipPermissions =
      this.config.dangerously_skip_permissions ?? this.skipPermissionsDefault;
    const args = [
      promptFlag,
      ...(this.config.extra_args ?? []),
      ...(skipPermissions ? ["--dangerously-skip-permissions"] : []),
    ];
    emitProviderLaunchDiagnostic(this.name, input);
    const result = await this.launchCommand(command, args, {
      ...applyWorkerTaskLaunchSettings(input, task),
      stdinText: prompt,
    });
    emitProviderDoneDiagnostic(this.name, input, result);
    return result;
  }
}
