import type { AgyConfig, spawnLoggedCommand } from "audit-tools/shared";
import {
  AgyProvider,
  buildActiveAgySessionMessage,
} from "audit-tools/shared";

export const ACTIVE_AGY_SESSION_MESSAGE =
  buildActiveAgySessionMessage({
    sessionConfigPath: ".audit-tools/remediation/session-config.json",
    slashCommand: "/remediate-code",
  });

/**
 * Construct the shared AgyProvider with remediate-code's options. The
 * autonomous remediator skips permission prompts by default (it applies changes
 * unattended and cannot pause mid-run); an explicit
 * `dangerously_skip_permissions: false` in the config still opts out.
 */
export function createAgyProvider(
  config: AgyConfig = {},
  launchCommand?: typeof spawnLoggedCommand,
): AgyProvider {
  return new AgyProvider(
    config,
    {
      skipPermissionsDefault: true,
      activeSessionMessage: ACTIVE_AGY_SESSION_MESSAGE,
    },
    launchCommand,
  );
}

export { AgyProvider } from "audit-tools/shared";
