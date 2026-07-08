import { join } from "node:path";
import {
  type AnalyzerSetting,
  type ProviderName,
  type SessionConfig,
  isRecord,
  readOptionalJsonFile,
  writeJsonFile,
  withFileLock,
  STALE_LOCK_MS,
  formatValidationIssues,
  type ValidationIssue,
} from "audit-tools/shared";
import { validateSessionConfig } from "../validation/sessionConfig.js";

const SESSION_CONFIG_FILENAME = "session-config.json";
const SESSION_CONFIG_LOCK_FILENAME = "session-config.lock";
const DEFAULT_SESSION_CONFIG: SessionConfig = {};

// Acquire timeout for the shared session-config lock, DERIVED to stay safely
// below shared fileLock's STALE_LOCK_MS (mirrors the remediate StateStore lock
// convention) so a fresh-but-held lock times out deterministically before it
// could be reclaimed as stale. The margin absorbs the write→acquire gap and
// load drift.
const LOCK_TIMEOUT_MARGIN_MS = 10_000;
const SESSION_CONFIG_LOCK_TIMEOUT_MS = STALE_LOCK_MS - LOCK_TIMEOUT_MARGIN_MS;

export function getSessionConfigPath(artifactsDir: string): string {
  return join(artifactsDir, SESSION_CONFIG_FILENAME);
}

function getSessionConfigLockPath(artifactsDir: string): string {
  return join(artifactsDir, SESSION_CONFIG_LOCK_FILENAME);
}

/**
 * Serialized read→merge→validate→write for `session-config.json`. The entire
 * critical section runs inside a single held {@link withFileLock} on a sibling
 * `session-config.lock`, so two concurrent writers can never interleave
 * read↔write and lose the other's field (last-writer-wins lost update). The
 * `merge` callback receives the freshly-read base record and returns the merged
 * result to persist, or `null` to skip the write (idempotent no-op) — the
 * skip-check therefore happens under the same lock as the read it compares
 * against. No caller adds backoff/retry of its own; that lives solely in the
 * shared lock.
 */
async function mutateSessionConfigLocked(
  artifactsDir: string,
  merge: (base: Record<string, unknown>) => Record<string, unknown> | null,
): Promise<SessionConfig> {
  const configPath = getSessionConfigPath(artifactsDir);
  const lockPath = getSessionConfigLockPath(artifactsDir);
  let result!: SessionConfig;
  await withFileLock(
    lockPath,
    async () => {
      const raw = (await readOptionalJsonFile<unknown>(configPath)) ?? {
        ...DEFAULT_SESSION_CONFIG,
      };
      const base = isRecord(raw) ? raw : { ...DEFAULT_SESSION_CONFIG };
      const merged = merge(base);
      if (merged === null) {
        // Idempotent no-op: nothing changed, so no write. The comparison ran
        // against `base`, which was read inside this same held lock.
        result = base as SessionConfig;
        return;
      }
      throwOnConfigErrors(configPath, validateSessionConfig(merged));
      await writeJsonFile(configPath, merged);
      result = merged as SessionConfig;
    },
    SESSION_CONFIG_LOCK_TIMEOUT_MS,
  );
  return result;
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
): Promise<SessionConfig> {
  const configPath = getSessionConfigPath(artifactsDir);
  const rawConfig = await readOptionalJsonFile<unknown>(configPath);
  if (rawConfig === undefined) {
    await writeJsonFile(configPath, DEFAULT_SESSION_CONFIG);
    return { ...DEFAULT_SESSION_CONFIG };
  }

  throwOnConfigErrors(configPath, validateSessionConfig(rawConfig));

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
  return mutateSessionConfigLocked(artifactsDir, (base) => {
    const current = isRecord(base.analyzers) ? base.analyzers : {};
    return { ...base, analyzers: { ...current, ...settings } };
  });
}

/**
 * B1: durably record the `--host-provider` override onto `session-config.json`,
 * preserving unknown fields, validating, and persisting. The conversation-host
 * identity is stable for a run, and the audit host-review path (`semanticReviewStep`)
 * re-reads the config file from disk — so persisting is the single-source seam that
 * makes the override reach it regardless of which subcommand re-enters the run.
 */
export async function persistHostProvider(
  artifactsDir: string,
  hostProvider: ProviderName,
): Promise<SessionConfig> {
  return mutateSessionConfigLocked(artifactsDir, (base) => {
    // Idempotent: an unchanged value is a no-op write. The host identity is stable
    // for a run, so a bare re-invocation re-passing --host-provider must not rewrite
    // the shared config file (needless churn + a wider lost-update window against a
    // concurrent writer on the multi-IDE cooperative path). The compare reads `base`
    // under the same held lock as the potential write, so it cannot race a
    // concurrent writer that flipped the value between read and write.
    if (base.host_provider === hostProvider) {
      return null;
    }
    return { ...base, host_provider: hostProvider };
  });
}
