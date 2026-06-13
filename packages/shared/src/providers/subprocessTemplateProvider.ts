import { readJsonFile } from "../io/json.js";
import { shellQuote } from "../tooling/exec.js";
import type {
  FreshSessionProvider,
  LaunchFreshSessionInput,
} from "./types.js";
import type {
  SubprocessTemplateConfig,
} from "../types/sessionConfig.js";
import { spawnLoggedCommand } from "./spawnLoggedCommand.js";
import {
  applyWorkerTaskLaunchSettings,
  type WorkerTaskWithCommand,
} from "./workerTaskLaunch.js";
import { RunLogger } from "../observability/runLog.js";

export function applyTemplate(
  template: string,
  input: LaunchFreshSessionInput,
  task: WorkerTaskWithCommand,
  context: { providerName: string; entryIndex: number; log: RunLogger },
): string {
  // worker_command is optional: remediation tasks dispatch via the template's
  // own placeholders and omit it entirely. Default to an empty argv so a
  // template that never references {workerCommandShell}/{workerCommandJson}
  // launches cleanly, and one that does gets a well-defined empty value.
  const workerCommand = task.worker_command ?? [];
  const workerCommandShell = workerCommand
    .map((arg) => shellQuote(arg))
    .join(" ");
  const workerCommandJson = JSON.stringify(workerCommand);
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
  // When the entire template entry is a single placeholder token with no
  // surrounding text (e.g. "{promptPath}" with nothing else), the rendered
  // value becomes the whole argv element on its own.  In that case we must
  // NOT additionally shell-quote it: the value already occupies a discrete
  // argument slot, and wrapping it in quotes would corrupt it (e.g. turning
  // /path/to/file into '/path/to/file' as a literal string).
  const wholePlaceholder = template.match(/^\{([A-Za-z0-9_]+)\}$/);
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (match, key) => {
    if (!(key in values)) {
      context.log.event({
        kind: "error",
        provider: context.providerName,
        note:
          `applyTemplate: unknown placeholder ${match} ` +
          `runId=${input.runId} ` +
          `obligationId=${input.obligationId ?? ""} taskPath=${input.taskPath} ` +
          `entryIndex=${context.entryIndex}`,
        obligation: input.obligationId ?? undefined,
      });
      // Unknown placeholder resolves to nothing: emit an empty (unquoted) string
      // so it disappears from the rendered argv rather than leaving the spurious
      // '' token that shellQuote("") would otherwise produce.
      return "";
    }
    const value = values[key] ?? "";
    // Two conditions skip shell-quoting:
    //   1. wholePlaceholder: the entry is exactly "{key}" with nothing else —
    //      the value IS the entire argv element; quoting would double-wrap it.
    //   2. key.endsWith("Shell"): the value (e.g. workerCommandShell) is already
    //      a pre-assembled shell string and must not be quoted again.
    // All other cases: the placeholder is embedded inside a larger string that
    // will become one argv token, so the substituted value must be shell-quoted
    // to prevent word-splitting or glob expansion.
    return wholePlaceholder || key.endsWith("Shell") ? value : shellQuote(value);
  });
}

export class SubprocessTemplateProvider implements FreshSessionProvider {
  name: string;
  private readonly config: SubprocessTemplateConfig;
  private readonly launchCommand: typeof spawnLoggedCommand;
  private readonly log: RunLogger;

  constructor(
    config: SubprocessTemplateConfig,
    name = "subprocess-template",
    launchCommand: typeof spawnLoggedCommand = spawnLoggedCommand,
    runLogger?: RunLogger,
  ) {
    this.config = config;
    this.name = name;
    this.launchCommand = launchCommand;
    this.log = runLogger ?? RunLogger.disabled();
  }

  async launch(input: LaunchFreshSessionInput) {
    const task = await readJsonFile<WorkerTaskWithCommand>(input.taskPath);
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
        log: this.log,
      }),
    );
    const [command, ...args] = rendered;
    return await this.launchCommand(command, args, launchInput, this.config.env);
  }
}
