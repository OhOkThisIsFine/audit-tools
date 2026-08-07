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

/**
 * Exclude backends whose provider names have died mid-run (recorded in a persisted
 * pause state). Dead providers are names observed to fail at spawn with
 * `provider_unavailable` outcomes; excluding them here means re-detection on
 * resume will fold in alternatives without re-offering the dead provider.
 *
 * The exclusion lives exactly as long as the pause record that carries the dead
 * provider names — once the pause is cleared (on resume or terminal), dead
 * providers are offered again on the next run. Undefined/empty dead provider list
 * excludes nothing.
 */
export function buildDeadProviderExclusion(
  deadProviders: ReadonlyArray<{ pool_id: string; provider_name: string }> | undefined,
): DispatchExclusion {
  const deadProviderSet = new Set<string>(
    deadProviders?.map((d) => d.provider_name) ?? [],
  );

  const excludedBy = (backend: ExcludableBackend): DispatchExclusionPattern | null =>
    deadProviderSet.has(backend.transport)
      ? (`transport:${backend.transport}` as DispatchExclusionPattern)
      : null;

  return {
    excludes: (backend) => excludedBy(backend) !== null,
    excludedBy,
  };
}

/**
 * Compose multiple dispatch exclusions: a backend is excluded if ANY exclusion
 * excludes it (OR logic). The `excludedBy` pattern matched is the FIRST one to
 * exclude the backend, so pattern order is deterministic (exclusions applied in
 * order; first match wins).
 */
export function composeDispatchExclusions(...exclusions: DispatchExclusion[]): DispatchExclusion {
  return {
    excludes: (backend) => exclusions.some((e) => e.excludes(backend)),
    excludedBy: (backend) => {
      for (const exclusion of exclusions) {
        const pattern = exclusion.excludedBy(backend);
        if (pattern !== null) return pattern;
      }
      return null;
    },
  };
}
