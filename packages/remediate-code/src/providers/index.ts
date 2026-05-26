import { spawnSync } from "node:child_process";
import { LocalSubprocessProvider } from "./localSubprocessProvider.js";
import { SubprocessTemplateProvider } from "./subprocessTemplateProvider.js";
import { ClaudeCodeProvider } from "./claudeCodeProvider.js";
import { OpenCodeProvider } from "./opencodeProvider.js";
import { VSCodeTaskProvider } from "./vscodeTaskProvider.js";
import type { FreshSessionProvider } from "./types.js";
import type {
  ResolvedProviderName,
  SessionConfig,
} from "../types/sessionConfig.js";

function hasEntries(values: string[] | undefined): boolean {
  return (values?.length ?? 0) > 0;
}

function hasConfiguredClaudeCode(sessionConfig: SessionConfig): boolean {
  return (
    Boolean(sessionConfig.claude_code?.command?.trim()) ||
    hasEntries(sessionConfig.claude_code?.extra_args)
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

interface AutoProviderContext {
  inVSCode: boolean;
  insideClaudeCode: boolean;
  hasVSCodeTaskTemplate: boolean;
  hasSubprocessTemplate: boolean;
  hasClaudeCodeConfig: boolean;
  hasOpenCodeConfig: boolean;
  claudeAvailable: boolean;
  opencodeAvailable: boolean;
}

function getAutoProviderContext(
  sessionConfig: SessionConfig,
  env: NodeJS.ProcessEnv,
  lookupCommand: (command: string) => boolean,
): AutoProviderContext {
  const insideClaudeCode = Boolean(env.CLAUDECODE);
  const claudeCommand = sessionConfig.claude_code?.command ?? "claude";
  const opencodeCommand = sessionConfig.opencode?.command ?? "opencode";
  return {
    inVSCode: (env.TERM_PROGRAM ?? "").toLowerCase() === "vscode",
    insideClaudeCode,
    hasVSCodeTaskTemplate: hasEntries(sessionConfig.vscode_task?.command_template),
    hasSubprocessTemplate: hasEntries(
      sessionConfig.subprocess_template?.command_template,
    ),
    hasClaudeCodeConfig: hasConfiguredClaudeCode(sessionConfig),
    hasOpenCodeConfig: hasConfiguredOpenCode(sessionConfig),
    claudeAvailable: !insideClaudeCode && lookupCommand(claudeCommand),
    opencodeAvailable: lookupCommand(opencodeCommand),
  };
}

function chooseAutoProvider(
  context: AutoProviderContext,
): ResolvedProviderName {
  if (context.inVSCode && context.hasVSCodeTaskTemplate) return "vscode-task";
  if (context.hasSubprocessTemplate) return "subprocess-template";
  if (context.hasClaudeCodeConfig && context.claudeAvailable) {
    return "claude-code";
  }
  if (context.hasOpenCodeConfig && context.opencodeAvailable) {
    return "opencode";
  }
  if (context.claudeAvailable && !context.opencodeAvailable) {
    return "claude-code";
  }
  if (context.opencodeAvailable && !context.claudeAvailable) {
    return "opencode";
  }
  return "local-subprocess";
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
  return chooseAutoProvider(
    getAutoProviderContext(sessionConfig, env, lookupCommand),
  );
}

export function createFreshSessionProvider(
  name: string | undefined,
  sessionConfig: SessionConfig = {},
): FreshSessionProvider {
  const providerName = resolveFreshSessionProviderName(name, sessionConfig);
  if (
    providerName === "local-subprocess" &&
    (name ?? sessionConfig.provider) === "auto"
  ) {
    process.stderr.write(
      "[warn] provider=local-subprocess event=auto_provider_fallback " +
        "remediate-code: auto provider resolved to local-subprocess — no capable agent provider detected. " +
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
      return new SubprocessTemplateProvider(sessionConfig.subprocess_template);
    case "claude-code":
      return new ClaudeCodeProvider(sessionConfig.claude_code);
    case "opencode":
      return new OpenCodeProvider(sessionConfig.opencode);
    case "vscode-task":
      if (!sessionConfig.vscode_task?.command_template?.length) {
        throw new Error(
          "vscode-task provider requires session-config.json with vscode_task.command_template.",
        );
      }
      return new VSCodeTaskProvider(sessionConfig.vscode_task);
    default:
      throw new Error(`Unknown provider: ${providerName}`);
  }
}
