import type { FreshSessionProvider, LaunchFreshSessionInput, VSCodeTaskConfig, OpenTokenConfig } from "@audit-tools/shared";
import { SubprocessTemplateProvider } from "./subprocessTemplateProvider.js";

export class VSCodeTaskProvider implements FreshSessionProvider {
  name = "vscode-task";
  private readonly delegate: SubprocessTemplateProvider;

  constructor(config: VSCodeTaskConfig, opentoken: OpenTokenConfig = {}) {
    this.delegate = new SubprocessTemplateProvider(
      {
        command_template: config.command_template,
        env: config.env,
      },
      "vscode-task",
      opentoken,
    );
  }

  async launch(input: LaunchFreshSessionInput) {
    return await this.delegate.launch(input);
  }
}
