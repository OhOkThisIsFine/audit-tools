import { readJsonFile } from "../io/json.js";
import type { WorkerTask } from "../types/workerSession.js";
import type { FreshSessionProvider, LaunchFreshSessionInput } from "./types.js";
import { spawnLoggedCommand } from "./spawnLoggedCommand.js";
import type { SubprocessTemplateConfig } from "../types/sessionConfig.js";

function shellQuote(arg: string): string {
  return JSON.stringify(arg);
}

function applyTemplate(
  template: string,
  input: LaunchFreshSessionInput,
  task: WorkerTask,
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
  return template.replace(
    /\{([A-Za-z0-9_]+)\}/g,
    (_match, key) => values[key] ?? "",
  );
}

export class SubprocessTemplateProvider implements FreshSessionProvider {
  name: string;
  private readonly config: SubprocessTemplateConfig;

  constructor(config: SubprocessTemplateConfig, name = "subprocess-template") {
    this.config = config;
    this.name = name;
  }

  async launch(input: LaunchFreshSessionInput) {
    const task = await readJsonFile<WorkerTask>(input.taskPath);
    if (!this.config.command_template.length) {
      throw new Error(
        `${this.name} provider requires a non-empty command_template.`,
      );
    }
    const rendered = this.config.command_template.map((entry) =>
      applyTemplate(entry, input, task),
    );
    const [command, ...args] = rendered;
    return await spawnLoggedCommand(command, args, input, this.config.env);
  }
}
