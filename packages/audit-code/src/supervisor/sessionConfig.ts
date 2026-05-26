import { join } from "node:path";
import type { SessionConfig } from "../types/sessionConfig.js";
import { readOptionalJsonFile } from "../io/json.js";
import {
  formatValidationIssues,
  type ValidationIssue,
} from "../validation/basic.js";
import { validateSessionConfig } from "../validation/sessionConfig.js";
import { writeJsonFile } from "../io/json.js";

const SESSION_CONFIG_FILENAME = "session-config.json";
const DEFAULT_SESSION_CONFIG: SessionConfig = { provider: "local-subprocess" };

export function getSessionConfigPath(artifactsDir: string): string {
  return join(artifactsDir, SESSION_CONFIG_FILENAME);
}

export async function readSessionConfigFile(
  artifactsDir: string,
): Promise<unknown | undefined> {
  return await readOptionalJsonFile<unknown>(getSessionConfigPath(artifactsDir));
}

function formatConfigValidationIssues(
  configPath: string,
  issues: ValidationIssue[],
): string {
  return `Invalid ${configPath}:\n${formatValidationIssues(issues).replace(/^  /gm, "- ")}`;
}

export async function loadSessionConfig(
  artifactsDir: string,
): Promise<SessionConfig> {
  const configPath = getSessionConfigPath(artifactsDir);
  const rawConfig = await readOptionalJsonFile<unknown>(configPath);
  if (rawConfig === undefined) {
    await writeJsonFile(configPath, DEFAULT_SESSION_CONFIG);
    return { ...DEFAULT_SESSION_CONFIG };
  }

  const issues = validateSessionConfig(rawConfig);
  if (issues.length > 0) {
    throw new Error(formatConfigValidationIssues(configPath, issues));
  }

  return rawConfig as SessionConfig;
}
