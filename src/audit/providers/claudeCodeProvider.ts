import type { ClaudeCodeConfig, spawnLoggedCommand } from "audit-tools/shared";
import {
  ClaudeCodeProvider,
  buildActiveClaudeCodeSessionMessage,
} from "audit-tools/shared";

// The claude-code provider class is single-sourced in audit-tools/shared
// (drift-plan E4). This module only carries audit-code's intended delta — the
// session-config path quoted in the nested-session guard message — and binds it
// via a factory; it defines no provider class body of its own. audit-code keeps
// the safe skip-permissions default (off unless explicitly configured).

export const ACTIVE_CLAUDE_CODE_SESSION_MESSAGE =
  buildActiveClaudeCodeSessionMessage({
    sessionConfigPath: ".audit-tools/audit/session-config.json",
    slashCommand: "/audit-code",
  });

/**
 * Construct the shared ClaudeCodeProvider with audit-code's options. The
 * auditor only skips permissions when `dangerously_skip_permissions: true` is
 * set explicitly (skipPermissionsDefault stays false).
 */
export function createClaudeCodeProvider(
  config: ClaudeCodeConfig = {},
  launchCommand?: typeof spawnLoggedCommand,
): ClaudeCodeProvider {
  return new ClaudeCodeProvider(
    config,
    {
      skipPermissionsDefault: false,
      activeSessionMessage: ACTIVE_CLAUDE_CODE_SESSION_MESSAGE,
    },
    launchCommand,
  );
}

export { ClaudeCodeProvider } from "audit-tools/shared";
