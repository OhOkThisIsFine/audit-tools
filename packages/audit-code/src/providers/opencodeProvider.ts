import type { OpenCodeConfig, spawnLoggedCommand } from "@audit-tools/shared";
import { OpenCodeProvider } from "@audit-tools/shared";

// The opencode provider class is single-sourced in @audit-tools/shared
// (drift-plan E4). opencode has no skip-permissions flag, so there is no
// per-orchestrator delta — this module is a thin construction shim with no
// provider class body of its own.

export function createOpenCodeProvider(
  config: OpenCodeConfig = {},
  launchCommand?: typeof spawnLoggedCommand,
): OpenCodeProvider {
  return new OpenCodeProvider(config, launchCommand);
}

export { OpenCodeProvider } from "@audit-tools/shared";
