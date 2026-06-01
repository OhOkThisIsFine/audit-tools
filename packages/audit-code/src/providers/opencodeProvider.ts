import { readFile } from "node:fs/promises";
import type { FreshSessionProvider, LaunchFreshSessionInput, OpenCodeConfig, OpenTokenConfig } from "@audit-tools/shared";
import { spawnLoggedCommand } from "@audit-tools/shared";

function resolveOpenCodeSpawnCommand(
  command: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
  shellCommand = process.env.ComSpec ?? "cmd.exe",
): { command: string; args: string[] } {
  if (platform !== "win32") {
    return { command, args };
  }
  const base = command.replace(/\.(cmd|bat|exe)$/i, "").toLowerCase();
  if (base === "opencode" || base === "npx" || command.endsWith(".cmd")) {
    return {
      command: shellCommand,
      args: ["/d", "/s", "/c", [command, ...args].map(quoteCmdArg).join(" ")],
    };
  }
  return { command, args };
}

function quoteCmdArg(value: string): string {
  if (/^[A-Za-z0-9_./:=+-]+$/.test(value)) {
    return value;
  }
  return `"${value.replace(/(["^&|<>%])/g, "^$1")}"`;
}

export class OpenCodeProvider implements FreshSessionProvider {
  name = "opencode";
  private readonly config: OpenCodeConfig;
  private readonly opentoken: OpenTokenConfig;

  constructor(config: OpenCodeConfig = {}, opentoken: OpenTokenConfig = {}) {
    this.config = config;
    this.opentoken = opentoken;
  }

  async launch(input: LaunchFreshSessionInput) {
    const prompt = await readFile(input.promptPath, "utf8");
    const baseCommand = this.config.command ?? "opencode";
    const baseArgs = ["run", prompt, ...(this.config.extra_args ?? [])];
    const resolved = resolveOpenCodeSpawnCommand(baseCommand, baseArgs);
    return await spawnLoggedCommand(resolved.command, resolved.args, input, undefined, {
      opentoken: this.opentoken.enabled,
      opentokenCommand: this.opentoken.command,
    });
  }
}
