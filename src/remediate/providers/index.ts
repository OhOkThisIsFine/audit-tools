import {
  createFreshSessionProvider as createSharedFreshSessionProvider,
  resolveFreshSessionProviderName as resolveSharedFreshSessionProviderName,
  readSharedProviderConfirmation,
} from "audit-tools/shared";
import type {
  FreshSessionProvider,
  ResolvedProviderName,
  SessionConfig,
} from "audit-tools/shared";
import { createClaudeCodeProvider } from "./claudeCodeProvider.js";
import { createOpenCodeProvider } from "./opencodeProvider.js";

/**
 * Auto-resolution and provider wiring are single-sourced in `audit-tools/shared`.
 * The claude-code / opencode provider classes are shared too; this module only
 * injects remediate-code's bound factories (the sole delta is the claude-code
 * skip-permissions default — on, since the remediator runs unattended — and the
 * nested-session guard message) and attributes the auto-fallback warning to
 * `remediate-code`.
 */

export function resolveFreshSessionProviderName(
  name: string | undefined,
  sessionConfig: SessionConfig = {},
  options: {
    env?: NodeJS.ProcessEnv;
    commandExists?: (command: string) => boolean;
  } = {},
): ResolvedProviderName {
  return resolveSharedFreshSessionProviderName(name, sessionConfig, options);
}

export function createFreshSessionProvider(
  name: string | undefined,
  sessionConfig: SessionConfig = {},
): FreshSessionProvider {
  return createSharedFreshSessionProvider(name, sessionConfig, {
    orchestratorName: "remediate-code",
    createClaudeCodeProvider: (config) => createClaudeCodeProvider(config),
    createOpenCodeProvider: (config) => createOpenCodeProvider(config),
  });
}

/** Decision returned by honoring a shared (audit-written) provider confirmation. */
export interface HonoredProviderConfirmation {
  /**
   * Provider names the prior audit Gate-0 marked excluded — remediate honors
   * these so it never auto-dispatches a provider the operator already excluded.
   * Empty when there is nothing to honor (no artifact / malformed / re-confirm).
   */
  exclusions: ResolvedProviderName[];
  /**
   * When true, a shared confirmation exists but its discovered roster has changed
   * since it was written (INV-DC2-3 / CE-012 third state): remediate must
   * RE-CONFIRM rather than honor the stale pool, so its exclusions are not
   * applied. `reason` carries the human-readable roster delta.
   */
  reconfirm: boolean;
  reason?: string;
}

/**
 * DC-2 read side — remediate's gain of the shared session-level confirmation.
 *
 * Reads `<root>/.audit-tools/provider-confirmation.json` (written by a prior
 * audit run) and folds it into a provider-selection decision:
 *   - absent / malformed → `{ exclusions: [], reconfirm: false }` — remediate
 *     self-resolves exactly as a standalone run does today (INV-DC1-6 never-block).
 *   - present + roster fresh → honor the recorded excluded providers.
 *   - present + roster stale → `{ exclusions: [], reconfirm: true, reason }` — the
 *     distinct re-confirm signal (INV-DC2-3); the stale pool is NOT honored.
 *
 * Never throws: the underlying accessor degrades any read/parse failure to the
 * never-block path.
 */
export async function honorSharedProviderConfirmation(
  root: string,
  sessionConfig: SessionConfig = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<HonoredProviderConfirmation> {
  const read = await readSharedProviderConfirmation(root, sessionConfig, env);
  if (read === null) {
    return { exclusions: [], reconfirm: false };
  }
  if (read.status === "reconfirm") {
    return { exclusions: [], reconfirm: true, reason: read.reason };
  }
  const exclusions = read.confirmation.provider_pool
    .filter((entry) => entry.excluded)
    .map((entry) => entry.name);
  return { exclusions, reconfirm: false };
}
