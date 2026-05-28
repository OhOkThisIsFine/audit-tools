import { spawnSync } from "node:child_process";
import { LocalSubprocessProvider } from "./localSubprocessProvider.js";
import { SubprocessTemplateProvider } from "./subprocessTemplateProvider.js";
import { ClaudeCodeProvider } from "./claudeCodeProvider.js";
import { OpenCodeProvider } from "./opencodeProvider.js";
import { VSCodeTaskProvider } from "./vscodeTaskProvider.js";
import type {
  FreshSessionProvider,
  ResolvedProviderName,
  SessionConfig,
} from "@audit-tools/shared";

function hasEntries(values: string[] | undefined): boolean {
  return (values?.length ?? 0) > 0;
}

function hasConfiguredClaudeCode(sessionConfig: SessionConfig): boolean {
  return (
    Boolean(sessionConfig.claude_code?.command?.trim()) ||
    hasEntries(sessionConfig.claude_code?.extra_args) ||
    sessionConfig.claude_code?.dangerously_skip_permissions === true
  );
}

function hasConfiguredOpenCode(sessionConfig: SessionConfig): boolean {
  return (
    Boolean(sessionConfig.opencode?.command?.trim()) ||
    hasEntries(sessionConfig.opencode?.extra_args)
  );
}

function commandExists(command: string): boolean {
  const lookupCommand = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(lookupCommand, [command], { stdio: "ignore" });
  return result.status === 0;
}

export function resolveFreshSessionProviderName(
  name: string | undefined,
  sessionConfig: SessionConfig = {},
  options: {
    env?: NodeJS.ProcessEnv;
    commandExists?: (command: string) => boolean;
  } = {},
): ResolvedProviderName {
  const requestedProvider =
    name ?? sessionConfig.provider ?? "local-subprocess";
  if (requestedProvider !== "auto") {
    return requestedProvider as ResolvedProviderName;
  }

  const env = options.env ?? process.env;
  const lookupCommand = options.commandExists ?? commandExists;
  const inVSCode = (env.TERM_PROGRAM ?? "").toLowerCase() === "vscode";
  const insideClaudeCode = Boolean(env.CLAUDECODE);
  const insideOpenCode = Boolean(env.OPENCODE);

  // If we're inside a specific IDE/conversation, use that as the provider
  if (insideOpenCode) {
    return "opencode";
  }

  if (insideClaudeCode) {
    return "claude-code";
  }

  if (inVSCode && hasEntries(sessionConfig.vscode_task?.command_template)) {
    return "vscode-task";
  }

  if (hasEntries(sessionConfig.subprocess_template?.command_template)) {
    return "subprocess-template";
  }

  const claudeCommand = sessionConfig.claude_code?.command ?? "claude";
  const opencodeCommand = sessionConfig.opencode?.command ?? "opencode";
  const claudeAvailable = !insideClaudeCode && lookupCommand(claudeCommand);
  const opencodeAvailable = lookupCommand(opencodeCommand);

  if (!insideClaudeCode && hasConfiguredClaudeCode(sessionConfig) && claudeAvailable) {
    return "claude-code";
  }

  if (hasConfiguredOpenCode(sessionConfig) && opencodeAvailable) {
    return "opencode";
  }

  if (claudeAvailable && !opencodeAvailable) {
    return "claude-code";
  }

  if (opencodeAvailable && !claudeAvailable) {
    return "opencode";
  }

  return "local-subprocess";
}

export function createFreshSessionProvider(
  name: string | undefined,
  sessionConfig: SessionConfig = {},
): FreshSessionProvider {
  const providerName = resolveFreshSessionProviderName(name, sessionConfig);
  const opentoken = sessionConfig.opentoken ?? {};
  if (
    providerName === "local-subprocess" &&
    (name ?? sessionConfig.provider) === "auto"
  ) {
    process.stderr.write(
      "audit-code: auto provider resolved to local-subprocess — no capable agent provider detected. " +
        "Agent tasks will require manual dispatch. Configure claude-code, opencode, or subprocess-template " +
        "in session-config.json to automate them.\n",
    );
  }

  switch (providerName) {
    case "local-subprocess":
      return new LocalSubprocessProvider();
    case "subprocess-template":
      if (!sessionConfig.subprocess_template?.command_template?.length) {
        throw new Error(
          "subprocess-template provider requires session-config.json with subprocess_template.command_template.",
        );
      }
      return new SubprocessTemplateProvider(sessionConfig.subprocess_template, undefined, opentoken);
    case "claude-code":
      return new ClaudeCodeProvider(sessionConfig.claude_code, undefined, opentoken);
    case "opencode":
      return new OpenCodeProvider(sessionConfig.opencode, opentoken);
    case "vscode-task":
      if (!sessionConfig.vscode_task?.command_template?.length) {
        throw new Error(
          "vscode-task provider requires session-config.json with vscode_task.command_template.",
        );
      }
      return new VSCodeTaskProvider(sessionConfig.vscode_task, opentoken);
    default:
      throw new Error(`Unknown provider: ${providerName}`);
  }
}
