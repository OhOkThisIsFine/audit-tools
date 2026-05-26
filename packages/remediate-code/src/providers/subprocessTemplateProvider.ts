import { readJsonFile } from "../io/json.js";
import type { WorkerTask } from "../types/workerSession.js";
import type { FreshSessionProvider, LaunchFreshSessionInput } from "./types.js";
import { spawnLoggedCommand } from "./spawnLoggedCommand.js";
import type { SubprocessTemplateConfig } from "../types/sessionConfig.js";
import { applyWorkerTaskLaunchSettings } from "./workerTaskLaunch.js";
import { quoteForCmd } from "../utils/commands.js";

function shellQuote(arg: string): string {
  if (process.platform === "win32") {
    return quoteForCmd(arg);
  }
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

function applyTemplate(
  template: string,
  input: LaunchFreshSessionInput,
  task: WorkerTask,
  context: { providerName: string; entryIndex: number },
): string {
  const workerCommandShell = task.worker_command.map(shellQuote).join(" ");
  const workerCommandJson = JSON.stringify(task.worker_command);
  const values: Record<string, string> = {
    repoRoot: input.repoRoot,
    runId: input.runId,
    obligationId: input.obligationId ?? "",
    promptPath: input.promptPath,
    taskPath: input.taskPath,
    resultPath: input.resultPath,
    stdoutPath: input.stdoutPath,
    stderrPath: input.stderrPath,
    workerCommandShell,
    workerCommandJson,
    uiMode: input.uiMode,
    timeoutMs: String(input.timeoutMs),
  };
  const wholePlaceholder = template.match(/^\{([A-Za-z0-9_]+)\}$/);
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (match, key) => {
    if (!(key in values)) {
      console.warn(
        `applyTemplate: unknown placeholder ${match} ` +
          `provider=${context.providerName} runId=${input.runId} ` +
          `obligationId=${input.obligationId ?? ""} taskPath=${input.taskPath} ` +
          `entryIndex=${context.entryIndex}`,
      );
    }
    const value = values[key] ?? "";
    return wholePlaceholder || key.endsWith("Shell") ? value : shellQuote(value);
  });
}

export class SubprocessTemplateProvider implements FreshSessionProvider {
  name: string;
  private readonly config: SubprocessTemplateConfig;
  private readonly launchCommand: typeof spawnLoggedCommand;

  constructor(
    config: SubprocessTemplateConfig,
    name = "subprocess-template",
    launchCommand: typeof spawnLoggedCommand = spawnLoggedCommand,
  ) {
    this.config = config;
    this.name = name;
    this.launchCommand = launchCommand;
  }

  async launch(input: LaunchFreshSessionInput) {
    const task = await readJsonFile<WorkerTask>(input.taskPath);
    if (!this.config.command_template.length) {
      throw new Error(
        `${this.name} provider requires a non-empty command_template.`,
      );
    }
    const launchInput = applyWorkerTaskLaunchSettings(input, task);
    const rendered = this.config.command_template.map((entry, entryIndex) =>
      applyTemplate(entry, launchInput, task, {
        providerName: this.name,
        entryIndex,
      }),
    );
    const [command, ...args] = rendered;
    return await this.launchCommand(command, args, launchInput, this.config.env);
  }
}
