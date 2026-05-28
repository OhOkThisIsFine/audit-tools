import type { SessionConfig, HostConcurrencyLimit } from "@audit-tools/shared";
import {
  detectHostActiveSubagentLimit as detectShared,
  resolveHostActiveSubagentLimit as resolveShared,
} from "@audit-tools/shared";

const ENV_PREFIX = "REMEDIATE_CODE";

export function detectHostActiveSubagentLimit(
  env: NodeJS.ProcessEnv = process.env,
): HostConcurrencyLimit | null {
  return detectShared(ENV_PREFIX, env);
}

export function resolveHostActiveSubagentLimit(options: {
  explicitLimit?: number | null;
  sessionConfig: SessionConfig;
  env?: NodeJS.ProcessEnv;
}): HostConcurrencyLimit | null {
  return resolveShared({ envPrefix: ENV_PREFIX, ...options });
}
