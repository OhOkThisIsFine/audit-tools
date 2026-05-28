import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import {
  PROVIDER_NAMES,
  SESSION_UI_MODES,
  type ProviderName,
  type SessionConfig,
  type SessionUiMode,
  type ValidationIssue,
  isRecord,
  pushValidationIssue,
} from "@audit-tools/shared";

const VALID_PROVIDERS = new Set<ProviderName>(PROVIDER_NAMES);
const VALID_UI_MODES = new Set<SessionUiMode>(SESSION_UI_MODES);

function pushIssue(
  issues: ValidationIssue[],
  path: string,
  message: string,
): void {
  pushValidationIssue(issues, path, message);
}

function validateStringArray(
  value: unknown,
  path: string,
  label: string,
  issues: ValidationIssue[],
  options: { allowEmptyArray?: boolean } = {},
): void {
  if (!Array.isArray(value)) {
    pushIssue(issues, path, `${label} must be an array of strings.`);
    return;
  }

  if (!options.allowEmptyArray && value.length === 0) {
    pushIssue(issues, path, `${label} must not be empty.`);
  }

  for (const [index, item] of value.entries()) {
    if (typeof item !== "string" || item.trim().length === 0) {
      pushIssue(
        issues,
        `${path}[${index}]`,
        `${label} entries must be non-empty strings.`,
      );
    }
  }
}

function validateEnvOverlay(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): void {
  if (!isRecord(value)) {
    pushIssue(issues, path, "env must be an object of string values.");
    return;
  }

  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") {
      pushIssue(
        issues,
        `${path}.${key}`,
        "Environment override values must be strings.",
      );
    }
  }
}

function validateTemplateProviderSection(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  required: boolean,
): void {
  if (value === undefined) {
    if (required) {
      pushIssue(
        issues,
        path,
        "Provider requires this config section with a non-empty command_template.",
      );
    }
    return;
  }

  if (!isRecord(value)) {
    pushIssue(issues, path, "Provider config must be a JSON object.");
    return;
  }

  if (value.command_template === undefined) {
    if (required) {
      pushIssue(
        issues,
        `${path}.command_template`,
        "command_template is required for this provider.",
      );
    }
  } else {
    validateStringArray(
      value.command_template,
      `${path}.command_template`,
      "command_template",
      issues,
    );
  }

  if (value.env !== undefined) {
    validateEnvOverlay(value.env, `${path}.env`, issues);
  }
}

function validateAgentProviderSection(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): void {
  if (value === undefined) {
    return;
  }

  if (!isRecord(value)) {
    pushIssue(issues, path, "Provider config must be a JSON object.");
    return;
  }

  if (value.command !== undefined) {
    if (typeof value.command !== "string" || value.command.trim().length === 0) {
      pushIssue(
        issues,
        `${path}.command`,
        "command must be a non-empty string when provided.",
      );
    } else if (!isSupportedConfiguredCommand(value.command)) {
      pushIssue(
        issues,
        `${path}.command`,
        "command must be a bare executable name or direct executable path. Put CLI flags in extra_args.",
      );
    }
  }

  if (value.extra_args !== undefined) {
    validateStringArray(
      value.extra_args,
      `${path}.extra_args`,
      "extra_args",
      issues,
      { allowEmptyArray: true },
    );
  }

  if (
    path === "claude_code" &&
    value.dangerously_skip_permissions !== undefined &&
    typeof value.dangerously_skip_permissions !== "boolean"
  ) {
    pushIssue(
      issues,
      `${path}.dangerously_skip_permissions`,
      "dangerously_skip_permissions must be a boolean when provided.",
    );
  }
}

function commandExists(command: string): boolean {
  const lookupCommand = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(lookupCommand, [command], { stdio: "ignore" });
  return result.status === 0;
}

function configuredPathExists(commandPath: string): boolean {
  try {
    accessSync(commandPath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function startsWithPathPrefix(command: string): boolean {
  return (
    command.startsWith(".") ||
    command.startsWith("/") ||
    command.startsWith("\\\\") ||
    /^[A-Za-z]:[\\/]/.test(command)
  );
}

function containsForbiddenCommandSyntax(command: string): boolean {
  return /[\r\n"'`|&;<>]/.test(command);
}

function isBareExecutableName(command: string): boolean {
  return (
    command.length > 0 &&
    !/\s/.test(command) &&
    !containsForbiddenCommandSyntax(command) &&
    !/[\\/]/.test(command) &&
    !/^[A-Za-z]:/.test(command)
  );
}

function isDirectExecutablePath(command: string): boolean {
  return (
    command.length > 0 &&
    !containsForbiddenCommandSyntax(command) &&
    startsWithPathPrefix(command)
  );
}

function isSupportedConfiguredCommand(command: string): boolean {
  const trimmed = command.trim();
  if (trimmed.length === 0 || trimmed !== command) {
    return false;
  }
  return isBareExecutableName(trimmed) || isDirectExecutablePath(trimmed);
}

export function validateSessionConfig(value: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (value === undefined) {
    return issues;
  }

  if (!isRecord(value)) {
    pushIssue(issues, "session_config", "Session config must be a JSON object.");
    return issues;
  }

  const provider = value.provider;
  if (provider !== undefined) {
    if (typeof provider !== "string") {
      pushIssue(issues, "provider", "provider must be a string.");
    } else if (!VALID_PROVIDERS.has(provider as ProviderName)) {
      pushIssue(
        issues,
        "provider",
        `Unsupported provider "${provider}". Expected one of: ${Array.from(VALID_PROVIDERS).join(", ")}.`,
      );
    }
  }

  const timeoutMs = value.timeout_ms;
  if (
    timeoutMs !== undefined &&
    (!Number.isInteger(timeoutMs) || Number(timeoutMs) <= 0)
  ) {
    pushIssue(
      issues,
      "timeout_ms",
      "timeout_ms must be a positive integer number of milliseconds.",
    );
  }

  const uiMode = value.ui_mode;
  if (uiMode !== undefined) {
    if (typeof uiMode !== "string" || !VALID_UI_MODES.has(uiMode as SessionUiMode)) {
      pushIssue(
        issues,
        "ui_mode",
        `ui_mode must be one of: ${Array.from(VALID_UI_MODES).join(", ")}.`,
      );
    }
  }

  if (
    value.host_can_dispatch_subagents !== undefined &&
    typeof value.host_can_dispatch_subagents !== "boolean"
  ) {
    pushIssue(
      issues,
      "host_can_dispatch_subagents",
      "host_can_dispatch_subagents must be a boolean when provided.",
    );
  }

  validateTemplateProviderSection(
    value.subprocess_template,
    "subprocess_template",
    issues,
    provider === "subprocess-template",
  );
  validateTemplateProviderSection(
    value.vscode_task,
    "vscode_task",
    issues,
    provider === "vscode-task",
  );
  validateAgentProviderSection(value.claude_code, "claude_code", issues);
  validateAgentProviderSection(value.opencode, "opencode", issues);

  return issues;
}

export function validateConfiguredProviderEnvironment(
  sessionConfig: SessionConfig,
  options: {
    commandExists?: (command: string) => boolean;
    pathExists?: (commandPath: string) => boolean;
  } = {},
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const lookupCommand = options.commandExists ?? commandExists;
  const lookupPath = options.pathExists ?? configuredPathExists;
  const provider = sessionConfig.provider ?? "local-subprocess";

  if (provider === "claude-code") {
    const command = sessionConfig.claude_code?.command ?? "claude";
    if (isBareExecutableName(command) && !lookupCommand(command)) {
      pushIssue(
        issues,
        "claude_code.command",
        `Configured claude-code executable was not found on PATH: ${command}.`,
      );
    } else if (isDirectExecutablePath(command) && !lookupPath(command)) {
      pushIssue(
        issues,
        "claude_code.command",
        `Configured claude-code executable path does not exist: ${command}.`,
      );
    } else if (!isSupportedConfiguredCommand(command)) {
      pushIssue(
        issues,
        "claude_code.command",
        "Configured claude-code command must be a bare executable name or direct path. Put CLI flags in extra_args.",
      );
    }
  }

  if (provider === "opencode") {
    const command = sessionConfig.opencode?.command ?? "opencode";
    if (isBareExecutableName(command) && !lookupCommand(command)) {
      pushIssue(
        issues,
        "opencode.command",
        `Configured opencode executable was not found on PATH: ${command}.`,
      );
    } else if (isDirectExecutablePath(command) && !lookupPath(command)) {
      pushIssue(
        issues,
        "opencode.command",
        `Configured opencode executable path does not exist: ${command}.`,
      );
    } else if (!isSupportedConfiguredCommand(command)) {
      pushIssue(
        issues,
        "opencode.command",
        "Configured opencode command must be a bare executable name or direct path. Put CLI flags in extra_args.",
      );
    }
  }

  return issues;
}

export { formatValidationIssues } from "@audit-tools/shared";
