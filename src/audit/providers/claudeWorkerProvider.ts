import type { ClaudeWorkerConfig, spawnLoggedCommand } from "audit-tools/shared";
import { ClaudeWorkerProvider } from "audit-tools/shared";

// The claude-worker provider class is single-sourced in audit-tools/shared
// (mirrors the claude-code shim pattern, drift-plan E4). This module only
// carries audit-code's intended delta — the safe skip-permissions default —
// and binds it via a factory; it defines no provider class body of its own.

/**
 * Construct the shared ClaudeWorkerProvider with audit-code's options. The
 * auditor only skips permissions when `dangerously_skip_permissions: true` is
 * set explicitly (skipPermissionsDefault stays false).
 */
export function createClaudeWorkerProvider(
  config: ClaudeWorkerConfig = {},
  launchCommand?: typeof spawnLoggedCommand,
): ClaudeWorkerProvider {
  return new ClaudeWorkerProvider(
    config,
    { skipPermissionsDefault: false },
    launchCommand,
  );
}

export { ClaudeWorkerProvider } from "audit-tools/shared";
