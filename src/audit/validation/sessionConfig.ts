import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { promisify } from "node:util";
import {
  isBareExecutableName,
  isDirectExecutablePath,
  isSupportedConfiguredCommand,
  type SessionConfig,
  type ValidationIssue,
  pushValidationIssue,
} from "audit-tools/shared";

const execFileAsync = promisify(execFile);

function pushIssue(
  issues: ValidationIssue[],
  path: string,
  message: string,
): void {
  pushValidationIssue(issues, path, message);
}

// Maximum wall-clock time for a PATH probe (where/which). 5 s is generous
// even on slow NFS mounts; prevents validation from hanging indefinitely on
// broken PATH entries or stalled DNS lookups.
const COMMAND_EXISTS_TIMEOUT_MS = 5_000;

async function commandExists(command: string): Promise<boolean> {
  const lookupCommand = process.platform === "win32" ? "where" : "which";
  try {
    // execFile (no shell) passes `command` as a literal argv entry, so shell
    // metacharacters in a config-supplied command cannot be interpreted or
    // executed during environment validation.
    await execFileAsync(lookupCommand, [command], {
      timeout: COMMAND_EXISTS_TIMEOUT_MS,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

function configuredPathExists(commandPath: string): boolean {
  try {
    accessSync(commandPath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function validateConfiguredProviderEnvironment(
  sessionConfig: SessionConfig,
  options: {
    commandExists?: (command: string) => Promise<boolean>;
    pathExists?: (commandPath: string) => boolean;
  } = {},
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const lookupCommand = options.commandExists ?? commandExists;
  const lookupPath = options.pathExists ?? configuredPathExists;
  const provider = sessionConfig.provider ?? "worker-command";

  // One row per CLI-launched provider: the provider name, its config block's
  // issue-path key, and the configured/default command. Same checks and message
  // text for every row — adding a CLI provider is a row, not a copied block.
  const cliProviderCommands: ReadonlyArray<{
    provider: string;
    configKey: string;
    command: string;
  }> = [
    {
      provider: "claude-code",
      configKey: "claude_code",
      command: sessionConfig.claude_code?.command ?? "claude",
    },
    {
      provider: "opencode",
      configKey: "opencode",
      command: sessionConfig.opencode?.command ?? "opencode",
    },
    {
      provider: "codex",
      configKey: "codex",
      command: sessionConfig.codex?.command ?? "codex",
    },
  ];

  for (const row of cliProviderCommands) {
    if (provider !== row.provider) continue;
    const { configKey, command } = row;
    if (isBareExecutableName(command) && !(await lookupCommand(command))) {
      pushIssue(
        issues,
        `${configKey}.command`,
        `Configured ${row.provider} executable was not found on PATH: ${command}.`,
      );
    } else if (isDirectExecutablePath(command) && !lookupPath(command)) {
      pushIssue(
        issues,
        `${configKey}.command`,
        `Configured ${row.provider} executable path does not exist: ${command}.`,
      );
    } else if (!isSupportedConfiguredCommand(command)) {
      pushIssue(
        issues,
        `${configKey}.command`,
        `Configured ${row.provider} command must be a bare executable name or direct path. Put CLI flags in extra_args.`,
      );
    }
  }

  return issues;
}

// `validateSessionConfig` (field-shape + security-warning validation) is now
// single-sourced in `audit-tools/shared` so both orchestrators validate
// identically. Re-exported here so audit call sites keep importing from
// `../validation/sessionConfig.js`.
export { validateSessionConfig, formatValidationIssues } from "audit-tools/shared";
