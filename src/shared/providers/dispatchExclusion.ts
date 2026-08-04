import { PROVIDER_NAMES, type ResolvedProviderName } from "../types/sessionConfig.js";
import { isSelfSpawnBlocked } from "./providerPathGuard.js";

/** A mechanical source-pool exclusion emitted by the local self-spawn guard. */
export type DispatchExclusionPattern = `transport:${ResolvedProviderName}`;

export interface ExcludableBackend {
  transport: string;
  service?: string;
  model?: string;
  endpoint?: string;
}

export interface DispatchExclusion {
  excludes(backend: ExcludableBackend): boolean;
  excludedBy(backend: ExcludableBackend): DispatchExclusionPattern | null;
}

/**
 * Reject source lanes that would recursively spawn the active host agent.
 * Provider/model ordering and failover deliberately belong to the dispatch broker.
 */
export function buildSelfSpawnExclusion(
  options: {
    env?: NodeJS.ProcessEnv;
    activeHostProvider?: ResolvedProviderName | null;
  } = {},
): DispatchExclusion {
  const env = options.env ?? process.env;
  const blocked = PROVIDER_NAMES
    .filter((name): name is ResolvedProviderName => name !== "auto")
    .filter((name) => isSelfSpawnBlocked(name, env));
  if (options.activeHostProvider) blocked.push(options.activeHostProvider);
  const blockedSet = new Set<ResolvedProviderName>(blocked);
  const excludedBy = (backend: ExcludableBackend): DispatchExclusionPattern | null =>
    blockedSet.has(backend.transport as ResolvedProviderName)
      ? (`transport:${backend.transport}` as DispatchExclusionPattern)
      : null;
  return {
    excludes: (backend) => excludedBy(backend) !== null,
    excludedBy,
  };
}
