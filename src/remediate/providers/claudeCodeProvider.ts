import type { ClaudeCodeConfig, spawnLoggedCommand } from "audit-tools/shared";
import {
  ClaudeCodeProvider,
  buildActiveClaudeCodeSessionMessage,
} from "audit-tools/shared";

// The claude-code provider class is single-sourced in audit-tools/shared
// (drift-plan E4). This module only carries remediate-code's two intended
// deltas — the skip-permissions default and the session-config path quoted in
// the nested-session guard message — and binds them via a factory; it defines
// no provider class body of its own.

export const ACTIVE_CLAUDE_CODE_SESSION_MESSAGE =
  buildActiveClaudeCodeSessionMessage({
    sessionConfigPath: ".audit-tools/remediation/session-config.json",
    slashCommand: "/remediate-code",
  });

/**
 * Construct the shared ClaudeCodeProvider with remediate-code's options. The
 * autonomous remediator skips permission prompts by default (it applies changes
 * unattended and cannot pause mid-run); an explicit
 * `dangerously_skip_permissions: false` in the config still opts out.
 */
export function createClaudeCodeProvider(
  config: ClaudeCodeConfig = {},
  launchCommand?: typeof spawnLoggedCommand,
): ClaudeCodeProvider {
  return new ClaudeCodeProvider(
    config,
    {
      skipPermissionsDefault: true,
      activeSessionMessage: ACTIVE_CLAUDE_CODE_SESSION_MESSAGE,
    },
    launchCommand,
  );
}

export { ClaudeCodeProvider } from "audit-tools/shared";
