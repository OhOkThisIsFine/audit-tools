import { join } from "node:path";
import {
  type AnalyzerSetting,
  type LockedJsonStore,
  type RepoSessionIntent,
  createLockedJsonStore,
  SKIP_WRITE,
  isRecord,
  readOptionalJsonFile,
  writeJsonFile,
  formatValidationIssues,
  validateRepoSessionIntent,
  type ValidationIssue,
} from "audit-tools/shared";

const SESSION_CONFIG_FILENAME = "session-config.json";
const SESSION_CONFIG_LOCK_FILENAME = "session-config.lock";
const DEFAULT_SESSION_CONFIG: RepoSessionIntent = {};

export function getSessionConfigPath(artifactsDir: string): string {
  return join(artifactsDir, SESSION_CONFIG_FILENAME);
}

function getSessionConfigLockPath(artifactsDir: string): string {
  return join(artifactsDir, SESSION_CONFIG_LOCK_FILENAME);
}

/**
 * Thin adapter over the shared locked JSON store: `session-config.json`
 * guarded by a sibling `session-config.lock`. The below-STALE_LOCK_MS
 * lock-timeout derivation and the read-under-lock → validate → atomic-write
 * cycle are single-sourced in the shared store; only the session-config parse
 * (non-record → default) and validation live here.
 */
function sessionConfigStore(
  artifactsDir: string,
): LockedJsonStore<Record<string, unknown>> {
  const configPath = getSessionConfigPath(artifactsDir);
  return createLockedJsonStore<Record<string, unknown>>({
    path: configPath,
    lockPath: getSessionConfigLockPath(artifactsDir),
    parse: (raw) => (isRecord(raw) ? raw : { ...DEFAULT_SESSION_CONFIG }),
    validate: (next) =>
      throwOnConfigErrors(configPath, validateRepoSessionIntent(next)),
  });
}

/**
 * Serialized read→merge→validate→write for `session-config.json`. The entire
 * critical section runs inside a single held file lock (shared locked JSON
 * store), so two concurrent writers can never interleave read↔write and lose
 * the other's field (last-writer-wins lost update). The `merge` callback
 * receives the freshly-read base record and returns the merged result to
 * persist, or `null` to skip the write (idempotent no-op) — the skip-check
 * therefore happens under the same lock as the read it compares against. No
 * caller adds backoff/retry of its own; that lives solely in the shared lock.
 */
async function mutateSessionConfigLocked(
  artifactsDir: string,
  merge: (base: Record<string, unknown>) => Record<string, unknown> | null,
): Promise<RepoSessionIntent> {
  const result = await sessionConfigStore(artifactsDir).mutate(
    (base) => merge(base) ?? SKIP_WRITE,
  );
  return result as RepoSessionIntent;
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

/**
 * A config only fails to LOAD on `error`-severity issues. `warning`-severity
 * issues (e.g. `dangerously_skip_permissions=true`) are surfaced to stderr but
 * must not block the load — they flag a legitimate-but-risky operator choice, not
 * an unusable config.
 */
function throwOnConfigErrors(
  configPath: string,
  issues: ValidationIssue[],
): void {
  const errors = issues.filter((issue) => issue.severity === "error");
  if (errors.length > 0) {
    throw new Error(formatConfigValidationIssues(configPath, errors));
  }
  const warnings = issues.filter((issue) => issue.severity === "warning");
  if (warnings.length > 0) {
    console.warn(formatConfigValidationIssues(configPath, warnings));
  }
}

export async function loadSessionConfig(
  artifactsDir: string,
): Promise<RepoSessionIntent> {
  const configPath = getSessionConfigPath(artifactsDir);
  const rawConfig = await readOptionalJsonFile<unknown>(configPath);
  if (rawConfig === undefined) {
    await writeJsonFile(configPath, DEFAULT_SESSION_CONFIG);
    return { ...DEFAULT_SESSION_CONFIG };
  }

  throwOnConfigErrors(configPath, validateRepoSessionIntent(rawConfig));

  return rawConfig as RepoSessionIntent;
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
): Promise<RepoSessionIntent> {
  return mutateSessionConfigLocked(artifactsDir, (base) => {
    const current = isRecord(base.analyzers) ? base.analyzers : {};
    return { ...base, analyzers: { ...current, ...settings } };
  });
}
