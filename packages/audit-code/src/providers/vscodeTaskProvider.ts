import type { FreshSessionProvider, LaunchFreshSessionInput } from "./types.js";
import type { VSCodeTaskConfig } from "../types/sessionConfig.js";
import { SubprocessTemplateProvider } from "./subprocessTemplateProvider.js";

export class VSCodeTaskProvider implements FreshSessionProvider {
  name = "vscode-task";
  private readonly delegate: SubprocessTemplateProvider;

  constructor(config: VSCodeTaskConfig) {
    this.delegate = new SubprocessTemplateProvider(
      {
        command_template: config.command_template,
        env: config.env,
      },
      "vscode-task",
    );
  }

  async launch(input: LaunchFreshSessionInput) {
    return await this.delegate.launch(input);
  }
}
