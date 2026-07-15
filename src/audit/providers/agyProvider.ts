import type { AgyConfig, spawnLoggedCommand } from "audit-tools/shared";
import {
  AgyProvider,
  buildActiveAgySessionMessage,
} from "audit-tools/shared";

export const ACTIVE_AGY_SESSION_MESSAGE =
  buildActiveAgySessionMessage({
    sessionConfigPath: ".audit-tools/audit/session-config.json",
    slashCommand: "/audit-code",
  });

/**
 * Construct the shared AgyProvider with audit-code's options. The
 * auditor only skips permissions when `dangerously_skip_permissions: true` is
 * set explicitly (skipPermissionsDefault stays false).
 */
export function createAgyProvider(
  config: AgyConfig = {},
  launchCommand?: typeof spawnLoggedCommand,
): AgyProvider {
  return new AgyProvider(
    config,
    {
      skipPermissionsDefault: false,
      activeSessionMessage: ACTIVE_AGY_SESSION_MESSAGE,
    },
    launchCommand,
  );
}

export { AgyProvider } from "audit-tools/shared";
