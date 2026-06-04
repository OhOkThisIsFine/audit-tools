import type {
  FreshSessionProvider,
  LaunchFreshSessionInput,
} from "./types.js";
import type {
  AntigravityConfig,
  OpenTokenConfig,
} from "../types/sessionConfig.js";
import { SubprocessTemplateProvider } from "./subprocessTemplateProvider.js";
import { spawnLoggedCommand } from "./spawnLoggedCommand.js";

/**
 * Antigravity backend. Antigravity is an agentic IDE with no headless CLI, so —
 * exactly like VSCodeTaskProvider — it is driven by an operator-configured
 * command/task template and delegates to SubprocessTemplateProvider. The
 * unconfigured-template guard lives in the factory switch (mirroring vscode-task),
 * so by the time this class is constructed `config.command_template` is non-empty.
 */
export class AntigravityProvider implements FreshSessionProvider {
  name = "antigravity";
  private readonly delegate: SubprocessTemplateProvider;

  constructor(
    config: AntigravityConfig,
    launchCommand: typeof spawnLoggedCommand = spawnLoggedCommand,
    opentoken: OpenTokenConfig = {},
  ) {
    this.delegate = new SubprocessTemplateProvider(
      {
        command_template: config.command_template,
        env: config.env,
      },
      "antigravity",
      launchCommand,
      opentoken,
    );
  }

  async launch(input: LaunchFreshSessionInput) {
    return await this.delegate.launch(input);
  }
}
