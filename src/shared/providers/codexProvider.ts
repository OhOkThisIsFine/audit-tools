import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { readJsonFile } from "../io/json.js";
import type {
  FreshSessionProvider,
  LaunchFreshSessionInput,
  ProviderRateLimits,
} from "./types.js";
import type { CodexConfig } from "../types/sessionConfig.js";
import { spawnLoggedCommand } from "./spawnLoggedCommand.js";
import { resolveWindowsShimSpawnCommand } from "./opencodeLaunch.js";
import {
  applyWorkerTaskLaunchSettings,
  type WorkerTaskWithCommand,
} from "./workerTaskLaunch.js";
import {
  emitProviderLaunchDiagnostic,
  emitProviderDoneDiagnostic,
} from "./providerDiagnostics.js";

export const CODEX_PROVIDER_NAME = "codex" as const;

/** Default `codex exec --sandbox` policy: writes confined to the working root. */
const DEFAULT_CODEX_SANDBOX = "workspace-write" as const;

/**
 * Codex CLI backend. Codex is a headless coding CLI in the same family as
 * claude-code. The non-interactive entrypoint is `codex exec`, which reads the
 * rendered prompt from STDIN (so very large prompts never hit the command-line
 * length limit) and runs to completion editing files in its working root. The
 * invocation shape is verified against codex-cli 0.140.0:
 *
 *   codex exec --sandbox <policy> --cd <root> --add-dir <resultDir> [--model M]
 *
 * `exec` is inherently non-interactive (it has no `--ask-for-approval` flag); the
 * sandbox policy governs what it may write. `--cd` roots the agent (and its
 * sandbox) at the node's isolated worktree; `--add-dir` grants write access to the
 * result-file directory, which lives outside the worktree. On Windows the `codex`
 * launcher is a `.cmd`/`.ps1` shim that `spawn` cannot run without a shell, so it
 * is routed through cmd.exe (no-op on other OSes). Launch/done diagnostics match
 * the other CLI providers.
 */
export class CodexProvider implements FreshSessionProvider {
  name = CODEX_PROVIDER_NAME;
  private readonly config: CodexConfig;
  private readonly launchCommand: typeof spawnLoggedCommand;

  constructor(
    config: CodexConfig | undefined,
    launchCommand: typeof spawnLoggedCommand = spawnLoggedCommand,
  ) {
    this.config = config ?? {};
    this.launchCommand = launchCommand;
  }

  async launch(input: LaunchFreshSessionInput) {
    const prompt = await readFile(input.promptPath, "utf8");
    const task = await readJsonFile<WorkerTaskWithCommand>(input.taskPath);
    const command = this.config.command ?? "codex";
    const sandbox = this.config.sandbox_mode ?? DEFAULT_CODEX_SANDBOX;
    // The prompt is delivered via stdin, so it is NOT appended to argv.
    const baseArgs = [
      "exec",
      "--sandbox",
      sandbox,
      // Root the agent + its sandbox at the worker's working root (the node's
      // isolated worktree); spawn cwd is set to the same path.
      "--cd",
      input.repoRoot,
      // The result file lives outside the worktree (the main artifacts dir), so
      // grant write access to its directory alongside the workspace.
      "--add-dir",
      dirname(input.resultPath),
      ...(this.config.model ? ["--model", this.config.model] : []),
      ...(this.config.extra_args ?? []),
    ];
    // On Windows the `codex` launcher is a `.cmd`/`.ps1` shim that `spawn` cannot
    // run without a shell; route it through cmd.exe (no-op on other OSes).
    const { command: spawnCmd, args } = resolveWindowsShimSpawnCommand(
      command,
      baseArgs,
      ["codex", "npx"],
    );
    emitProviderLaunchDiagnostic(this.name, input);
    const result = await this.launchCommand(spawnCmd, args, {
      ...applyWorkerTaskLaunchSettings(input, task),
      stdinText: prompt,
    });
    emitProviderDoneDiagnostic(this.name, input, result);
    return result;
  }

  /**
   * Best-effort, never-throwing. Codex is a hosted backend whose 429/RPM/TPM
   * ceilings are not introspectable from the CLI, so this returns null today.
   * Resolution falls back to classifyProvider("codex").hostClass=hosted defaults plus the
   * learned-limits subsystem (which absorbs the real usage-limit signal Codex
   * surfaces on stderr when a quota is exhausted).
   */
  async queryLimits(_model: string | null): Promise<ProviderRateLimits | null> {
    return null;
  }
}
