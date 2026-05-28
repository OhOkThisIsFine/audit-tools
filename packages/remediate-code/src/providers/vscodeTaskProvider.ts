import type { FreshSessionProvider, LaunchFreshSessionInput, VSCodeTaskConfig, OpenTokenConfig } from "@audit-tools/shared";
import { SubprocessTemplateProvider } from "./subprocessTemplateProvider.js";
import { spawnLoggedCommand } from "./spawnLoggedCommand.js";

export class VSCodeTaskProvider implements FreshSessionProvider {
  name = "vscode-task";
  private readonly delegate: SubprocessTemplateProvider;

  constructor(
    config: VSCodeTaskConfig,
    launchCommand: typeof spawnLoggedCommand = spawnLoggedCommand,
    opentoken: OpenTokenConfig = {},
  ) {
    this.delegate = new SubprocessTemplateProvider(
      {
        command_template: config.command_template,
        env: config.env,
      },
      "vscode-task",
      launchCommand,
      opentoken,
    );
  }

  async launch(input: LaunchFreshSessionInput) {
    return await this.delegate.launch(input);
  }
}
