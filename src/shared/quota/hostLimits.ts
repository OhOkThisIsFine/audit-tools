import type { SessionConfig } from "../types/sessionConfig.js";
import type { HostConcurrencyLimit } from "./types.js";
import {
  CODEX_DEFAULT_MAX_THREADS,
  readCodexConfiguredMaxThreads,
} from "./codexHostConfig.js";

/** Reads Codex's configured `[agents].max_threads`, or null when unset. Injectable for tests. */
export type ReadCodexMaxThreads = () => number | null;

function parsePositiveInteger(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isInteger(value) && value > 0 ? value : null;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function detectHostActiveSubagentLimit(
  envPrefix: string,
  env: NodeJS.ProcessEnv = process.env,
  readCodexMaxThreads: ReadCodexMaxThreads = () => readCodexConfiguredMaxThreads(),
): HostConcurrencyLimit | null {
  const explicitEnvLimit = parsePositiveInteger(
    env[`${envPrefix}_HOST_MAX_ACTIVE_SUBAGENTS`] ??
      env.CODEX_MAX_ACTIVE_SUBAGENTS,
  );
  if (explicitEnvLimit !== null) {
    return {
      active_subagents: explicitEnvLimit,
      source: "environment",
      description: "Host active subagent limit from environment.",
    };
  }

  if (env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE === "Codex Desktop") {
    // Codex exposes no env var for its concurrency, but `[agents].max_threads`
    // in `~/.codex/config.toml` IS its real user-configurable ceiling — discover
    // it there. Only when that config is silent do we fall back to Codex's
    // documented default, labelled `known_default` (not a fake env reading).
    const discovered = readCodexMaxThreads();
    if (discovered !== null) {
      return {
        active_subagents: discovered,
        source: "discovered_config",
        description: "Codex agents.max_threads from ~/.codex/config.toml.",
      };
    }
    return {
      active_subagents: CODEX_DEFAULT_MAX_THREADS,
      source: "known_default",
      description: "Codex documented default agents.max_threads (config file silent).",
    };
  }

  return null;
}

export function resolveHostActiveSubagentLimit(options: {
  envPrefix: string;
  explicitLimit?: number | null;
  sessionConfig: SessionConfig;
  env?: NodeJS.ProcessEnv;
  readCodexMaxThreads?: ReadCodexMaxThreads;
}): HostConcurrencyLimit | null {
  if (options.explicitLimit !== undefined && options.explicitLimit !== null) {
    return {
      active_subagents: options.explicitLimit,
      source: "cli_flags",
      description: "Host active subagent limit reported by the conversation host.",
    };
  }

  const configuredLimit = parsePositiveInteger(
    options.sessionConfig.quota?.host_active_subagent_limit ??
      options.sessionConfig.parallel_workers,
  );
  if (configuredLimit !== null) {
    return {
      active_subagents: configuredLimit,
      source: "session_config",
      description: "Host active subagent limit from session-config.",
    };
  }

  return detectHostActiveSubagentLimit(
    options.envPrefix,
    options.env,
    options.readCodexMaxThreads ?? (() => readCodexConfiguredMaxThreads()),
  );
}
