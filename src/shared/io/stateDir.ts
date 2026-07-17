import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Single source for the MACHINE-GLOBAL state dir (`~/.audit-code` /
 * `~/.remediate-code`): the home-dir tree holding `sources-declared.json`,
 * `catalog-cache.json`, `quota-state.json`, and `reservations.json`.
 *
 * Every reader/writer of that state MUST resolve its path through this module —
 * never `join(homedir(), ".audit-code")` inline — so the {@link STATE_DIR_ENV_VAR}
 * override is honored everywhere at once. The override exists for hermeticity:
 * test/smoke harnesses point it at a per-run temp dir so no test or smoke outcome
 * can depend on the box's live declaration, populate cache, or quota ledger
 * (docs/backlog.md "Machine-global ~/.audit-code state leaks into EVERY e2e test").
 * Normal conversational usage never sets it — auto-resolution stays flag-free.
 */
export const STATE_DIR_ENV_VAR = "AUDIT_CODE_STATE_DIR";

/** `~/.audit-code` — the established audit-code home-dir state dir name. */
const AUDIT_CODE_STATE_DIR_NAME = ".audit-code";

/**
 * Resolve a machine-global state dir.
 *
 * Precedence: explicit `homeDir` (per-call test injection — the narrowest scope)
 * → `AUDIT_CODE_STATE_DIR` env override (used VERBATIM as the state dir, no
 * `defaultDirName` suffix, so a harness redirects every tool's state with one
 * var; audit and remediate deliberately collapse into the same dir under it) →
 * `join(os.homedir(), defaultDirName)`.
 */
export function resolveStateDir(
  defaultDirName: string,
  homeDir?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (homeDir !== undefined) return join(homeDir, defaultDirName);
  const override = env[STATE_DIR_ENV_VAR]?.trim();
  if (override !== undefined && override.length > 0) return override;
  return join(homedir(), defaultDirName);
}

/** {@link resolveStateDir} for `~/.audit-code` — the shared providers/quota state dir. */
export function resolveAuditCodeStateDir(
  homeDir?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return resolveStateDir(AUDIT_CODE_STATE_DIR_NAME, homeDir, env);
}
