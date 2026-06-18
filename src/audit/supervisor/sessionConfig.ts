import { join } from "node:path";
import {
  type AnalyzerSetting,
  type SessionConfig,
  isRecord,
  readOptionalJsonFile,
  writeJsonFile,
  formatValidationIssues,
  type ValidationIssue,
} from "audit-tools/shared";
import { validateSessionConfig } from "../validation/sessionConfig.js";

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

/**
 * Merge per-analyzer resolution decisions into `session-config.json`,
 * preserving any unknown fields, validating, and persisting the result. Used by
 * the conversation-first `analyzer_install` step to durably record the host's
 * `{ephemeral|permanent|skip}` choices under `analyzers.<id>`.
 */
export async function persistAnalyzerSettings(
  artifactsDir: string,
  settings: Record<string, AnalyzerSetting>,
): Promise<SessionConfig> {
  const configPath = getSessionConfigPath(artifactsDir);
  const raw = (await readOptionalJsonFile<unknown>(configPath)) ?? {
    ...DEFAULT_SESSION_CONFIG,
  };
  const base = isRecord(raw) ? raw : { ...DEFAULT_SESSION_CONFIG };
  const current = isRecord(base.analyzers) ? base.analyzers : {};
  const merged = { ...base, analyzers: { ...current, ...settings } };

  const issues = validateSessionConfig(merged);
  if (issues.length > 0) {
    throw new Error(formatConfigValidationIssues(configPath, issues));
  }
  await writeJsonFile(configPath, merged);
  return merged as SessionConfig;
}
