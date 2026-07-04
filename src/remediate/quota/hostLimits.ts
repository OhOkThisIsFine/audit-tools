import type {
  SessionConfig,
  HostConcurrencyLimit,
  ReadCodexMaxThreads,
} from "audit-tools/shared";
import {
  detectHostActiveSubagentLimit as detectShared,
  resolveHostActiveSubagentLimit as resolveShared,
} from "audit-tools/shared";

const ENV_PREFIX = "REMEDIATE_CODE";

export function detectHostActiveSubagentLimit(
  env: NodeJS.ProcessEnv = process.env,
  readCodexMaxThreads?: ReadCodexMaxThreads,
): HostConcurrencyLimit | null {
  return detectShared(ENV_PREFIX, env, readCodexMaxThreads);
}

export function resolveHostActiveSubagentLimit(options: {
  explicitLimit?: number | null;
  sessionConfig: SessionConfig;
  env?: NodeJS.ProcessEnv;
  readCodexMaxThreads?: ReadCodexMaxThreads;
}): HostConcurrencyLimit | null {
  return resolveShared({ envPrefix: ENV_PREFIX, ...options });
}
