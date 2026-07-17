import type { ClaudeWorkerConfig, spawnLoggedCommand } from "audit-tools/shared";
import { ClaudeWorkerProvider } from "audit-tools/shared";

// The claude-worker provider class is single-sourced in audit-tools/shared
// (mirrors the claude-code shim pattern, drift-plan E4). This module only
// carries remediate-code's intended delta — the skip-permissions default —
// and binds it via a factory; it defines no provider class body of its own.

/**
 * Construct the shared ClaudeWorkerProvider with remediate-code's options. The
 * autonomous remediator skips permission prompts by default (it applies changes
 * unattended and cannot pause mid-run); an explicit
 * `dangerously_skip_permissions: false` in the config still opts out.
 */
export function createClaudeWorkerProvider(
  config: ClaudeWorkerConfig = {},
  launchCommand?: typeof spawnLoggedCommand,
): ClaudeWorkerProvider {
  return new ClaudeWorkerProvider(
    config,
    { skipPermissionsDefault: true },
    launchCommand,
  );
}

export { ClaudeWorkerProvider } from "audit-tools/shared";
